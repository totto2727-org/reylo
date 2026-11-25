import { columnFixes, fixRows } from "./decode-mysql-columns.ts";
import type { DriverRow } from "./decode-mysql-columns.ts";
import { hasObjectType, isEmptyArray, isEmptyString, matchesNull, matchesNullish, matchesUndefined } from "./native-predicates.ts";
import { jsonValue } from "./value-text.ts";
import { utf8 } from "./values.ts";
import type { Columns } from "./values.ts";

interface PlanetscaleField {
  charset?: number;
  type: string;
}

const BINARY_CHARSET = 63;
const DECIMAL_RADIX = 10;

// The wire string has one UTF-16 code unit for each byte.
const bytesOf = (text: string): Uint8Array =>
  // oxlint-disable-next-line unicorn/prefer-code-point -- Converting full code points would combine wire bytes represented by adjacent surrogate units.
  Uint8Array.from({ length: text.length }, (_unused, index) => text.charCodeAt(index));

const identity = (text: string): string => text;
const dateTime = (text: string): string => text.replace(" ", "T");
const integer = (text: string): number => Number.parseInt(text, DECIMAL_RADIX);
// oxlint-disable-next-line unicorn/prefer-number-coercion -- PlanetScale parses the numeric prefix of its floating-point text.
const float = (text: string): number => Number.parseFloat(text);

const casts = new Map<string, (text: string) => unknown>([
  ["INT64", BigInt],
  ["UINT64", BigInt],
  ["DATE", identity],
  ["TIME", identity],
  ["DECIMAL", identity],
  ["DATETIME", dateTime],
  ["TIMESTAMP", dateTime],
  ["JSON", (text) => jsonValue(utf8(bytesOf(text)))],
  ["INT8", integer],
  ["INT16", integer],
  ["INT24", integer],
  ["INT32", integer],
  ["UINT8", integer],
  ["UINT16", integer],
  ["UINT24", integer],
  ["UINT32", integer],
  ["YEAR", integer],
  ["FLOAT32", float],
  ["FLOAT64", float],
]);

// Match PlanetScale's default casts, keeping BIGINT exact and using T in timestamp text.
const planetscaleCast = function (field: PlanetscaleField, value: string | null): unknown {
  if (matchesNullish(value)) {return value;}
  const cast = casts.get(field.type);
  if (!matchesUndefined(cast)) {return cast(value);}
  if (field.charset === BINARY_CHARSET) {return bytesOf(value);}
  return isEmptyString(value) ? "" : utf8(bytesOf(value));
};

interface PlanetScaleOptions {
  as: string;
  cast: typeof planetscaleCast;
}
type Result = { rows?: DriverRow[] } | null | undefined;
type PlanetscaleProtocol = DriverRow & {
  execute: (text: string, values: unknown[] | null | PlanetScaleOptions, queryOptions?: PlanetScaleOptions) => PromiseLike<Result>;
};

const errorMessage = function (value: unknown): string {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PlanetScale reports the 1.x negotiation error using the native message field.
  const message = (value as { message?: string } | null | undefined)?.message;
  // oxlint-disable-next-line typescript/no-unnecessary-template-expression -- Match the old RegExp reader's native coercion for malformed driver errors, including rejection of Symbol.
  return `${message ?? ""}`;
};

const UNSUPPORTED_BINDINGS = "Query parameters are not supported";
// oxlint-disable-next-line unicorn/no-null -- PlanetScale 1.x accepts null for absent query bindings.
const NO_BINDINGS = null;

const run = async (
  driver: PlanetscaleProtocol,
  text: string,
  values: unknown[]
): Promise<Result> => {
  const options = { as: "object", cast: planetscaleCast };
  try {
    const bindings = isEmptyArray(values) ? NO_BINDINGS : values;
    return await driver.execute(text, bindings, options);
  } catch (error) {
    if (!errorMessage(error).startsWith(UNSUPPORTED_BINDINGS)) {throw error;}
    if (!isEmptyArray(values)) {
      // oxlint-disable-next-line rules/require-tagged-error -- Preserve the adapter's native type-error payload and cause for unsupported bindings.
      throw new TypeError("@planetscale/database 2.0 binds no parameters, so reylo cannot pass this statement's values to it; use its 1.x line, or mysql2 on PlanetScale's MySQL endpoint.", { cause: error });
    }
    return driver.execute(text, options);
  }
};

const describeResult = (value: unknown): string => {
  if (Array.isArray(value)) {return "an array";}
  if (matchesNull(value) || !hasObjectType(value)) {return String(value);}
  return "an object";
};

/**
 * Runs a query through PlanetScale's native execute API.
 * @param {DriverRow} client - The driver selected by the native query dispatcher.
 * @param {string} text - The SQL statement.
 * @param {unknown[]} values - The values to bind on the 1.x driver.
 * @param {Columns | undefined} columns - The generated output kinds, when known.
 * @returns {Promise<unknown[]>} Fresh rows in the generated query's representation.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the positional MySQL adapter API used by the query dispatcher.
export const planetscale = async function planetscale(client: DriverRow, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native dispatch checks for PlanetScale's execute protocol before choosing this adapter.
  const result = await run(client as PlanetscaleProtocol, text, values);
  if (!Array.isArray(result?.rows)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Callers of native driver adapters receive this original TypeError for a mismatched execute protocol.
    throw new TypeError(`reylo ran this statement through execute(), as on PlanetScale's @planetscale/database, and the client answered with ${describeResult(result)} rather than a result with rows. It takes execute(text, values) as on mysql2 and PlanetScale, or a Drizzle database over one of them.`);
  }
  fixRows(result.rows, columnFixes(columns));
  return result.rows;
};
