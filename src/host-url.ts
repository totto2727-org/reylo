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
import { Unreachable } from "./connection.ts";
import { joinHost, prepareHostUrl, splitPair, withHost } from "./host-url-address.ts";
import type { SocketAddress, SocketDialect } from "./host-url-address.ts";
import { mysqlPacket as whole, MYSQL_LENGTH_BYTES, MYSQL_PACKET_HEADER_BYTES, takeAttribute, withoutTls } from "./host-url-mysql.ts";
import { hostEnvironment } from "./project-files.ts";
import { matchesUndefined } from "./native-predicates.ts";

export { takeAttribute } from "./host-url-mysql.ts";

/**
 * A URL as the engine opens it, the bridge's token where it goes through one, what to close with
 * the connection, and why the bridge could not open its socket, which the engine sees only as a
 * connection closed.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep the exported native connection shape assignable to structural record consumers.
export type HostUrl = { url: string; bridge?: string; close: () => void; failure?: () => Error | undefined };

/** The connection attribute a MySQL login through the bridge carries its token in (upstream engine/native/src/mysql.rs). */
const MYSQL_ATTRIBUTE = "reylo_bridge";

/** How long a connection to the bridge may take to show its token. */
const TOKEN_TIMEOUT = 10_000;
const MYSQL_PACKET_SEQUENCE_OFFSET = MYSQL_LENGTH_BYTES;
const FIRST_PACKET_BYTE = 0;
const BRIDGE_TOKEN_BYTES = 24;
const LOOPBACK = "127.0.0.1";
const EPHEMERAL_PORT = 0;
const EMPTY_BUFFER_BYTES = 0;


interface Admission<Upstream> {
  pipe: (upstream: Socket, toServer: Buffer[]) => void;
  token: string;
  upstream: Upstream;
}

// Postgres forwards only the data following a verified token and opens the upstream lazily.
const gatePostgres = (client: Socket, { pipe, token, upstream }: Admission<() => Socket>): void => {
  const expected = Buffer.from(token);
  const received = { head: Buffer.alloc(EMPTY_BUFFER_BYTES) };
  const read = (chunk: Buffer): void => {
    received.head = Buffer.concat([received.head, chunk]);
    if (received.head.length < expected.length) {return;}
    client.off("data", read);
    client.pause();
    if (!timingSafeEqual(received.head.subarray(FIRST_PACKET_BYTE, expected.length), expected)) {
      client.destroy();
      return;
    }
    pipe(upstream(), [received.head.subarray(expected.length)]);
    client.resume();
  };
  client.on("data", read);
};

interface LoginPacket {
  payload: Buffer;
  stream: Buffer;
}

const forwardLogin = (client: Socket, { payload, stream }: LoginPacket, { pipe, token, upstream }: Admission<Socket>): void => {
  const taken = takeAttribute(payload, MYSQL_ATTRIBUTE);
  if (taken?.value !== token) {
    client.destroy();
    return;
  }
  const header = Buffer.alloc(MYSQL_PACKET_HEADER_BYTES);
  header.writeUIntLE(taken.login.length, FIRST_PACKET_BYTE, MYSQL_LENGTH_BYTES);
  header[MYSQL_PACKET_SEQUENCE_OFFSET] = stream.readUInt8(MYSQL_PACKET_SEQUENCE_OFFSET);
  upstream.resume();
  pipe(upstream, [header, taken.login, stream.subarray(MYSQL_PACKET_HEADER_BYTES + payload.length)]);
  client.resume();
};

const readLogin = (client: Socket, admission: Admission<Socket>): void => {
  const received = { stream: Buffer.alloc(EMPTY_BUFFER_BYTES) };
  const login = (chunk: Buffer): void => {
    received.stream = Buffer.concat([received.stream, chunk]);
    const answer = whole(received.stream);
    if (matchesUndefined(answer)) {return;}
    client.off("data", login);
    client.pause();
    forwardLogin(client, { payload: answer.payload, stream: received.stream }, admission);
  };
  client.on("data", login);
};

// MySQL sends the greeting first. The login is forwarded only after it passes the bridge's admission check.
const gateMysql = (client: Socket, admission: Admission<Socket>): void => {
  const { upstream } = admission;
  const received = { stream: Buffer.alloc(EMPTY_BUFFER_BYTES) };
  const greeting = (chunk: Buffer): void => {
    received.stream = Buffer.concat([received.stream, chunk]);
    const packet = whole(received.stream);
    if (matchesUndefined(packet)) {return;}
    upstream.off("data", greeting);
    upstream.pause();
    withoutTls(packet.payload);
    client.write(received.stream);
    readLogin(client, admission);
  };
  upstream.on("data", greeting);
};

interface BridgePool {
  failure?: Error;
  sockets: Set<Socket>;
}

