import { civilFromDays, daysFromCivil } from "./gregorian-day.ts";
import { matchesUndefined } from "./native-predicates.ts";
import { DecodeError } from "./value-numbers.ts";

const FIRST_YEAR_AD = 1;
const ISO_YEAR_ZERO = 0;
const YEAR_DIGITS = 4;
const EXTENDED_YEAR_DIGITS = 6;
const LAST_FOUR_DIGIT_YEAR = 9999;
const CLOCK_DIGITS = 2;
const TEXT_START = 0;
const BC_SUFFIX = " BC";
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = 86_400;
const NO_OFFSET = 0;
const EAST_OFFSET = 1;
const WEST_OFFSET = -1;

const pad = (value: number, width = CLOCK_DIGITS): string => String(value).padStart(width, "0");

/**
 * An ISO 8601 year: four digits from 0000 (1 BC) to 9999, and the extended form, a sign and six
 * digits, outside them (`+010000`, `-000001` for 2 BC), as `Temporal` reads and writes it. A year
 * past 999999, which only a Postgres `date` reaches (up to 5874897), takes the digits it needs after
 * the sign (`+5874897`): ISO 8601 leaves the number of extended digits to the parties that exchange
 * them, Temporal holds no such date in any form, and a sign keeps the rule that every year outside
 * 0000–9999 has one, which `postgresYear` reads back.
 * @param {number} year - A proleptic ISO year.
 * @returns {string} The year with its required width and sign.
 */
export const isoYear = (year: number): string => (year >= ISO_YEAR_ZERO && year <= LAST_FOUR_DIGIT_YEAR ? pad(year, YEAR_DIGITS) : `${year < ISO_YEAR_ZERO ? "-" : "+"}${pad(Math.abs(year), EXTENDED_YEAR_DIGITS)}`);

/**
 * A date's or timestamp's text with its year as `isoYear` writes it: Postgres writes a year past
 * 9999 with more digits (`12345-01-01`) and one before 1 AD in its own form (`0002-06-01 BC`), which
 * `Temporal.PlainDate.from` refuses, so `12345-01-01` is `+012345-01-01` and `0002-06-01 BC` is
 * `-000001-06-01`. A four-digit year after 1 BC, `infinity` and `-infinity` are left as they are.
 * @param {string} value - The driver's date or timestamp text.
 * @returns {string} The text with its ISO year.
 */
export const isoDate = (value: string): string => {
  const dash = value.indexOf("-");
  const beforeChrist = value.endsWith(BC_SUFFIX);
  if (dash < YEAR_DIGITS || (dash === YEAR_DIGITS && !beforeChrist)) {return value;}
  const digits = value.slice(TEXT_START, dash);
  if (!/^\d+$/u.test(digits)) {return value;}
  const year = beforeChrist ? FIRST_YEAR_AD - Number(digits) : Number(digits);
  return isoYear(year) + value.slice(dash, beforeChrist ? -BC_SUFFIX.length : undefined);
};

// Timestamp decoding also changes the separator from a space to T.
export const timestamp = (text: string): string => isoDate(text.replace(" ", "T"));

// Timestamptz in DateStyle ISO: `2026-10-20 03:03:00.123456-07`, offsets with seconds before
// Standard time (`-07:52:58`), years past 9999, ` BC`. `new Date(text)`, which postgres.js and
// PGlite use, returns Invalid Date for the last three and reads year 0001 as 2001
// (wiki/driver-decoding/spike/postgres.md); and a Date holds milliseconds, not the server's
// Microseconds. So Reylo moves the wall-clock time to UTC itself, in whole seconds on a day count,
// And keeps the fraction as the server wrote it.
const TSTZ = /^(?<year>\d{4,})-(?<month>\d\d)-(?<day>\d\d) (?<hour>\d\d):(?<minute>\d\d):(?<second>\d\d)(?<fraction>\.\d{1,6})?(?<zoneSign>[+-])(?<zoneHour>\d\d)(?::(?<zoneMinute>\d\d))?(?::(?<zoneSecond>\d\d))?(?<era> BC)?$/u;

/**
 * A date or time parameter's text as Postgres reads it, the inverse of `isoYear` for what `run`
 * returns (the round-trip rule): Postgres 18 refuses an ISO 8601 extended year (`+010000-01-01`,
 * "time zone displacement out of range") and the year 0000 ("date/time field value out of range"),
 * and reads `10000-01-01` and a year before 1 as its own ` BC` form, year 1 − n, so `-000001` is
 * `0002 … BC` and `0000` or `+000000` is `0001 … BC`. Any other text is left as it is.
 * @param {string} text - A date or timestamp parameter.
 * @returns {string} The parameter written with a PostgreSQL year.
 */
export const postgresYear = (text: string): string => {
  const parts = /^(?<year>[+-]\d{6,}|0000)(?<rest>-.*)$/u.exec(text)?.groups;
  if (matchesUndefined(parts) || /\sbc$/iu.test(text)) {return text;}
  const year = Number(parts.year);
  return year > ISO_YEAR_ZERO
    ? `${pad(year, YEAR_DIGITS)}${parts.rest}`
    : `${pad(FIRST_YEAR_AD - year, YEAR_DIGITS)}${parts.rest}${BC_SUFFIX}`;
};

