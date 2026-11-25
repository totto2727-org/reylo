// What the host does to a database's URL before its engine opens it (src/engine.ts). The files a
// Postgres URL names (`sslrootcert`, `sslcert`, `sslkey`) are resolved as libpq resolves them, from
// This process's working directory, so that the engine, a process of its own, reads the same file;
// And a URL that names a Unix socket (Postgres's `host=/dir`, or `PGHOST=/dir` where the URL names
// No host, and mysql2's `socketPath`) is opened through a bridge, a TCP port on the loopback
// Interface that this thread pipes to the socket, since the engine connects over TCP alone
// (upstream engine/native). The server sees a connection on its socket, which peer authentication
// (Postgres's `peer`, MySQL's `auth_socket`) trusts as this process's user, so the bridge admits the
// Engine's own connections alone: each carries the bridge's token, which only the engine is given
// And the server never sees, and any other is closed before the server reads a byte of it.
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to compare the native protocol token with the host's timing-safe operation.
import { randomBytes, timingSafeEqual } from "node:crypto";
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to use native sockets and their close events.
import { createServer, connect } from 'node:net';
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to type the host's native address and socket.
import type { AddressInfo, Socket } from 'node:net';
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to resolve paths using the host platform's filesystem conventions.
import { resolve } from "node:path";
import { Unreachable } from "./connection.ts";
import { matchesUndefined } from "./native-predicates.ts";

/**
 * A URL as the engine opens it, the bridge's token where it goes through one, what to close with
 * the connection, and why the bridge could not open its socket, which the engine sees only as a
 * connection closed.
 */
export type HostUrl = { url: string; bridge?: string; close: () => void; failure?: () => Error | undefined };

/** The Postgres URL parameters that name a file. */
const FILES = ["sslrootcert", "sslcert", "sslkey"];

/** The connection attribute a MySQL login through the bridge carries its token in (upstream engine/native/src/mysql.rs). */
const MYSQL_ATTRIBUTE = "reylo_bridge";

/** How long a connection to the bridge may take to show its token. */
const TOKEN_TIMEOUT = 10_000;
const SCHEME_SEPARATOR = "://";
const DEFAULT_POSTGRES_PORT = "5432";
const MYSQL_PACKET_HEADER_BYTES = 4;
const MYSQL_LENGTH_BYTES = 3;
const MYSQL_PACKET_SEQUENCE_OFFSET = MYSQL_LENGTH_BYTES;
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
const BRIDGE_TOKEN_BYTES = 24;
const LOOPBACK = "127.0.0.1";
const EPHEMERAL_PORT = 0;
const EMPTY_BUFFER_BYTES = 0;
const URL_START = 0;
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

type SocketDialect = "postgres" | "mysql";

const splitQuery = function splitQuery(url: string): [string, string?] {
  const separator = "?";
  const queryStart = url.indexOf(separator);
  return queryStart === NOT_FOUND ? [url] : [url.slice(URL_START, queryStart), url.slice(queryStart + separator.length)];
};

const decodeQueryPart = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

const splitPair = function splitPair(pair: string): [string, string] {
  const separator = "=";
  const assignment = pair.indexOf(separator);
  return assignment === NOT_FOUND
    ? [decodeQueryPart(pair), ""]
    : [decodeQueryPart(pair.slice(URL_START, assignment)), decodeQueryPart(pair.slice(assignment + separator.length))];
};

const join = function join(base: string, pairs: string[]): string {
  return pairs.length ? `${base}?${pairs.join("&")}` : base;
};

const detectDialect = (url: string): SocketDialect | undefined => {
  const separator = url.indexOf(SCHEME_SEPARATOR);
  const scheme = separator === NOT_FOUND ? "" : url.slice(URL_START, separator).toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") {return "postgres";}
  if (scheme === "mysql") {return "mysql";}
  return undefined;
};

/** Find the authority after the scheme and user information and before the path. */
const authorityRange = (base: string): { end: number; start: number } => {
  const authorityStart = base.indexOf(SCHEME_SEPARATOR) + SCHEME_SEPARATOR.length;
  const pathStart = base.indexOf("/", authorityStart);
  const end = pathStart === NOT_FOUND ? base.length : pathStart;
  const firstAt = base.indexOf("@", authorityStart);
  const start = firstAt >= authorityStart && firstAt < end ? firstAt + "@".length : authorityStart;
  return { end, start };
};

/** `base` with its host and port replaced, its user, password and path kept. */
const withHost = (base: string, host: string): string => {
  const { end, start } = authorityRange(base);
  return `${base.slice(URL_START, start)}${host}${base.slice(end)}`;
};

const resolvePostgresFile = (pair: string): string => {
  const [key, value] = splitPair(pair);
  if (!FILES.includes(key) || value === "" || value === "system") {return pair;}
  return `${key}=${encodeURIComponent(resolve(value))}`;
};