const trackSocket = (socket: Socket, pool: BridgePool): void => {
  pool.sockets.add(socket);
  socket.unref();
  socket.on("close", () => {pool.sockets.delete(socket);});
};

const socketOpenFailure = (path: string, error: Error): Error =>
  // oxlint-disable-next-line rules/require-tagged-error -- The host bridge reports its native socket-open diagnostic through the existing failure hook.
  new Error(`cannot open the socket ${path}: ${error.message}`);

const openUpstream = (path: string, client: Socket, pool: BridgePool): Socket => {
  const upstream = connect(path);
  trackSocket(upstream, pool);
  // Once connected, a server rejection belongs to the engine's own diagnostic.
  const status = { opened: false };
  upstream.once("connect", () => {status.opened = true;});
  upstream.on("error", (error) => {
    if (!status.opened) {pool.failure = socketOpenFailure(path, error);}
    upstream.destroy();
    client.destroy();
  });
  upstream.on("close", () => {client.destroy();});
  client.on("close", () => {upstream.destroy();});
  return upstream;
};

const admissionTimer = (client: Socket): NodeJS.Timeout => {
  const timer = setTimeout(() => {client.destroy();}, TOKEN_TIMEOUT);
  timer.unref();
  client.on("close", () => {clearTimeout(timer);});
  return timer;
};

interface BridgeTarget {
  dialect: SocketDialect;
  path: string;
  token: string;
}

const acceptClient = (client: Socket, { path, dialect, token }: BridgeTarget, pool: BridgePool): void => {
  trackSocket(client, pool);
  client.on("error", () => {client.destroy();});
  const timer = admissionTimer(client);
  const pipe = (upstream: Socket, toServer: Buffer[]): void => {
    clearTimeout(timer);
    Iterator.from(toServer).forEach((chunk) => {upstream.write(chunk);});
    client.pipe(upstream).pipe(client);
  };
  const open = (): Socket => openUpstream(path, client, pool);
  if (dialect === "postgres") {gatePostgres(client, { pipe, token, upstream: open });}
  else {gateMysql(client, { pipe, token, upstream: open() });}
};

interface OpenBridge {
  close: () => void;
  failure: () => Error | undefined;
  port: number;
}

// Only admitted engine connections are forwarded. The loopback listener and its sockets are unref'ed.
const openBridge = async (path: string, dialect: SocketDialect, token: string): Promise<OpenBridge> => {
  const pool: BridgePool = { sockets: new Set() };
  const server = createServer((client) => {acceptClient(client, { dialect, path, token }, pool);});
  // oxlint-disable-next-line promise/avoid-new -- Await the native server's first listen success or startup error.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(EPHEMERAL_PORT, LOOPBACK, resolve);
  });
  server.unref();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A successfully listening TCP server has an IP address and port.
  const { port } = server.address() as AddressInfo;
  return {
    close: () => {
      server.close();
      Iterator.from(pool.sockets).forEach((socket) => {socket.destroy();});
    },
    failure: () => pool.failure,
    port,
  };
};

const directAddress = (url: string): HostUrl =>
  // oxlint-disable-next-line eslint/sort-keys -- Keep the established URL resource field order.
  ({ url, close: () => {
    // This address owns no socket bridge.
  } });

const socketAddress = async ({ base, dialect, pairs, socket }: SocketAddress, platform: NodeJS.Platform): Promise<HostUrl> => {
  if (dialect === "postgres" && platform === "win32") {
    // oxlint-disable-next-line rules/require-tagged-error -- Unreachable retains the native host error as its cause for the existing callers.
    throw new Unreachable(new Error(`the URL names the Unix socket ${socket.path}, which Node cannot open on Windows: name the server's host and port, as host=localhost&port=5432`));
  }
  const token = randomBytes(BRIDGE_TOKEN_BYTES).toString("hex");
  const bridge = await openBridge(socket.path, dialect, token);
  const rest = pairs.filter((pair) => !socket.params.includes(splitPair(pair)[0]));
  // oxlint-disable-next-line eslint/sort-keys -- Keep the established URL resource field order for bridged connections.
  return { url: joinHost(withHost(base, `${LOOPBACK}:${bridge.port}`), rest), bridge: token, close: bridge.close, failure: bridge.failure };
};

/**
 * Adapts a database URL to the host runtime, resolving TLS paths or opening a Unix socket bridge.
 * @param {string} url The database URL.
 * @param {Record<string, string | undefined>} env The host environment for Postgres fallback settings.
 * @param {NodeJS.Platform} platform The platform that will open the connection.
 * @returns {Promise<HostUrl>} The URL and its connection resources.
 */
export const hostUrl = async function hostUrl(url: string, env: Record<string, string | undefined> = hostEnvironment(), platform: NodeJS.Platform = process.platform): Promise<HostUrl> {
  const address = prepareHostUrl(url, env);
  return "url" in address ? directAddress(address.url) : socketAddress(address, platform);
};
