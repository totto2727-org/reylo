import type { ResolvedProject } from "./project.ts";

/**
 * One query per dialect whose rows change when anything an analysis reads changes: relations and
 * their columns, inheritance, constraints, indexes, row triggers and rules (nullability and the row
 * count read them), enum labels, domains, functions with their defaults, volatility, strictness,
 * kind and variadic argument, user operators and casts (the trust check reads them), view
 * definitions and column comments (a field's doc comment), and the server settings that change a statement's types;
 * and what the errors a statement may raise are read from: defaults (a domain's too), generated columns, policies and
 * operator classes on Postgres, and triggers, foreign keys, checks and every schema's stored functions on MySQL. SQLite's whole schema is
 * its `sqlite_schema` table, and the functions of the SQLite that opened it are part of what an
 * analysis reads: another Node has another SQLite. A `"char"` column is cast to text:
 * `text || "char"` is ambiguous, and a query the server refuses leaves every entry unverified.
 */
// The Postgres query names every operator, function, type and table as pg_catalog's, and converts a
// Value to text only by a built-in cast (a name, a "char", a boolean) or by its type's output
// Function (`textin(oidout(…))`), as the upstream engine's catalog queries do (engine/postgres/src/postgres.rs):
// Under a search path that puts a user's schema before pg_catalog, a user's `||` that answers NULL
// Would leave every row NULL, and the fingerprint would never move. Each row is the text the plain
// `||` of each field makes. The server's own `pg_get_viewdef` and `pg_get_ruledef` read a rule
// Through a query of bare operators, which a user's `=` of oids answers too: a view's or a rule's
// Row is then NULL, and left out.
const NS = `not (n.nspname operator(pg_catalog.=) any ('{pg_catalog,information_schema}'::pg_catalog.name[])) and n.nspname operator(pg_catalog.!~) '^pg_(toast|temp)'::pg_catalog.text`;
const cat = (...parts: string[]): string => parts.join(" operator(pg_catalog.||) ");
const lit = (text: string): string => `'${text}'::pg_catalog.text`;
const line = (tag: string, ...fields: string[]): string => cat(lit(`${tag} `), ...fields.flatMap((field, index) => (index ? [lit(" "), field] : [field])));
const out = (type: string, value: string): string => `pg_catalog.textin(pg_catalog.${type}out(${value}))`;
const txt = (value: string): string => `${value}::pg_catalog.text`;
const md5 = (value: string): string => `pg_catalog.md5(${value})`;
const or = (value: string): string => `coalesce(${value}, ''::pg_catalog.text)`;
const eq = (left: string, right: string): string => `${left} operator(pg_catalog.=) ${right}`;
const rel = (alias: string, column: string): string => `join pg_catalog.pg_class c on ${eq("c.oid", `${alias}.${column}`)} join pg_catalog.pg_namespace n on ${eq("n.oid", "c.relnamespace")}`;
const PG_CLASS = "'pg_catalog.pg_class'::pg_catalog.regclass::pg_catalog.oid";
const USER = "'16384'::pg_catalog.oid";
const POLICY_CONDITIONS = md5(cat(or("pg_catalog.pg_get_expr(p.polqual, p.polrelid)"), lit(" "), or("pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)")));
const POSTGRES_FINGERPRINT = `select pg_catalog.md5(coalesce(pg_catalog.string_agg(t.x, E'\\n'::pg_catalog.text order by t.x), ''::pg_catalog.text)) from (
    select ${line("v", "pg_catalog.current_setting('server_version_num'::pg_catalog.text)", "pg_catalog.current_setting('search_path'::pg_catalog.text)")} as x
    union all select ${line("r", out("oid", "c.oid"), cat(txt("n.nspname"), lit("."), txt("c.relname")), txt("c.relkind"))} from pg_catalog.pg_class c join pg_catalog.pg_namespace n on ${eq("n.oid", "c.relnamespace")} where ${NS}
    union all select ${line("a", out("oid", "a.attrelid"), out("int2", "a.attnum"), txt("a.attname"), out("oid", "a.atttypid"), txt("a.attnotnull"), out("oid", "a.attcollation"))} from pg_catalog.pg_attribute a ${rel("a", "attrelid")} where a.attnum operator(pg_catalog.>) 0 and not a.attisdropped and ${NS}
    union all select ${line("h", out("oid", "h.inhrelid"), out("oid", "h.inhparent"), out("int4", "h.inhseqno"))} from pg_catalog.pg_inherits h ${rel("h", "inhrelid")} where ${NS}
    union all select ${line("c", out("oid", "o.conrelid"), out("oid", "o.contypid"), txt("o.conname"), "pg_catalog.pg_get_constraintdef(o.oid)")} from pg_catalog.pg_constraint o join pg_catalog.pg_namespace n on ${eq("n.oid", "o.connamespace")} where ${NS}
    union all select ${line("i", out("oid", "i.indexrelid"), txt("i.indisvalid"), "pg_catalog.pg_get_indexdef(i.indexrelid)")} from pg_catalog.pg_index i ${rel("i", "indrelid")} where ${NS}
    union all select ${line("g", out("oid", "g.tgrelid"), txt("g.tgname"), out("int2", "g.tgtype"), txt("g.tgenabled"))} from pg_catalog.pg_trigger g ${rel("g", "tgrelid")} where not g.tgisinternal and ${NS}
    union all select ${line("u", out("oid", "w.ev_class"), txt("w.rulename"), txt("w.ev_type"), txt("w.ev_enabled"), md5("pg_catalog.pg_get_ruledef(w.oid)"))} from pg_catalog.pg_rewrite w ${rel("w", "ev_class")} where w.rulename operator(pg_catalog.<>) '_RETURN'::pg_catalog.name and ${NS}
    union all select ${line("o", out("oid", "o.oid"), txt("o.oprname"), out("oid", "o.oprleft"), out("oid", "o.oprright"), out("oid", "o.oprcode::pg_catalog.oid"))} from pg_catalog.pg_operator o where o.oid operator(pg_catalog.>=) ${USER}
    union all select ${line("e", out("oid", "e.enumtypid"), out("float4", "e.enumsortorder"), txt("e.enumlabel"))} from pg_catalog.pg_enum e
    union all select ${line("t", out("oid", "t.oid"), txt("t.typname"), txt("t.typtype"), out("oid", "t.typbasetype"), txt("t.typnotnull"), md5(or("t.typdefault")))} from pg_catalog.pg_type t join pg_catalog.pg_namespace n on ${eq("n.oid", "t.typnamespace")} where ${NS}
    union all select ${line("f", out("oid", "p.oid"), txt("p.proname"), out("oid", "p.prorettype"), txt("p.proretset"), out("oidvector", "p.proargtypes"), md5(or("p.prosrc")), txt("p.prokind"), txt("p.provolatile"), txt("p.proisstrict"), out("int2", "p.pronargdefaults"), out("oid", "p.provariadic"))} from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on ${eq("n.oid", "p.pronamespace")} where ${NS}
    union all select ${line("k", out("oid", "k.oid"), out("oid", "k.castsource"), out("oid", "k.casttarget"), out("oid", "k.castfunc"), txt("k.castcontext"), txt("k.castmethod"))} from pg_catalog.pg_cast k where k.oid operator(pg_catalog.>=) ${USER}
    union all select ${line("w", out("oid", "c.oid"), md5("pg_catalog.pg_get_viewdef(c.oid)"))} from pg_catalog.pg_class c join pg_catalog.pg_namespace n on ${eq("n.oid", "c.relnamespace")} where c.relkind operator(pg_catalog.=) any ('{v,m}'::pg_catalog."char"[]) and ${NS}
    union all select ${line("x", out("oid", "d.adrelid"), out("int2", "d.adnum"), md5("pg_catalog.pg_get_expr(d.adbin, d.adrelid)"))} from pg_catalog.pg_attrdef d ${rel("d", "adrelid")} where ${NS}
    union all select ${line("p", out("oid", "p.polrelid"), txt("p.polname"), txt("p.polcmd"), txt("p.polpermissive"), POLICY_CONDITIONS)} from pg_catalog.pg_policy p ${rel("p", "polrelid")} where ${NS}
    union all select ${line("q", out("oid", "q.oid"), txt("q.opcname"), out("oid", "q.opcmethod"), out("oid", "q.opcintype"))} from pg_catalog.pg_opclass q where q.oid operator(pg_catalog.>=) ${USER}
    union all select ${line("d", out("oid", "d.objoid"), out("int4", "d.objsubid"), md5("d.description"))} from pg_catalog.pg_description d ${rel("d", "objoid")} where ${eq("d.classoid", PG_CLASS)} and d.objsubid operator(pg_catalog.>) 0 and ${NS}
  ) t`;
