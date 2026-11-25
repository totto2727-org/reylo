import { matchesUndefined } from "./native-predicates.ts";

export const MYSQL_PACKET_HEADER_BYTES = 4;
export const MYSQL_LENGTH_BYTES = 3;
const FIRST_PACKET_BYTE = 0;
const STRING_TERMINATOR = 0;
const STRING_TERMINATOR_BYTES = 1;
const MYSQL_PROTOCOL_V10 = 10;
const MYSQL_GREETING_VERSION_START = 1;
const MYSQL_THREAD_ID_BYTES = 4;
const MYSQL_GREETING_SEED_BYTES = 8;
const MYSQL_GREETING_FILLER_BYTES = 1;
const MYSQL_LOWER_CAPABILITY_BYTES = 2;
const MYSQL_HANDSHAKE_HEADER_BYTES = 32;
const MYSQL_SSL_CAPABILITY = 0x08_00;
const NOT_FOUND = -1;
const MYSQL_INLINE_LENGTH_LIMIT = 0xFB;
const MYSQL_LENGTH_TWO_BYTE_TAG = 0xFC;
const MYSQL_LENGTH_THREE_BYTE_TAG = 0xFD;
const MYSQL_LENGTH_EIGHT_BYTE_TAG = 0xFE;
const MYSQL_LENGTH_TWO_BYTES = 2;
const MYSQL_LENGTH_THREE_BYTES = 3;
const MYSQL_LENGTH_EIGHT_BYTES = 8;
const MYSQL_LENGTH_TWO_BYTE_LIMIT = 0x1_00_00;
const MYSQL_LENGTH_THREE_BYTE_LIMIT = 0x1_00_00_00;
const MYSQL_LENGTH_TAG_BYTES = 1;
const MYSQL_AUTH_LENGTH_BYTES = 1;
const MAX_BUFFER_INTEGER_BYTES = 6;

const CONNECT_WITH_DB = 0x8;
const SECURE_CONNECTION = 0x80_00;
const PLUGIN_AUTH = 0x8_00_00;
const CONNECT_ATTRS = 0x10_00_00;
const LENENC_AUTH = 0x20_00_00;

export const mysqlPacket = (stream: Buffer): { payload: Buffer } | undefined => {
  if (stream.length < MYSQL_PACKET_HEADER_BYTES) {return undefined;}
  const length = stream.readUIntLE(FIRST_PACKET_BYTE, MYSQL_LENGTH_BYTES);
  const packetEnd = MYSQL_PACKET_HEADER_BYTES + length;
  return stream.length < packetEnd ? undefined : { payload: stream.subarray(MYSQL_PACKET_HEADER_BYTES, packetEnd) };
};

// The local socket bridge does not forward TLS.
export const withoutTls = (greeting: Buffer): void => {
  const versionEnd = greeting.indexOf(STRING_TERMINATOR, MYSQL_GREETING_VERSION_START);
  const capabilityOffset = versionEnd + STRING_TERMINATOR_BYTES +
    MYSQL_THREAD_ID_BYTES + MYSQL_GREETING_SEED_BYTES + MYSQL_GREETING_FILLER_BYTES;
  if (greeting[FIRST_PACKET_BYTE] === MYSQL_PROTOCOL_V10 &&
    capabilityOffset + MYSQL_LOWER_CAPABILITY_BYTES <= greeting.length) {
    // oxlint-disable-next-line eslint/no-bitwise -- Retain every other MySQL capability stored in this native bit field.
    greeting.writeUInt16LE(greeting.readUInt16LE(capabilityOffset) & ~MYSQL_SSL_CAPABILITY, capabilityOffset);
  }
};

const has = (capabilities: number, capability: number): boolean =>
  // oxlint-disable-next-line eslint/no-bitwise -- MySQL encodes capabilities as a bit field in the client header.
  Boolean(capabilities & capability);

interface LengthEncoding {
  length: number;
  marker: number;
}

const TWO_BYTES: LengthEncoding = { length: MYSQL_LENGTH_TWO_BYTES, marker: MYSQL_LENGTH_TWO_BYTE_TAG };
const THREE_BYTES: LengthEncoding = { length: MYSQL_LENGTH_THREE_BYTES, marker: MYSQL_LENGTH_THREE_BYTE_TAG };
const EIGHT_BYTES: LengthEncoding = { length: MYSQL_LENGTH_EIGHT_BYTES, marker: MYSQL_LENGTH_EIGHT_BYTE_TAG };

const encodeSize = (value: number): LengthEncoding => {
  if (value < MYSQL_LENGTH_TWO_BYTE_LIMIT) {return TWO_BYTES;}
  return value < MYSQL_LENGTH_THREE_BYTE_LIMIT ? THREE_BYTES : EIGHT_BYTES;
};

const decodeSize = (marker: number): number => {
  if (marker === MYSQL_LENGTH_TWO_BYTE_TAG) {return MYSQL_LENGTH_TWO_BYTES;}
  return marker === MYSQL_LENGTH_THREE_BYTE_TAG ? MYSQL_LENGTH_THREE_BYTES : MYSQL_LENGTH_EIGHT_BYTES;
};

