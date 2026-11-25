import { matchesUndefined } from "./native-predicates.ts";

const DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/iu;

const DATE_LENGTH = 10;
const TIME_START = 11;
const FIRST_MONTH = 1;
const FIRST_DAY = 1;
const LONG_MONTH = 31;
const SHORT_MONTH = 30;
const FEBRUARY = 28;
const LEAP_FEBRUARY = 29;
const COMMON_LEAP_INTERVAL = 4;
const YEARS_PER_CENTURY = 100;
const GREGORIAN_CYCLE = 400;
const EVEN_REMAINDER = 0;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
const ONE_MINUTE = 1;
const LAST_MINUTE_OF_DAY = MINUTES_PER_DAY - ONE_MINUTE;
const LEAP_SECOND = 60;
const UTC_OFFSET = 0;

const isLeapYear = (year: number): boolean =>
  year % COMMON_LEAP_INTERVAL === EVEN_REMAINDER &&
  (year % YEARS_PER_CENTURY !== EVEN_REMAINDER || year % GREGORIAN_CYCLE === EVEN_REMAINDER);

const daysOfMonths = (year: number): number[] => [
  LONG_MONTH, isLeapYear(year) ? LEAP_FEBRUARY : FEBRUARY, LONG_MONTH, SHORT_MONTH,
  LONG_MONTH, SHORT_MONTH, LONG_MONTH, LONG_MONTH, SHORT_MONTH, LONG_MONTH, SHORT_MONTH, LONG_MONTH,
];

export const date = (value: string): boolean => {
  const parts = DATE.exec(value)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const month = Number(parts.month);
  const day = Number(parts.day);
  const lastDay = daysOfMonths(Number(parts.year))[month - FIRST_MONTH];
  return !matchesUndefined(lastDay) && day >= FIRST_DAY && day <= lastDay;
};

const validClock = (hour: number, minute: number): boolean =>
  hour < HOURS_PER_DAY && minute < MINUTES_PER_HOUR;

const utcOffset = ({ sign, offsetHour, offsetMinute }: Record<string, string | undefined>): number => {
  if (matchesUndefined(sign)) {return UTC_OFFSET;}
  const minutes = Number(offsetHour) * MINUTES_PER_HOUR + Number(offsetMinute);
  return sign === "-" ? -minutes : minutes;
};

const leapSecondEndsUtcDay = (hour: number, minute: number, parts: Record<string, string | undefined>): boolean => {
  const localMinute = hour * MINUTES_PER_HOUR + minute;
  const utcMinute = ((localMinute - utcOffset(parts)) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return utcMinute === LAST_MINUTE_OF_DAY;
};

const validOffset = ({ sign, offsetHour, offsetMinute }: Record<string, string | undefined>): boolean =>
  matchesUndefined(sign) || validClock(Number(offsetHour), Number(offsetMinute));

export const time = (value: string): boolean => {
  const parts = TIME.exec(value)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (!validClock(hour, minute) || second > LEAP_SECOND || !validOffset(parts)) {return false;}
  return second !== LEAP_SECOND || leapSecondEndsUtcDay(hour, minute, parts);
};

const START = 0;
export const dateTime = (value: string): boolean => {
  const separator = value.search(/[tT ]/u);
  return separator === DATE_LENGTH && date(value.slice(START, separator)) && time(value.slice(TIME_START));
};
