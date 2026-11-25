// What every build step emits for a `.sql` file: a module that carries everything the query needs
// At run time (the dialect, the statement as the engine rewrote it for the database, the binding
// Order, each parameter's type, the row count the analysis proved), so that the running code reads no file and asks no
// Database. The analysis comes from `src/analyze.ts`: `.reylo/` when it holds the statement for the
// Current schema, else the database. A build that has neither fails, because a module built
// Without the analysis would not do what its types say.
// oxlint-disable-next-line rules/no-node-imports -- The bundler loader checks watched paths through the host filesystem.
import { stat } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to resolve paths using the host platform's filesystem conventions.
import nodePath from "node:path";
import { Session } from "./analyze.ts";
import type { Outcome } from "./analyze.ts";
import type { Analysis, Dialect } from "./engine-core.ts";
import { nativeErrorText } from "./native-error-text.ts";
import { matchesUndefined } from "./native-predicates.ts";
import { sourceName } from "./project.ts";
import { querySchemas } from "./schema.ts";
import { arrayDelimiter, columnKind } from "./values.ts";

export interface SqlModule {
  code: string;
  /** The `.reylo/` entry the module was built from. A bundler watches it, so that the module is built again when the type check analyzes the statement anew (after a migration). */
  entry: string;
  /** The project file and the `.env` files that exist: the module's text depends on them too (`sqlcommenter`, the URL), so a bundler watches them as well. */
  watched: string[];
}

const START_OF_TEXT = 0;
const LEXER_FAILED = 1;
const MIXED_PARAMETERS = 2;
const REPEATED_PARAMETER = 3;
const DATABASE_REFUSED = 6;
const INVALID_COLUMN_DESCRIPTOR = 20;
const INSERT_DESCRIPTOR_MISMATCH = 21;

/**
 * The JavaScript offset into `text` of a UTF-8 byte offset.
 * @param {string} text - The source text.
 * @param {number} bytes - The UTF-8 offset into the source text.
 * @returns {number} The JavaScript offset in UTF-16 code units.
 */
const utf16 = function utf16(text: string, bytes: number): number {
  return Buffer.from(text, "utf8").subarray(START_OF_TEXT, bytes).toString("utf8").length;
};

/**
 * The line and column, from 1, of a UTF-8 byte offset into `text`.
 * @param {string} text - The SQL source text.
 * @param {number} bytes - The UTF-8 offset into the SQL source text.
 * @returns {string} The line and column separated by a colon.
 */
const place = function place(text: string, bytes: number): string {
  const before = text.slice(START_OF_TEXT, utf16(text, bytes));
  return `${before.split("\n").length}:${before.length - before.lastIndexOf("\n")}`;
};

const buildError = (location: string, message: string, options?: ErrorOptions): Error =>
  // oxlint-disable-next-line rules/require-tagged-error -- Vite and the other build hosts receive a native Error without loading Effect.
  new Error(`${location}: ${message}`, options);

const readAnalysis = async (session: Session, sql: string): Promise<Outcome> => {
  const first = await session.analyze(sql);
  // A statement the database refuses may have been analyzed against a schema read a few seconds
  // Before a migration (a session reads it again at most every 5 seconds, and SQLite's analysis
  // Replays it): it is analyzed again when the schema has changed since.
  if (first.ok && first.analysis.diagnostics.some((diagnostic) => diagnostic.code === DATABASE_REFUSED) && (await session.recheck())) {
    return session.analyze(sql);
  }
  return first;
};

const readParameters = async (session: Session, { path, sql }: { path: string; sql: string }, analysis: Analysis): Promise<string[]> => {
  // A statement whose placeholders break a rule fails the build: one the engine could not read
  // (1), named and positional mixed (2), or a parameter written more than once (3), since each
  // Parameter appears once so that one place types it.
  const unread = analysis.diagnostics.find((diagnostic) => diagnostic.code === LEXER_FAILED || diagnostic.code === MIXED_PARAMETERS || diagnostic.code === REPEATED_PARAMETER);
  if (unread) {throw buildError(path, unread.message);}
  if (session.project.dialect === "mysql") {
    // A MySQL session reads its strings by its sql_mode, which the analysis asked for: its
    // Placeholders are the ones the server finds.
    return analysis.params.map((parameter) => parameter.name);
  }
  try {
    const { params } = await session.lex(sql);
    return params;
  } catch (error) {
    throw buildError(path, nativeErrorText(error, "message"), { cause: error });
  }
};

