// One analysis path for every consumer of a `.sql` file — the type check, the bundler plugins,
// The runtime hook and `reylo generate` — and one cache they share: `.reylo/` beside the project
// File, one entry per statement. The cache is only for speed. An entry records the schema it was
// Analyzed against; while the database answers, an entry for another schema is analyzed again,
// And while it does not, or no URL names it, the entries are used as they are, so a build that
// Cannot reach the database runs on what `reylo generate` or an earlier type check wrote.
import { anyEngine, engine as installedEngine, reason, MissingEngine, Unreachable } from './engine.ts';
import type { Engine, Lexed } from './engine.ts';
import { packageDir, resolveProject } from './project.ts';
import type { ResolvedProject } from './project.ts';
import { NotMysql, refusedLogin } from "./connection.ts";
import { matchesNull, matchesNullish, matchesUndefined, nonemptyText } from "./native-predicates.ts";
import { CACHE_ENTRY_VERSION, cacheEntryFile, readCacheEntry, readOfflineEntry, writeCacheEntry } from "./analysis-cache.ts";
import type { Entry } from "./analysis-cache.ts";
import { closeAnalysisConnection, getOpenConnection, openAnalysisConnection, settleInBackground, withLoginRetry } from "./analysis-connection.ts";
import type { AnalysisConnection } from "./analysis-connection.ts";

import { cacheServer, connectionDiagnostic, databaseLocation, digestPrefix } from "./analysis-identity.ts";
import { cacheTime, errorMessage, failedAnalysis, offlineSchema, successfulAnalysis } from "./analysis-results.ts";
import type { Outcome } from "./analysis-results.ts";
import { SchemaTracker } from "./analysis-schema.ts";

export type { Entry } from "./analysis-cache.ts";
export type { Outcome } from "./analysis-results.ts";

interface AnalysisOptions {
  force?: boolean;
  store?: boolean;
}

interface SessionOrigin {
  dir: string;
  env: Record<string, string | undefined>;
  idle: number;
}

interface AnalysisTarget {
  file: string;
  fingerprint: string;
}

const SERVER_DIGEST_LENGTH = 16;
const STATEMENT_DIGEST_LENGTH = 32;
const DATABASE_FAILURE = 5;
const MISSING_DATABASE_URL = 4;
const INVALID_PROJECT = 11;

// A build step's session closes its connection a moment after its last file, so that a build
// Process ends when its work does: the plugins whose bundler says when a build ends close it then
// (`releaseConnections`), and a loader (webpack, Rspack, Turbopack) has no such signal. The type
// Check's session keeps its connection.
const BUILD_IDLE = 250;
const NO_ACTIVE_ANALYSIS = 0;
const ONE_ANALYSIS = 1;

// oxlint-disable-next-line node/no-process-env -- The public Session factories default to the current host environment when the caller supplies none.
const hostEnvironment = (): NodeJS.ProcessEnv => process.env;

const sessions = new Map<string, Session>();

/**
 * The project a directory belongs to, its file read by the engine's core, and the engine of its own
 * database, or why that cannot be run.
 * @param {string} dir Directory used to find the project.
 * @param {Record<string, string | undefined>} env Environment used to resolve the project configuration.
 * @returns {Promise<{ project: ResolvedProject; engine: Engine | MissingEngine }>} The resolved configuration and its engine, or the reason the engine is missing.
 */
const openProject = async function (dir: string, env: Record<string, string | undefined>): Promise<{ project: ResolvedProject; engine: Engine | MissingEngine }> {
  const project = resolveProject(await anyEngine(), dir, env);
  const own = await installedEngine(project.dialect).catch((error: unknown) => (error instanceof MissingEngine ? error : new MissingEngine(errorMessage(error))));
  return { engine: own, project };
};