/**
 * `url` as the engine opens it: files resolved, a Unix socket bridged. On Windows,
 * where Node opens no Unix socket, a Postgres URL that names one is an Unreachable that says so.
 */
export const hostUrl = async function hostUrl(url: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Promise<HostUrl> {
  const dialect = detectDialect(url);
  if (matchesUndefined(dialect)) {return { url, close: () => {} };}
  const postgres = dialect === "postgres";
  const [base, query = ""] = splitQuery(url);
  const options = query ? query.split("&") : [];
  const pairs = postgres ? options.map((pair) => resolvePostgresFile(pair)) : options;
  const socket = postgres ? postgresSocket(base, pairs, env) : mysqlSocket(pairs);
  if (!socket) {return { url: join(base, pairs), close: () => {} };}
  if (postgres && platform === "win32") {
    throw new Unreachable(new Error(`the URL names the Unix socket ${socket.path}, which Node cannot open on Windows: name the server's host and port, as host=localhost&port=5432`));
  }
  const token = randomBytes(BRIDGE_TOKEN_BYTES).toString("hex");
  const bridge = await openBridge(socket.path, dialect, token);
  const rest = pairs.filter((pair) => !socket.params.includes(splitPair(pair)[0]));
  return { url: join(withHost(base, `${LOOPBACK}:${bridge.port}`), rest), bridge: token, close: bridge.close, failure: bridge.failure };
};

/**
 * The socket file a Postgres URL names, as libpq reads it: a `host` that is a directory, in the
 * query or percent-encoded in the authority, or `PGHOST` where the URL names no host at all, and the
 * port's file in it (the URL's port, else `PGPORT`, else 5432).
 */
function postgresSocket(base: string, pairs: string[], env: Record<string, string | undefined>): { path: string; params: string[] } | undefined {
  const params = new Map(pairs.map((pair) => splitPair(pair)));
  const { end, start } = authorityRange(base);
  const authority = base.slice(start, end);
  const { encodedHost = "", port: authorityPort } = /^(?<encodedHost>.*?)(?::(?<port>\d+))?$/u.exec(authority)?.groups ?? {};
  const host = params.get("host") ?? (encodedHost ? decodeURIComponent(encodedHost) : (params.get("hostaddr") ? undefined : env.PGHOST));
  if (!host?.startsWith("/") || host.includes(",")) {return undefined;}
  const port = params.get("port") || authorityPort || env.PGPORT || DEFAULT_POSTGRES_PORT;
  return { path: `${host.replace(/\/$/u, "")}/.s.PGSQL.${port}`, params: ["host", "port", "sslmode"] };
}

/** The socket file a mysql2 URL names: `socketPath`, or `socket`. */
function mysqlSocket(pairs: string[]): { path: string; params: string[] } | undefined {
  const params = new Map(pairs.map((pair) => splitPair(pair)));
  const path = params.get("socketPath") || params.get("socket");
  // Its TLS settings too: the bridge takes TLS out of the server's greeting (`gateMysql`), and a
  // Unix socket carries none.
  return path ? { path, params: ["socketPath", "socket", "ssl", "ssl-mode", "sslmode", "ssl_mode", "sslaccept"] } : undefined;
}

/**
 * A TCP port on the loopback interface piped to the Unix socket at `path`, for the connections that
 * carry `token`: on Postgres the engine sends it before anything else; on MySQL, whose server speaks
 * first, the login carries it as a connection attribute, which the bridge reads in the client's
 * handshake and takes out of it before passing the handshake on, having taken TLS out of the
 * server's greeting so that the handshake is in plain text. None of its sockets keeps the process
 * alive.
 */
async function openBridge(path: string, dialect: "postgres" | "mysql", token: string): Promise<{ port: number; close: () => void; failure: () => Error | undefined }> {
  const open = new Set<Socket>();
  let failure: Error | undefined;
  const failed = (error: Error): void => {failure = new Error(`cannot open the socket ${path}: ${error.message}`);};
  const track = (socket: Socket): void => {
    open.add(socket);
    socket.unref();
    socket.on("close", () => open.delete(socket));
  };
  const server = createServer((client) => {
    track(client);
    client.on("error", () => client.destroy());
    const refused = setTimeout(() => client.destroy(), TOKEN_TIMEOUT);
    refused.unref();
    client.on("close", () => {clearTimeout(refused);});
    const pipe = (upstream: Socket, toServer: Buffer[]): void => {
      clearTimeout(refused);
      Iterator.from(toServer).forEach((chunk) => {upstream.write(chunk);});
      client.pipe(upstream).pipe(client);
    };
    if (dialect === "postgres") {gatePostgres(client, token, () => openUpstream(path, client, track, failed), pipe);}
    else {gateMysql(client, token, openUpstream(path, client, track, failed), pipe);}
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(EPHEMERAL_PORT, LOOPBACK, done);
  });
  server.unref();
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.close();
      Iterator.from(open).forEach((socket) => {socket.destroy();});
    },
    failure: () => failure,
  };
}

