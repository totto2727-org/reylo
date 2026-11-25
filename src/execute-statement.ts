import type { EngineType } from "./engine-type.ts";
import { JSON_NULL, NATIVE_NULL, checkBinary, checkParams, checkTime, encode, indexedElements, isJsonValue, jsonText, parameterName } from "./execute-parameters.ts";
import { postgresText } from "./execute-postgres.ts";
import type { ParamsInput, QueryModule } from "./execute-types.ts";
import { lexPlaceholders } from "./lex.ts";
import { hasObjectType, matchesNull, matchesNullish, matchesString, matchesUndefined } from "./native-predicates.ts";
import { withSqlcommenter } from "./sqlcommenter.ts";
import { ParameterError } from "./values.ts";

/**
 * `text` as Reylo sends it: with the comment naming the query's file, where the module asks for one (src/sqlcommenter.ts).
 *
 * @param {QueryModule} query - The query module that controls the SQL comment.
 * @param {string} text - The statement after placeholder compilation.
 * @returns {string} The statement with the source comment when requested and available.
 */
export const sentText = function sentText(query: QueryModule, text: string): string {
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- Keep the native optional path check and its short-circuit evaluation before writing the source comment.
  return query.sqlcommenter === true && query.source?.length ? withSqlcommenter(text, query.source) : text;
};

/**
 * The checks a parameter needs (src/checks.ts): every build step passes them where its statement has such a parameter.
 *
 * @param {QueryModule} query - The query module that supplies the runtime checks.
 * @param {string} name - The name used in the diagnostic if the checks are missing.
 * @returns {NonNullable<QueryModule["checks"]>} The module's runtime checks.
 */
const checksFor = function checksFor(query: QueryModule, name: string): NonNullable<QueryModule["checks"]> {
  if (query.checks) {return query.checks;}
  throw new ParameterError(`Parameter "${name}" is a typed JSON, structured or cast parameter, which the run time checks with Reylo's checks; a query defined by hand passes them: defineQuery({ …, checks }) with checks from "@totto2727/reylo".`);
};

/**
 * Where an array, or an array inside it (a multidimensional one), holds null or undefined: `[2]`, `[1][0]`.
 *
 * @param {Readonly<unknown[]>} array - The array to inspect, including its nested arrays.
 * @param {string} path - The index path of the parent array.
 * @returns {string | undefined} The first null or undefined element's index path, or undefined.
 */
const nullElement = function nullElement(array: Readonly<unknown[]>, path = ""): string | undefined {
  return Iterator.from(indexedElements(array))
    .map(([index, element]): string | undefined => {
      const location = `${path}[${index}]`;
      if (matchesNullish(element)) {return location;}
      return Array.isArray(element) ? nullElement(element, location) : undefined;
    })
    .find((candidate) => matchesString(candidate));
};

/**
 * Whether a parameter the statement takes no null for is declared with a type that takes no null: for a JSON one, whether the schema its type carries refuses JSON's null too.
 *
 * @param {QueryModule} query - The query module that provides JSON Schema validation.
 * @param {EngineType | undefined} type - The engine type of the parameter, if available.
 * @returns {boolean} True if the type cannot represent the supplied null.
 */
const refusesNull = function refusesNull(query: QueryModule, type: EngineType | undefined): boolean {
  if (matchesUndefined(type) || type.kind === "unknown") {return false;}
  if (type.kind !== "json") {return true;}
  return !matchesUndefined(type.schema) && !matchesUndefined(query.checks) && !matchesUndefined(query.checks.validate(type.schema, NATIVE_NULL));
};

/**
 * A parameter the statement takes no null for, given null or left out.
 *
 * @param {string} name - The parameter name shown in the diagnostic.
 * @param {unknown} parameterValue - The null or missing value that caused the error.
 */
const refuseNull = function refuseNull(name: string, parameterValue: unknown): never {
  throw new ParameterError(`Parameter "${name}" ${matchesUndefined(parameterValue) ? "is missing" : "is null"}, and the statement takes no null for it: pass a value.`);
};

const value = function value(params: Record<string, unknown>, name: string): unknown {
  const suppliedValue = params[name];
  return matchesUndefined(suppliedValue) ? NATIVE_NULL : suppliedValue;
};

const MISSING_PARAMETER = -1;
const FIRST_NUMBERED_PARAMETER = 1;

const indexOf = function indexOf(query: QueryModule, placeholder: { name: string; start: number; end: number }): number {
  const index = query.params.indexOf(placeholder.name);
  // A hand-built query whose `params` misses a placeholder would bind `$0`.
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native error for a hand-built module whose binding list is incomplete.
  if (index === MISSING_PARAMETER) {throw new Error(`The statement's placeholder ${query.sql.slice(placeholder.start, placeholder.end)} is parameter "${placeholder.name}", which the query's params (${JSON.stringify(query.params)}) do not list.`);}
  return index;
};

interface CompiledStatement {
  order: Readonly<string[]>;
  text: string;
}

const compiledStatement = (text: string, order: Readonly<string[]>): CompiledStatement =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the compiled statement's observable text and binding order keys.
  ({ text, order });