const checkDatabaseDiagnostics = (path: string, sql: string, analysis: Analysis): void => {
  // A column list that does not read, or that disagrees with the table its insert writes, fails
  // The build too.
  const descriptor = analysis.diagnostics.find((diagnostic) => diagnostic.code === INVALID_COLUMN_DESCRIPTOR || diagnostic.code === INSERT_DESCRIPTOR_MISMATCH);
  if (descriptor) {throw buildError(path, descriptor.message);}
  // So does a statement the database refuses (6: a misspelled column, a dropped table), at its line
  // And column, as the type check reports it: its module would run a statement nothing typed, with
  // No columns and any number of rows.
  const refused = analysis.diagnostics.find((diagnostic) => diagnostic.code === DATABASE_REFUSED);
  if (refused) {throw buildError(`${path}:${place(sql, refused.start)}`, refused.message);}
};

const watchedPaths = async (files: string[]): Promise<string[]> => {
  const found = await Promise.allSettled(files.map(async (file) => {
    await stat(file);
    return file;
  }));
  return found.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
};

const emitCode = ({ analysis, dialect, params, path, sql, sqlcommenter }: {
  analysis: Analysis;
  dialect: Dialect;
  params: string[];
  path: string;
  sql: string;
  sqlcommenter: boolean;
}): string => {
  // Each parameter's type, for the drivers that bind an array or a JSON value wrong, and whether it
  // Takes null, which the run time refuses for one that does not (src/execute.ts).
  const inputs = Object.fromEntries(analysis.params.map((parameter) => [parameter.name, { type: parameter.type, ...(matchesUndefined(parameter.schema) ? {} : { schema: parameter.schema }), ...(matchesUndefined(parameter.cast) ? {} : { cast: parameter.cast }), nullable: parameter.nullable }]));
  // Each output column's name and kind, from the table the declared types come from: what the run
  // Time gives each value (src/values.ts); and an array's delimiter where it is not a comma.
  const columns = analysis.columns.map((column) => {
    const kind = columnKind(column.type, dialect);
    const delimiter = arrayDelimiter(column.type);
    return matchesUndefined(delimiter) ? [column.name, kind] : [column.name, kind, delimiter];
  });
  const source = sourceName(path);
  // The compiled statement without the file's trailing blank lines; the comment naming the file
  // Is added where the statement is sent (src/execute.ts, `sentText`).
  const text = analysis.rewritten.sql.trimEnd();
  // A structured parameter's lists, at JavaScript's offsets into the statement (the engine's are
  // UTF-8 bytes).
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the field order in the emitted module's serialized rewrite plan.
  const structured = (analysis.structured ?? []).map(({ name, lists }) => ({ name, lists: lists.map(({ start, end, entries }) => ({ start: utf16(text, start), end: utf16(text, end), entries })) }));
  // A typed JSON, structured or cast parameter is checked with reylo's `checks`, imported only where
  // The statement has one, so that an app none of whose statements has one bundles none of them
  // (src/checks.ts). A non-null JSON parameter whose type alone carries a schema needs them too,
  // To learn whether that schema allows null.
  const checked = analysis.params.some((parameter) => !matchesUndefined(parameter.schema) || !matchesUndefined(parameter.cast) || parameter.type.kind === "rows" || (parameter.type.kind === "json" && !matchesUndefined(parameter.type.schema) && !parameter.nullable));
  return [
    `import { defineQuery${checked ? ", checks" : ""} } from "@totto2727/reylo";`,
    // `sql` is the compiled statement and `raw` the file as written; the definition's own `sql` is
    // The statement as written and its `text` the compiled one. The comment naming the file
    // (src/sqlcommenter.ts) is added where the statement is sent, so `sql` leaves it out.
    `export const sql = ${JSON.stringify(text)};`,
    `export const raw = ${JSON.stringify(sql)};`,
    `export const params = ${JSON.stringify(params)};`,
    `export default defineQuery({ dialect: ${JSON.stringify(dialect)}, sql: raw, params, cardinality: ${JSON.stringify(analysis.cardinality)}, text: sql, order: ${JSON.stringify(analysis.rewritten.order)}, inputs: ${JSON.stringify(inputs)}, columns: ${JSON.stringify(columns)}${structured.length ? `, structured: ${JSON.stringify(structured)}` : ""}${analysis.fresh ? `, fresh: ${JSON.stringify(analysis.fresh)}` : ""}, source: ${JSON.stringify(source)}${sqlcommenter ? ", sqlcommenter: true" : ""}, jsonSchema: ${JSON.stringify(querySchemas(analysis, dialect))}${checked ? ", checks" : ""} });`,
    ``,
  ].join("\n");
};

export const sqlModule = async function sqlModule(path: string, sql: string): Promise<SqlModule> {
  const session = await Session.for(nodePath.dirname(path));
  const outcome = await readAnalysis(session, sql);
  if (!outcome.ok) {throw buildError(path, outcome.message);}
  const { analysis } = outcome;
  const params = await readParameters(session, { path, sql }, analysis);
  checkDatabaseDiagnostics(path, sql, analysis);
  const { dialect, sqlcommenter, watched } = session.project;
  const code = emitCode({ analysis, dialect, params, path, sql, sqlcommenter });
  return { code, entry: outcome.entry, watched: await watchedPaths(watched) };
};
