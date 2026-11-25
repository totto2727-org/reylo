// What a statement's module declares, read off its analysis: the diagnostics the type check places
// In the `.sql` file, the Params and Row types and the row count. The content mapper (src/mapper.ts)
// Writes these into the module it hands TypeScript; the docs site's playground shows them as they
// Are. It imports nothing from Node, so a browser can run it beside the engine.
import type { Analysis, Dialect, Lexed } from "./engine-core.ts";
import { docComment } from "./doc-comment.ts";
import { declaredType, ident, lastOfEachName, orNull, renderParamType, renderType } from "./render.ts";
import { hasObjectType, isEmptyArray, isEmptyString, matchesNull, matchesNullish, matchesUndefined } from "./native-predicates.ts";
import { fileDiagnostics, invalidAnalysis, statementParameters } from "./module-diagnostics.ts";
import type { FileDiagnostic } from "./module-diagnostics.ts";

export { withinFile } from "./module-diagnostics.ts";
export type { FileDiagnostic } from "./module-diagnostics.ts";

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve assignability of the published module type record.
export type ModuleTypes = {
  diagnostics: FileDiagnostic[];
  /** `{ id: number }`, `Record<never, never>` for none, or `unknown` where the statement failed. */
  params: string;
  /** `{ id: number; name: string }` (a field per line, after its doc comment, where a column's comment documents one), `never` for no columns, or `unknown` where the statement failed. */
  row: string;
  cardinality: Analysis["cardinality"];
  /** The parameters' names in order of first use: the module's `params` at run time. */
  names: string[];
  /** The type of the error `.try()` gives: the module's `QueryError`. */
  queryError: string;
};

const ERROR_TYPE_NAMES: Record<Dialect, string> = {
  duckdb: "DuckdbQueryError",
  mysql: "MysqlQueryError",
  postgres: "PostgresQueryError",
  sqlite: "SqliteQueryError",
};

type QueryErrorFields = Record<string, string[]>;
const typeNames = (field: string, names: string[]): string => names.map((name) =>
  field === "columns" ? `readonly [${name.split(", ").map((part) => JSON.stringify(part)).join(", ")}]` : JSON.stringify(name),
).join(" | ");

const errorFields = (code: string, fields: QueryErrorFields): string => {
  const declared = Object.entries(fields).map(([field, names]) => `${field}: ${typeNames(field, names)}`).join("; ");
  return `  ${JSON.stringify(code)}: { ${declared} };`;
};

const broadErrorType = (dialect: Dialect): string => `import("@totto2727/reylo").QueryError<${JSON.stringify(dialect)}>`;

/**
 * The type of the error `.try()` gives for a statement: where it runs only its database's own
 * code, narrowed to the names each code's fields may hold (upstream engine/core/src/errors.rs), a SQLite
 * unique key's columns written as SQLite's message lists them, `a, b`; the dialect's whole error
 * type otherwise.
 * @param {Dialect} dialect - The database dialect.
 * @param {Analysis["errors"]} errors - The codes and fields from the analysis.
 * @returns {string} The TypeScript type for a query error.
 */
export const queryErrorType = function queryErrorType(dialect: Dialect, errors: Analysis["errors"]): string {
  if (matchesNullish(errors)) {return broadErrorType(dialect);}
  const name = ERROR_TYPE_NAMES[dialect];
  const codes = Object.entries(errors).map(([code, fields]) => errorFields(code, fields));
  return isEmptyArray(codes) ? `import("@totto2727/reylo").${name}<{}>` : `import("@totto2727/reylo").${name}<{\n${codes.join("\n")}\n}>`;
};

/**
 * A parameter's TypeScript type: `unknown` when nothing in the statement types it (a CAST does), with `| null` where the statement lets the caller pass null.
 * @param {Analysis["params"][number]} parameter - The parameter from the analysis.
 * @param {string} rendered - The base TypeScript type.
 * @returns {string} The parameter type for the module.
 */
const paramType = function (parameter: Analysis["params"][number], rendered: string): string {
  if (parameter.type.kind === "unknown") {return "unknown";}
  return parameter.nullable ? orNull(rendered) : rendered;
};

/**
 * The module's import from `reylo`: `Query`, and `Json` where one of `types` names it. Comments,
 * string literal types and a key named `Json` are left out of the search, so that the module never
 * imports a name it does not use. Strings and comments are read in one pass, from the left, so a
 * comment's delimiter inside a quoted name (`"/*"`) starts no comment, nor a quote inside a comment
 * a string.
 * @param {...string} types - The TypeScript types in the module.
 * @returns {string} The TypeScript import declaration.
 */
