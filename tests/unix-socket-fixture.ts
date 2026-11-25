// oxlint-disable-next-line rules/no-node-imports -- Exercise native loopback and Unix sockets in the integration test.
import { connect, createServer } from "node:net";
// oxlint-disable-next-line rules/no-node-imports -- Close and await the actual server used by the native test.
import type { Server } from "node:net";
// oxlint-disable-next-line rules/no-node-imports -- Wait for listening and close events before advancing the fixture.
import { once } from "node:events";
// oxlint-disable-next-line rules/no-node-imports -- The Unix socket uses the host's filesystem path.
import path from "node:path";
import { nativeTestDirectory } from "./native-engine-fixture.ts";

const listen = async (server: Server, filename: string): Promise<void> => {
  const listening = once(server, "listening");
  server.listen(filename);
  await listening;
};

export const closeServer = async (server: Server): Promise<void> => {
  const closed = once(server, "close");
  server.close();
  await closed;
};

export const postgresSocket = async (record: () => void): Promise<{ dir: string; server: Server }> => {
  const dir = await nativeTestDirectory("reylo-sock-");
  const server = createServer((socket) => {
    record();
    socket.destroy();
  });
  await listen(server, path.join(dir, ".s.PGSQL.5432"));
  return { dir, server };
};

export const socketFor = async (url: string, name: string): Promise<{ filename: string; server: Server }> => {
  const { hostname, port } = new URL(url);
  const dir = await nativeTestDirectory("reylo-sock-");
  const filename = path.join(dir, name);
  const server = createServer((client) => {
    const upstream = connect(Number(port), hostname);
    client.on("error", () => {upstream.destroy();});
    upstream.on("error", () => {client.destroy();});
    client.pipe(upstream).pipe(client);
  });
  await listen(server, filename);
  return { filename, server };
};

const tolerateDisconnect = (): void => {
  // This negative probe checks the received bytes after the rejected connection closes.
};

export const knock = async (url: string, bytes: Buffer): Promise<Buffer> => {
  const { hostname, port } = new URL(url.replace(/^[a-z]+:/u, "http:"));
  const socket = connect(Number(port), hostname);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const read: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => {read.push(chunk);});
  socket.on("error", tolerateDisconnect);
  socket.on("close", () => {resolve(true);});
  socket.write(bytes);
  await promise;
  return Buffer.concat(read);
};
