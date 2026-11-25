import { isEmptyArray, isEmptyString, matchesNull, matchesString, matchesUndefined } from "./native-predicates.ts";
import { bytea } from "./value-bytes.ts";
import { describe } from "./value-errors.ts";
import { instant, isoDate as date, timestamp } from "./value-time.ts";
import type { Decoder, Kind } from "./values.ts";

const TEXT_START = 0;
const identity: Decoder = (text) => text;
// oxlint-disable-next-line eslint/no-implicit-coercion -- The original number decoder uses unary plus, including its native rejection of BigInt input from JavaScript.
const number: Decoder = (text) => +text;

export const jsonValue = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  return value;
};

// Interval in IntervalStyle postgres: `1 year 2 mons 3 days 04:05:06.789`. Postgres keeps three
// Parts, each signed on its own: months (written as years and months), days, and a time that may
// Pass 24 hours; a part after a negative one carries `+` (`-1 days +01:00:00`).
const INTERVAL = /^(?:(?<years>[+-]?\d+) years? ?)?(?:(?<months>[+-]?\d+) mons? ?)?(?:(?<days>[+-]?\d+) days? ?)?(?:(?<timeSign>[+-]?)(?<hours>\d+):(?<minutes>\d\d):(?<seconds>\d\d)(?:\.(?<fraction>\d+))?)?$/u;

interface DurationPart {
  magnitude: string;
  negative: boolean;
  unit: string;
}

const ZERO_DURATION = 0;

const calendarPart = (digits: string | undefined, unit: string): DurationPart[] => {
  const magnitude = Number(digits ?? ZERO_DURATION);
  return magnitude === ZERO_DURATION
    ? []
    : [{ magnitude: String(Math.abs(magnitude)), negative: magnitude < ZERO_DURATION, unit }];
};

const clockPart = (magnitude: string, unit: string, negative: boolean): DurationPart[] =>
  magnitude === "0" ? [] : [{ magnitude, negative, unit }];

const intervalClock = (parts: Record<string, string | undefined>): DurationPart[] => {
  const negative = parts.timeSign === "-";
  const fraction = (parts.fraction ?? "").replace(/0+$/u, "");
  const seconds = Number(parts.seconds ?? ZERO_DURATION);
  return [
    ...clockPart(String(Number(parts.hours ?? ZERO_DURATION)), "H", negative),
    ...clockPart(String(Number(parts.minutes ?? ZERO_DURATION)), "M", negative),
    ...clockPart(isEmptyString(fraction) ? String(seconds) : `${seconds}.${fraction}`, "S", negative),
  ];
};

const writeDuration = (parts: DurationPart[], allNegative: boolean): string =>
  parts.map(({ magnitude, negative, unit }) => `${negative && !allNegative ? "-" : ""}${magnitude}${unit}`).join("");

/**
 * An interval's text as an ISO 8601 duration, which `Temporal.Duration.from` reads: `1 year 2 mons
 * 3 days 04:05:06.789` is `P1Y2M3DT4H5M6.789S` and zero is `PT0S`, as Postgres writes them in
 * IntervalStyle iso_8601, and a negative interval has one sign in front, `-1 days` being `-P1D`
 * (Postgres writes `P-1D`, which ISO 8601 and Temporal refuse). An interval whose parts differ in
 * sign has no ISO 8601 form, so it keeps Postgres's, each part signed on its own: `1 mon -1 days`
 * is `P1M-1D`, which Postgres reads back and Temporal refuses. `infinity` and `-infinity` stay
 * those words.
 * @param {string} text - Text emitted by PostgreSQL using its native interval style.
 * @returns {string} The ISO-style duration or the original text if it does not match that style.
 */
export const duration = (text: string): string => {
  const parts = INTERVAL.exec(text)?.groups;
  if (matchesUndefined(parts) || isEmptyString(text)) {return text;}
  const calendar = [
    ...calendarPart(parts.years, "Y"),
    ...calendarPart(parts.months, "M"),
    ...calendarPart(parts.days, "D"),
  ];
  const clock = intervalClock(parts);
  if (isEmptyArray(calendar) && isEmptyArray(clock)) {return "PT0S";}
  const negative = calendar.every((part) => part.negative) && clock.every((part) => part.negative);
  const time = writeDuration(clock, negative);
  return `${negative ? "-" : ""}P${writeDuration(calendar, negative)}${isEmptyString(time) ? "" : `T${time}`}`;
};

