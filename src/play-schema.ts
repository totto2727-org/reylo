import type { Dialect } from "./engine-core.ts";
import type { Catalog, Table } from "./play-catalog.ts";

const POSTGRES_SCHEMA = `with q as (
  select n.oid, case when n.nspname = 'public' then '' else quote_ident(n.nspname) || '.' end as p
  from pg_namespace n where n.nspname = any(current_schemas(false)) and n.nspname <> 'pg_catalog'
)
select ddl from (
  select 0 as k, t.typname::text as name, format('create type %s%s as enum (%s);', q.p, quote_ident(t.typname),
    (select string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)) as ddl
  from pg_type t join q on q.oid = t.typnamespace where t.typtype = 'e'
  union all
  select 0, t.typname::text, format('create domain %s%s as %s%s%s;', q.p, quote_ident(t.typname), format_type(t.typbasetype, t.typtypmod),
    case when t.typnotnull then ' not null' else '' end,
    coalesce((select string_agg(' ' || pg_get_constraintdef(con.oid), '' order by con.conname) from pg_constraint con where con.contypid = t.oid and con.contype = 'c'), ''))
  from pg_type t join q on q.oid = t.typnamespace where t.typtype = 'd'
  union all
  select 1, c.relname::text, format(E'create table %s%s (\n%s\n);', q.p, quote_ident(c.relname), (
    select string_agg(line, E',\n' order by ord) from (
      select a.attnum::int as ord, '  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
        || case when a.attidentity in ('a', 'd') then ' generated ' || case a.attidentity when 'a' then 'always' else 'by default' end || ' as identity' else '' end
        || case when a.attgenerated <> '' then ' generated always as (' || pg_get_expr(d.adbin, d.adrelid) || ')' || case a.attgenerated when 's' then ' stored' else ' virtual' end
                when d.adbin is not null and a.attidentity = '' then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end
        || case when a.attnotnull then ' not null' else '' end as line
      from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      union all
      select 100000 + row_number() over (order by con.contype <> 'p', con.contype, con.conname)::int, '  constraint ' || quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid)
      from pg_constraint con where con.conrelid = c.oid and con.contype in ('p', 'u', 'f', 'c', 'x')
    ) lines))
  from pg_class c join q on q.oid = c.relnamespace where c.relkind in ('r', 'p', 'f')
  union all
  select 2, c.relname::text, format(E'create %sview %s%s as\n%s;', case c.relkind when 'm' then 'materialized ' else '' end, q.p, quote_ident(c.relname), rtrim(rtrim(pg_get_viewdef(c.oid, true)), ';'))
  from pg_class c join q on q.oid = c.relnamespace where c.relkind in ('v', 'm')
  union all
  select 3, i.relname::text, pg_get_indexdef(i.oid) || ';'
  from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid join q on q.oid = c.relnamespace
  where not exists (select 1 from pg_constraint con where con.conindid = x.indexrelid and con.contype in ('p', 'u', 'x'))
) s order by k, name`;

type QueryRows = (sql: string) => Promise<unknown[][]>;
type QuoteName = (name: string) => string;
const FIRST_ROW = 0;
const CREATE_STATEMENT = 1;

const sqliteDdl = async (query: QueryRows): Promise<string> => {
  const rows = await query(`select sql as ddl from sqlite_schema where sql is not null and name not like 'sqlite_%' order by case type when 'table' then 0 when 'view' then 1 when 'index' then 2 else 3 end, name`);
  return rows.map(([ddl]) => `${String(ddl).trim()};`).join("\n\n");
};

const mysqlStatement = async (query: QueryRows, name: string, type: string): Promise<string> => {
  const rows = await query(`show create ${type === "VIEW" ? "view" : "table"} \`${name.replaceAll('`', "``")}\``);
  // The next AUTO_INCREMENT value records table data.
  // oxlint-disable-next-line typescript/no-base-to-string -- Preserve MySQL SHOW CREATE's existing driver value coercion.
  return `${String(rows[FIRST_ROW]?.[CREATE_STATEMENT] ?? "").replace(/ AUTO_INCREMENT=\d+/u, "")};`;
};

const mysqlDdl = async (query: QueryRows): Promise<string> => {
  const tables = await query("select table_name, table_type from information_schema.tables where table_schema = database() order by table_type = 'VIEW', table_name");
  const statements: string[] = [];
  // oxlint-disable-next-line rules/no-for-loops, typescript/no-unsafe-type-assertion -- MySQL returns each table name and kind in this layout. Read SHOW CREATE in order through the same session.
  for (const [name, type] of tables as [string, string][]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each SHOW CREATE uses the same session, in catalog order.
    statements.push(await mysqlStatement(query, name, type));
  }
  return statements.join("\n\n");
};

export const schemaDdl = async (dialect: Dialect, query: QueryRows): Promise<string | undefined> => {
  try {
    if (dialect === "sqlite") {return await sqliteDdl(query);}
    if (dialect === "mysql") {return await mysqlDdl(query);}
    const rows = await query(POSTGRES_SCHEMA);
    return rows.map(([ddl]) => String(ddl)).join("\n\n");
  } catch {
    return undefined;
  }
};

const tableText = ({ columns, name }: Table, quote: QuoteName): string => {
  const width = Math.max(...columns.map((column) => quote(column.name).length));
  const fields = columns.map((column) => `  ${quote(column.name).padEnd(width)} ${column.type}${column.nullable ? "" : " not null"}`);
  return `create table ${quote(name)} (\n${fields.join(",\n")}\n);`;
};

const identifier = (dialect: Dialect, name: string): string => {
  if (/^[a-z_][a-z0-9_]*$/u.test(name)) {return name;}
  return dialect === "mysql" ? `\`${name}\`` : `"${name.replaceAll('"', '""')}"`;
};

export const schemaText = (dialect: Dialect, { tables }: Catalog): string =>
  tables.map((table) => tableText(table, (name) => identifier(dialect, name))).join("\n\n");
