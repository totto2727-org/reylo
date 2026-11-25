import { attribute, columnList, fail, identifier, label, path, shape, tuple } from "./hcl-sqlite-fields.ts";
import type { Block, Expression } from "./hclsyntax/types.ts";
import { matchesUndefined } from "./native-predicates.ts";

const actionNames = new Map([
  ["NO_ACTION", "NO ACTION"], ["RESTRICT", "RESTRICT"], ["SET_NULL", "SET NULL"],
  ["SET_DEFAULT", "SET DEFAULT"], ["CASCADE", "CASCADE"],
]);
const actionFields = [["on_update", "ON UPDATE"], ["on_delete", "ON DELETE"]] as const;
const FOREIGN_PATH_SEGMENTS = 4;
const ACTION_PATH_SEGMENTS = 1;

interface TableColumns {
  columns: ReadonlySet<string>;
  name: string;
}

interface ColumnReference {
  column: string;
  table: string;
}

const referencedColumn = (expression: Expression, tables: ReadonlyMap<string, TableColumns>): ColumnReference => {
  const parts = path(expression);
  const [kind, name, field, column] = parts;
  if (parts.length !== FOREIGN_PATH_SEGMENTS || kind !== "table" || field !== "column" || matchesUndefined(name) || matchesUndefined(column)) {
    return fail(expression, "Expected table.<name>.column.<name> reference.");
  }
  const target = tables.get(name);
  if (matchesUndefined(target) || !target.columns.has(column)) {
    return fail(expression, "Foreign key references an undeclared table or column.");
  }
  return { column, table: target.name };
};

const validateReferences = (block: Block, references: ColumnReference[], count: number): string => {
  const [first] = references;
  if (references.length !== count || matchesUndefined(first) ||
    references.some(({ table }) => table !== first.table) ||
    new Set(references.map(({ column }) => column)).size !== references.length) {
    return fail(block, "Foreign key columns must match a nonempty, unique column list in one target table.");
  }
  return first.table;
};

const actionSql = (block: Block, [name, sql]: typeof actionFields[number]): string => {
  if (!block.body.attributes[name]) {return "";}
  const expression = attribute(block.body, name);
  const parts = path(expression);
  const [method] = parts;
  const action = parts.length === ACTION_PATH_SEGMENTS && !matchesUndefined(method) ? actionNames.get(method) : undefined;
  if (matchesUndefined(action)) {
    return fail(expression, `Unsupported foreign-key action ${parts.join(".")}.`);
  }
  return ` ${sql} ${action}`;
};

export const foreignKey = (
  block: Block, table: TableColumns, tables: ReadonlyMap<string, TableColumns>,
): string => {
  const name = label(block);
  shape(block.body, ["columns", "ref_columns", "on_update", "on_delete"], []);
  const columns = columnList(attribute(block.body, "columns"), table.columns);
  const references = tuple(attribute(block.body, "ref_columns")).map((expression) =>
    referencedColumn(expression, tables));
  const target = validateReferences(block, references, columns.length);
  const localNames = columns.map((column) => identifier(column)).join(", ");
  const remoteNames = references.map(({ column }) => identifier(column)).join(", ");
  const actions = actionFields.map((action) => actionSql(block, action)).join("");
  return `CONSTRAINT ${identifier(name)} FOREIGN KEY (${localNames}) REFERENCES ${identifier(target)} (${remoteNames})${actions}`;
};
