// What a statement's module declares, read off its analysis: the diagnostics the type check places
// In the `.sql` file, the Params and Row types and the row count. The content mapper (src/mapper.ts)
// Writes these into the module it hands TypeScript; the docs site's playground shows them as they
// Are. It imports nothing from Node, so a browser can run it beside the engine.
import type { Analysis, Dialect, Lexed } from "./engine.ts";
import { docComment } from "./doc-comment.ts";
import { declaredType, ident, lastOfEachName, orNull, renderParamType, renderType } from "./render.ts";
import { hasObjectType, matchesNull } from "./native-predicates.ts";

/** A diagnostic of the `.sql` file: its range in UTF-8 bytes, the encoding the content mapper chose. */
export type FileDiagnostic = { message: string; start: number; length: number; code: number };

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
  if (!errors) {return `import("@totto2727/reylo").QueryError<${JSON.stringify(dialect)}>`;}
  const name = { postgres: "PostgresQueryError", mysql: "MysqlQueryError", sqlite: "SqliteQueryError", duckdb: "DuckdbQueryError" }[dialect];
  const names = (field: string, list: string[]): string => list.map((fieldValue) => (field === "columns" ? `readonly [${fieldValue.split(", ").map((part) => JSON.stringify(part)).join(", ")}]` : JSON.stringify(fieldValue))).join(" | ");
  const codes = Object.entries(errors).map(([code, fields]) => `  ${JSON.stringify(code)}: { ${Object.entries(fields).map(([field, list]) => `${field}: ${names(field, list)}`).join("; ")} };`);
  return codes.length ? `import("@totto2727/reylo").${name}<{\n${codes.join("\n")}\n}>` : `import("@totto2727/reylo").${name}<{}>`;
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
  if (!text) {return "";}
  if (!text.includes("\n")) {return `/** ${text.replaceAll("*/", String.raw`*\/`)} */`;}
  return docComment(text, undefined, "", indent).trim();
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
  if (!docs.some(Boolean)) {return `{ ${fields.map(([text]) => text).join("; ")} }`;}
  return `{\n${fields.map(([text], index) => `${docs[index] ? `  ${docs[index]}\n` : ""}  ${text};`).join("\n")}\n}`;
};

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const FIRST_UTF8_BYTE = 0;
const SINGLE_BYTE_RANGE = 1;
const UNTYPED_PARAMETER = 12;
const INVALID_STATEMENT = 6;

/**
 * A diagnostic's range kept inside a text of `size` UTF-8 bytes. TypeScript refuses a content
 * mapper's whole transform when a diagnostic runs past the end of the file ("returned an invalid
 * transform response"), and the module becomes `any`; a range that does is cut at the end.
 * @param {number} start - The UTF-8 byte offset.
 * @param {number} length - The range length in bytes.
 * @param {number} size - The file size in bytes.
 * @returns {{ start: number, length: number }} The range inside the file.
 */
export const withinFile = function withinFile(start: number, length: number, size: number): { start: number; length: number } {
  const from = Math.max(FIRST_UTF8_BYTE, Math.min(start, size));
  return { start: from, length: Math.max(FIRST_UTF8_BYTE, Math.min(length, size - from)) };
};

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
export const moduleTypes = function moduleTypes(sql: string, analysis: Analysis, dialect: Dialect, lexed: Pick<Lexed, "params" | "placeholders"> | undefined, strictParams: boolean, projectFile = ".reylo.yaml"): ModuleTypes {
  // A MySQL session reads its strings by its sql_mode, which the analysis asked for and the
  // Lexer alone does not know: the placeholders are the ones the analysis read.
  const mysql = dialect === "mysql";
  const names = mysql ? analysis.params.map((parameter) => parameter.name) : (lexed?.params ?? []);
  const placeholders = mysql
    ? analysis.rewritten.spans.map(([start, end], index) => ({ name: analysis.rewritten.order[index], start, end }))
    : (lexed?.placeholders ?? []);
  const diagnostics: FileDiagnostic[] = analysis.diagnostics.map((diagnostic) => ({ message: diagnostic.message, start: diagnostic.start, length: diagnostic.length, code: diagnostic.code }));
  // A parameter nothing in the statement types is an error at its first use, unless the project
  // File says `strict_params: false` (the default is true since 2026-10-20). A statement the engine
  // Already refused (a parameter written twice, an error from the server) was not analysed to its
  // End, so its parameters are untyped for that reason: its own error is the one to fix first.
  if (strictParams && !analysis.diagnostics.length) {
    const bytes = utf8.encode(sql);
    Iterator.from(analysis.params).forEach((parameter) => {
      if (parameter.type.kind !== "unknown") {return;}
      const at = placeholders.find((placeholder) => placeholder.name === parameter.name);
      // The engine's offsets are UTF-8 bytes, as the diagnostics' are. A MySQL placeholder's span
      // Takes in the `::type` the engine rewrote, which is no part of its name.
      const span = at ? fromUtf8.decode(bytes.subarray(at.start, at.end)) : `:${parameter.name}`;
      const written = span.replace(/\s*::[\s\S]*$/u, "");
      const length = at ? utf8.encode(written).length : SINGLE_BYTE_RANGE;
      const message = `Nothing in the statement gives the parameter ${written} a type; cast it, as in ${written}::text, or set strict_params: false in ${projectFile}.`;
      diagnostics.push({ message, start: at?.start ?? FIRST_UTF8_BYTE, length, code: UNTYPED_PARAMETER });
    });
  }
  const {cardinality} = analysis;
  if (analysis.diagnostics.some((diagnostic) => diagnostic.code === INVALID_STATEMENT) || (dialect === "postgres" && analysis.kind === "")) {return { diagnostics, params: "unknown", row: "unknown", cardinality, names, queryError: queryErrorType(dialect, undefined) };}
  const columns = lastOfEachName(analysis.columns).map((column) => [`${ident(column.name)}: ${column.nullable ? orNull(renderType(column.type, false, dialect)) : renderType(column.type, false, dialect)}`, column.comment] as const);
  // A parameter is typed from its context (a column it is compared with or written to, a CAST);
  // One no context types is `unknown`.
  const typed = analysis.params.map((parameter) => [parameter.name, paramType(parameter, declaredType(parameter.type, parameter.schema) ?? renderParamType(parameter.type, dialect)), parameter.comment] as const);
  // A parameter that takes null may be left out, which binds NULL; so may a typed JSON parameter
  // Whose schema has a `default` (wiki/typed-json-params.md).
  const optional = new Set(analysis.params.filter((parameter) => parameter.nullable || (!matchesNull(parameter.schema) && hasObjectType(parameter.schema) && "default" in parameter.schema)).map((parameter) => parameter.name));
  const paramTypes = typed.map(([name, type, comment]) => [`${ident(name)}${optional.has(name) ? "?" : ""}: ${type}`, comment] as const);
  return {
    diagnostics,
    params: paramTypes.length ? objectType(paramTypes) : "Record<never, never>",
    row: columns.length ? objectType(columns) : "never",
    cardinality,
    names,
    queryError: queryErrorType(dialect, analysis.errors),
  };
};
