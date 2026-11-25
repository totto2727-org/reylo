// The published native engine answers JSON lines. Each connection gets its own process, and one
// An idle process per engine serves ping, lexing, and analysis that uses externally supplied data.
// The synchronous config path starts a one-shot child. See engine-channel.ts for ownership of the
// See that module for the streams and keep-alive timer.
// oxlint-disable-next-line rules/no-node-imports -- Read the installed runtime's package version during initialization.
import { readFileSync } from "node:fs";
import { Channel } from "./engine-channel.ts";
import type { ChannelAnswer } from "./engine-channel.ts";
import { EngineCore, expectLexed } from "./engine-core.ts";
import type { Dialect, Lexed, Response } from "./engine-core.ts";
import { callSync } from "./engine-launch.ts";
import { MissingEngine, missingEngine } from "./engine-missing.ts";
import { openEngineSession } from "./engine-session.ts";
import type { Connection } from "./engine-session.ts";
import { ENGINE_VERSION } from "./engine-version.ts";
import { nativeBinary } from "./native.ts";
import { matchesUndefined } from "./native-predicates.ts";

export { reason, Unreachable } from "./connection.ts";
export type { Analysis, Answer, DbError, Described, Diagnostic, Dialect, DuckdbDescribed, DuckdbType, EngineType, EngineIo, Lexed, MysqlDescribed, Need, Response } from "./engine-core.ts";
export { AnswerCache, EngineCore } from "./engine-core.ts";
export { MissingEngine } from "./engine-missing.ts";
export type { Connection } from "./engine-session.ts";

const PACKAGE_LOCATIONS = ["./package.json", "../package.json"];

const versionAt = (filename: string): { version: string } | undefined => {
  try {
    // oxlint-disable-next-line node/no-sync -- REYLO_VERSION remains available synchronously on import.
    const manifest: unknown = JSON.parse(readFileSync(new URL(filename, import.meta.url), "utf8"));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Read the original package version field from the installed manifest.
    return { version: (manifest as { version: string }).version };
  } catch {
    return undefined;
  }
};

const ownVersion = (): string => {
  const result = Iterator.from(PACKAGE_LOCATIONS).map((filename) => versionAt(filename))
    .find((version) => !matchesUndefined(version));
  if (!matchesUndefined(result)) {return result.version;}
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native package initialization error without importing Effect.
  throw new Error("reylo cannot find the package.json of its own package");
};

/** The fork package version, shared by the runtime and SQLite tooling packages. */
export const REYLO_VERSION: string = ownVersion();

const keptKey = (request: object): string | undefined => {
  const { op } = request as { op?: unknown };
  return op === "config" || op === "lex" ? JSON.stringify(request) : undefined;
};

const KEPT_ANSWERS = 512;

const decodeCoreResponse = (answer: ChannelAnswer): Response => {
  const decoded: unknown = answer;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native host emits the published response union on this channel.
  return decoded as Response;
};

/** One database's engine, as the native executable serves it. */
export class Engine extends EngineCore {
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public read-only executable path.
  public readonly binary: string;
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public read-only dialect.
  public readonly dialect: Dialect;
  /** The native engine fingerprint identifies entries in .reylo. */
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public read-only fingerprint.
  public readonly fingerprint: string;
  #core: Channel;
  #kept = new Map<string, Response>();

  // oxlint-disable-next-line eslint/max-params -- Preserve the public engine constructor signature.
  public constructor(binary: string, dialect: Dialect, fingerprint: string, core: Channel) {
    // oxlint-disable-next-line node/no-sync -- The public Engine.call method preserves the native synchronous request.
    super((request) => callSync(binary, dialect, request));
    this.binary = binary;
    this.dialect = dialect;
    this.fingerprint = fingerprint;
    this.#core = core;
  }

  /**
   * Send a synchronous config or lexer request to a one-shot native process.
   * @param {object} request - The engine operation and its inputs.
   * @returns {Response} The native answer, cached for config and lex requests.
   */
  public override call(request: object): Response {
    const key = keptKey(request);
    const remembered = this.#cached(key);
    if (remembered) {return remembered;}
    return this.#remember(key, super.call(request));
  }

  /**
   * Read the lexer's answer over the long-lived native channel.
   * @param {string} sql - Statement text.
   * @param {Dialect} dialect - The dialect used by the lexer.
   * @returns {Promise<Lexed>} The lexer's reading of the statement.
   */
  public async lexAsync(sql: string, dialect: Dialect): Promise<Lexed> {
    // oxlint-disable-next-line eslint/sort-keys -- Keep the existing wire request and cache key order.
    const request = { op: "lex", sql, dialect };
    const key = keptKey(request);
    const remembered = this.#cached(key);
    if (remembered) {return expectLexed(remembered);}
    return expectLexed(this.#remember(key, await this.ask(request)));
  }

  #cached(key: string | undefined): Response | undefined {
    return matchesUndefined(key) ? undefined : this.#kept.get(key);
  }

