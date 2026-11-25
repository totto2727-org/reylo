// oxlint-disable-next-line rules/no-node-imports -- The native engine replies over the child's standard streams.
import { spawn } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Capture the native process with all three standard streams available.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Analysis, Described, Dialect } from "./engine-core.ts";
import { diagnosticTail, engineEnvironment } from "./engine-launch.ts";
import { matchesUndefined } from "./native-predicates.ts";

export interface ChannelAnswer {
  status: string;
  id?: number;
  message?: string;
  code?: string;
  conn?: number;
  analysis?: Analysis;
  rows?: unknown[][];
  server?: string;
  params?: number[];
  columns?: Described["columns"];
}

const FIRST_REQUEST = 1;
const NEXT_REQUEST = 1;
const EMPTY_PENDING = 0;
const START_OF_LINE = 0;
const AFTER_NEWLINE = 1;
const NO_NEWLINE = -1;
const HOLD_INTERVAL = 1_073_741_824;
const STDERR_KEPT = 4096;

const unreachable = (message: string): ChannelAnswer =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the transport's existing unreachable response shape.
  ({ status: "unreachable", message });

const unrefPipes = (child: ChildProcessWithoutNullStreams): void => {
  child.unref();
  [child.stdin, child.stdout, child.stderr].forEach((stream) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Some host streams expose unref, although the generic stdio types do not.
    const pipe = stream as unknown as { unref?: () => void };
    pipe.unref?.();
  });
};

const parseAnswer = (line: string): ChannelAnswer | undefined => {
  try {
    const answer: unknown = JSON.parse(line);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native process owns the JSON line response protocol.
    return answer as ChannelAnswer;
  } catch {
    return undefined;
  }
};

/**
 * The engine answers JSON lines in request order. The child and its pipes stay unreferenced so
 * the build can exit when idle, and a timer holds the host only while requests wait.
 */
export class Channel {
  #child: ChildProcessWithoutNullStreams;
  #pending = new Map<number, (answer: ChannelAnswer) => void>();
  #next = FIRST_REQUEST;
  #buffered = "";
  #stderr = "";
  #ended: string | undefined;
  #waiting: ReturnType<typeof setInterval> | undefined;

  public constructor(binary: string, dialect: Dialect) {
    const child = spawn(binary, ["engine", dialect], { env: engineEnvironment(), windowsHide: true });
    this.#child = child;
    this.#subscribe(child, binary);
    unrefPipes(child);
  }

  #subscribe(child: ChildProcessWithoutNullStreams, binary: string): void {
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {this.#receive(chunk);});
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_KEPT);
    });
    child.stdin.on("error", () => {
      // The close event reports why the input stopped.
    });
    child.on("error", (error: Error) => {this.#end(`the engine ${binary} could not start: ${error.message}`);});
    // Wait until stdout has ended, including the last response before the process exited.
    child.on("close", (code, signal) => {
      this.#end(`the engine ${binary} stopped (${code ?? signal})${diagnosticTail(this.#stderr)}`);
    });
  }

  #receive(chunk: string): void {
    this.#buffered += chunk;
    const cursor = { end: this.#buffered.indexOf("\n") };
    while (cursor.end !== NO_NEWLINE) {
      const line = this.#buffered.slice(START_OF_LINE, cursor.end);
      this.#buffered = this.#buffered.slice(cursor.end + AFTER_NEWLINE);
      this.#answer(line);
      cursor.end = this.#buffered.indexOf("\n");
    }
  }

  public get ended(): boolean {
    return !matchesUndefined(this.#ended);
  }

  public async ask(request: object): Promise<ChannelAnswer> {
    if (!matchesUndefined(this.#ended)) {return unreachable(this.#ended);}
    const id = this.#next;
    this.#next += NEXT_REQUEST;
    const { promise, resolve } = Promise.withResolvers<ChannelAnswer>();
    this.#pending.set(id, resolve);
    this.#hold(true);
    this.#child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    return promise;
  }

  /** Close standard input so the engine can exit after its pending output. */
  public end(): void {
    this.#ended ??= "the connection is closed";
    this.#child.stdin.end();
    this.#hold(false);
  }

  /** Terminate an engine that failed its startup handshake. */
  public kill(): void {
    this.end();
    this.#child.kill();
  }

  #answer(line: string): void {
    const parsed = parseAnswer(line);
    if (matchesUndefined(parsed)) {return;}
    // Without an ID, the engine is replying to the oldest request.
    this.#resolve(parsed.id ?? this.#pending.keys().next().value, parsed);
  }

  #resolve(id: number | undefined, parsed: ChannelAnswer): void {
    if (matchesUndefined(id)) {return;}
    const reply = this.#pending.get(id);
    if (matchesUndefined(reply)) {return;}
    this.#pending.delete(id);
    reply(parsed);
    if (this.#pending.size === EMPTY_PENDING) {this.#hold(false);}
  }

  #end(why: string): void {
    this.#ended ??= why;
    const message = this.#ended;
    this.#pending.forEach((reply) => {reply(unreachable(message));});
    this.#pending.clear();
    this.#hold(false);
  }

  #hold(held: boolean): void {
    if (held) {
      this.#waiting ??= setInterval(() => {
        // The active timer keeps the host alive.
      }, HOLD_INTERVAL);
    } else if (!matchesUndefined(this.#waiting)) {
      clearInterval(this.#waiting);
      this.#waiting = undefined;
    }
  }
}
