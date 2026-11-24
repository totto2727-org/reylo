/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
import { graphemeClusters, scanStringLit } from './scanner.ts';
import type { Diagnostic, Pos, Range, Token } from './types.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const FIRST_BYTE = 0;
const SELECTOR_BYTE = 1;
const ESCAPE_HEADER_BYTES = 2;
const ASCII_DOUBLE_QUOTE = 34;
const ASCII_DOLLAR = 36;
const ASCII_PERCENT = 37;
const ASCII_BACKSLASH = 92;
const ASCII_CR = 13;
const ASCII_LF = 10;
const ASCII_TEMPLATE_OPEN = 123;
const ASCII_LOWER_N = 110;
const ASCII_LOWER_R = 114;
const ASCII_LOWER_T = 116;
const ASCII_LITTLE_U = 117;
const ASCII_CAPITAL_U = 85;
const TEMPLATE_OPEN_BYTE = 2;
const ESCAPED_TEMPLATE_BYTES = 3;
const SHORT_UNICODE_ESCAPE_BYTES = 6;
const LONG_UNICODE_ESCAPE_BYTES = 10;
const HEX_RADIX = 16;
const MINIMUM_HEX_WIDTH = 4;
const MAX_UNICODE_CODE_POINT = 0x10_FF_FF;
const FIRST_SURROGATE = 0xD8_00;
const LAST_SURROGATE = 0xDF_FF;
const INITIAL_COLUMN = 1;
const POSITION_STEP = 1;
const EMPTY_LENGTH = 0;

const simpleEscapes: Record<number, string> = {
  [ASCII_BACKSLASH]: '\\',
  [ASCII_DOUBLE_QUOTE]: '"',
  [ASCII_LOWER_N]: '\n',
  [ASCII_LOWER_R]: '\r',
  [ASCII_LOWER_T]: '\t',
};

interface StringParseResult {
  diagnostics: Diagnostic[];
  value: string;
}

interface StringScan {
  diagnostics: Diagnostic[];
  end: Pos;
  output: Uint8Array[];
}

type DecodedSlice = { bytes: Uint8Array } | { bytes: Uint8Array; detail: string };

const advancePosition = (start: Pos, slice: Uint8Array): Pos => {
  const position = { ...start };
  graphemeClusters(slice).forEach((cluster) => {
    position.byte += cluster.length;
    if (cluster[FIRST_BYTE] === ASCII_CR || cluster[FIRST_BYTE] === ASCII_LF) {
      position.line += POSITION_STEP;
      position.column = INITIAL_COLUMN;
    } else {
      position.column += POSITION_STEP;
    }
  });
  return position;
};

const decodeUnicode = (bytes: Uint8Array, selector: number): DecodedSlice => {
  if (selector === ASCII_LITTLE_U && bytes.length !== SHORT_UNICODE_ESCAPE_BYTES) {
    return { bytes, detail: String.raw`The \u escape sequence must be followed by four hexadecimal digits.` };
  }
  if (selector === ASCII_CAPITAL_U && bytes.length !== LONG_UNICODE_ESCAPE_BYTES) {
    return { bytes, detail: String.raw`The \U escape sequence must be followed by eight hexadecimal digits.` };
  }
  const codePoint = Number.parseInt(decoder.decode(bytes.subarray(ESCAPE_HEADER_BYTES)), HEX_RADIX);
  if (codePoint > MAX_UNICODE_CODE_POINT || (codePoint >= FIRST_SURROGATE && codePoint <= LAST_SURROGATE)) {
    return { bytes, detail: `Cannot encode character U+${codePoint.toString(HEX_RADIX).padStart(MINIMUM_HEX_WIDTH, '0')} in UTF-8.` };
  }
  return { bytes: encoder.encode(String.fromCodePoint(codePoint)) };
};

const decodeEscape = (slice: Uint8Array): DecodedSlice => {
  const selector = slice[SELECTOR_BYTE] ?? FIRST_BYTE;
  if (slice.length < ESCAPE_HEADER_BYTES) {
    return { bytes: slice, detail: 'Backslash must be followed by an escape sequence selector character.' };
  }
  const escape = simpleEscapes[selector] ?? '';
  if (escape.length > EMPTY_LENGTH) {return { bytes: encoder.encode(escape) };}
  if (selector === ASCII_LITTLE_U || selector === ASCII_CAPITAL_U) {return decodeUnicode(slice, selector);}
  const bytes = slice.subarray(SELECTOR_BYTE);
  return { bytes, detail: `The symbol ${JSON.stringify(decoder.decode(bytes))} is not a valid escape sequence selector.` };
};

const decodeSlice = (slice: Uint8Array, quoted: boolean): DecodedSlice => {
  const starts = slice[FIRST_BYTE];
  if (quoted && starts === ASCII_BACKSLASH) {return decodeEscape(slice);}
  const templateMarker = starts === ASCII_DOLLAR || starts === ASCII_PERCENT;
  if (templateMarker && slice.length === ESCAPED_TEMPLATE_BYTES && slice[SELECTOR_BYTE] === starts &&
      slice[TEMPLATE_OPEN_BYTE] === ASCII_TEMPLATE_OPEN) {
    return { bytes: slice.subarray(SELECTOR_BYTE) };
  }
  return { bytes: slice };
};

const invalidEscape = (detail: string, subject: Range): Diagnostic =>
  // oxlint-disable-next-line eslint/sort-keys -- This is the diagnostic field order retained by the HCL port.
  ({ severity: 'error', summary: 'Invalid escape sequence', detail, subject });

const appendSlice = (scan: StringScan, slice: Uint8Array, token: Token): void => {
  if (slice.length === EMPTY_LENGTH) {return;}
  const start = scan.end;
  scan.end = advancePosition(start, slice);
  const decoded = decodeSlice(slice, token.type === 'TokenQuotedLit');
  if ('detail' in decoded) {
    // oxlint-disable-next-line eslint/sort-keys -- Keep the serialized source range in the HCL diagnostic's existing order.
    const range = { filename: token.range.filename, start: { ...start }, end: { ...scan.end } };
    scan.diagnostics.push(invalidEscape(decoded.detail, range));
  }
  scan.output.push(decoded.bytes);
};

const join = (output: Uint8Array[]): string => {
  const length = output.reduce((total, slice) => total + slice.length, EMPTY_LENGTH);
  const joined = new Uint8Array(length);
  // oxlint-disable-next-line rules/no-let -- The offset advances as each scanned slice is copied into the final byte buffer.
  let offset = FIRST_BYTE;
  output.forEach((slice) => {
    joined.set(slice, offset);
    offset += slice.length;
  });
  return decoder.decode(joined);
};

/**
 * Resolve the scanner's literal slices, retaining byte and grapheme diagnostic ranges.
 * @param {Token} token - A quoted or bare string token from the scanner.
 * @returns {StringParseResult} The decoded text and invalid escape diagnostics.
 */
export const parseStringLiteralToken = (token: Token): StringParseResult => {
  if (token.type !== 'TokenQuotedLit' && token.type !== 'TokenStringLit') {
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native error for callers supplying the wrong token.
    throw new Error('parseStringLiteralToken can only be used with TokenStringLit and TokenQuotedLit tokens');
  }
  const scan: StringScan = { diagnostics: [], end: { ...token.range.start }, output: [] };
  scanStringLit(token.bytes, token.type === 'TokenQuotedLit').forEach((slice) => {
    appendSlice(scan, slice, token);
  });
  // oxlint-disable-next-line eslint/sort-keys -- Preserve field order for callers serializing the literal parse result.
  return { value: join(scan.output), diagnostics: scan.diagnostics };
};
