// Interpret static Atlas SQLite declarations after parsing native HCL.
import { attribute, boolean, columnList, columnType, defaultValue, fail, identifier, label, path, requireNoLabels, shape, string } from "./hcl-sqlite-fields.ts";
import { foreignKey } from "./hcl-sqlite-foreign.ts";
import { IMPLICIT_INDEX_PREFIX, indexesFor } from "./hcl-sqlite-indexes.ts";
import { parseConfig } from "./hclsyntax/parser.ts";
import type { Block, Body } from "./hclsyntax/types.ts";
import { isEmptyArray, matchesUndefined } from "./native-predicates.ts";

interface Table {
  block: Block;
  columns: ReadonlySet<string>;
  name: string;
}

interface Statements {
  indexNames: Set<string>;
  indexes: string[];
  tables: string[];
}

const NO_COLUMNS = 0;
const FIRST_LINE = 1;
const FIRST_COLUMN = 1;
const SCHEMA_PATH_SEGMENTS = 2;
const SINGLE_SCHEMA = 1;
const MAX_CHECK_LABELS = 1;
const NO_CONSTRAINT_NAME = undefined;

const declarationBlocks = (body: Body, kind: string): Block[] =>
  body.blocks.filter((block) => block.type === kind);

const columnsFor = (table: Block): ReadonlySet<string> => {
  const columns = new Set<string>();
  declarationBlocks(table.body, "column").forEach((column) => {
    const name = label(column);
    if (columns.has(name)) {fail(column, `Duplicate column ${name}.`);}
    columns.add(name);
  });
  if (columns.size === NO_COLUMNS) {fail(table, "A SQLite table requires at least one column.");}
  return columns;
};

const registerTable = (tables: Map<string, Table>, block: Block): void => {
  const name = label(block);
  if (tables.has(name)) {fail(block, `Duplicate table ${name}.`);}
  shape(block.body, ["schema", "without_rowid", "strict"], ["column", "primary_key", "foreign_key", "index", "check"]);
  const reference = path(attribute(block.body, "schema"));
  const [kind, schema] = reference;
  if (reference.length !== SCHEMA_PATH_SEGMENTS || kind !== "schema" || schema !== "main") {
    fail(block, "Only the declared schema.main is supported.");
  }
  tables.set(name, { block, columns: columnsFor(block), name });
};

const tablesFor = (body: Body): Map<string, Table> => {
  shape(body, [], ["schema", "table"]);
  const schemas = declarationBlocks(body, "schema");
  const [schema] = schemas;
  if (schemas.length !== SINGLE_SCHEMA || matchesUndefined(schema) || label(schema) !== "main") {
    fail(body, 'Exactly one SQLite schema "main" declaration is required.');
  }
  shape(schema.body, [], []);
  const tables = new Map<string, Table>();
  declarationBlocks(body, "table").forEach((block) => {registerTable(tables, block);});
  return tables;
};

const columnSql = (column: Block): string => {
  const { body } = column;
  const name = label(column);
  shape(body, ["type", "null", "default"], []);
  const type = columnType(attribute(body, "type"));
  const nullable = boolean(attribute(body, "null")) ? "" : " NOT NULL";
  const defaultSql = body.attributes.default ? ` DEFAULT ${defaultValue(attribute(body, "default"))}` : "";
  return `${identifier(name)} ${type}${nullable}${defaultSql}`;
};

const addPrimaryKey = (definitions: string[], table: Table): void => {
  const primaryKeys = declarationBlocks(table.block.body, "primary_key");
  const [first, second] = primaryKeys;
  if (second) {fail(second, "Duplicate primary_key block.");}
  if (first) {
    requireNoLabels(first);
    shape(first.body, ["columns"], []);
    const columns = columnList(attribute(first.body, "columns"), table.columns);
    definitions.push(`PRIMARY KEY (${columns.map((column) => identifier(column)).join(", ")})`);
  }
};

const addForeignKeys = (definitions: string[], table: Table, tables: ReadonlyMap<string, Table>): void => {
  const names = new Set<string>();
  declarationBlocks(table.block.body, "foreign_key").forEach((block) => {
    const name = label(block);
    if (names.has(name)) {fail(block, `Duplicate foreign key ${name}.`);}
    names.add(name);
    definitions.push(foreignKey(block, table, tables));
  });
};

const checkSql = (block: Block): string => {
  const { body, labels: [name] } = block;
  if (block.labels.length > MAX_CHECK_LABELS) {fail(block, "A check has at most one optional constraint name.");}
  shape(body, ["expr"], []);
  const prefix = name === NO_CONSTRAINT_NAME ? "" : `CONSTRAINT ${identifier(name)} `;
  return `${prefix}CHECK (${string(attribute(body, "expr"))})`;
};

const registerIndexNames = (table: Table, names: Set<string>): void => {
  declarationBlocks(table.block.body, "index").forEach((block) => {
    const name = label(block);
    if (!name.startsWith(IMPLICIT_INDEX_PREFIX) && names.has(name)) {
      fail(block, `Duplicate SQLite index name ${name}.`);
    }
    names.add(name);
  });
};

const tableOptions = [["without_rowid", "WITHOUT ROWID"], ["strict", "STRICT"]] as const;
const optionSql = (body: Body): string => {
  const options = tableOptions.flatMap(([name, sql]) => {
    const field = body.attributes[name];
    return matchesUndefined(field) || !boolean(field.expression) ? [] : [sql];
  });
  return isEmptyArray(options) ? "" : ` ${options.join(", ")}`;
};

const compileTable = (statements: Statements, table: Table, tables: ReadonlyMap<string, Table>): void => {
  const definitions = declarationBlocks(table.block.body, "column").map((column) => columnSql(column));
  addPrimaryKey(definitions, table);
  addForeignKeys(definitions, table, tables);
  declarationBlocks(table.block.body, "check").forEach((block) => {definitions.push(checkSql(block));});
  registerIndexNames(table, statements.indexNames);
  const index = indexesFor(table);
  definitions.push(...index.constraints);
  const options = optionSql(table.block.body);
  statements.tables.push(`CREATE TABLE ${identifier(table.name)} (${definitions.join(", ")})${options}`);
  statements.indexes.push(...index.statements);
};

const parsedBody = (source: string | Uint8Array, filename: string): Body => {
  const { body, diagnostics } = parseConfig(source, filename);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!isEmptyArray(errors)) {
    const messages = errors.map(({ detail, subject, summary }) =>
      `${subject?.filename ?? filename}:${subject?.start.line ?? FIRST_LINE}:${subject?.start.column ?? FIRST_COLUMN}: ${summary}: ${detail}`);
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the compiler's native synchronous syntax error.
    throw new Error(messages.join("\n"));
  }
  return body;
};

/**
 * Compile supported static Atlas SQLite declarations to in-memory DDL.
 * @param {string | Uint8Array} source - Atlas SQLite declarations.
 * @param {string} filename - Source filename for diagnostics.
 * @returns {string[]} Table DDL followed by named index DDL in declaration order.
 */
export const sqliteSchemaFromHcl = function sqliteSchemaFromHcl(source: string | Uint8Array, filename = "schema.hcl"): string[] {
  const tables = tablesFor(parsedBody(source, filename));
  const statements: Statements = { indexNames: new Set(), indexes: [], tables: [] };
  Iterator.from(tables.values()).forEach((table) => {compileTable(statements, table, tables);});
  return [...statements.tables, ...statements.indexes];
};
