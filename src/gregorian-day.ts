const MONTHS_BEFORE_MARCH = 2;
const FIRST_MONTH_IN_MARCH_BASED_YEAR = 3;
const MONTHS_FROM_MARCH_TO_JANUARY = 10;
const MONTHS_FROM_JANUARY_TO_MARCH_BASED_YEAR_END = 9;
const YEAR_BEFORE_MARCH = 1;
const DAYS_PER_COMMON_YEAR = 365;
const LEAP_YEAR_INTERVAL = 4;
const YEARS_PER_CENTURY = 100;
const YEARS_PER_GREGORIAN_CYCLE = 400;
const DAYS_PER_GREGORIAN_CYCLE = 146_097;
const DAYS_PER_FOUR_COMMON_YEARS = 1460;
const DAYS_PER_NON_LEAP_CENTURY = 36_524;
const LAST_DAY_IN_CYCLE = 146_096;
const MARCH_CYCLE_TO_UNIX_EPOCH = 719_468;
const DAYS_PER_FIVE_MONTHS = 153;
const MONTHS_PER_BLOCK = 5;
const MONTH_LENGTH_OFFSET = 2;
const FIRST_DAY_OF_MONTH = 1;

// Howard Hinnant's days_from_civil and civil_from_days use March as the first month.
// The proleptic Gregorian calendar numbers 1 BC as year zero.
const daysBeforeYear = (yearOfCycle: number): number =>
  DAYS_PER_COMMON_YEAR * yearOfCycle + Math.floor(yearOfCycle / LEAP_YEAR_INTERVAL) - Math.floor(yearOfCycle / YEARS_PER_CENTURY);

const daysBeforeMarchBasedMonth = (month: number): number =>
  Math.floor((DAYS_PER_FIVE_MONTHS * month + MONTH_LENGTH_OFFSET) / MONTHS_PER_BLOCK);

const marchBasedYear = (year: number, month: number): number =>
  month <= MONTHS_BEFORE_MARCH ? year - YEAR_BEFORE_MARCH : year;

export const daysFromCivil = (year: number, month: number, day: number): number => {
  const adjustedYear = marchBasedYear(year, month);
  const cycle = Math.floor(adjustedYear / YEARS_PER_GREGORIAN_CYCLE);
  const yearOfCycle = adjustedYear - cycle * YEARS_PER_GREGORIAN_CYCLE;
  const marchBasedMonth = month > MONTHS_BEFORE_MARCH
    ? month - FIRST_MONTH_IN_MARCH_BASED_YEAR
    : month + MONTHS_FROM_JANUARY_TO_MARCH_BASED_YEAR_END;
  const dayOfYear = daysBeforeMarchBasedMonth(marchBasedMonth) + day - FIRST_DAY_OF_MONTH;
  const dayOfCycle = daysBeforeYear(yearOfCycle) + dayOfYear;
  return cycle * DAYS_PER_GREGORIAN_CYCLE + dayOfCycle - MARCH_CYCLE_TO_UNIX_EPOCH;
};

const commonYearsInCycle = (dayOfCycle: number): number =>
  Math.floor((
    dayOfCycle
    - Math.floor(dayOfCycle / DAYS_PER_FOUR_COMMON_YEARS)
    + Math.floor(dayOfCycle / DAYS_PER_NON_LEAP_CENTURY)
    - Math.floor(dayOfCycle / LAST_DAY_IN_CYCLE)
  ) / DAYS_PER_COMMON_YEAR);

export const civilFromDays = (days: number): [year: number, month: number, day: number] => {
  const adjustedDays = days + MARCH_CYCLE_TO_UNIX_EPOCH;
  const cycle = Math.floor(adjustedDays / DAYS_PER_GREGORIAN_CYCLE);
  const dayOfCycle = adjustedDays - cycle * DAYS_PER_GREGORIAN_CYCLE;
  const yearOfCycle = commonYearsInCycle(dayOfCycle);
  const dayOfYear = dayOfCycle - daysBeforeYear(yearOfCycle);
  const marchBasedMonth = Math.floor((MONTHS_PER_BLOCK * dayOfYear + MONTH_LENGTH_OFFSET) / DAYS_PER_FIVE_MONTHS);
  const day = dayOfYear - daysBeforeMarchBasedMonth(marchBasedMonth) + FIRST_DAY_OF_MONTH;
  const month = marchBasedMonth < MONTHS_FROM_MARCH_TO_JANUARY
    ? marchBasedMonth + FIRST_MONTH_IN_MARCH_BASED_YEAR
    : marchBasedMonth - MONTHS_FROM_JANUARY_TO_MARCH_BASED_YEAR_END;
  const year = cycle * YEARS_PER_GREGORIAN_CYCLE + yearOfCycle;
  return [month <= MONTHS_BEFORE_MARCH ? year + YEAR_BEFORE_MARCH : year, month, day];
};