const clockText = (seconds: number): string => {
  const hour = Math.floor(seconds / SECONDS_PER_HOUR);
  const minute = Math.floor(seconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const second = seconds % SECONDS_PER_MINUTE;
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
};

const zoneOffset = (parts: Readonly<Record<string, string | undefined>>): number => {
  const direction = parts.zoneSign === "-" ? WEST_OFFSET : EAST_OFFSET;
  return direction * (
    Number(parts.zoneHour) * SECONDS_PER_HOUR
    + Number(parts.zoneMinute ?? NO_OFFSET) * SECONDS_PER_MINUTE
    + Number(parts.zoneSecond ?? NO_OFFSET)
  );
};

const instantSeconds = (parts: Readonly<Record<string, string | undefined>>): number => {
  const year = matchesUndefined(parts.era) ? Number(parts.year) : FIRST_YEAR_AD - Number(parts.year);
  const day = daysFromCivil(year, Number(parts.month), Number(parts.day));
  const time = Number(parts.hour) * SECONDS_PER_HOUR + Number(parts.minute) * SECONDS_PER_MINUTE + Number(parts.second);
  return day * SECONDS_PER_DAY + time - zoneOffset(parts);
};

/**
 * A timestamptz's text as the instant's ISO 8601 text in UTC: `2026-10-20 10:00:00.123456+02` is
 * `2026-10-20T08:00:00.123456Z`, the fraction as the server wrote it (trailing zeros dropped, none
 * for a whole second), which `Temporal.Instant.from` reads. `infinity` and `-infinity` stay those
 * words.
 * @param {string} text - The timestamp reported by the server.
 * @returns {string} The UTC instant with the full precision of the server value.
 */
export const instant = (text: string): string => {
  const parts = TSTZ.exec(text)?.groups;
  if (matchesUndefined(parts)) {return text;}
  const seconds = instantSeconds(parts);
  const utcDay = Math.floor(seconds / SECONDS_PER_DAY);
  const [year, month, day] = civilFromDays(utcDay);
  const time = clockText(seconds - utcDay * SECONDS_PER_DAY);
  return `${isoYear(year)}-${pad(month)}-${pad(day)}T${time}${parts.fraction ?? ""}Z`;
};

/**
 * A string for a `timestamptz` names its zone: without one the server reads it in the session's
 * TimeZone, which the driver or the server sets.
 */
// oxlint-disable-next-line eslint/require-unicode-regexp -- This exported expression retains its flags and ASCII-only zone name folding.
export const zoned = /(?:\d:\d\d(?::\d\d(?:\.\d+)?)?(?:\s*(?:z|[+-]\d\d?(?::?\d\d){0,2})|\s+[a-z][\w/+-]*)|^-?infinity|^epoch|^now)(?:\s+bc)?$/i;

/**
 * A Date a driver handed back must hold a time. Bun.sql 1.4 decodes a date, timestamp or timestamptz
 * before 1 AD as an Invalid Date (its infinities come as the numbers ±Infinity), so an Invalid Date
 * is a value the driver lost, and Reylo refuses it rather than return a wrong one.
 * @param {Date} value - The date the driver returned.
 * @param {string} column - The name used in the decoding error.
 */
const validDate = (value: Date, column: string): void => {
  if (Number.isNaN(value.getTime())) {throw new DecodeError(`Column "${column}": the driver returned an Invalid Date, which is how Bun.sql decodes a date or timestamp before 1 AD. Reylo refuses it rather than return a wrong value.`);}
};

const FIRST_ISO_MONTH = 1;
const MILLISECOND_DIGITS = 3;

/**
 * A Date a driver read as UTC (Bun.sql's date and timestamp) back to the text the server's would
 * decode to: `YYYY-MM-DD`, or with `T` and the fraction the driver kept, the year as `isoYear`
 * writes it.
 * @param {Date} value - The date the driver returned.
 * @param {"date" | "timestamp"} kind - Date only or date and time.
 * @param {string} column - The name used in the decoding error.
 * @returns {string} The UTC calendar value with the precision from the driver.
 */
export const utcText = function (value: Date, kind: "date" | "timestamp", column: string): string {
  validDate(value, column);
  const calendar = `${isoYear(value.getUTCFullYear())}-${pad(value.getUTCMonth() + FIRST_ISO_MONTH)}-${pad(value.getUTCDate())}`;
  if (kind === "date") {return calendar;}
  const ms = value.getUTCMilliseconds();
  const fraction = ms ? `.${pad(ms, MILLISECOND_DIGITS).replace(/0+$/u, "")}` : "";
  return `${calendar}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}${fraction}`;
};

/**
 * The instant a driver already decoded to a Date (Bun.sql's timestamptz), as the same text: to the
 * millisecond, which is all a Date holds, with its fraction's trailing zeros dropped as the server
 * drops them, so that a value the driver did not cut reads alike on every driver.
 * @param {Date} value - The date the driver returned.
 * @param {string} column - The name used in the decoding error.
 * @returns {string} The UTC instant with the precision from the driver.
 */
export const instantOfDate = function instantOfDate(value: Date, column: string): string {
  validDate(value, column);
  return value.toISOString().replace(/\.?0+Z$/u, "Z");
};
