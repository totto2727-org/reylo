// Atlas SQLite declarations are interpreted here, after the native HCL syntax parser.
// This is schema analysis only: no Atlas process, filesystem database, or migration execution.
import { parseConfig } from "./hclsyntax/parser.ts";
import { staticString, staticTraversal, type Body, type Block, type Expression } from "./hclsyntax/types.ts";

const sqliteTypes = new Set(["integer", "int", "int2", "int8", "tinyint", "smallint", "mediumint", "bigint", "unsigned big int", "text", "clob", "blob", "real", "double", "double precision", "float", "numeric", "decimal", "boolean", "bool", "date", "datetime", "json", "varchar", "character", "char", "nchar", "nvarchar", "native character", "varying character"]);
const actions = new Map([["NO_ACTION", "NO ACTION"], ["RESTRICT", "RESTRICT"], ["SET_NULL", "SET NULL"], ["SET_DEFAULT", "SET DEFAULT"], ["CASCADE", "CASCADE"]]);
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

function fail(node: { range: { filename: string; start: { line: number; column: number } } }, message: string): never {
  const { filename, start } = node.range;
  throw new Error(`${filename}:${start.line}:${start.column}: ${message}`);
}

function shape(body: Body, attributes: readonly string[], blocks: readonly string[]) {
  for (const attribute of Object.values(body.attributes)) if (!attributes.includes(attribute.name)) fail(attribute, `Unsupported Atlas SQLite attribute ${attribute.name}.`);
  for (const block of body.blocks) if (!blocks.includes(block.type)) fail(block, `Unsupported Atlas SQLite block ${block.type}.`);
}

function labels(block: Block, count: number): string[] {
  if (block.labels.length !== count || block.labels.some((label) => !label || label.includes("\0"))) fail(block, `${block.type} requires ${count} nonempty label${count === 1 ? "" : "s"}.`);
  return block.labels;
}

function attribute(body: Body, name: string): Expression {
  const attribute = body.attributes[name];
  if (!attribute) fail(body, `Missing Atlas SQLite attribute ${name}.`);
  return attribute.expression;
}

function string(expression: Expression): string {
  const value = staticString(expression);
  if (value !== undefined) return value;
  fail(expression, "Expected a static HCL string.");
}

function boolean(expression: Expression): boolean {
  if (expression.kind === "literal" && typeof expression.value === "boolean") return expression.value;
  fail(expression, "Expected a literal HCL boolean.");
}

function path(expression: Expression): string[] {
  const parts = staticTraversal(expression);
  if (parts && parts.every((part) => typeof part === "string")) return [...parts];
  fail(expression, "Expected a static HCL reference.");
}

function tuple(expression: Expression): Expression[] {
  if (expression.kind === "tuple") return expression.expressions;
  fail(expression, "Expected an HCL tuple of column references.");
}

function localColumn(expression: Expression, columns: ReadonlySet<string>): string {
  const parts = path(expression);
  if (parts.length !== 2 || parts[0] !== "column" || !columns.has(parts[1]!)) fail(expression, "Expected a reference to a declared column in this table.");
  return parts[1]!;
}

function columnList(expression: Expression, columns: ReadonlySet<string>): string[] {
  const result = tuple(expression).map((item) => localColumn(item, columns));
  if (!result.length || new Set(result).size !== result.length) fail(expression, "Column lists must be nonempty and contain no duplicates.");
  return result;
}

function sqlCall(expression: Expression): string | undefined {
  if (expression.kind !== "call") return undefined;
  if (expression.name !== "sql" || expression.args.length !== 1 || expression.expandFinal) fail(expression, "Only sql(\"static SQL expression\") is supported in this Atlas SQLite field.");
  return string(expression.args[0]!);
}

function defaultValue(expression: Expression): string {
  const raw = sqlCall(expression);
  if (raw !== undefined) return `(${raw})`;
  const literalString = staticString(expression);
  if (literalString !== undefined) return quoted(literalString);
  if (expression.kind === "literal") {
    if (expression.value === null) return "NULL";
    if (typeof expression.value === "boolean") return expression.value ? "1" : "0";
    if (typeof expression.value === "number") return expression.numberText ?? String(expression.value);
  }
  if (expression.kind === "unary" && expression.operator === "-" && expression.operand.kind === "literal" && typeof expression.operand.value === "number") return expression.operator + (expression.operand.numberText ?? String(expression.operand.value));
  fail(expression, "Unsupported Atlas SQLite default; use a literal or explicit sql(\"...\").");
}

