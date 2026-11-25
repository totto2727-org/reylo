import { civilFromDays } from "./gregorian-day.ts";
import { isEmptyArray, isEmptyString, matchesNumber, matchesUndefined } from "./native-predicates.ts";
import { duration } from "./value-text.ts";
import { isoYear } from "./value-time.ts";

interface Precision {
  digits: number;
  perSecond: bigint;
}

export const SECONDS: Precision = { digits: 0, perSecond: BigInt("1") };
export const MILLISECONDS: Precision = { digits: 3, perSecond: BigInt("1000") };
export const MICROSECONDS: Precision = { digits: 6, perSecond: BigInt("1000000") };
export const NANOSECONDS: Precision = { digits: 9, perSecond: BigInt("1000000000") };

const CLOCK_DIGITS = 2;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = BigInt("86400");
const CLOCK_ZERO = BigInt("0");
const ONE_DAY = BigInt("1");
const MONTHS_PER_YEAR = 12;
const DATE_INFINITY = 2_147_483_647;
const TIMESTAMP_INFINITY = BigInt("9223372036854775807");
const NO_DECIMAL_PLACES = 0;
const MIN_INTEGER_DIGITS = 1;
const AFTER_SIGN = 1;

const pad = (part: number | bigint, width = CLOCK_DIGITS): string => String(part).padStart(width, "0");

const civil = (days: number): string => {
  const [year, month, day] = civilFromDays(days);
  return `${isoYear(year)}-${pad(month)}-${pad(day)}`;
};

export const dateFromDays = (native: { days: number }, original: unknown): string => {
  if (native.days === DATE_INFINITY) {return "infinity";}
  if (native.days === -DATE_INFINITY) {return "-infinity";}
  return matchesNumber(native.days) ? civil(native.days) : String(original);
};

const clockText = (seconds: number): string => {
  const hours = pad(Math.floor(seconds / SECONDS_PER_HOUR));
  const minutes = pad(Math.floor(seconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR);
  const wholeSeconds = pad(seconds % SECONDS_PER_MINUTE);
  return `${hours}:${minutes}:${wholeSeconds}`;
};

const wallClock = (count: bigint, { digits, perSecond }: Precision): string => {
  const perDay = SECONDS_PER_DAY * perSecond;
  const wholeDays = count / perDay;
  const remainder = count % perDay;
  const previousDay = remainder < CLOCK_ZERO;
  const days = previousDay ? wholeDays - ONE_DAY : wholeDays;
  const rest = previousDay ? remainder + perDay : remainder;
  const fraction = (rest % perSecond).toString().padStart(digits, "0").replace(/0+$/u, "");
  const suffix = isEmptyString(fraction) ? "" : `.${fraction}`;
  return `${civil(Number(days))}T${clockText(Number(rest / perSecond))}${suffix}`;
};

export const timestamp = (count: bigint, precision: Precision, zone: string): string => {
  if (count === TIMESTAMP_INFINITY) {return "infinity";}
  if (count === -TIMESTAMP_INFINITY) {return "-infinity";}
  return wallClock(count, precision) + zone;
};

const intervalClock = (micros: bigint): string => {
  const sign = micros < CLOCK_ZERO ? "-" : "";
  const abs = micros < CLOCK_ZERO ? -micros : micros;
  const seconds = abs / MICROSECONDS.perSecond;
  const fraction = (abs % MICROSECONDS.perSecond).toString().padStart(MICROSECONDS.digits, "0");
  const hours = seconds / BigInt(SECONDS_PER_HOUR);
  const minutes = pad((seconds / BigInt(SECONDS_PER_MINUTE)) % BigInt(MINUTES_PER_HOUR));
  const wholeSeconds = pad(seconds % BigInt(SECONDS_PER_MINUTE));
  return `${sign}${hours}:${minutes}:${wholeSeconds}.${fraction}`;
};

// Preserve the separate calendar and clock signs when converting DuckDB intervals.
export const interval = (months: number, days: number, micros: bigint): string => {
  const years = Math.trunc(months / MONTHS_PER_YEAR);
  const remainingMonths = months - years * MONTHS_PER_YEAR;
  return duration(`${years} years ${remainingMonths} mons ${days} days ${intervalClock(micros)}`);
};

export const decimal = (value: bigint, scale: number): string => {
  if (scale === NO_DECIMAL_PLACES) {return value.toString();}
  const negative = value < CLOCK_ZERO;
  const digits = (negative ? -value : value).toString().padStart(scale + MIN_INTEGER_DIGITS, "0");
  return `${negative ? "-" : ""}${digits.slice(NO_DECIMAL_PLACES, -scale)}.${digits.slice(-scale)}`;
};

const INTERVAL_MAGNITUDE = String.raw`[+-]?\d+(?:[.,]\d+)?`;
const calendarUnits = [["years", "Y"], ["months", "M"], ["weeks", "W"], ["days", "D"]] as const;
const clockUnits = [["hours", "H"], ["minutes", "M"], ["seconds", "S"]] as const;
const units = [...calendarUnits, ...clockUnits];

const partsPattern = (parts: Readonly<(Readonly<[string, string]>)[]>): string =>
  parts.map(([name, unit]) => `(?:(?<${name}>${INTERVAL_MAGNITUDE})[${unit}${unit.toLowerCase()}])?`).join("");

const INTERVAL_PATTERN = new RegExp(
  String.raw`^\s*(?<sign>[+-])?[Pp]${partsPattern(calendarUnits)}(?:[Tt]${partsPattern(clockUnits)})?\s*$`,
  "u",
);

const signedMagnitude = (value: string, negate: boolean): string => {
  const number = value.replace(",", ".");
  if (!negate) {return number;}
  if (number.startsWith("-")) {return number.slice(AFTER_SIGN);}
  return `-${number.startsWith("+") ? number.slice(AFTER_SIGN) : number}`;
};

/**
 * Converts an ISO 8601 duration into DuckDB's interval spelling.
 * @param {string} text - The parameter value as a duration or native DuckDB text.
 * @returns {string} One part per unit with its sign, or the original text.
 */
export const duckdbInterval = function duckdbInterval(text: string): string {
  const captures = INTERVAL_PATTERN.exec(text)?.groups;
  if (matchesUndefined(captures) || !/\d/u.test(text)) {return text;}
  const negate = captures.sign === "-";
  const parts = units.flatMap(([unit]) => {
    const value = captures[unit];
    return matchesUndefined(value) ? [] : [`${signedMagnitude(value, negate)} ${unit}`];
  });
  return isEmptyArray(parts) ? "0 seconds" : parts.join(" ");
};
