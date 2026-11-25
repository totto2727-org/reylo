// oxlint-disable-next-line rules/no-node-imports -- Exercise the mapper and language server as native Node subprocesses.
import { spawn } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Use the native stdin and stdout of these fixture processes.
import type { ChildProcessByStdio } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Type the stdio pipes retained for the JSON-RPC fixture.
import type { Readable, Writable } from "node:stream";
import { isRecord, matchesNumber, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";

const DELIMITER = "\r\n\r\n";
const CONTENT_LENGTH = /Content-Length:\s*(?<length>\d+)/iu;
const NO_BYTES = 0;
const NO_HEADER = -1;
const NEXT_ID = 1;
const CLEAN_EXIT = 0;

interface Frame { end: number; message: unknown }

const bodyWidth = (header: string): number => {
  const width = CONTENT_LENGTH.exec(header)?.groups?.length;
  if (matchesUndefined(width)) {
    // oxlint-disable-next-line rules/require-tagged-error -- A malformed native reply must fail the integration test.
    throw new Error(`Unexpected JSON-RPC header: ${header}`);
  }
  return Number(width);
};

const readFrame = (bytes: Buffer): Frame | undefined => {
  const divider = bytes.indexOf(DELIMITER);
  if (divider === NO_HEADER) {return undefined;}
  const header = bytes.subarray(NO_BYTES, divider).toString("ascii");
  const start = divider + DELIMITER.length;
  const end = start + bodyWidth(header);
  if (bytes.length < end) {return undefined;}
  const message: unknown = JSON.parse(bytes.subarray(start, end).toString("utf8"));
  return { end, message };
};

const exitedBeforeReply = (code: number | null, signal: NodeJS.Signals | null): Error =>
  // oxlint-disable-next-line rules/require-tagged-error -- A stopped child rejects outstanding requests in the native test.
  new Error(`JSON-RPC fixture exited before replying (${signal ?? code ?? CLEAN_EXIT})`);

interface StartOptions { args: string[]; cwd: string; stderr: "ignore" | "inherit" }
interface ServerRequest { id: number | string; method: string; params: unknown }
type Respond = (request: ServerRequest) => unknown;

export class RpcFixture {
  #child: ChildProcessByStdio<Writable, Readable, null>;
  #requests = new Map<number, PromiseWithResolvers<unknown>>();
  #buffer: Buffer = Buffer.alloc(NO_BYTES);
  #id = NO_BYTES;
  #closed: Error | undefined;
  #finished = Promise.withResolvers<boolean>();
  #respond: Respond | undefined;

  public constructor({ args, cwd, stderr }: StartOptions, respond?: Respond) {
    this.#child = spawn(process.execPath, args, { cwd, stdio: ["pipe", "pipe", stderr] });
    this.#respond = respond;
    this.#watch();
  }

  #watch(): void {
    this.#child.stdout.on("data", (chunk: Buffer) => {this.#read(chunk);});
    this.#child.once("close", (code, signal) => {
      this.#stop(exitedBeforeReply(code, signal));
      this.#finished.resolve(true);
    });
    this.#child.once("error", (error) => {
      this.#stop(error);
      this.#finished.resolve(true);
    });
    this.#child.stdin.on("error", (error) => {this.#stop(error);});
  }

  #stop(error: Error): void {
    this.#closed ??= error;
    Iterator.from(this.#requests.values()).forEach((request) => {request.reject(error);});
    this.#requests.clear();
  }

  #read(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const cursor = { frame: readFrame(this.#buffer) };
    while (!matchesUndefined(cursor.frame)) {
      this.#buffer = this.#buffer.subarray(cursor.frame.end);
      this.#receive(cursor.frame.message);
      cursor.frame = readFrame(this.#buffer);
    }
  }

  #receive(message: unknown): void {
    if (!isRecord(message)) {return;}
    const { id, method, params } = message;
    if (matchesString(method) && (matchesString(id) || matchesNumber(id)) && !matchesUndefined(this.#respond)) {
      this.#write({ id, result: this.#respond({ id, method, params }) });
      return;
    }
    if (matchesNumber(id)) {this.#settle(id, message);}
  }

  #settle(id: number, { error, result }: Record<string, unknown>): void {
    const request = this.#requests.get(id);
    if (matchesUndefined(request)) {return;}
    this.#requests.delete(id);
    if (isRecord(error) && matchesString(error.message)) {
      // oxlint-disable-next-line rules/require-tagged-error -- Surface the native server's JSON-RPC failure in the caller's test.
      request.reject(new Error(error.message));
      return;
    }
    request.resolve(result);
  }

  #write(message: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.#child.stdin.write(`Content-Length: ${body.length}${DELIMITER}`);
    this.#child.stdin.write(body);
  }

  public async request(method: string, params?: unknown): Promise<unknown> {
    if (!matchesUndefined(this.#closed)) {throw this.#closed;}
    const request = Promise.withResolvers<unknown>();
    this.#id += NEXT_ID;
    this.#requests.set(this.#id, request);
    this.#write({ id: this.#id, method, params });
    return request.promise;
  }

  public notify(method: string, params?: unknown): void {this.#write({ method, params });}
  public endInput(): void {this.#child.stdin.end();}
  public async wait(): Promise<void> {await this.#finished.promise;}
}

export const languageServerResponse = ({ method, params }: ServerRequest): unknown => {
  // oxlint-disable-next-line unicorn/no-null -- The editor leaves each requested workspace setting unset.
  if (method === "workspace/configuration" && isRecord(params) && Array.isArray(params.items)) {return params.items.map(() => null);}
  // oxlint-disable-next-line unicorn/no-null -- The language server expects a JSON-RPC null acknowledgment.
  return null;
};
