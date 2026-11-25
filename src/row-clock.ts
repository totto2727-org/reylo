import { matchesString, matchesUndefined } from "./native-predicates.ts";
import { SINGLE_TYPE_MODIFIER } from "./row-scalar.ts";
import type { RowValueContext } from "./row-scalar.ts";
import { describe } from "./values.ts";

const CLOCK = /^-?(?<hours>\d{1,3}):(?<minutes>\d{2})(?::(?<seconds>\d{2})(?:\.(?<fraction>\d+))?)?$/u;
const WALL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:[T ](?<hours>\d{2}):(?<minutes>\d{2})(?::(?<seconds>\d{2})(?:\.(?<fraction>\d+))?)?)?$/u;
const ZERO = 0;
const DATETIME_FRACTION_DIGITS = 6;
const MYSQL_TIME_HOUR_LIMIT = 838;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const FIRST_MONTH = 1;
const FEBRUARY = 2;
const FIRST_DAY_OF_MONTH = 1;
const LEAP_FEBRUARY = 29;
const SHORT_MONTH = 30;
const LONG_MONTH = 31;
const COMMON_FEBRUARY = 28;
const MONTH_LENGTHS = [
  LONG_MONTH, COMMON_FEBRUARY, LONG_MONTH, SHORT_MONTH, LONG_MONTH, SHORT_MONTH,
  LONG_MONTH, LONG_MONTH, SHORT_MONTH, LONG_MONTH, SHORT_MONTH, LONG_MONTH,
];
const LEAP_INTERVAL = 4;
const CENTURY = 100;
const LEAP_CENTURY = 400;
const LEGACY_YEAR_BASE = 1900;

type ClockFields = Record<string, string | undefined>;

const validClock = (parts: ClockFields, keeps: number): boolean =>
  Number(parts.minutes ?? ZERO) < MINUTES_PER_HOUR &&
  Number(parts.seconds ?? ZERO) < SECONDS_PER_MINUTE &&
  (parts.fraction ?? "").length <= keeps;

const validMysqlTime = (text: string, keeps: number): boolean => {
  const parts = CLOCK.exec(text)?.groups;
  return !matchesUndefined(parts) && Number(parts.hours) <= MYSQL_TIME_HOUR_LIMIT && validClock(parts, keeps);
};

const monthLength = (year: number, month: number): number => {
  // Preserve the previous Date.UTC validation of the years 0000–0099.
  const calendarYear = year < CENTURY ? LEGACY_YEAR_BASE + year : year;
  const leapYear = calendarYear % LEAP_INTERVAL === ZERO &&
    (calendarYear % CENTURY !== ZERO || calendarYear % LEAP_CENTURY === ZERO);
  if (month === FEBRUARY && leapYear) {return LEAP_FEBRUARY;}
  return MONTH_LENGTHS[month - FIRST_MONTH] ?? ZERO;
};

const validMysqlDate = (text: string, base: string, keeps: number): boolean => {
  const parts = WALL_DATE.exec(text)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const day = Number(parts.day);
  if (day < FIRST_DAY_OF_MONTH || day > monthLength(Number(parts.year), Number(parts.month))) {return false;}
  if (base === "date") {return matchesUndefined(parts.hours);}
  return Number(parts.hours ?? ZERO) < HOURS_PER_DAY && validClock(parts, keeps);
};

const dateExample = (base: string): string => {
  if (base === "date") {return '"2026-10-12"';}
  return base === "time" ? '"19:06:48"' : '"2026-10-12 19:06:48.282"';
};

const clockPrecision = (base: string, keeps: number): string => {
  if (keeps > ZERO && base !== "date") {return ` with at most ${keeps} digits after the second's point`;}
  return base === "time" ? " with no fraction of a second" : "";
};

// Reject clock input that MySQL would round, discard, or read in a driver-dependent zone.
export const wallClock = (base: string, value: unknown, { fail, written }: RowValueContext): void => {
  const example = dateExample(base);
  if (!matchesString(value)) {
    return fail(`is ${written}, which takes its text (${example}), not ${describe(value)}${value instanceof Date ? ": drivers write a Date's time in different zones" : ""}.`);
  }
  const text = value.trim();
  const digits = SINGLE_TYPE_MODIFIER.exec(written)?.groups?.digits;
  const keeps = Number(digits ?? (base === "time" ? ZERO : DATETIME_FRACTION_DIGITS));
  if (base === "time" ? validMysqlTime(text, keeps) : validMysqlDate(text, base, keeps)) {return;}
  fail(`is ${written}, as text like ${example}${clockPrecision(base, keeps)}; got ${describe(value)}, which MySQL's CAST would make NULL or change.`);
};