/** The connection to the socket for `client`, each closed with the other. */
function openUpstream(path: string, client: Socket, track: (socket: Socket) => void, failed: (error: Error) => void): Socket {
  const upstream = connect(path);
  track(upstream);
  // Only a socket that never opened is the bridge's failure: an error after it opened (a reset once
  // The server refused the login) leaves the engine's own answer, which names the refusal.
  let opened = false;
  upstream.once("connect", () => (opened = true));
  upstream.on("error", (error) => {
    if (!opened) {failed(error);}
    upstream.destroy();
    client.destroy();
  });
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
  return upstream;
}

/** A Postgres connection admitted once its first bytes are the token: the socket is opened only then, and what followed the token goes to it first. */
function gatePostgres(client: Socket, token: string, upstream: () => Socket, pipe: (upstream: Socket, toServer: Buffer[]) => void): void {
  const expected = Buffer.from(token);
  let head = Buffer.alloc(EMPTY_BUFFER_BYTES);
  const read = (chunk: Buffer): undefined => {
    head = Buffer.concat([head, chunk]);
    if (head.length < expected.length) {return;}
    client.off("data", read);
    client.pause();
    if (!timingSafeEqual(head.subarray(FIRST_PACKET_BYTE, expected.length), expected)) {return void client.destroy();}
    pipe(upstream(), [head.subarray(expected.length)]);
    client.resume();
  };
  client.on("data", read);
}

/**
 * A MySQL connection admitted once its login carries the token. The server's greeting reaches the
 * client without TLS among its capabilities, so the login that answers it is in plain text; the
 * login is read whole, and passed on only where its connection attributes hold the token, without
 * it, so that the token is not among the session's attributes the server shows its accounts.
 */
function gateMysql(client: Socket, token: string, upstream: Socket, pipe: (upstream: Socket, toServer: Buffer[]) => void): void {
  let fromServer = Buffer.alloc(EMPTY_BUFFER_BYTES);
  const greeting = (chunk: Buffer): void => {
    fromServer = Buffer.concat([fromServer, chunk]);
    const packet = whole(fromServer);
    if (!packet) {return;}
    upstream.off("data", greeting);
    upstream.pause();
    withoutTls(packet.payload);
    client.write(fromServer);
    let fromClient = Buffer.alloc(EMPTY_BUFFER_BYTES);
    const login = (chunk: Buffer): undefined => {
      fromClient = Buffer.concat([fromClient, chunk]);
      const answer = whole(fromClient);
      if (!answer) {return;}
      client.off("data", login);
      client.pause();
      const taken = takeAttribute(answer.payload, MYSQL_ATTRIBUTE);
      if (taken?.value !== token) {return void client.destroy();}
      const header = Buffer.alloc(MYSQL_PACKET_HEADER_BYTES);
      header.writeUIntLE(taken.login.length, FIRST_PACKET_BYTE, MYSQL_LENGTH_BYTES);
      header[MYSQL_PACKET_SEQUENCE_OFFSET] = fromClient.readUInt8(MYSQL_PACKET_SEQUENCE_OFFSET);
      upstream.resume();
      pipe(upstream, [header, taken.login, fromClient.subarray(MYSQL_PACKET_HEADER_BYTES + answer.payload.length)]);
      client.resume();
    };
    client.on("data", login);
  };
  upstream.on("data", greeting);
}

/** The first whole packet of a MySQL stream, its payload in place, or undefined while it is still arriving. */
function whole(stream: Buffer): { payload: Buffer } | undefined {
  if (stream.length < MYSQL_PACKET_HEADER_BYTES) {return undefined;}
  const length = stream.readUIntLE(FIRST_PACKET_BYTE, MYSQL_LENGTH_BYTES);
  const packetEnd = MYSQL_PACKET_HEADER_BYTES + length;
  return stream.length < packetEnd ? undefined : { payload: stream.subarray(MYSQL_PACKET_HEADER_BYTES, packetEnd) };
}

/** The greeting (HandshakeV10) with CLIENT_SSL cleared from its capabilities, in place. */
function withoutTls(greeting: Buffer): void {
  const versionEnd = greeting.indexOf(STRING_TERMINATOR, MYSQL_GREETING_VERSION_START);
  const capabilityOffset = versionEnd + STRING_TERMINATOR_BYTES +
    MYSQL_THREAD_ID_BYTES + MYSQL_GREETING_SEED_BYTES + MYSQL_GREETING_FILLER_BYTES;
  if (greeting[FIRST_PACKET_BYTE] === MYSQL_PROTOCOL_V10 &&
    capabilityOffset + MYSQL_LOWER_CAPABILITY_BYTES <= greeting.length) {
    greeting.writeUInt16LE(greeting.readUInt16LE(capabilityOffset) & ~MYSQL_SSL_CAPABILITY, capabilityOffset);
  }
}