/**
 * An interval parameter's text as Postgres reads it, the inverse of `duration` for a negative
 * interval (the round-trip rule): Postgres refuses a sign before the `P` (`-P1DT2H`, as `.run()`
 * returns it and Temporal writes it), and reads each part signed instead (`P-1DT-2H`). Any other
 * text is left as it is.
 * @param {string} text - A signed ISO-style duration used as a query parameter.
 * @returns {string} The duration with a sign on each negative part, or the original text.
 */
export const postgresInterval = (text: string): string => {
  const parts = /^\s*(?<sign>[+-])(?<duration>[Pp][^+-]*)$/u.exec(text)?.groups;
  const durationText = parts?.duration;
  if (matchesUndefined(durationText)) {return text;}
  return parts?.sign === "+"
    ? durationText
    : durationText.replaceAll(/(?<magnitude>\d+(?:[.,]\d+)?)(?<unit>[YMWDHSymwdhs])/gu, "-$<magnitude>$<unit>");
};

interface TextCursor {
  offset: number;
  text: string;
}

const CHARACTER_WIDTH = 1;
const HSTORE_SEPARATOR = "=>";
const POSTGRES_NULL = "NULL";
// oxlint-disable-next-line unicorn/no-null -- PostgreSQL NULL inside arrays and hstores has always decoded to JavaScript null.
const SQL_NULL_VALUE = null;

const consumeCharacter = (cursor: TextCursor): string | undefined => {
  const character = cursor.text[cursor.offset];
  cursor.offset += CHARACTER_WIDTH;
  return character;
};

const readQuotedText = (cursor: TextCursor): string => {
  const quoted = { prefix: "", start: cursor.offset + CHARACTER_WIDTH };
  cursor.offset = quoted.start;
  while (cursor.offset < cursor.text.length && cursor.text[cursor.offset] !== '"') {
    if (consumeCharacter(cursor) === "\\") {
      quoted.prefix += cursor.text.slice(quoted.start, cursor.offset - CHARACTER_WIDTH);
      quoted.start = cursor.offset;
      cursor.offset += CHARACTER_WIDTH;
    }
  }
  const suffix = cursor.text.slice(quoted.start, cursor.offset);
  cursor.offset += CHARACTER_WIDTH;
  return quoted.prefix + suffix;
};

const readHstoreValue = (cursor: TextCursor): string | null => {
  cursor.offset += HSTORE_SEPARATOR.length;
  if (cursor.text[cursor.offset] === '"') {return readQuotedText(cursor);}
  cursor.offset += POSTGRES_NULL.length;
  return SQL_NULL_VALUE;
};

/**
 * An hstore's text as an object of its keys: `"a"=>"1", "b c"=>NULL` is `{ a: "1", "b c": null }`.
 * The server quotes every key and value, escapes `"` and `\` with a backslash, writes a null value
 * as a bare NULL and separates the pairs with `, `. A key such as `__proto__` is a key like any other.
 * @param {string} text - The hstore as PostgreSQL writes it.
 * @returns {Record<string, string | null>} The key and value pairs.
 */
export const hstore = (text: string): Record<string, string | null> => {
  const pairs: [string, string | null][] = [];
  const cursor = { offset: TEXT_START, text };
  while (cursor.offset < text.length) {
    while (text[cursor.offset] === " " || text[cursor.offset] === ",") {cursor.offset += CHARACTER_WIDTH;}
    if (text[cursor.offset] !== '"') {break;}
    pairs.push([readQuotedText(cursor), readHstoreValue(cursor)]);
  }
  return Object.fromEntries(pairs);
};

const quote = (text: string): string => `"${text.replaceAll(/[\\"]/gu, String.raw`\$&`)}"`;

/**
 * An hstore, as `.run()` returns it, in the text its input reads: each key and value quoted, `"`
 * and `\` escaped, a null value a bare NULL. A key whose value is undefined is left out, as JSON
 * leaves it out.
 * @param {object} source - A plain object of hstore keys.
 * @param {(message: string) => never} fail - Reports a value that cannot be bound as an hstore.
 * @returns {string} The hstore literal.
 */