function columnType(expression: Expression): string {
  if (expression.kind === "call" && expression.name === "sql") fail(expression, "Raw SQL column types are not supported; use an Atlas SQLite type identifier.");
  const reference = staticTraversal(expression);
  if (reference?.length === 1 && typeof reference[0] === "string" && sqliteTypes.has(reference[0].toLowerCase())) return reference[0];
  // Atlas uses constructor calls for sized SQLite types, for example varchar(255).
  if (expression.kind === "call" && !expression.expandFinal && sqliteTypes.has(expression.name.toLowerCase()) && expression.args.length > 0 && expression.args.length <= 2) {
    const sizes = expression.args.map((argument) => {
      if (argument.kind !== "literal" || typeof argument.value !== "number" || !Number.isSafeInteger(argument.value) || argument.value < 0) fail(argument, "SQLite type sizes must be nonnegative integer literals.");
      return argument.value;
    });
    return `${expression.name}(${sizes.join(", ")})`;
  }
  fail(expression, "Unsupported Atlas SQLite column type.");
}

function one(blocks: readonly Block[], type: string): Block | undefined {
  const matches = blocks.filter((block) => block.type === type);
  if (matches.length > 1) fail(matches[1]!, `Duplicate ${type} block.`);
  return matches[0];
}

interface Table {
  block: Block;
  name: string;
  columns: ReadonlySet<string>;
}