/**
 * The statement as Reylo sends it to the database, and the parameter each placeholder binds: the
 * engine's compiled text where a build step wrote one into the module. Without it (a query
 * defined by hand) the run time lexes the placeholders itself (`lex.ts`); the engine's lexer is
 * the authoritative one, and the two agree on every statement the fallback is meant for.
 * Postgres numbers each distinct parameter once; MySQL has only `?`, and better-sqlite3 reads
 * SQLite's `?NNN` as a named parameter, so both get one `?` per placeholder and a repeated name is
 * repeated in the binding order.
 *
 * @param {QueryModule} query - The module with either raw SQL or a compiled statement.
 * @returns {{ text: string, order: Readonly<string[]> }} The statement and the parameter names in binding order.
 */
export const compile = function compile(query: QueryModule): CompiledStatement {
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- Keep the cached plan's short-circuit lookup and compile raw SQL when cached text is empty.
  if (query.text?.length && query.order) {return compiledStatement(query.text, query.order);}
  const { placeholders } = lexPlaceholders(query.sql, query.dialect);
  // Postgres and DuckDB number each distinct parameter once.
  const numbered = query.dialect === "postgres" || query.dialect === "duckdb";
  const rewritten = { offset: 0, text: "" };
  const order: string[] = [];
  Iterator.from(placeholders).forEach((placeholder) => {
    const index = indexOf(query, placeholder);
    rewritten.text += query.sql.slice(rewritten.offset, placeholder.start) + (numbered ? `$${index + FIRST_NUMBERED_PARAMETER}` : "?");
    order.push(placeholder.name);
    rewritten.offset = placeholder.end;
  });
  return compiledStatement(rewritten.text + query.sql.slice(rewritten.offset), numbered ? query.params : order);
};

// The rows are bound positionally in every dialect. A value left out binds NULL, as pg,
// PGlite, better-sqlite3 and Bun.sql already do; postgres.js, mysql2, node:sqlite and libSQL
// Would reject it instead.
export interface BoundStatement {
  names: Readonly<string[]>;
  text: string;
  values: unknown[];
}

type InputMetadata = NonNullable<QueryModule["inputs"]>[string];
type QueryChecks = NonNullable<QueryModule["checks"]>;

interface JsonParameter {
  input: InputMetadata | undefined;
  name: string;
  schema: Exclude<InputMetadata["schema"], undefined>;
}

const validatedJson = (
  { name, schema }: JsonParameter,
  parameterValue: unknown,
  { validate, withDefaults }: Pick<QueryChecks, "validate" | "withDefaults">,
): unknown => {
  const normalized = withDefaults(schema, parameterValue);
  const failure = validate(schema, normalized);
  if (failure) {throw new ParameterError(`Parameter "${name}"${failure.path ? ` at ${failure.path}` : ""} ${failure.message}.`);}
  return normalized;
};

const typedJsonNull = (input: JsonParameter, parameterValue: unknown, validate: QueryChecks["validate"]): unknown => {
  if (input.input?.nullable !== false) {return parameterValue;}
  if (matchesUndefined(parameterValue) || validate(input.schema, NATIVE_NULL)) {refuseNull(input.name, parameterValue);}
  return JSON_NULL;
};

// A typed JSON parameter (`:p::jsonb('…')`): a value left out takes the schema's default, a
// Key under `properties` too, and the value is checked against the schema before the
// Statement runs (wiki/typed-json-params.md). Null is SQL NULL where the statement takes SQL
// NULL for the parameter, and elsewhere JSON's null, where the schema admits it; a value left
// Out there is refused.
const typedJson = (query: QueryModule, input: JsonParameter, supplied: unknown): unknown => {
  const { name, schema } = input;
  const { cloneJson, validate, withDefaults } = checksFor(query, name);
  const candidate = matchesUndefined(supplied) && !matchesNull(schema) && hasObjectType(schema) && "default" in schema
    ? cloneJson(schema.default)
    : supplied;
  const normalized = matchesNullish(candidate)
    ? typedJsonNull(input, candidate, validate)
    : validatedJson(input, candidate, { validate, withDefaults });
  return matchesUndefined(normalized) ? NATIVE_NULL : normalized;
};

// A structured parameter is checked against its column list and written as the JSON the
// Statement reads; in an insert, its lists name only the keys the call carries. It refuses
// Null itself, saying what to pass.
const bindRows = (
  query: QueryModule,
  bound: BoundStatement,
  { index, name, type }: { index: number; name: string; type: Extract<EngineType, { kind: "rows" }> },
): void => {
  const structured = query.structured?.find((candidate) => candidate.name === name);
  const { prepareRows, variant } = checksFor(query, name);
  const prepared = prepareRows(name, type, bound.values[index], query.dialect, !matchesUndefined(structured));
  bound.values[index] = prepared.value;
  if (structured) {bound.text = variant(bound.text, structured, type.fields, prepared.present);}
};

interface ParameterPosition {
  index: number;
  name: string;
  params: ParamsInput;
}

