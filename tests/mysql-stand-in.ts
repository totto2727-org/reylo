// A MySQL server stand-in for the type check's tests: enough of MySQL's client/server protocol for
// The engine's own driver to log in, run text queries and quit, over a real socket. It answers
// `select version()` with the version a test sets and every other query with one row, refuses a
// Password it does not take as MySQL does (error 1045, at the login), and closes the connection on a
// Prepare, so an analysis on it fails as on a server that went away. Each password tried is recorded
// By its name among the ones a test may try, since the login carries only its scramble.
// oxlint-disable-next-line rules/no-node-imports -- The stand-in uses Node's native SHA-1 and entropy to speak the driver protocol.
import { createHash, randomBytes } from "node:crypto";
// oxlint-disable-next-line rules/no-node-imports -- The test accepts real driver connections over a local Node socket.
import { createServer } from 'node:net';
// oxlint-disable-next-line rules/no-node-imports -- The fixture types the native sockets it owns.
import type { Socket } from 'node:net';
import { matchesNull, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";

export interface MysqlStandIn {
  port: number;
  /** Every query and statement the stand-in was sent, in order. */
  queries: string[];
  /** Every password a login tried, by its name in `passwords` ("?" for another). */
  tried: string[];
  /** How many logged-in connections are open. */
  open: () => number;
  /** Whether a connection said goodbye (COM_QUIT). */
  ended: () => boolean;
  close: () => Promise<void>;
}

const CLIENT = { CONNECT_WITH_DB: 0x8, FOUND_ROWS: 0x2, LONG_FLAG: 0x4, LONG_PASSWORD: 0x1, MULTI_RESULTS: 0x2_00_00, PLUGIN_AUTH: 0x8_00_00, PLUGIN_AUTH_LENENC_CLIENT_DATA: 0x20_00_00, PROTOCOL_41: 0x2_00, SECURE_CONNECTION: 0x80_00, TRANSACTIONS: 0x20_00 };
const NO_CAPABILITIES = 0;
const CAPABILITIES = Object.values(CLIENT).reduce((selected, flag) => selected + flag, NO_CAPABILITIES);
const PACKET_START = 0;
const PACKET_LENGTH_BYTES = 3;
const PACKET_HEADER_BYTES = 4;
const COMMAND_HEADER_BYTES = 1;
const FIRST_SERVER_REPLY = 1;
const HANDSHAKE_SEQUENCE = 0;
const HANDSHAKE_REPLY = 2;
const LOGIN_USER_OFFSET = 32;
const HANDSHAKE_VERSION = 10;
const HANDSHAKE_RESERVED_BYTES = 10;
const CONNECTION_ID = 1;
const EMPTY_LENGTH = 0;
const AVAILABLE_PORT = 0;
const CONNECTION_DELTA = 1;
const WORD_SIZE = 2;
const WORD_RANGE = 0x1_00_00;
const NUL = 0;
const AUTO_COMMIT = 2;
const NO_WARNINGS = 0;
const NO_ROWS_AFFECTED = 0;
const NO_LAST_INSERT = 0;
const CHARACTER_SET = 33;
const SALT_BYTES = 20;
const FIRST_SALT_PART_BYTES = 8;
const FIRST_PRINTABLE = 33;
const PRINTABLE_BYTES = 94;
const ONE_BYTE_LENGTH = 251;
const LENENC_UINT16 = 0xFC;
const LENENC_UINT16_BYTES = 3;
const LENENC_VALUE_OFFSET = 1;
const STRING_TERMINATOR_BYTES = 1;
const SCRAMBLE_LENGTH_BYTES = 1;
const DWORD_BYTES = 4;
const COLUMN_COUNT = 1;
const COLUMN_DEFINITION_LENGTH = 0x0C;
const MAX_COLUMN_WIDTH = 255;
const COLUMN_VARCHAR = 0xFD;
const NO_COLUMN_FLAGS = 0;
const COLUMN_DECIMALS = 0x1F;
const LOGIN_REFUSED = 1045;
const UNKNOWN_COMMAND = 1047;
const COM_QUIT = 0x01;
const COM_QUERY = 0x03;
const COM_PING = 0x0E;
const COM_STMT_PREPARE = 0x16;
const COM_STMT_CLOSE = 0x19;
const PACKET_OK = 0x00;
const PACKET_EOF = 0xFE;
const PACKET_ERR = 0xFF;

const sha1 = (...parts: Buffer[]): Buffer => createHash("sha1").update(Buffer.concat(parts)).digest();

// MySQL native authentication sends SHA1(password) XOR SHA1(scramble + SHA1(SHA1(password))).
const scrambled = (password: string, salt: Buffer): Buffer => {
  if (password.length === EMPTY_LENGTH) {return Buffer.alloc(EMPTY_LENGTH);}
  const once = sha1(Buffer.from(password));
  const mask = sha1(salt, sha1(once));
  // oxlint-disable-next-line eslint/no-bitwise -- The native-password challenge response is the bytewise XOR of the two hashes.
  return Buffer.from(once.map((byte, index) => byte ^ (mask[index] ?? NUL)));
};

const lenenc = (value: number): Buffer => {
  if (value < ONE_BYTE_LENGTH) {return Buffer.from([value]);}
  const bytes = Buffer.alloc(LENENC_UINT16_BYTES);
  bytes[PACKET_START] = LENENC_UINT16;
  bytes.writeUInt16LE(value, LENENC_VALUE_OFFSET);
  return bytes;
};
const str = (value: string): Buffer => Buffer.concat([lenenc(Buffer.byteLength(value)), Buffer.from(value)]);
const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(WORD_SIZE);
  bytes.writeUInt16LE(value, PACKET_START);
  return bytes;
};
const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(DWORD_BYTES);
  bytes.writeUInt32LE(value, PACKET_START);
  return bytes;
};
const OK = Buffer.concat([Buffer.from([PACKET_OK, NO_ROWS_AFFECTED, NO_LAST_INSERT]), u16(AUTO_COMMIT), u16(NO_WARNINGS)]);
const EOF = Buffer.concat([Buffer.from([PACKET_EOF]), u16(NO_WARNINGS), u16(AUTO_COMMIT)]);
const err = (code: number, state: string, message: string): Buffer => Buffer.concat([Buffer.from([PACKET_ERR]), u16(code), Buffer.from(`#${state}${message}`)]);