export class Session {
  /** The project as resolved when the session opened, or again once a failed `direct_url` command succeeds (`#reread`). */
  public project!: ResolvedProject;
  /** The project's directory, which holds `.reylo/`. */
  // oxlint-disable-next-line rules/no-readonly -- Keep the public Session root read-only for existing callers.
  public readonly root: string;
  /** The engine of the project's database, or why there is none, which an analysis reports. */
  #engine!: Engine | MissingEngine;
  #engineFingerprint!: string;
  /** The original project lookup and its connection idle policy. */
  // oxlint-disable-next-line rules/no-readonly -- This session always re-resolves the project with the settings it opened with.
  readonly #origin: SessionOrigin;
  #io: Promise<AnalysisConnection> | undefined;
  /** The URL the connection opens: the project's, until a command in `direct_url` gives a fresh one. */
  #url: string | undefined;
  #busy = NO_ACTIVE_ANALYSIS;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #catalog = new SchemaTracker({
    // oxlint-disable-next-line typescript/promise-function-async -- Catalog failure must retain the original connection ticket for an identity check.
    connect: () => this.#connection(),
    drop: (pending) => {this.#drop(pending);},
    project: () => this.project,
    refused: (error) => this.notMysql(error),
    release: async () => this.#release(),
    root: () => this.root,
  });

  private constructor(engine: Engine | MissingEngine, project: ResolvedProject, origin: SessionOrigin) {
    this.root = project.root;
    this.#origin = origin;
    this.#adopt(engine, project);
  }

  #adopt(engine: Engine | MissingEngine, project: ResolvedProject): void {
    this.#engine = engine;
    this.project = project;
    this.#url = project.url;
    this.#engineFingerprint = engine instanceof MissingEngine ? "unknown" : engine.fingerprint;
  }

  /**
   * Reads the project again while a `direct_url` command's failure is its error, as when a
   * password manager was locked: the command runs again once its failure has stood a minute
   * (src/project.ts), so that a session kept open, as the type check's is, recovers without a
   * restart.
   */
  async #reread(): Promise<void> {
    if (matchesUndefined(nonemptyText(this.project.error)) || matchesUndefined(this.project.refreshUrl)) {return;}
    const { project, engine } = await openProject(this.#origin.dir, this.#origin.env);
    if (!matchesUndefined(nonemptyText(project.error))) {return;}
    this.#adopt(engine, project);
    this.#catalog.snapshot = undefined;
  }

  /**
   * Reuses a build session for matching project and connection settings in this process.
   * @param {string} from File or directory in the project.
   * @param {Record<string, string | undefined>} env Environment used to resolve connection settings.
   * @returns {Promise<Session>} The build session for those settings.
   */
  public static async for(from: string, env: Record<string, string | undefined> = hostEnvironment()): Promise<Session> {
    // From the package's directory, so that a message names a file as the project sees it.
    const dir = packageDir(from);
    const { project, engine } = await openProject(dir, env);
    // A setting the build step reads (`sqlcommenter`) is part of the key, so a change to it in the
    // Project file reaches a running watch process.
    const key = JSON.stringify([project.root, project.url, project.error, project.sqlcommenter, engine instanceof MissingEngine ? engine.message : undefined]);
    const existing = sessions.get(key);
    if (existing) {
      return existing;
    }
    const session = new Session(engine, project, { dir, env, idle: BUILD_IDLE });
    sessions.set(key, session);
    return session;
  }

  /**
   * Opens an independent session for callers such as the type checker.
   * @param {string} from File or directory in the project.
   * @param {Record<string, string | undefined>} env Environment used to resolve connection settings.
   * @param {number} idle Milliseconds before releasing an idle connection. The default keeps it open.
   * @returns {Promise<Session>} An independent session.
   */
  public static async open(from: string, env: Record<string, string | undefined> = hostEnvironment(), idle = Infinity): Promise<Session> {
    const { project, engine } = await openProject(from, env);
    return new Session(engine, project, { dir: from, env, idle });
  }

  /**
   * Lists build sessions so callers such as `reylo generate` can close them.
   * @returns {Session[]} The build sessions this process opened.
   */
  public static opened(): Session[] {
    return [...sessions.values()];
  }

  public async lex(sql: string): Promise<Lexed> {
    if (this.#engine instanceof MissingEngine) {throw this.#engine;}
    return this.#engine.lexAsync(sql, this.project.dialect);
  }

  /**
   * Where this session's entry for a statement lives, whether or not it exists yet: named by the
   * statement, then by the server. Two databases keep an entry each, since a Postgres fingerprint
   * holds object ids, so a dev and a test database built by the same migrations still differ. A
   * session that cannot reach its database, or has no URL, reads another server's entry for the
   * statement where it has none of its own (`#offlineAnalysis`).
   * @param {string} sql The SQL statement used to compute the cache key.
   * @returns {string} The absolute path of this server's cache entry.
   */
  public entryFile(sql: string): string {
    return this.#cacheFile(this.#statementKey(sql));
  }

  #cacheFile(statementKey: string): string {
    return cacheEntryFile(this.root, statementKey, digestPrefix(cacheServer(this.project), SERVER_DIGEST_LENGTH));
  }

  #statementKey(sql: string): string {
    return digestPrefix(JSON.stringify([CACHE_ENTRY_VERSION, this.#engineFingerprint, this.project.dialect, sql]), STATEMENT_DIGEST_LENGTH);
  }

  async #offlineAnalysis(sql: string): Promise<Extract<Outcome, { ok: true }> | undefined> {
    const statementKey = this.#statementKey(sql);
    const own = this.#cacheFile(statementKey);
    const hit = await readOfflineEntry(this.root, statementKey, own);
    return hit ? successfulAnalysis(hit.entry.analysis, "cache", hit.file) : undefined;
  }

  /**
   * The statement's analysis: from `.reylo/` when the entry matches the schema, else from the
   * database. `store: false` neither reads nor writes `.reylo/`, for a statement that is no file of
   * the project (`reylo play`'s, analyzed at each keystroke).
   * @param {string} sql The SQL statement to analyze.
   * @param {{ force?: boolean; store?: boolean }} options Controls for refreshing existing results and storing live analysis.
   * @returns {Promise<Outcome>} The analysis or a diagnostic with an error code.
   */
  public async analyze(sql: string, options: { force?: boolean; store?: boolean } = {}): Promise<Outcome> {
    clearTimeout(this.#timer);
    this.#busy += ONE_ANALYSIS;
    try {
      await this.#reread();
      const outcome = await this.#analyze(sql, options);
      return outcome.ok && this.project.dialect === "sqlite" ? await this.#onDrivers(sql, outcome) : outcome;
    } finally {
      this.#busy -= ONE_ANALYSIS;
      if (this.#busy === NO_ACTIVE_ANALYSIS && this.#io && Number.isFinite(this.#origin.idle)) {
        this.#timer = setTimeout(() => {
          settleInBackground(this.#release());
        }, this.#origin.idle).unref();
      }
    }
  }

  /**
   * Runs a catalog query on the session's connection.
   * @param {string} sql The catalog query.
   * @param {unknown[]} params Bound positional values.
   * @returns {Promise<unknown[][]>} The result rows, with each row represented as an array of values.
   */
  public async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    const connection = await this.#connection();
    return connection.query(sql, params);
  }

  /**
   * A SQLite statement prepared on the app's own drivers too, whose SQLite may be older than the
   * engine's: the first that refuses it is an error at the place SQLite names. Not kept in
   * `.reylo/`, since the drivers are the project's and not the database's; a session that cannot
   * open the database checks nothing. One whose connection was released while its schema is still
   * trusted opens it again, so a `.reylo/` hit is checked however long the session sat idle.
   * @param {string} sql The original statement, used to locate a diagnostic.
   * @param {Extract<Outcome, { ok: true }>} outcome The successful analysis to check on the installed drivers.
   * @returns {Promise<Outcome>} The outcome with a diagnostic if a driver refuses the statement.
   */
  async #onDrivers(sql: string, outcome: Extract<Outcome, { ok: true }>): Promise<Outcome> {
    const { analysis } = outcome;
    if (analysis.diagnostics.length || matchesNullish(this.#catalog.snapshot?.value)) {return outcome;}
    const io = await getOpenConnection(this.#connection());
    for (const driver of io?.drivers ?? []) {
      const refusal = await driver.refuses(analysis.rewritten.sql, analysis.rewritten.order.length);
      if (matchesUndefined(refusal)) {continue;}
      const { placeRefusal } = await import("./sqlite-drivers.ts");
      const { start, length } = placeRefusal(sql, refusal);
      const message = driver.says(refusal);
      return { ...outcome, analysis: { ...analysis, diagnostics: [{ message, start, length, code: 6 }] } };
    }
    return outcome;
  }

  async #analyze(sql: string, options: AnalysisOptions): Promise<Outcome> {
    const projectError = nonemptyText(this.project.error);
    if (!matchesUndefined(projectError)) {
      return failedAnalysis(projectError, INVALID_PROJECT);
    }
    if (matchesUndefined(nonemptyText(this.project.url))) {
      const hit = this.#engine instanceof MissingEngine || options.force === true ? undefined : await this.#offlineAnalysis(sql);
      return hit ?? failedAnalysis(this.project.missingUrl, MISSING_DATABASE_URL);
    }
    const engine = this.#engine;
    if (engine instanceof MissingEngine) {
      return failedAnalysis(engine.message, INVALID_PROJECT);
    }
    const file = this.entryFile(sql);
    const schema = await this.schema();
    if (schema.fatal === true) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Every fatal schema result has a diagnostic and the public schema result retains its optional fields.
      return failedAnalysis(schema.error!, DATABASE_FAILURE);
    }
    if (matchesNull(schema.value)) {
      const hit = options.force === true ? undefined : await this.#offlineAnalysis(sql);
      return hit ?? failedAnalysis(`${this.cannotConnect(schema.error)}; .reylo has no analysis of this statement, so run reylo generate where the database can be reached.`, DATABASE_FAILURE);
    }
    return this.#analyzeLive(sql, { file, fingerprint: schema.value }, options);
  }

  async #analyzeLive(sql: string, { file, fingerprint }: AnalysisTarget, options: AnalysisOptions): Promise<Outcome> {
    const entry = options.force === true || options.store === false ? undefined : await readCacheEntry(file);
    if (entry?.schema === fingerprint) {
      return successfulAnalysis(entry.analysis, "cache", file);
    }
    const outcome = await this.#queryAnalysis(sql, file);
    if (outcome.ok && options.store !== false) {
      // oxlint-disable-next-line eslint/sort-keys -- Preserve the byte order of the serialized version 1 cache entry.
      const updated: Entry = { version: CACHE_ENTRY_VERSION, dialect: this.project.dialect, schema: fingerprint, analysis: outcome.analysis, at: cacheTime() };
      await writeCacheEntry(this.root, file, updated);
    }
    return outcome;
  }

  async #queryAnalysis(sql: string, file: string): Promise<Outcome> {
    const pending = this.#connection();
    try {
      const connection = await pending;
      const analysis = await connection.analyze(sql);
      return successfulAnalysis(analysis, "database", file);
    } catch (error) {
      return this.#analyzeFailure(pending, error);
    }
  }

  #analyzeFailure(pending: Promise<AnalysisConnection>, error: unknown): Outcome {
    // A dead connection is reopened on the next call. A server error is reported to the caller.
    if (error instanceof Unreachable) {
      this.#drop(pending);
      this.#catalog.snapshot = offlineSchema(cacheTime(), reason(error));
      return failedAnalysis(this.cannotConnect(reason(error)), DATABASE_FAILURE);
    }
    if (error instanceof NotMysql) {
      this.#drop(pending);
      const message = this.notMysql(error);
      this.#catalog.snapshot = offlineSchema(cacheTime(), message, true);
      return failedAnalysis(message, DATABASE_FAILURE);
    }
    return failedAnalysis(errorMessage(error), DATABASE_FAILURE);
  }

  /**
   * The fingerprint of the database's schema; null when the database cannot be reached, and
   * `fatal` when no connection can be made at all (no driver installed) or the server is one the type
   * check refuses (MariaDB, `NotMysql`). A server that refuses the
   * fingerprint query gets a value no entry matches, so every statement is analyzed live.
   * @returns {Promise<{ value: string | null; error?: string; fatal?: boolean }>} The catalog fingerprint, or the reason it could not be obtained.
   */
  public async schema(): Promise<{ value: string | null; error?: string; fatal?: boolean }> {
    return this.#catalog.read();
  }

  /**
   * Refreshes the schema fingerprint even if the current value is still fresh.
   * @returns {Promise<boolean>} Whether the fingerprint changed.
   */
  public async recheck(): Promise<boolean> {
    const before = this.#catalog.snapshot?.value;
    if (this.#catalog.snapshot) {this.#catalog.snapshot = { ...this.#catalog.snapshot, at: -Infinity };}
    const after = await this.schema();
    return after.value !== before;
  }

  /**
   * Describes the address and the source of its configuration.
   * @param {string} why An optional connection error to append to the diagnostic.
   * @returns {string} A connection diagnostic with the address redacted of credentials.
   */
  public cannotConnect(why?: string): string {
    return connectionDiagnostic(this.project, () => this.where(), why);
  }

  /**
   * Explains why an incompatible MySQL server was rejected.
   * @param {NotMysql} refusal The error that identifies the server implementation.
   * @returns {string} A diagnostic describing the required replacement server.
   */
  public notMysql(refusal: NotMysql): string {
    return `Cannot type-check against the database at ${this.where()} (${this.project.urlSource}): it is ${refusal.server}, and Reylo type-checks MySQL statements against MySQL. Point the type check's URL at a MySQL server, 8.4 or later, with the same schema.`;
  }

  /**
   * Formats the database location for a diagnostic.
   * @returns {string} The host, port and database, or the path to a local database.
   */
  public where(): string {
    return databaseLocation(this.project);
  }

  public async close(): Promise<void> {
    Iterator.from(sessions).forEach(([key, session]) => {if (session === this) {sessions.delete(key);}});
    await this.release();
  }

  /** Closes the connection now, for a caller that knows no file is coming; the next analysis opens another. */
  public async release(): Promise<void> {
    clearTimeout(this.#timer);
    await this.#release();
  }

  /** Closes the connection; the next analysis opens another. */
  async #release(): Promise<void> {
    const pending = this.#io;
    this.#io = undefined;
    if (!matchesUndefined(pending)) {
      await closeAnalysisConnection(pending);
    }
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Return the same Promise so failure and release can distinguish it from a newer connection.
  #connection(): Promise<AnalysisConnection> {
    const pending = this.#io;
    if (!matchesUndefined(pending)) {
      return pending;
    }
    const opened = this.#connect();
    this.#io = opened;
    settleInBackground(this.#discardFailedOpen(opened));
    return opened;
  }

  async #discardFailedOpen(pending: Promise<AnalysisConnection>): Promise<void> {
    try {
      await pending;
    } catch {
      if (this.#io === pending) {
        this.#io = undefined;
      }
    }
  }

  async #connect(): Promise<AnalysisConnection> {
    const first = await this.#openFirst();
    return matchesUndefined(this.project.refreshUrl) ? first : withLoginRetry(first, async (cause) => this.#reopen(cause));
  }

  async #openFirst(): Promise<AnalysisConnection> {
    try {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Analysis supplies a project URL. Direct query calls without one retain the native open diagnostic.
      return await this.#open(this.#url!);
    } catch (error) {
      return this.#reopen(error);
    }
  }

  async #reopen(cause: unknown): Promise<AnalysisConnection> {
    const fresh = this.#freshUrl(cause);
    if (matchesUndefined(fresh)) {
      throw cause;
    }
    return this.#open(fresh);
  }

  /**
   * Forgets a connection a call found dead, and closes it, since one opened in its place with a
   * command's fresh output may be live. Only the connection that call ran on: a call that fails
   * late never ends one opened since.
   * @param {Promise<AnalysisConnection>} io The connection promise used by the failed operation.
   */
  #drop(io: Promise<AnalysisConnection>): void {
    if (this.#io !== io) {return;}
    this.#io = undefined;
    settleInBackground(closeAnalysisConnection(io));
  }

  /**
   * A URL to try instead, when the server refused the login and `direct_url`'s command now prints
   * something else, as when a short-lived password has expired; else undefined, so that nothing
   * is tried twice on the same password.
   * @param {unknown} cause The error from connecting with the current URL.
   * @returns {string | undefined} The refreshed URL if the configuration produced a different one.
   */
  #freshUrl(cause: unknown): string | undefined {
    if (!refusedLogin(cause)) {return undefined;}
    const fresh = this.project.refreshUrl?.();
    if (matchesUndefined(fresh) || fresh === this.#url) {return undefined;}
    this.#url = fresh;
    return fresh;
  }

  async #open(url: string): Promise<AnalysisConnection> {
    return openAnalysisConnection(this.#engine, this.project, url);
  }
}

/** Closes every build-step session's connection, for a build step whose build has ended: the process then ends without waiting out the idle time. */
export const releaseConnections = async function (): Promise<void> {
  await Promise.all([...sessions.values()].map(async (session) => session.release()));
};
