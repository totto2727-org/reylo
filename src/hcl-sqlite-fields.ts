import { staticString, staticTraversal } from "./hclsyntax/types.ts";
import type { Block, Body, Expression, Range } from "./hclsyntax/types.ts";
import {
  isEmptyArray, isEmptyString, matchesBoolean, matchesNull, matchesNumber, matchesString,
  matchesUndefined,
} from "./native-predicates.ts";

const sqliteTypes = new Set(["integer", "int", "int2", "int8", "tinyint", "smallint", "mediumint", "bigint", "unsigned big int", "text", "clob", "blob", "real", "double", "double precision", "float", "numeric", "decimal", "boolean", "bool", "date", "datetime", "json", "varchar", "character", "char", "nchar", "nvarchar", "native character", "varying character"]);
const SINGLE_LABEL = 1;
const NULL_SIZE = 0;
const TYPES_WITHOUT_SIZE = 0;
const MAXIMUM_SIZES = 2;
const COLUMN_PATH_SEGMENTS = 2;
const NO_LABELS = 0;

export const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoted = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const fail: (node: {range: Range}, message: string) => never = (node, message) => {
  const { filename, start } = node.range;
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native Error thrown by the synchronous HCL compiler.
  throw new Error(`${filename}:${start.line}:${start.column}: ${message}`);
};

export const shape = (body: Body, attributes: Readonly<string[]>, blocks: Readonly<string[]>): void => {
  Object.values(body.attributes).forEach((field) => {
    if (!attributes.includes(field.name)) {fail(field, `Unsupported Atlas SQLite attribute ${field.name}.`);}
  });
  body.blocks.forEach((block) => {
    if (!blocks.includes(block.type)) {fail(block, `Unsupported Atlas SQLite block ${block.type}.`);}
  });
};

const invalidLabels = (block: Block, count: number): never =>
  fail(block, `${block.type} requires ${count} nonempty label${count === SINGLE_LABEL ? "" : "s"}.`);

export const label = (block: Block): string => {
  const [name] = block.labels;
  if (block.labels.length !== SINGLE_LABEL || matchesUndefined(name) || isEmptyString(name) || name.includes("\0")) {
    return invalidLabels(block, SINGLE_LABEL);
  }
  return name;
};

export const requireNoLabels = (block: Block): void => {
  if (block.labels.length !== NO_LABELS) {invalidLabels(block, NO_LABELS);}
};

export const attribute = (body: Body, name: string): Expression => {
  const field = body.attributes[name];
  if (matchesUndefined(field)) {return fail(body, `Missing Atlas SQLite attribute ${name}.`);}
  return field.expression;
};

export const string = (expression: Expression): string => {
  const value = staticString(expression);
  if (matchesUndefined(value)) {return fail(expression, "Expected a static HCL string.");}
  return value;
};

export const boolean = (expression: Expression): boolean => {
  if (expression.kind === "literal" && matchesBoolean(expression.value)) {return expression.value;}
  return fail(expression, "Expected a literal HCL boolean.");
};

export const path = (expression: Expression): string[] => {
  const parts = staticTraversal(expression);
  if (parts?.every((part) => matchesString(part)) === true) {return [...parts];}
  return fail(expression, "Expected a static HCL reference.");
};

export const tuple = (expression: Expression): Expression[] => {
  if (expression.kind === "tuple") {return expression.expressions;}
  return fail(expression, "Expected an HCL tuple of column references.");
};

export const localColumn = (expression: Expression, columns: ReadonlySet<string>): string => {
  const parts = path(expression);
  const [kind, name] = parts;
  if (parts.length !== COLUMN_PATH_SEGMENTS || kind !== "column" || matchesUndefined(name) || !columns.has(name)) {
    return fail(expression, "Expected a reference to a declared column in this table.");
  }
  return name;
};

export const columnList = (expression: Expression, columns: ReadonlySet<string>): string[] => {
  const result = tuple(expression).map((item) => localColumn(item, columns));
  if (isEmptyArray(result) || new Set(result).size !== result.length) {
    fail(expression, "Column lists must be nonempty and contain no duplicates.");
  }
  return result;
};

const sqlCall = (expression: Expression): string | undefined => {
  const ONLY_SQL_ARGUMENT = 1;
  if (expression.kind !== "call") {return undefined;}
  const [argument] = expression.args;
  if (expression.name !== "sql" || expression.args.length !== ONLY_SQL_ARGUMENT || matchesUndefined(argument) || expression.expandFinal) {
    fail(expression, 'Only sql("static SQL expression") is supported in this Atlas SQLite field.');
  }
  return string(argument);
};

const literalDefault = (expression: Expression): string | undefined => {
  if (expression.kind !== "literal") {return undefined;}
  if (matchesNull(expression.value)) {return "NULL";}
  if (matchesBoolean(expression.value)) {return expression.value ? "1" : "0";}
  if (matchesNumber(expression.value)) {return expression.numberText ?? String(expression.value);}
  return undefined;
};

const negativeDefault = (expression: Expression): string | undefined => {
  if (expression.kind === "unary" && expression.operator === "-" && expression.operand.kind === "literal" && matchesNumber(expression.operand.value)) {
    return expression.operator + (expression.operand.numberText ?? String(expression.operand.value));
  }
  return undefined;
};

export const defaultValue = (expression: Expression): string => {
  const raw = sqlCall(expression);
  if (!matchesUndefined(raw)) {return `(${raw})`;}
  const literalString = staticString(expression);
  if (!matchesUndefined(literalString)) {return quoted(literalString);}
  return literalDefault(expression) ?? negativeDefault(expression) ??
    fail(expression, 'Unsupported Atlas SQLite default; use a literal or explicit sql("...").');
};

const size = (argument: Expression): number => {
  if (argument.kind !== "literal" || !matchesNumber(argument.value) || !Number.isSafeInteger(argument.value) || argument.value < NULL_SIZE) {
    return fail(argument, "SQLite type sizes must be nonnegative integer literals.");
  }
  return argument.value;
};

// Atlas uses constructor calls for sized SQLite types, for example varchar(255).
const sizedType = (expression: Expression): string | undefined => {
  if (expression.kind === "call" && !expression.expandFinal && sqliteTypes.has(expression.name.toLowerCase()) &&
      expression.args.length > TYPES_WITHOUT_SIZE && expression.args.length <= MAXIMUM_SIZES) {
    const sizes = expression.args.map((argument) => size(argument));
    return `${expression.name}(${sizes.join(", ")})`;
  }
  return undefined;
};

export const columnType = (expression: Expression): string => {
  const TYPE_PATH_SEGMENTS = 1;
  if (expression.kind === "call" && expression.name === "sql") {
    fail(expression, "Raw SQL column types are not supported; use an Atlas SQLite type identifier.");
  }
  const reference = staticTraversal(expression);
  const [name] = reference ?? [];
  if (reference?.length === TYPE_PATH_SEGMENTS && matchesString(name) && sqliteTypes.has(name.toLowerCase())) {return name;}
  return sizedType(expression) ?? fail(expression, "Unsupported Atlas SQLite column type.");
};
