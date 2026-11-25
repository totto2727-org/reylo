import { matchesBigInt, matchesBoolean, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
// oxlint-disable-next-line rules/require-tagged-error, unicorn/custom-error-definition -- Keep the native TypeError name and DecodeError constructor identity used by generated queries.
export class DecodeError extends TypeError {}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const INTEGER = /^[+-]?\d+$/u;

const outOfRange = (value: string, column: string, rounded = false): DecodeError => new DecodeError(
  rounded
    ? `Column "${column}" holds an integer past ±(2^53 - 1), which the driver already rounded to ${value}: a number cannot hold it exactly, so Reylo refuses it rather than return a rounded value. Cast it to text in the statement (cast(${column} as text)) to read it exactly.`
    : `Column "${column}" holds ${value}, an integer past ±(2^53 - 1), which a number cannot hold exactly, so Reylo refuses it rather than return a rounded value. Cast it to text in the statement (cast(${column} as text)) to read it exactly.`,
);

/**
 * Reads an integer as a number where it fits exactly.
 * @param {number | bigint} value The driver's decoded integer.
 * @param {string} column The column reported in diagnostics.
 * @returns {number} The exact JavaScript number.
 */
export const exactInteger = function exactInteger(value: number | bigint, column: string): number {
  const wide = matchesBigInt(value);
  // Outside the safe range a BigInt converts to a number with a magnitude of at least 2^53.
  const numeric = wide ? Number(value) : value;
  if (numeric > MAX_SAFE || numeric < -MAX_SAFE) {throw outOfRange(String(value), column, !wide);}
  return numeric;
};

/**
 * Reads a 64-bit SQL integer as a BigInt and preserves other native representations.
 * @param {number | bigint | string} value The value returned by the driver.
 * @param {string} column The column reported in diagnostics.
 * @returns {unknown} The wide integer or the driver's non-integer value.
 */
export const bigInteger = function bigInteger(value: number | bigint | string, column: string): unknown {
  if (matchesBigInt(value)) {return value;}
  if (matchesString(value)) {return INTEGER.test(value) ? BigInt(value) : value;}
  if (Number.isSafeInteger(value)) {return BigInt(value);}
  if (Number.isInteger(value)) {
    throw new DecodeError(`Column "${column}" is a 64-bit integer, and the driver already rounded its value to ${value}, past ±(2^53 - 1): Reylo refuses it rather than return a BigInt of a rounded value.`);
  }
  return value;
};

const FALSE_VALUE = 0;
const TRUE_VALUE = 1;
const FALSE_BIGINT = BigInt(FALSE_VALUE);
const TRUE_BIGINT = BigInt(TRUE_VALUE);
const BIT_BYTE_COUNT = 1;
const FIRST_BIT_BYTE = 0;
const HEX_DIGITS_PER_BYTE = 2;
const HEX_RADIX = 16;

const binaryText = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0")).join("");

const showTruth = (value: unknown): string => {
  if (value instanceof Uint8Array) {return `the bytes 0x${binaryText(value)}`;}
  return matchesString(value) ? JSON.stringify(value) : String(value);
};

/**
 * Reports a value that cannot represent SQL truth.
 * @param {string} column The column reported in the diagnostic.
 * @param {string} shown The displayed form of the supplied value.
 * @returns {never} Always throws the native decoding error.
 */
export const refuseTruth = function refuseTruth(column: string, shown: string): never {
  throw new DecodeError(
    `Column "${column}" is a boolean, stored as 0 or 1, and holds ${shown}, which is neither: the database does not hold the column to 0 and 1, so Reylo refuses the value rather than guess its truth. Store 0 or 1 in it, or read the stored number with ${column} + 0 in the statement.`,
  );
};

const textTruth = (value: string): boolean | undefined => {
  if (value === "t" || value === "true" || value === "1") {return true;}
  if (value === "f" || value === "false" || value === "0") {return false;}
  return undefined;
};

const primitiveTruth = (value: unknown): boolean | undefined => {
  if (matchesBoolean(value)) {return value;}
  if (matchesNumber(value) && (value === FALSE_VALUE || value === TRUE_VALUE)) {return value === TRUE_VALUE;}
  if (matchesBigInt(value) && (value === FALSE_BIGINT || value === TRUE_BIGINT)) {return value === TRUE_BIGINT;}
  return matchesString(value) ? textTruth(value) : undefined;
};

const byteTruth = (value: unknown): boolean | undefined => {
  if (!(value instanceof Uint8Array) || value.length !== BIT_BYTE_COUNT) {return undefined;}
  const bit = value[FIRST_BIT_BYTE];
  return !matchesUndefined(bit) && bit <= TRUE_VALUE ? value[FIRST_BIT_BYTE] === TRUE_VALUE : undefined;
};

/**
 * Reads a SQL truth value from the driver's boolean, bit, number or text.
 * @param {unknown} value The driver's value.
 * @param {string} column The column reported in diagnostics.
 * @returns {boolean} Its boolean representation.
 */
export const truth = function truth(value: unknown, column: string): boolean {
  const decoded = primitiveTruth(value) ?? byteTruth(value);
  return decoded ?? refuseTruth(column, showTruth(value));
};

const EMPTY_REMAINDER = 0;
const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;

/**
 * Reads little-endian 32-bit floats from a driver's vector bytes.
 * @param {Uint8Array} bytes The bytes returned by the driver.
 * @param {string} column The column reported in diagnostics.
 * @returns {number[]} Decoded floats in input order.
 */
export const float32s = function float32s(bytes: Uint8Array, column: string): number[] {
  if (bytes.byteLength % FLOAT32_BYTES !== EMPTY_REMAINDER) {
    throw new DecodeError(`Column "${column}" is a VECTOR, whose value is 4 bytes per 32-bit float, and holds ${bytes.byteLength} bytes.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / FLOAT32_BYTES }, (_unused, index) => view.getFloat32(index * FLOAT32_BYTES, true));
};