export const hstoreText = function hstoreText(source: object, fail: (message: string) => never): string {
  // Only a plain object's own keys are its pairs: a Map, a Set or a class instance would be written
  // As an empty hstore, so anything else is refused, its constructor named.
  const proto: unknown = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && !matchesNull(proto)) {
    const name = Array.isArray(source) || source instanceof Date || ArrayBuffer.isView(source)
      ? undefined
      : (source.constructor as { name?: unknown } | null | undefined)?.name;
    return fail(`is an hstore, an object of its keys whose values are strings or null; got ${matchesString(name) && name ? `a ${name}` : describe(source)}.`);
  }
  const entries: [string, unknown][] = Object.entries(source);
  const pairs: string[] = [];
  Iterator.from(entries).forEach(([key, value]) => {
    if (matchesUndefined(value)) {return;}
    if (!matchesNull(value) && !matchesString(value)) {fail(`is an hstore, whose values are strings or null, and its key ${JSON.stringify(key)} holds ${describe(value)}.`);}
    pairs.push(`${quote(key)}=>${matchesNull(value) ? "NULL" : quote(value)}`);
  });
  return pairs.join(", ");
};

// oxlint-disable-next-line eslint/sort-keys -- Keep the decoder table in the representation order documented by values.ts.
const TEXT_DECODERS: Readonly<Record<string, Decoder | undefined>> = {
  bool: (text) => text === "t",
  int: number,
  float: number,
  // oxlint-disable-next-line unicorn/prefer-native-coercion-functions -- Preserve the name and arity of the decoder returned to callers.
  int8: (text) => BigInt(text),
  decimal: identity,
  text: identity,
  date,
  timestamp,
  timestamptz: instant,
  interval: duration,
  json: (text) => jsonValue(text),
  bytes: bytea,
  // Pgvector prints the shortest text of each float, `[1,2.5,1e-07]`, which JSON reads exactly.
  vector: (text) => jsonValue(text),
  hstore,
  unknown: identity,
};

interface ArrayFormat {
  decode: Decoder;
  delimiter: string;
}

const readArrayValue = (cursor: TextCursor, { decode, delimiter }: ArrayFormat): unknown => {
  const { text } = cursor;
  if (text[cursor.offset] === '"') {return decode(readQuotedText(cursor));}
  const start = cursor.offset;
  while (cursor.offset < text.length && text[cursor.offset] !== delimiter && text[cursor.offset] !== "}") {
    cursor.offset += CHARACTER_WIDTH;
  }
  const value = text.slice(start, cursor.offset);
  return value === POSTGRES_NULL ? SQL_NULL_VALUE : decode(value);
};

const readArray = (cursor: TextCursor, format: ArrayFormat): unknown[] => {
  const items: unknown[] = [];
  cursor.offset += CHARACTER_WIDTH;
  if (cursor.text[cursor.offset] === "}") {
    cursor.offset += CHARACTER_WIDTH;
    return items;
  }
  while (cursor.offset < cursor.text.length) {
    items.push(cursor.text[cursor.offset] === "{" ? readArray(cursor, format) : readArrayValue(cursor, format));
    if (consumeCharacter(cursor) === "}") {return items;}
  }
  return items;
};

/**
 * Postgres's array output: `{a,"b,c",NULL,{d}}`, optionally after its bounds (`[0:1]={...}`).
 * An element is quoted when it holds the delimiter, a brace, a quote, a backslash or white space,
 * or is empty or the word NULL; inside quotes a backslash escapes the next character.
 * @param {string} text - The array as PostgreSQL writes it.
 * @param {Decoder} element - Decodes the text of each non-NULL scalar.
 * @param {string} delimiter - The type's element separator.
 * @returns {unknown[]} The decoded array, including any nested arrays.
 */
export const parseArray = (text: string, element: Decoder, delimiter = ","): unknown[] => {
  const offset = text[TEXT_START] === "[" ? text.indexOf("=") + CHARACTER_WIDTH : TEXT_START;
  return readArray({ offset, text }, { decode: element, delimiter });
};

const ARRAY_KIND_SUFFIX = "[]";

/**
 * Finds the decoder for a PostgreSQL value.
 * @param {Kind} kind - The representation kind of the value.
 * @param {string} delim - The separator to use for arrays of this kind.
 * @returns {Decoder} A decoder for the scalar or array text.
 */
export const textDecoder = function textDecoder(kind: Kind, delim = ","): Decoder {
  if (kind.endsWith(ARRAY_KIND_SUFFIX)) {
    const element = textDecoder(kind.slice(TEXT_START, -ARRAY_KIND_SUFFIX.length), delim);
    return (text) => parseArray(text, element, delim);
  }
  return TEXT_DECODERS[kind] ?? identity;
};