/** A length-encoded integer, as MySQL's protocol writes one. */
const lenenc = (value: number): Buffer => {
  if (value < MYSQL_INLINE_LENGTH_LIMIT) {return Buffer.from([value]);}
  const size = value < MYSQL_LENGTH_TWO_BYTE_LIMIT
    ? MYSQL_LENGTH_TWO_BYTES
    : (value < MYSQL_LENGTH_THREE_BYTE_LIMIT ? MYSQL_LENGTH_THREE_BYTES : MYSQL_LENGTH_EIGHT_BYTES);
  const out = Buffer.alloc(MYSQL_LENGTH_TAG_BYTES + size);
  out[FIRST_PACKET_BYTE] = size === MYSQL_LENGTH_TWO_BYTES
    ? MYSQL_LENGTH_TWO_BYTE_TAG
    : (size === MYSQL_LENGTH_THREE_BYTES ? MYSQL_LENGTH_THREE_BYTE_TAG : MYSQL_LENGTH_EIGHT_BYTE_TAG);
  out.writeUIntLE(value, MYSQL_LENGTH_TAG_BYTES, Math.min(size, MAX_BUFFER_INTEGER_BYTES));
  return out;
};

const lengthSizeForMarker = (marker: number): number =>
  marker === MYSQL_LENGTH_TWO_BYTE_TAG
    ? MYSQL_LENGTH_TWO_BYTES
    : (marker === MYSQL_LENGTH_THREE_BYTE_TAG ? MYSQL_LENGTH_THREE_BYTES : MYSQL_LENGTH_EIGHT_BYTES);

/**
 * A connection attribute of a login (HandshakeResponse41), and the login without it, its
 * attributes' length written again; undefined where the login carries no such attribute.
 */
export function takeAttribute(login: Buffer, name: string): { value: string; login: Buffer } | undefined {
  const CONNECT_WITH_DB = 0x8; const SECURE_CONNECTION = 0x80_00; const PLUGIN_AUTH = 0x8_00_00; const CONNECT_ATTRS = 0x10_00_00; const LENENC_AUTH = 0x20_00_00;
  if (login.length < MYSQL_HANDSHAKE_HEADER_BYTES) {return undefined;}
  const capabilities = login.readUInt32LE(FIRST_PACKET_BYTE);
  if (capabilities & MYSQL_SSL_CAPABILITY || !(capabilities & CONNECT_ATTRS)) {return undefined;}
  // Capabilities, the largest packet, the character set and 23 bytes of filler.
  let at = MYSQL_HANDSHAKE_HEADER_BYTES;
  const int = (): number => {
    const first = login[at];
    at += MYSQL_LENGTH_TAG_BYTES;
    if (matchesUndefined(first)) {throw new RangeError("short");}
    if (first < MYSQL_INLINE_LENGTH_LIMIT) {return first;}
    const size = lengthSizeForMarker(first);
    const value = login.readUIntLE(at, Math.min(size, MAX_BUFFER_INTEGER_BYTES));
    at += size;
    return value;
  };
  const bytes = (length: number): Buffer => {
    if (at + length > login.length) {throw new RangeError("short");}
    const value = login.subarray(at, at + length);
    at += length;
    return value;
  };
  const cstring = (): void => {
    const end = login.indexOf(STRING_TERMINATOR, at);
    if (end === NOT_FOUND) {throw new RangeError("unterminated");}
    at = end + STRING_TERMINATOR_BYTES;
  };
  try {
    cstring(); // The user
    if (capabilities & LENENC_AUTH) {bytes(int());}
    else if (capabilities & SECURE_CONNECTION) {bytes(bytes(MYSQL_AUTH_LENGTH_BYTES).readUInt8(FIRST_PACKET_BYTE));}
    else {cstring();}
    if (capabilities & CONNECT_WITH_DB) {cstring();}
    if (capabilities & PLUGIN_AUTH) {cstring();}
    const lengthAt = at;
    const length = int();
    const start = at;
    const end = start + length;
    while (at < end) {
      const pairAt = at;
      const key = bytes(int()).toString("utf8");
      const value = bytes(int()).toString("utf8");
      if (key !== name) {continue;}
      const rest = Buffer.concat([login.subarray(start, pairAt), login.subarray(at, end)]);
      return { value, login: Buffer.concat([login.subarray(FIRST_PACKET_BYTE, lengthAt), lenenc(rest.length), rest, login.subarray(end)]) };
    }
  } catch {}
  return undefined;
}