const resultPayloads = (name: string, value: string): Buffer[] => {
  const column = Buffer.concat([
    str("def"), str(""), str(""), str(""), str(name), str(""),
    Buffer.from([COLUMN_DEFINITION_LENGTH]), u16(CHARACTER_SET), u32(MAX_COLUMN_WIDTH),
    Buffer.from([COLUMN_VARCHAR]), u16(NO_COLUMN_FLAGS), Buffer.from([COLUMN_DECIMALS]), u16(NUL),
  ]);
  return [Buffer.from([COLUMN_COUNT]), column, EOF, str(value), EOF];
};

// HandshakeV10 writes the version, connection ID, salt, capabilities and authentication plugin.
const handshake = (version: string, salt: Buffer): Buffer => Buffer.concat([
  Buffer.from([HANDSHAKE_VERSION]), Buffer.from(`${version}\0`), u32(CONNECTION_ID),
  salt.subarray(PACKET_START, FIRST_SALT_PART_BYTES), Buffer.from([NUL]), u16(CAPABILITIES % WORD_RANGE),
  Buffer.from([CHARACTER_SET]), u16(AUTO_COMMIT), u16(Math.floor(CAPABILITIES / WORD_RANGE)),
  Buffer.from([SALT_BYTES + STRING_TERMINATOR_BYTES]), Buffer.alloc(HANDSHAKE_RESERVED_BYTES),
  salt.subarray(FIRST_SALT_PART_BYTES), Buffer.from([NUL]), Buffer.from("mysql_native_password\0"),
]);

interface StandInOptions {
  accepts?: () => string | undefined;
  passwords?: string[];
  version: string;
}

interface FixtureState {
  ended: boolean;
  open: number;
  queries: string[];
  sockets: Set<Socket>;
  tried: string[];
}

interface Connection {
  authenticated: boolean;
  fixture: FixtureState;
  options: StandInOptions;
  pending: Buffer;
  salt: Buffer;
  socket: Socket;
}

const send = (socket: Socket, sequence: number, payload: Buffer): void => {
  const header = Buffer.alloc(PACKET_HEADER_BYTES);
  header.writeUIntLE(payload.length, PACKET_START, PACKET_LENGTH_BYTES);
  header[PACKET_LENGTH_BYTES] = sequence;
  socket.write(Buffer.concat([header, payload]));
};

const readScramble = (packet: Buffer): Buffer => {
  // HandshakeResponse41 puts the user and the length-prefixed scramble after the fixed client header.
  const lengthOffset = packet.indexOf(NUL, LOGIN_USER_OFFSET) + STRING_TERMINATOR_BYTES;
  const start = lengthOffset + SCRAMBLE_LENGTH_BYTES;
  return packet.subarray(start, start + (packet[lengthOffset] ?? EMPTY_LENGTH));
};

const denyLogin = (socket: Socket): false => {
  send(socket, HANDSHAKE_REPLY, err(LOGIN_REFUSED, "28000", "Access denied for user 'root'@'localhost' (using password: YES)"));
  socket.end();
  return false;
};

const acceptLogin = (packet: Buffer, connection: Connection): boolean => {
  const { fixture, options, salt, socket } = connection;
  const scramble = readScramble(packet);
  fixture.tried.push(
    (options.passwords ?? []).find((password) => scrambled(password, salt).equals(scramble))
      ?? (scramble.length === EMPTY_LENGTH ? "" : "?"),
  );
  const wanted = options.accepts?.();
  if (!matchesUndefined(wanted) && !scrambled(wanted, salt).equals(scramble)) {return denyLogin(socket);}
  connection.authenticated = true;
  fixture.open += CONNECTION_DELTA;
  send(socket, HANDSHAKE_REPLY, OK);
  return true;
};

