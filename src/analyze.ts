// Bundlers, the type checker, the loader and `reylo generate` share the project's persistent analysis cache.
import { MissingEngine } from "./engine.ts";
import type { Engine, Lexed } from './engine.ts';
import { packageDir } from './project.ts';
import type { ResolvedProject } from './project.ts';
import type { NotMysql } from "./connection.ts";
import { matchesNull, matchesUndefined, nonemptyText } from "./native-predicates.ts";
import { analyzeLive, cacheEntryFile, readOfflineEntry } from "./analysis-cache.ts";
import type { AnalysisOptions } from "./analysis-cache.ts";
import { applyProjectDrivers, openAnalysisConnection, settleInBackground } from "./analysis-connection.ts";
import { ConnectionOwner } from "./analysis-connection-owner.ts";
import { connectionDiagnostic, databaseLocation, hostEnvironment, openProject, serverKey, statementKey } from "./analysis-identity.ts";
import { DATABASE_FAILURE, failedAnalysis, INVALID_PROJECT, MISSING_DATABASE_URL, successfulAnalysis } from "./analysis-results.ts";
import type { Outcome } from "./analysis-results.ts";
import { SchemaTracker } from "./analysis-schema.ts";

export type { Entry } from "./analysis-cache.ts";
export type { Outcome } from "./analysis-results.ts";

interface SessionOrigin {
  dir: string;
  env: Record<string, string | undefined>;
  idle: number;
}

// A build step's session closes its connection a moment after its last file, so that a build
// Process ends when its work does: the plugins whose bundler says when a build ends close it then
// (`releaseConnections`), and a loader (webpack, Rspack, Turbopack) has no such signal. The type
// Check's session keeps its connection.
const BUILD_IDLE = 250;
const NO_ACTIVE_ANALYSIS = 0;
const ONE_ANALYSIS = 1;

const sessions = new Map<string, Session>();

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
  #connections = new ConnectionOwner({
    open: async (url) => openAnalysisConnection(this.#engine, this.project, url),
    project: () => this.project,
  });
  #busy = NO_ACTIVE_ANALYSIS;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #catalog = new SchemaTracker({
    connections: this.#connections,
    project: () => this.project,
    refused: (error) => this.notMysql(error),
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
    this.#connections.adopt(project.url);
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

  #cacheFile(statement: string): string {
    return cacheEntryFile(this.root, statement, serverKey(this.project));
  }

  #statementKey(sql: string): string {
    return statementKey(this.#engineFingerprint, this.project.dialect, sql);
  }

  async #offlineAnalysis(sql: string): Promise<Extract<Outcome, { ok: true }> | undefined> {
    const statement = this.#statementKey(sql);
    const own = this.#cacheFile(statement);
    const hit = await readOfflineEntry(this.root, statement, own);
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
      return outcome.ok && this.project.dialect === "sqlite"
        ? await applyProjectDrivers(sql, outcome, { connections: this.#connections, schema: this.#catalog.snapshot?.value })
        : outcome;
    } finally {
      this.#busy -= ONE_ANALYSIS;
      if (this.#busy === NO_ACTIVE_ANALYSIS && this.#connections.hasPending() && Number.isFinite(this.#origin.idle)) {
        this.#timer = setTimeout(() => {
          settleInBackground(this.#connections.release());
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
    const connection = await this.#connections.get();
    return connection.query(sql, params);
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
    return this.#analyzeConfigured(sql, options);
  }

  async #analyzeConfigured(sql: string, options: AnalysisOptions): Promise<Outcome> {
    if (this.#engine instanceof MissingEngine) {
      return failedAnalysis(this.#engine.message, INVALID_PROJECT);
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
    return analyzeLive(sql, { file, fingerprint: schema.value, options }, {
      cannotConnect: (why) => this.cannotConnect(why),
      catalog: this.#catalog,
      connections: this.#connections,
      project: () => this.project,
      refused: (error) => this.notMysql(error),
      root: this.root,
    });
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
    await this.#connections.release();
  }
};

export const releaseConnections = async (): Promise<void> => {
  await Promise.all([...sessions.values()].map(async (session) => session.release()));
};
