import { matchesJsonFormat } from "./json-formats.ts";
import { hasObjectType, isRecord, matchesBoolean, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

type Keywords = Readonly<Record<string, unknown>>;

const MULTIPLE_ROUNDING_TOLERANCE = 1e-9;
const ZERO = 0;
const CODE_POINT_STEP = 1;
const regexes = new Map<string, RegExp>();

// JSON Schema uses ECMA-262 patterns with Unicode enabled.
export const regex = (pattern: string): RegExp => {
  const cached = regexes.get(pattern);
  if (!matchesUndefined(cached)) {return cached;}
  const compiled = new RegExp(pattern, "u");
  regexes.set(pattern, compiled);
  return compiled;
};

const is = (type: unknown, value: unknown): boolean => {
  switch (type) {
    case "null": {return matchesNull(value);}
    case "boolean": {return matchesBoolean(value);}
    case "number": {return matchesNumber(value) && Number.isFinite(value);}
    case "integer": {return matchesNumber(value) && Number.isInteger(value);}
    case "string": {return matchesString(value);}
    case "array": {return Array.isArray(value);}
    case "object": {return isRecord(value);}
    default: {return false;}
  }
};

const kind = (value: unknown): string => {
  if (matchesNull(value)) {return "null";}
  if (Array.isArray(value)) {return "an array";}
  if (matchesNumber(value)) {return Number.isInteger(value) ? "an integer" : "a number";}
  if (hasObjectType(value)) {return "an object";}
  return `a ${typeof value}`;
};

export const equal = function equal(left: unknown, right: unknown): boolean {
  if (left === right) {return true;}
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) {return false;}
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]));
};

const multiple = (value: number, of: number): boolean => {
  const quotient = value / of;
  // Decimal multiples allow a small rounding error. An overflowing quotient uses the remainder.
  if (Number.isFinite(quotient)) {return Math.abs(quotient - Math.round(quotient)) < MULTIPLE_ROUNDING_TOLERANCE;}
  return value % of === ZERO;
};

const numberFailure = (schema: Keywords, value: number): string | undefined => {
  if (matchesNumber(schema.multipleOf) && !multiple(value, schema.multipleOf)) {return `must be a multiple of ${schema.multipleOf}`;}
  if (matchesNumber(schema.maximum) && value > schema.maximum) {return `must be at most ${schema.maximum}`;}
  if (matchesNumber(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) {return `must be less than ${schema.exclusiveMaximum}`;}
  if (matchesNumber(schema.minimum) && value < schema.minimum) {return `must be at least ${schema.minimum}`;}
  return matchesNumber(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum
    ? `must be more than ${schema.exclusiveMinimum}`
    : undefined;
};

const stringFailure = (schema: Keywords, value: string): string | undefined => {
  // JSON Schema counts Unicode code points, including combining characters.
  const length = Iterator.from(value).reduce((count) => count + CODE_POINT_STEP, ZERO);
  if (matchesNumber(schema.maxLength) && length > schema.maxLength) {return `must be at most ${schema.maxLength} characters long`;}
  if (matchesNumber(schema.minLength) && length < schema.minLength) {return `must be at least ${schema.minLength} characters long`;}
  if (matchesString(schema.pattern) && !regex(schema.pattern).test(value)) {return `must match the pattern ${schema.pattern}`;}
  if (matchesString(schema.format) && !matchesJsonFormat(schema.format, value)) {return `must be a ${schema.format}`;}
  return undefined;
};

const literalFailure = (schema: Keywords, value: unknown): string | undefined => {
  if (!matchesUndefined(schema.type)) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => is(type, value))) {return `must be ${types.join(" or ")}, got ${kind(value)}`;}
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equal(item, value))) {
    return `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
  }
  if ("const" in schema && !equal(schema.const, value)) {return `must be ${JSON.stringify(schema.const)}`;}
  return undefined;
};

export const basicFailure = (schema: Keywords, value: unknown): string | undefined => {
  const message = literalFailure(schema, value);
  if (!matchesUndefined(message)) {return message;}
  if (matchesNumber(value)) {return numberFailure(schema, value);}
  if (matchesString(value)) {return stringFailure(schema, value);}
  return undefined;
};

// Escapes one segment of a JSON Pointer.
export const pointer = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");