type CommandHandler = (text: string, connection: Connection) => void;

const replyToQuery: CommandHandler = (text, { fixture, options, socket }) => {
  fixture.queries.push(text);
  const wantsVersion = text === "select version()";
  resultPayloads(wantsVersion ? "version()" : "x", wantsVersion ? options.version : "x").forEach((payload, index) => {
    send(socket, index + FIRST_SERVER_REPLY, payload);
  });
};

const prepareCommand: CommandHandler = (text, { fixture, socket }) => {
  // Dropping the connection reproduces an analysis against a server that went away.
  fixture.queries.push(text);
  socket.destroy();
};

const quitCommand: CommandHandler = (_text, { fixture, socket }) => {
  fixture.ended = true;
  socket.end();
};

const commands = new Map<number, CommandHandler>([
  [COM_QUIT, quitCommand],
  [COM_QUERY, replyToQuery],
  [COM_PING, (_text, { socket }) => {send(socket, FIRST_SERVER_REPLY, OK);}],
  [COM_STMT_PREPARE, prepareCommand],
  [COM_STMT_CLOSE, () => {
    // The fixture drops prepare connections before allocating any statement.
  }],
]);

const runCommand = (packet: Buffer, connection: Connection): void => {
  const command = packet[PACKET_START];
  const handler = matchesUndefined(command) ? undefined : commands.get(command);
  if (matchesUndefined(handler)) {
    send(connection.socket, FIRST_SERVER_REPLY, err(UNKNOWN_COMMAND, "08S01", "Unknown command"));
    return;
  }
  handler(packet.subarray(COMMAND_HEADER_BYTES).toString("utf8"), connection);
};

const readPacket = (connection: Connection): Buffer | undefined => {
  const { pending } = connection;
  if (pending.length < PACKET_HEADER_BYTES) {return undefined;}
  const length = pending.readUIntLE(PACKET_START, PACKET_LENGTH_BYTES);
  const end = PACKET_HEADER_BYTES + length;
  if (pending.length < end) {return undefined;}
  connection.pending = pending.subarray(end);
  return pending.subarray(PACKET_HEADER_BYTES, end);
};

const attachConnection = (socket: Socket, fixture: FixtureState, options: StandInOptions): void => {
  fixture.sockets.add(socket);
  const salt = Buffer.from(randomBytes(SALT_BYTES).map((byte) => (byte % PRINTABLE_BYTES) + FIRST_PRINTABLE));
  const connection: Connection = { authenticated: false, fixture, options, pending: Buffer.alloc(EMPTY_LENGTH), salt, socket };
  socket.on("close", () => {
    fixture.sockets.delete(socket);
    if (connection.authenticated) {fixture.open -= CONNECTION_DELTA;}
  });
  socket.on("error", () => {
    // The fixture handles disconnects through the close listener.
  });
  socket.on("data", (data: Buffer) => {
    connection.pending = Buffer.concat([connection.pending, data]);
    while (connection.pending.length >= PACKET_HEADER_BYTES) {
      const packet = readPacket(connection);
      if (matchesUndefined(packet)) {return;}
      if (connection.authenticated) {
        runCommand(packet, connection);
      } else if (!acceptLogin(packet, connection)) {
        return;
      }
    }
  });
  send(socket, HANDSHAKE_SEQUENCE, handshake(options.version, salt));
};

/**
 * @param {StandInOptions} options - The server version and credentials used by the fixture.
 * @returns {Promise<MysqlStandIn>} An isolated loopback server and its observed driver activity.
 */
export const mysqlStandIn = async (options: StandInOptions): Promise<MysqlStandIn> => {
  const fixture: FixtureState = { ended: false, open: 0, queries: [], sockets: new Set(), tried: [] };
  const server = createServer((socket) => {attachConnection(socket, fixture, options);});
  // oxlint-disable-next-line promise/avoid-new -- Node's start callback marks when the loopback listener has acquired its free port.
  await new Promise<void>((resolve) => {server.listen(AVAILABLE_PORT, "127.0.0.1", resolve);});
  const address = server.address();
  if (matchesNull(address) || matchesString(address)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Failure to expose a TCP address is a native fixture setup error.
    throw new Error("The MySQL fixture did not open a TCP port.");
  }
  return {
    close: async () => {
      Iterator.from(fixture.sockets).forEach((socket) => {socket.destroy();});
      // oxlint-disable-next-line promise/avoid-new -- Node confirms all fixture connections are closed through this callback.
      await new Promise<void>((resolve) => {server.close(() => {resolve();});});
    },
    ended: () => fixture.ended,
    open: () => fixture.open,
    port: address.port,
    queries: fixture.queries,
    tried: fixture.tried,
  };
};
