import type { EngineType } from "./engine-type.ts";
import { NATIVE_NULL, indexedElements, isJson, isJsonValue, jsonText } from "./execute-parameters.ts";
import type { QueryModule } from "./execute-types.ts";
import { hasObjectType, matchesBoolean, matchesNullish } from "./native-predicates.ts";

const HEX_RADIX = 16;

const byteaHex = (bytes: Uint8Array): string =>
  Iterator.from(bytes).reduce(
    (hex, byte) => hex + (byte < HEX_RADIX ? "0" : "") + byte.toString(HEX_RADIX),
    String.raw`\x`,
  );

export const asByteaHex = (candidate: unknown): unknown => candidate instanceof Uint8Array ? byteaHex(candidate) : candidate;

const CLOCK_FIELD_WIDTH = 2;
const YEAR_FIELD_WIDTH = 4;
const MILLISECOND_FIELD_WIDTH = 3;
const FIRST_AD_YEAR = 1;
const FIRST_CALENDAR_MONTH = 1;
const MINUTES_PER_HOUR = 60;
const ZERO_ZONE_OFFSET = 0;

const padClockField = (field: number, width = CLOCK_FIELD_WIDTH): string => String(field).padStart(width, "0");

/**
 * Pg's `dateToString`: the local date and time to the millisecond, then the offset; BC for a year before 1.
 *
 * @param {Date} date - The Date to read in local time.
 * @returns {string} Postgres date and time text with its local offset.
 */
const dateText = function dateText(date: Date): string {
  const year = date.getFullYear();
  const offset = -date.getTimezoneOffset();
  const absoluteOffset = Math.abs(offset);
  const beforeEra = year < FIRST_AD_YEAR;
  const yearText = padClockField(beforeEra ? FIRST_AD_YEAR - year : year, YEAR_FIELD_WIDTH);
  const calendarDay = `${padClockField(date.getMonth() + FIRST_CALENDAR_MONTH)}-${padClockField(date.getDate())}`;
  const time = `${padClockField(date.getHours())}:${padClockField(date.getMinutes())}:${padClockField(date.getSeconds())}.${padClockField(date.getMilliseconds(), MILLISECOND_FIELD_WIDTH)}`;
  const zone = `${offset < ZERO_ZONE_OFFSET ? "-" : "+"}${padClockField(Math.floor(absoluteOffset / MINUTES_PER_HOUR))}:${padClockField(absoluteOffset % MINUTES_PER_HOUR)}`;
  return `${yearText}-${calendarDay}T${time}${zone}${beforeEra ? " BC" : ""}`;
};

// oxlint-disable-next-line typescript/no-base-to-string -- Match pg's native string coercion for untyped scalar parameters.
const postgresScalarText = (element: unknown): string => hasObjectType(element) ? JSON.stringify(element) : String(element);

/**
 * A Postgres array literal, written as pg writes one (`arrayString` in pg/lib/utils.js): a nested
 * array in braces, null and undefined as NULL, binary data as `\\x` and its hex, and every other
 * element quoted, with `"` and `\` escaped: a Date as its local time and offset, an object as
 * its JSON, anything else as its string. The elements are separated by `delim`, the element type's
 * delimiter: the server reads `{"a","b"}` as one element of a `geometry[]`, whose delimiter is `:`.
 *
 * @param {Readonly<unknown[]>} array - The array of SQL values, including nested arrays.
 * @param {string} delim - The separator that the element type uses.
 * @returns {string} A Postgres array literal with the elements escaped.
 */
export const arrayLiteral = function arrayLiteral(array: Readonly<unknown[]>, delim = ","): string {
  const text = (element: unknown): string => {
    if (matchesNullish(element)) {return "NULL";}
    if (Array.isArray(element)) {return arrayLiteral(element, delim);}
    if (ArrayBuffer.isView(element)) {
      return `\\${byteaHex(new Uint8Array(element.buffer, element.byteOffset, element.byteLength))}`;
    }
    const scalar = element instanceof Date ? dateText(element) : postgresScalarText(element);
    return `"${scalar.replaceAll(/[\\"]/gu, String.raw`\$&`)}"`;
  };
  const items = Iterator.from(indexedElements(array))
    .reduce((out, [index, element]) => (index ? out + delim : out) + text(element), "{");
  return `${items}}`;
};

// A value as Slonik's sql tag takes it, which is a string, a number, a boolean, a BigInt or null:
// The rest as pg would write them, binary data as `\x` and its hex, an array as its literal, a
// Date as its instant, and an object as its JSON. An omitted parameter binds NULL, as on pg.
export const slonikParam = function (parameterValue: unknown): unknown {
  if (matchesNullish(parameterValue)) {return NATIVE_NULL;}
  if (parameterValue instanceof Uint8Array) {return byteaHex(parameterValue);}
  if (Array.isArray(parameterValue)) {return arrayLiteral(parameterValue);}
  if (parameterValue instanceof Date) {return parameterValue.toISOString();}
  return hasObjectType(parameterValue) ? JSON.stringify(parameterValue) : parameterValue;
};

export const postgresTypedArray = (values: unknown[], type: Extract<EngineType, { kind: "array" }>): string =>
  arrayLiteral(isJson(type.of.kind) ? values.map((element) => (matchesNullish(element) ? element : JSON.stringify(element))) : values, type.delimiter);

const untypedPostgresText = (parameterValue: unknown): string => {
  if (Array.isArray(parameterValue)) {return arrayLiteral(parameterValue);}
  if (parameterValue instanceof Uint8Array) {return byteaHex(parameterValue);}
  if (matchesBoolean(parameterValue)) {return parameterValue ? "t" : "f";}
  if (parameterValue instanceof Date) {return dateText(parameterValue);}
  return postgresScalarText(parameterValue);
};

/**
 * A bound value as the text Postgres's input function reads, as `.run()` sends it through pg.
 *
 * @param {QueryModule} query - The query module that describes the value's engine type.
 * @param {string} name - The name used to look up the parameter.
 * @param {unknown} parameterValue - The bound JavaScript value.
 * @returns {string | null} The input text accepted by Postgres, or null for SQL NULL.
 */
export const postgresText = function postgresText(query: QueryModule, name: string, parameterValue: unknown): string | null {
  if (matchesNullish(parameterValue)) {return NATIVE_NULL;}
  const inputType = query.inputs?.[name]?.type;
  if (Array.isArray(parameterValue) && inputType?.kind === "array") {return postgresTypedArray(parameterValue, inputType);}
  if (isJsonValue(query, name, parameterValue)) {return jsonText(parameterValue);}
  return untypedPostgresText(parameterValue);
};