const lenenc = (value: number): Buffer => {
  if (value < MYSQL_INLINE_LENGTH_LIMIT) {return Buffer.from([value]);}
  const { length, marker } = encodeSize(value);
  const out = Buffer.alloc(MYSQL_LENGTH_TAG_BYTES + length);
  out[FIRST_PACKET_BYTE] = marker;
  out.writeUIntLE(value, MYSQL_LENGTH_TAG_BYTES, Math.min(length, MAX_BUFFER_INTEGER_BYTES));
  return out;
};

const incomplete = (message: string): RangeError =>
  // oxlint-disable-next-line rules/require-tagged-error -- Incomplete reads share the packet parser's internal synchronous rejection path.
  new RangeError(message);

class LoginCursor {
  #login: Buffer;
  #offset = MYSQL_HANDSHAKE_HEADER_BYTES;

  public constructor(login: Buffer) {
    this.#login = login;
  }

  public get offset(): number {
    return this.#offset;
  }

  public integer(): number {
    const marker = this.#login[this.#offset];
    this.#offset += MYSQL_LENGTH_TAG_BYTES;
    if (matchesUndefined(marker)) {throw incomplete("short");}
    if (marker < MYSQL_INLINE_LENGTH_LIMIT) {return marker;}
    const size = decodeSize(marker);
    const value = this.#login.readUIntLE(this.#offset, Math.min(size, MAX_BUFFER_INTEGER_BYTES));
    this.#offset += size;
    return value;
  }

  public bytes(length: number): Buffer {
    const end = this.#offset + length;
    if (end > this.#login.length) {throw incomplete("short");}
    const value = this.#login.subarray(this.#offset, end);
    this.#offset = end;
    return value;
  }

  public skipString(): void {
    const end = this.#login.indexOf(STRING_TERMINATOR, this.#offset);
    if (end === NOT_FOUND) {throw incomplete("unterminated");}
    this.#offset = end + STRING_TERMINATOR_BYTES;
  }

  #skipAuthentication(capabilities: number): void {
    if (has(capabilities, LENENC_AUTH)) {
      this.bytes(this.integer());
    } else if (has(capabilities, SECURE_CONNECTION)) {
      this.bytes(this.bytes(MYSQL_AUTH_LENGTH_BYTES).readUInt8(FIRST_PACKET_BYTE));
    } else {this.skipString();}
  }

  public skipPreamble(capabilities: number): void {
    this.skipString();
    this.#skipAuthentication(capabilities);
    if (has(capabilities, CONNECT_WITH_DB)) {this.skipString();}
    if (has(capabilities, PLUGIN_AUTH)) {this.skipString();}
  }

  public text(): string {
    return this.bytes(this.integer()).toString("utf8");
  }
}

interface Attribute {
  login: Buffer;
  value: string;
}

interface AttributeWindow {
  after: number;
  end: number;
  lengthAt: number;
  pairAt: number;
  start: number;
}

const removeAttribute = (login: Buffer, { after, end, lengthAt, pairAt, start }: AttributeWindow): Buffer => {
  const rest = Buffer.concat([login.subarray(start, pairAt), login.subarray(after, end)]);
  return Buffer.concat([login.subarray(FIRST_PACKET_BYTE, lengthAt), lenenc(rest.length), rest, login.subarray(end)]);
};

const attributesWindow = (cursor: LoginCursor): { end: number; lengthAt: number; start: number } => {
  const lengthAt = cursor.offset;
  const length = cursor.integer();
  const start = cursor.offset;
  return { end: start + length, lengthAt, start };
};

const readAttribute = (login: Buffer, name: string, cursor: LoginCursor): Attribute | undefined => {
  const { end, lengthAt, start } = attributesWindow(cursor);
  while (cursor.offset < end) {
    const pairAt = cursor.offset;
    const key = cursor.text();
    const value = cursor.text();
    if (key === name) {
      // oxlint-disable-next-line eslint/sort-keys -- Keep the existing field order of the decoded attribute.
      return { value, login: removeAttribute(login, { after: cursor.offset, end, lengthAt, pairAt, start }) };
    }
  }
  return undefined;
};

/**
 * Reads a login attribute and removes it from the forwarded login.
 * @param {Buffer} login The native MySQL login payload.
 * @param {string} name The attribute to remove.
 * @returns {{ value: string; login: Buffer } | undefined} The attribute and updated login if present.
 */
export const takeAttribute = function takeAttribute(login: Buffer, name: string): { value: string; login: Buffer } | undefined {
  if (login.length < MYSQL_HANDSHAKE_HEADER_BYTES) {return undefined;}
  const capabilities = login.readUInt32LE(FIRST_PACKET_BYTE);
  if (has(capabilities, MYSQL_SSL_CAPABILITY) || !has(capabilities, CONNECT_ATTRS)) {return undefined;}
  const cursor = new LoginCursor(login);
  try {
    cursor.skipPreamble(capabilities);
    return readAttribute(login, name, cursor);
  } catch {
    return undefined;
  }
};