  #remember(key: string | undefined, answer: Response): Response {
    if (matchesUndefined(key) || answer.status === "error") {return answer;}
    if (this.#kept.size >= KEPT_ANSWERS) {
      const oldest = this.#kept.keys().next().value;
      if (!matchesUndefined(oldest)) {this.#kept.delete(oldest);}
    }
    this.#kept.set(key, answer);
    return answer;
  }

  /**
   * Run an engine request that can wait on the shared channel.
   * @param {object} request - An operation that uses no engine-owned database connection.
   * @returns {Promise<Response>} The native response, after restarting a closed channel if necessary.
   */
  protected override async ask(request: object): Promise<Response> {
    if (this.#core.ended) {this.#core = new Channel(this.binary, this.dialect);}
    const answer = await this.#core.ask(request);
    if (answer.status === "unreachable") {
      // oxlint-disable-next-line rules/require-tagged-error -- A failed core request exposes the native Error expected by callers.
      throw new Error(answer.message);
    }
    return decodeCoreResponse(answer);
  }

  /**
   * Open a connection in its own native worker.
   * @param {string} url - The database URL or local SQLite path.
   * @returns {Promise<Connection>} A session that owns its worker and any host bridge.
   */
  public async open(url: string): Promise<Connection> {
    return openEngineSession(this.binary, this.dialect, url);
  }
}

const engines = new Map<string, Promise<Engine>>();
const PING_SECONDS = 10;
const MILLISECONDS = 1000;

const pendingPing = async (core: Channel): Promise<ChannelAnswer> => {
  const { promise, resolve } = Promise.withResolvers<ChannelAnswer>();
  const late = setTimeout(() => {
    // oxlint-disable-next-line eslint/sort-keys -- Match the native error response used by the startup check.
    resolve({ status: "error", message: `it did not answer a ping in ${PING_SECONDS} s` });
  }, PING_SECONDS * MILLISECONDS);
  try {
    return await Promise.race([core.ask({ op: "ping" }), promise]);
  } finally {
    clearTimeout(late);
  }
};

const refuse = (core: Channel, message: string): MissingEngine => {
  core.kill();
  return new MissingEngine(message);
};

const launchEngine = async (binary: string, dialect: Dialect): Promise<Engine> => {
  const core = new Channel(binary, dialect);
  const answer = await pendingPing(core);
  const ping = decodeCoreResponse(answer);
  if (ping.status !== "ok") {throw refuse(core, `the engine ${binary} does not answer: ${answer.message ?? answer.status}`);}
  if (ping.version !== ENGINE_VERSION) {
    throw refuse(core, `reylo ${REYLO_VERSION} runs with its engine at ${ENGINE_VERSION}, and ${binary} is ${ping.version}: install reylo again with optional dependencies enabled, or point REYLO_ENGINE_PATH at the engine of reylo ${ENGINE_VERSION}`);
  }
  if (ping.database !== dialect) {throw refuse(core, `${binary} serves ${ping.database ?? "no one database"}'s engine when asked for ${dialect}'s`);}
  return new Engine(binary, dialect, ping.fingerprint, core);
};

// oxlint-disable-next-line typescript/promise-function-async -- Return the original in-flight Promise stored for this engine.
const loadEngine = (binary: string, dialect: Dialect): Promise<Engine> => {
  const key = `${binary}\0${dialect}`;
  const active = engines.get(key);
  if (active) {return active;}
  const loading = launchEngine(binary, dialect);
  // oxlint-disable-next-line promise/prefer-await-to-then -- Observe rejection to release the cache and return the original shared Promise to callers.
  loading.catch(() => {engines.delete(key);});
  engines.set(key, loading);
  return loading;
};

/**
 * Load a native engine once per process and binary.
 * @param {Dialect} dialect - The database whose native engine should run.
 * @returns {Promise<Engine>} The shared engine load, or a MissingEngine rejection.
 */
// oxlint-disable-next-line typescript/promise-function-async -- Existing callers receive the same in-flight Promise from this native cache.
export const engine = function engine(dialect: Dialect): Promise<Engine> {
  if (dialect !== "sqlite") {
    return Promise.reject(new MissingEngine(`This fork supports SQLite analysis only, not ${dialect} statements`));
  }
  try {return loadEngine(nativeBinary(), dialect);}
  catch (error) {return Promise.reject(missingEngine(error));}
};

/**
 * Load the engine used to read project configuration.
 * @returns {Promise<Engine | MissingEngine>} The engine or its native initialization failure.
 */
export const anyEngine = async function anyEngine(): Promise<Engine | MissingEngine> {
  try {return await engine("sqlite");}
  catch (error) {return error instanceof MissingEngine ? error : missingEngine(error);}
};