interface ParameterMetadata extends ParameterPosition {
  input: InputMetadata | undefined;
  type: EngineType | undefined;
}

// A parameter the statement takes no null for, which its types rely on (a column it alone
// Fills, an expression of it typed non-null), refuses null and refuses to be left out, which
// Would bind NULL: exactly where its declared type takes no null (src/render.ts,
// `renderParamType`). One typed `unknown` is declared `unknown` and takes anything. A JSON one
// Takes JSON's null there instead, unless the schema its type carries refuses null, and is
// Refused only when left out.
const representsJsonNull = (
  query: QueryModule,
  bound: BoundStatement,
  { index, input, name, params, type }: ParameterMetadata,
): boolean => {
  if (input?.nullable !== false || !matchesNull(bound.values[index])) {return false;}
  if (type?.kind === "json" && !matchesUndefined(params[name]) && !refusesNull(query, type)) {return true;}
  if (type?.kind === "json" || refusesNull(query, type)) {refuseNull(name, params[name]);}
  return false;
};

// An array parameter takes no NULL element, as its type says (`:ids::int[]` is `number[]`):
// A NULL in `= any(:ids)` matches nothing. An array inside a
// Structured parameter's member keeps its NULL elements (src/rows.ts).
const validateArrayMembers = (bound: BoundStatement, { index, name, type }: ParameterMetadata): void => {
  if (type?.kind !== "array" || !Array.isArray(bound.values[index])) {return;}
  const at = nullElement(bound.values[index]);
  if (!matchesUndefined(at)) {throw new ParameterError(`Parameter "${name}" is an array whose elements may not be null, and the element at ${at} is. Leave it out of the array.`);}
};

const validateBinding = (query: QueryModule, bound: BoundStatement, parameter: ParameterMetadata): void => {
  validateArrayMembers(bound, parameter);
  const { index, name, type } = parameter;
  // A `::type` written on MySQL or SQLite, whose cast turns a value it cannot read into 0 or
  // NULL: the value is checked against the type as written.
  const cast = query.inputs?.[name]?.cast;
  if (!matchesUndefined(cast) && !matchesUndefined(type)) {checksFor(query, name).checkCast(name, cast, type, bound.values[index], query.dialect);}
  checkTime(type, name, bound.values[index]);
  checkBinary(type, name, bound.values[index]);
};

const bindScalar = (query: QueryModule, bound: BoundStatement, parameter: ParameterMetadata): void => {
  const jsonNull = representsJsonNull(query, bound, parameter);
  validateBinding(query, bound, parameter);
  const { index, name, type } = parameter;
  if (jsonNull) {
    bound.values[index] = JSON_NULL;
  } else {
    const parameterValue = bound.values[index];
    bound.values[index] = encode({ dialect: query.dialect, name }, type, parameterValue);
  }
};

const bindParameter = (query: QueryModule, bound: BoundStatement, { index, name, params }: ParameterPosition): void => {
  const input = query.inputs?.[name];
  const { type, schema } = input ?? {};
  if (!matchesUndefined(schema)) {bound.values[index] = typedJson(query, { input, name, schema }, params[name]);}
  else if (type?.kind === "rows") {bindRows(query, bound, { index, name, type });}
  else {bindScalar(query, bound, { index, input, name, params, type });}
};

export const statement = function statement(query: QueryModule, params: ParamsInput): BoundStatement {
  // The build step already compiled the statement; only the values need ordering.
  const compiled = compile(query);
  const bound: BoundStatement = { names: compiled.order, text: compiled.text, values: compiled.order.map((name) => value(params, name)) };
  bound.names.forEach((name, index) => {bindParameter(query, bound, { index, name, params });});
  // Every MySQL and SQLite driver binds JSON text as text, which the database reads as JSON (a
  // Structured parameter's is written already).
  if (query.dialect !== "postgres") {bound.values = bound.values.map((currentValue, index) => (isJsonValue(query, parameterName(bound.names, index), currentValue) && query.inputs?.[parameterName(bound.names, index)]?.type.kind !== "rows" ? jsonText(currentValue) : currentValue));}
  // The comment naming the file goes on last, after a structured parameter's lists are written.
  bound.text = sentText(query, bound.text);
  return bound;
};

/**
 * The statement and its values in the database's raw form, which a Standard Query's `encode`
 * returns (src/standard-query.ts), bound as `.run()` binds them, its checks included: on Postgres
 * each value's text, which a driver binds with no declared type, so the server reads it as the
 * parameter's type; on MySQL and SQLite each value as a driver binds it.
 *
 * @param {QueryModule} query - The module with the statement and its metadata.
 * @param {unknown} params - The values keyed by parameter name or position.
 * @returns {{ text: string, values: unknown[] }} The compiled statement and encoded values in binding order.
 */
export const rawStatement = function rawStatement(query: QueryModule, params: unknown): { text: string; values: unknown[] } {
  checkParams(query, params);
  const { text, values, names } = statement(query, params);
  if (query.dialect !== "postgres") {return { text, values };}
  return { text, values: values.map((currentValue, index) => postgresText(query, parameterName(names, index), currentValue)) };
};