function indexes(table: Table): { constraints: string[]; statements: string[] } {
  const constraints: string[] = [];
  const statements: string[] = [];
  const names = new Set<string>();
  for (const block of table.block.body.blocks.filter((block) => block.type === "index")) {
    const name = labels(block, 1)[0]!;
    if (names.has(name)) fail(block, `Duplicate index ${name}.`);
    names.add(name);
    shape(block.body, ["columns", "unique", "where"], ["on"]);
    const unique = block.body.attributes.unique ? boolean(attribute(block.body, "unique")) : false;
    const on = block.body.blocks.filter((block) => block.type === "on");
    let terms: string[];
    if (block.body.attributes.columns) {
      if (on.length) fail(block, "An index must use either columns or on blocks, not both.");
      terms = columnList(attribute(block.body, "columns"), table.columns).map(identifier);
    } else {
      if (!on.length) fail(block, "An index requires columns or on blocks.");
      const seen = new Set<string>();
      terms = on.map((term) => {
        labels(term, 0);
        shape(term.body, ["column", "expr", "desc"], []);
        const column = term.body.attributes.column;
        const expr = term.body.attributes.expr;
        if (Boolean(column) === Boolean(expr)) fail(term, "An index term requires exactly one column or expr.");
        const value = column ? identifier(localColumn(column.expression, table.columns)) : `(${string(expr!.expression)})`;
        if (seen.has(value)) fail(term, "Duplicate index term.");
        seen.add(value);
        return value + (term.body.attributes.desc && boolean(attribute(term.body, "desc")) ? " DESC" : "");
      });
    }
    const where = block.body.attributes.where ? ` WHERE ${string(attribute(block.body, "where"))}` : "";
    // Atlas inspection names implicit UNIQUE constraints sqlite_autoindex_*. SQLite reserves
    // that namespace, so preserve their constraint meaning instead of creating named indexes.
    if (name.startsWith("sqlite_autoindex_")) {
      if (!unique || on.length || where) fail(block, "An implicit SQLite autoindex must describe a plain UNIQUE column constraint.");
      constraints.push(`UNIQUE (${terms.join(", ")})`);
    } else {
      statements.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${identifier(name)} ON ${identifier(table.name)} (${terms.join(", ")})${where}`);
    }
  }
  return { constraints, statements };
}

function foreignKey(block: Block, table: Table, tables: ReadonlyMap<string, Table>): string {
  labels(block, 1);
  shape(block.body, ["columns", "ref_columns", "on_update", "on_delete"], []);
  const columns = columnList(attribute(block.body, "columns"), table.columns);
  const references = tuple(attribute(block.body, "ref_columns")).map((expression) => {
    const parts = path(expression);
    if (parts.length !== 4 || parts[0] !== "table" || parts[2] !== "column") fail(expression, "Expected table.<name>.column.<name> reference.");
    const target = tables.get(parts[1]!);
    if (!target || !target.columns.has(parts[3]!)) fail(expression, "Foreign key references an undeclared table or column.");
    return { table: target.name, column: parts[3]! };
  });
  if (references.length !== columns.length || !references.length || references.some((reference) => reference.table !== references[0]!.table) || new Set(references.map((reference) => reference.column)).size !== references.length) fail(block, "Foreign key columns must match a nonempty, unique column list in one target table.");
  let result = `CONSTRAINT ${identifier(block.labels[0]!)} FOREIGN KEY (${columns.map(identifier).join(", ")}) REFERENCES ${identifier(references[0]!.table)} (${references.map((reference) => identifier(reference.column)).join(", ")})`;
  for (const [name, sql] of [["on_update", "ON UPDATE"], ["on_delete", "ON DELETE"]] as const) {
    if (!block.body.attributes[name]) continue;
    const expression = attribute(block.body, name);
    const parts = path(expression);
    const action = parts.length === 1 ? actions.get(parts[0]!) : undefined;
    if (!action) fail(expression, `Unsupported foreign-key action ${parts.join(".")}.`);
    result += ` ${sql} ${action}`;
  }
  return result;
}

/** Compile the supported static Atlas SQLite declarations to individual in-memory DDL statements. */
export function sqliteSchemaFromHcl(source: string | Uint8Array, filename = "schema.hcl"): string[] {
  const parsed = parseConfig(source, filename);
  const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length) throw new Error(errors.map((diagnostic) => `${diagnostic.subject?.filename ?? filename}:${diagnostic.subject?.start.line ?? 1}:${diagnostic.subject?.start.column ?? 1}: ${diagnostic.summary}: ${diagnostic.detail}`).join("\n"));
  const body = parsed.body;
  shape(body, [], ["schema", "table"]);
  const schemas = body.blocks.filter((block) => block.type === "schema");
  if (schemas.length !== 1 || labels(schemas[0]!, 1)[0] !== "main") fail(body, "Exactly one SQLite schema \"main\" declaration is required.");
  shape(schemas[0]!.body, [], []);
  const tables = new Map<string, Table>();
  for (const block of body.blocks.filter((block) => block.type === "table")) {
    const name = labels(block, 1)[0]!;
    if (tables.has(name)) fail(block, `Duplicate table ${name}.`);
    shape(block.body, ["schema", "without_rowid", "strict"], ["column", "primary_key", "foreign_key", "index", "check"]);
    const schema = path(attribute(block.body, "schema"));
    if (schema.length !== 2 || schema[0] !== "schema" || schema[1] !== "main") fail(block, "Only the declared schema.main is supported.");
    const columns = new Set<string>();
    for (const column of block.body.blocks.filter((child) => child.type === "column")) {
      const name = labels(column, 1)[0]!;
      if (columns.has(name)) fail(column, `Duplicate column ${name}.`);
      columns.add(name);
    }
    if (!columns.size) fail(block, "A SQLite table requires at least one column.");
    tables.set(name, { name, block, columns });
  }
  const statements: string[] = [];
  const indexStatements: string[] = [];
  const indexNames = new Set<string>();
  for (const table of tables.values()) {
    const definitions = table.block.body.blocks.filter((block) => block.type === "column").map((column) => {
      shape(column.body, ["type", "null", "default"], []);
      let sql = `${identifier(column.labels[0]!)} ${columnType(attribute(column.body, "type"))}`;
      if (!boolean(attribute(column.body, "null"))) sql += " NOT NULL";
      if (column.body.attributes.default) sql += ` DEFAULT ${defaultValue(attribute(column.body, "default"))}`;
      return sql;
    });
    const primaryKey = one(table.block.body.blocks, "primary_key");
    if (primaryKey) {
      labels(primaryKey, 0);
      shape(primaryKey.body, ["columns"], []);
      definitions.push(`PRIMARY KEY (${columnList(attribute(primaryKey.body, "columns"), table.columns).map(identifier).join(", ")})`);
    }
    const foreignNames = new Set<string>();
    for (const block of table.block.body.blocks.filter((block) => block.type === "foreign_key")) {
      const name = labels(block, 1)[0]!;
      if (foreignNames.has(name)) fail(block, `Duplicate foreign key ${name}.`);
      foreignNames.add(name);
      definitions.push(foreignKey(block, table, tables));
    }
    for (const block of table.block.body.blocks.filter((block) => block.type === "check")) {
      if (block.labels.length > 1) fail(block, "A check has at most one optional constraint name.");
      shape(block.body, ["expr"], []);
      definitions.push(`${block.labels.length ? `CONSTRAINT ${identifier(block.labels[0]!)} ` : ""}CHECK (${string(attribute(block.body, "expr"))})`);
    }
    for (const block of table.block.body.blocks.filter((block) => block.type === "index")) {
      const name = labels(block, 1)[0]!;
      if (!name.startsWith("sqlite_autoindex_") && indexNames.has(name)) fail(block, `Duplicate SQLite index name ${name}.`);
      indexNames.add(name);
    }
    const index = indexes(table);
    definitions.push(...index.constraints);
    const options: string[] = [];
    if (table.block.body.attributes.without_rowid && boolean(attribute(table.block.body, "without_rowid"))) options.push("WITHOUT ROWID");
    if (table.block.body.attributes.strict && boolean(attribute(table.block.body, "strict"))) options.push("STRICT");
    statements.push(`CREATE TABLE ${identifier(table.name)} (${definitions.join(", ")})${options.length ? ` ${options.join(", ")}` : ""}`);
    indexStatements.push(...index.statements);
  }
  return [...statements, ...indexStatements];
}