export const reyloImport = function reyloImport(...types: string[]): string {
  const text = types.join("\n").replaceAll(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\//gu, (part) => (part.startsWith('"') ? '""' : ""));
  return `import type { ${/(?<![\w$])Json(?![\w$]|\s*\??:)/u.test(text) ? "Json, " : ""}Query } from "@totto2727/reylo";`;
};

/**
 * A column's comment as the doc comment of the field that reads it, for an editor's hover: on one
 * line where the comment has one, else a block of lines after `indent` (src/doc-comment.ts), and
 * nothing where there is none.
 * @param {string | undefined} comment - The column comment from the database.
 * @param {string} [indent] - The prefix for each comment line.
 * @returns {string} The JSDoc comment or an empty string.
 */
export const fieldComment = function fieldComment(comment: string | undefined, indent = ""): string {
  const text = (comment ?? "").replaceAll(/\r\n?/gu, "\n").replaceAll(/[ \t]+$/gmu, "").trim();
  if (isEmptyString(text)) {return "";}
  if (!text.includes("\n")) {return `/** ${text.replaceAll("*/", String.raw`*\/`)} */`;}
  return docComment(text, undefined, "", indent).trim();
};

const documentedField = (text: string, doc: string | undefined): string => {
  const leading = matchesUndefined(doc) || isEmptyString(doc) ? "" : `  ${doc}\n`;
  return `${leading}  ${text};`;
};

/**
 * An object type of `fields`, each a field's text and its column's comment: on one line, or a field
 * per line, each after its doc comment, where any has one. TypeScript reads a doc comment only where
 * a line starts with it.
 * @param {Array<Readonly<[string, string | undefined]>>} fields - Pairs of field text and column comments.
 * @returns {string} The TypeScript object type.
 */
const objectType = function (fields: (Readonly<[text: string, comment: string | undefined]>)[]): string {
  const docs = fields.map(([, comment]) => fieldComment(comment, "  "));
  if (!docs.some((doc) => !isEmptyString(doc))) {return `{ ${fields.map(([text]) => text).join("; ")} }`;}
  return `{\n${fields.map(([text], index) => documentedField(text, docs[index])).join("\n")}\n}`;
};

type Field = Readonly<[text: string, comment: string | undefined]>;

const columnField = (column: Analysis["columns"][number], dialect: Dialect): Field => {
  const name = ident(column.name);
  const { nullable } = column;
  const rendered = renderType(column.type, false, dialect);
  return [`${name}: ${nullable ? orNull(rendered) : rendered}`, column.comment];
};

const optionalParameter = (parameter: Analysis["params"][number]): boolean => {
  if (parameter.nullable) {return true;}
  const { schema } = parameter;
  return !matchesNull(schema) && hasObjectType(schema) && "default" in schema;
};

const paramFields = (params: Analysis["params"], dialect: Dialect): Field[] => {
  const typed = params.map((parameter) => {
    const { name } = parameter;
    const rendered = declaredType(parameter.type, parameter.schema) ?? renderParamType(parameter.type, dialect);
    const type = paramType(parameter, rendered);
    return { comment: parameter.comment, name, type };
  });
  const optional = new Set(params.filter((parameter) => optionalParameter(parameter)).map(({ name }) => name));
  return typed.map(({ name, type, comment }) => [`${ident(name)}${optional.has(name) ? "?" : ""}: ${type}`, comment]);
};

interface ModuleSource { cardinality: Analysis["cardinality"]; diagnostics: FileDiagnostic[]; names: string[] }

const assembledTypes = (
  { cardinality, diagnostics, names }: ModuleSource, { params, row }: { params: string; row: string }, queryError: string,
): ModuleTypes =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public module type record's established JSON field order.
  ({ diagnostics, params, row, cardinality, names, queryError });

/**
 * The module's types for a statement the engine analyzed. `lexed` is the engine's lexer's reading of
 * the statement, which names the parameters (absent where the lexer refused it); `strictParams` is
 * the project file's `strict_params`, and `projectFile` the file the error about it names: the
 * project's own file, which may be `.reylo.yml` or another path REYLO_CONFIG names.
 * @param {string} sql - The SQL file's source.
 * @param {Analysis} analysis - The engine's result for the statement.
 * @param {Dialect} dialect - The database dialect.
 * @param {Pick<Lexed, "params" | "placeholders"> | undefined} lexed - The parameter names and ranges from the lexer.
 * @param {boolean} strictParams - Whether an untyped parameter is an error.
 * @param {string} [projectFile] - The file name in the diagnostic.
 * @returns {ModuleTypes} The types and diagnostics for the query module.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the content mapper's published positional arguments.
export const moduleTypes = function moduleTypes(sql: string, analysis: Analysis, dialect: Dialect, lexed: Pick<Lexed, "params" | "placeholders"> | undefined, strictParams: boolean, projectFile = ".reylo.yaml"): ModuleTypes {
  const { names, placeholders } = statementParameters(analysis, dialect, lexed);
  const diagnostics = fileDiagnostics(analysis, placeholders, { projectFile, sql, strictParams });
  const source = { cardinality: analysis.cardinality, diagnostics, names };
  if (invalidAnalysis(analysis, dialect)) {
    return assembledTypes(source, { params: "unknown", row: "unknown" }, broadErrorType(dialect));
  }
  const columns = lastOfEachName(analysis.columns).map((column) => columnField(column, dialect));
  const fields = paramFields(analysis.params, dialect);
  return assembledTypes(source, {
    params: isEmptyArray(fields) ? "Record<never, never>" : objectType(fields),
    row: isEmptyArray(columns) ? "never" : objectType(columns),
  }, queryErrorType(dialect, analysis.errors));
};
