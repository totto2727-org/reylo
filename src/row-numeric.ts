import { isEmptyString, matchesBigInt, matchesBoolean, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { describe } from "./values.ts";

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const SIGN_BITS = 1;
const TINY_INTEGER_BITS = 8;
const SMALL_INTEGER_BITS = 16;
const MEDIUM_INTEGER_BITS = 24;
const INTEGER_BITS = 32;
const BIG_INTEGER_BITS = 64;

// BigInt() lets projects such as the Next.js example type-check these sources with pre-ES2020 targets.
const BIG_ZERO = BigInt(ZERO);
const BIG_ONE = BigInt(ONE);
const BIG_TWO = BigInt(TWO);

export type RejectParameter = (message: string) => never;
type IntegerRange = Readonly<[minimum: bigint, maximum: bigint]>;

const signedRange = (bits: number): IntegerRange => {
  const ceiling = BIG_TWO ** BigInt(bits - SIGN_BITS);
  return [-ceiling, ceiling - BIG_ONE];
};

const smallInteger = signedRange(SMALL_INTEGER_BITS);
const standardInteger = signedRange(INTEGER_BITS);
export const bigInteger = signedRange(BIG_INTEGER_BITS);

export const INTEGERS: Record<string, IntegerRange> = {
  int2: smallInteger,
  int4: standardInteger,
  int8: bigInteger,
  // SQLite's INTEGER is also signed 64 bit.
  integer: bigInteger,
};

export const MYSQL_INTEGERS: Record<string, IntegerRange> = {
  bigint: bigInteger,
  int: standardInteger,
  int2: smallInteger,
  int4: standardInteger,
  int8: bigInteger,
  integer: standardInteger,
  mediumint: signedRange(MEDIUM_INTEGER_BITS),
  signed: bigInteger,
  smallint: smallInteger,
  tinyint: signedRange(TINY_INTEGER_BITS),
};

export const unsignedRange = ([, maximum]: IntegerRange): IntegerRange => [BIG_ZERO, maximum * BIG_TWO + BIG_ONE];

interface IntegerConstraint {
  digits: boolean;
  range: IntegerRange;
  // MySQL and SQLite return boolean for some integer columns. They must accept it again as 0 or 1.
  truth: boolean;
  written: string;
}

const integerValue = (value: unknown, { digits, truth, written }: IntegerConstraint, fail: RejectParameter): bigint => {
  if (matchesBigInt(value)) {return value;}
  if (matchesBoolean(value) && truth) {return value ? BIG_ONE : BIG_ZERO;}
  if (matchesNumber(value) && Number.isInteger(value)) {
    return Number.isSafeInteger(value) ? BigInt(value) : fail(
      `is ${written}; ${value} is past 2^53 - 1, where a number stops being exact, so pass it as a BigInt${digits ? " or a string of digits" : ""}.`,
    );
  }
  if (matchesString(value) && /^[+-]?\d+$/u.test(value.trim()) && digits) {return BigInt(value.trim());}
  return fail(`is ${written}, an integer; got ${describe(value)}.`);
};

export const integer = (value: unknown, constraint: IntegerConstraint, fail: RejectParameter): bigint => {
  const checked = integerValue(value, constraint, fail);
  const { range: [minimum, maximum], written } = constraint;
  if (checked < minimum || checked > maximum) {fail(`is ${written}, from ${minimum} to ${maximum}; got ${checked}.`);}
  return checked;
};

const DECIMAL_VALUE = /^[+-]?(?<whole>\d*)(?:\.(?<fraction>\d*))?(?:[eE](?<exponent>[+-]?\d+))?$/u;
const DECIMAL_MODIFIER = /\(\s*(?<precision>\d+)\s*(?:,\s*(?<scale>-?\d+)\s*)?\)/u;

const invalidDecimal = (written: string, value: unknown): string =>
  `is ${written}, a decimal: a number or a string of its digits; got ${describe(value)}.`;

const decimalText = (written: string, value: unknown, fail: RejectParameter): string => {
  if (matchesNumber(value)) {
    if (!Number.isFinite(value)) {return fail(`is ${written}, a finite decimal; got ${value}.`);}
    return String(value);
  }
  if (matchesString(value)) {return value.trim();}
  if (matchesBigInt(value)) {return value.toString();}
  return fail(invalidDecimal(written, value));
};

interface DecimalDigits {
  fraction: string;
  whole: string;
}

const trimLeadingZeros = (value: string): string => value.replace(/^0+/u, "");
const trimTrailingZeros = (value: string): string => value.replace(/0+$/u, "");

const moveDecimalPoint = ({ fraction, whole }: DecimalDigits, exponent: number): DecimalDigits => {
  if (exponent > ZERO) {
    const moved = fraction.slice(ZERO, exponent).padEnd(exponent, "0");
    return { fraction: fraction.slice(exponent), whole: trimLeadingZeros(whole + moved) };
  }
  if (exponent < ZERO) {
    const digits = whole.padStart(-exponent, "0");
    const point = digits.length + exponent;
    return { fraction: trimTrailingZeros(digits.slice(point) + fraction), whole: trimLeadingZeros(digits.slice(ZERO, point)) };
  }
  return { fraction, whole };
};

interface DecimalLimit {
  scale: number;
  text: string;
  wholeLimit: number;
  written: string;
}

const verifyDigits = ({ fraction, whole }: DecimalDigits, { scale, text, wholeLimit, written }: DecimalLimit, fail: RejectParameter): void => {
  if (fraction.length > scale) {
    fail(`is ${written}, which keeps ${scale} digit${scale === ONE ? "" : "s"} after the point, so ${text} would be rounded.`);
  }
  if (whole.length > wholeLimit) {
    fail(`is ${written}, which holds at most ${wholeLimit} digit${wholeLimit === ONE ? "" : "s"} before the point; got ${text}.`);
  }
};

// A decimal must fit its SQL precision and scale without rounding.
export const decimal = (written: string, value: unknown, fail: RejectParameter): unknown => {
  const text = decimalText(written, value, fail);
  const digits = DECIMAL_VALUE.exec(text)?.groups;
  if (matchesUndefined(digits) || (isEmptyString(digits.whole ?? "") && isEmptyString(digits.fraction ?? ""))) {
    return fail(invalidDecimal(written, value));
  }
  const modifier = DECIMAL_MODIFIER.exec(written)?.groups;
  if (!matchesUndefined(modifier)) {
    const scale = Number(modifier.scale ?? ZERO);
    const trimmed = { fraction: trimTrailingZeros(digits.fraction ?? ""), whole: trimLeadingZeros(digits.whole ?? "") };
    verifyDigits(moveDecimalPoint(trimmed, Number(digits.exponent ?? ZERO)), { scale, text, wholeLimit: Number(modifier.precision) - scale, written }, fail);
  }
  return matchesBigInt(value) ? value.toString() : value;
};