export const FINGERPRINT: Record<ResolvedProject["dialect"], string> = {
  // The columns, keys, views, types and macros of every attached database, and the version, whose
  // Functions and binder an analysis reads.
  duckdb: `select md5(coalesce(string_agg(x, chr(10) order by x), '')) from (
    select concat_ws(' ', 'v', version()) as x
    union all select concat_ws(' ', 'c', database_name, schema_name, table_name, column_index, column_name, data_type, is_nullable, coalesce(column_default, ''), md5(coalesce(comment, ''))) from duckdb_columns() where not internal
    union all select concat_ws(' ', 'k', database_name, schema_name, table_name, constraint_type, constraint_text) from duckdb_constraints()
    union all select concat_ws(' ', 'w', database_name, schema_name, view_name, md5(coalesce(sql, ''))) from duckdb_views() where not internal
    union all select concat_ws(' ', 't', database_name, schema_name, type_name, logical_type) from duckdb_types() where not internal
    union all select concat_ws(' ', 'f', database_name, schema_name, function_name, function_type, md5(coalesce(macro_definition, ''))) from duckdb_functions() where not internal
  ) t`,
  mysql: `select concat_ws(' ', @@version, @@sql_mode, count(*), sum(crc32(x)), bit_xor(crc32(x))) from (
    select concat_ws(' ', 'c', table_name, column_name, ordinal_position, column_type, is_nullable, column_key, extra, coalesce(generation_expression, ''), md5(column_comment)) as x from information_schema.columns where table_schema = database()
    union all select concat_ws(' ', 's', table_name, index_name, non_unique, seq_in_index, column_name) from information_schema.statistics where table_schema = database()
    union all select concat_ws(' ', 'v', table_name, md5(view_definition)) from information_schema.views where table_schema = database()
    union all select concat_ws(' ', 'r', routine_name, routine_type, coalesce(dtd_identifier, ''), md5(coalesce(routine_definition, ''))) from information_schema.routines where routine_schema = database()
    union all select concat_ws(' ', 'p', routine_schema, routine_name) from information_schema.routines where routine_schema <> database() and routine_type = 'FUNCTION'
    union all select concat_ws(' ', 'g', event_object_table, trigger_name, event_manipulation, action_timing) from information_schema.triggers where event_object_schema = database()
    union all select concat_ws(' ', 'f', table_name, constraint_name, referenced_table_name, update_rule, delete_rule) from information_schema.referential_constraints where constraint_schema = database()
    union all select concat_ws(' ', 'k', table_name, constraint_name, constraint_type) from information_schema.table_constraints where table_schema = database()
  ) t`,
  postgres: POSTGRES_FINGERPRINT,
  sqlite: `select type, name, tbl_name, coalesce(sql, '') from sqlite_schema
    union all select 'function', name, type, narg from pragma_function_list order by 1, 2, 3, 4`,
};
