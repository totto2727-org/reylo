import { matchesUndefined } from "./native-predicates.ts";

const FIRST_BYTE = 0;
const AFTER_LAST_BYTE = 1;
const CODE_UNIT_STEP = 1;
const SURROGATE_PAIR_WIDTH = 2;
const ASCII_LIMIT = 0x80;
const THREE_BYTE_MINIMUM = 0xE0;
const FOUR_BYTE_MINIMUM = 0xF0;
const ASCII_WIDTH = 1;
const TWO_BYTE_WIDTH = 2;
const THREE_BYTE_WIDTH = 3;
const FOUR_BYTE_WIDTH = 4;
const FIRST_LINE_INDEX = 0;
const INDEX_DIVISOR = 2;
const ONE_BASED = 1;
const NO_NEWLINE = -1;

interface Position { column: number; line: number }
interface Range extends Position { endColumn: number; endLine: number }
type Place = (start: number, length: number) => Range;

const byteWidth = (lead: number): number => {
  if (lead < ASCII_LIMIT) {return ASCII_WIDTH;}
  if (lead < THREE_BYTE_MINIMUM) {return TWO_BYTE_WIDTH;}
  if (lead < FOUR_BYTE_MINIMUM) {return THREE_BYTE_WIDTH;}
  return FOUR_BYTE_WIDTH;
};

const byteOffsets = (sql: string): Uint32Array => {
  const bytes = new TextEncoder().encode(sql);
  const index = new Uint32Array(bytes.length + AFTER_LAST_BYTE);
  const cursor = { byte: FIRST_BYTE, codeUnit: FIRST_BYTE };
  while (cursor.byte < bytes.length) {
    const width = byteWidth(bytes[cursor.byte] ?? ASCII_LIMIT);
    index.fill(cursor.codeUnit, cursor.byte, cursor.byte + width);
    cursor.byte += width;
    cursor.codeUnit += width === FOUR_BYTE_WIDTH ? SURROGATE_PAIR_WIDTH : CODE_UNIT_STEP;
  }
  index[bytes.length] = sql.length;
  return index;
};

const lineOffsets = (sql: string): number[] => {
  const starts = [FIRST_LINE_INDEX];
  const cursor = { newline: sql.indexOf("\n") };
  while (cursor.newline !== NO_NEWLINE) {
    const next = cursor.newline + CODE_UNIT_STEP;
    starts.push(next);
    cursor.newline = sql.indexOf("\n", next);
  }
  return starts;
};

const upperLine = (starts: number[], offset: number): number => {
  const search = { high: starts.length - ONE_BASED, low: FIRST_LINE_INDEX };
  while (search.low < search.high) {
    const middle = Math.floor((search.low + search.high + ONE_BASED) / INDEX_DIVISOR);
    if ((starts[middle] ?? Number.NaN) <= offset) {search.low = middle;}
    else {search.high = middle - ONE_BASED;}
  }
  return search.low;
};

const position = (starts: number[], offset: number | undefined): Position => {
  const codeUnit = matchesUndefined(offset) ? Number.NaN : offset;
  const line = upperLine(starts, codeUnit);
  return { column: codeUnit - (starts[line] ?? Number.NaN) + ONE_BASED, line: line + ONE_BASED };
};

/**
 * Convert engine byte ranges to the playground's UTF-16 editor positions.
 * @param {string} sql - The input statement.
 * @returns {Place} A function that places a zero-based byte range in the editor.
 */
export const placer = function placer(sql: string): Place {
  const offsets = byteOffsets(sql);
  const starts = lineOffsets(sql);
  const last = offsets.length - AFTER_LAST_BYTE;
  const at = (byte: number): Position => position(starts, offsets[Math.max(FIRST_BYTE, Math.min(byte, last))]);
  return (start, length) => {
    const first = at(start);
    const end = at(start + length);
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the playground diagnostic range's JSON order.
    return { line: first.line, column: first.column, endLine: end.line, endColumn: end.column };
  };
};
