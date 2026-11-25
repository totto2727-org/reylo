// These values run in generated modules, including projects without Node or DOM types.
interface BufferBytes extends Uint8Array {
  readUInt8: (offset?: number) => number;
  toString: (encoding?: "utf8") => string;
}

interface BufferClass {
  from: (data: string, encoding: "hex") => Uint8Array;
  // oxlint-disable-next-line rules/no-type-predicate -- The platform's Buffer predicate narrows to the native Buffer overload without Node ambient types.
  isBuffer: (value: unknown) => value is BufferBytes;
}

interface Utf8Decoder {
  decode: (bytes: Uint8Array) => string;
}

const { Buffer: NodeBuffer } = globalThis as { Buffer?: BufferClass };
// Every supported runtime supplies TextDecoder even when the consumer has no Node or DOM types.
const { TextDecoder: Utf8 } = globalThis as typeof globalThis & { TextDecoder: new (label?: string) => Utf8Decoder };
const utf8Decoder = new Utf8("utf8");

const { fromHex } = Uint8Array as { prototype: Uint8Array; fromHex?: (hex: string) => Uint8Array };

// Buffer decodes with its own policy, including retaining the UTF-8 byte order mark.
export const utf8 = function utf8(bytes: Uint8Array): string {
  if (NodeBuffer?.isBuffer(bytes) === true) {return bytes.toString("utf8");}
  return utf8Decoder.decode(bytes);
};

const TEXT_START = 0;
const BYTE_ESCAPE = "\\";
const BYTE_HEX_PREFIX = String.raw`\x`;
const HEX_DIGITS_PER_BYTE = 2;
const HEX_RADIX = 16;
const OCTAL_DIGITS_PER_BYTE = 3;
const OCTAL_RADIX = 8;
const BACKSLASH_BYTE = 0x5C;

const hexBytes = (hex: string): Uint8Array => {
  if (NodeBuffer) {return NodeBuffer.from(hex, "hex");}
  if (fromHex) {return fromHex(hex);}
  return Uint8Array.from({ length: hex.length / HEX_DIGITS_PER_BYTE }, (_unused, index) => {
    const start = index * HEX_DIGITS_PER_BYTE;
    return Number.parseInt(hex.slice(start, start + HEX_DIGITS_PER_BYTE), HEX_RADIX);
  });
};

interface ByteCursor {
  offset: number;
  text: string;
}

const readEscape = (cursor: ByteCursor, afterEscape: number): number => {
  if (cursor.text[afterEscape] === BYTE_ESCAPE) {
    cursor.offset = afterEscape + BYTE_ESCAPE.length;
    return BACKSLASH_BYTE;
  }
  cursor.offset = afterEscape + OCTAL_DIGITS_PER_BYTE;
  return Number.parseInt(cursor.text.slice(afterEscape, cursor.offset), OCTAL_RADIX);
};

const readByte = (cursor: ByteCursor): number => {
  const { offset, text } = cursor;
  const afterEscape = offset + BYTE_ESCAPE.length;
  if (text[offset] === BYTE_ESCAPE) {return readEscape(cursor, afterEscape);}
  cursor.offset = afterEscape;
  // oxlint-disable-next-line unicorn/prefer-code-point -- Bytea's fallback consumes a UTF-16 code unit at a time, including escape text a driver passes through.
  return text.charCodeAt(offset);
};

/**
 * @param {string} text - The PostgreSQL bytea text in the default hex or escape format.
 * @returns {Uint8Array} The bytes in their original order.
 */
export const bytea = function bytea(text: string): Uint8Array {
  if (text.startsWith(BYTE_HEX_PREFIX)) {return hexBytes(text.slice(BYTE_HEX_PREFIX.length));}
  const bytes: number[] = [];
  const cursor = { offset: TEXT_START, text };
  while (cursor.offset < text.length) {bytes.push(readByte(cursor));}
  return Uint8Array.from(bytes);
};
