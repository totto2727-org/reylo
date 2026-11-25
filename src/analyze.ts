// One analysis path for every consumer of a `.sql` file — the type check, the bundler plugins,
// The runtime hook and `reylo generate` — and one cache they share: `.reylo/` beside the project
// File, one entry per statement. The cache is only for speed. An entry records the schema it was
// Analyzed against; while the database answers, an entry for another schema is analyzed again,
// And while it does not, or no URL names it, the entries are used as they are, so a build that
// Cannot reach the database runs on what `reylo generate` or an earlier type check wrote.
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to inspect or write files through the host filesystem.
import { readFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to compute the existing digest using the host's hash implementation.
import { createHash } from "node:crypto";
import { anyEngine, AnswerCache, engine, reason, MissingEngine, Unreachable } from './engine.ts';
import type { Analysis, Engine, Lexed } from './engine.ts';
import { duckdbPath, hclPath, packageDir, resolveProject, sqlitePath } from './project.ts';
import type { ResolvedProject } from './project.ts';
import { duckdbDatabase } from "./duckdb.ts";
import { NotMysql, refusedLogin } from "./connection.ts";
import type { SqliteDriver } from "./sqlite-drivers.ts";
import { matchesNull, matchesNullish, matchesUndefined } from "./native-predicates.ts";
import { CACHE_ENTRY_VERSION, cacheEntryFile, readCacheEntry, readOfflineEntry, writeCacheEntry } from "./analysis-cache.ts";
import { FINGERPRINT } from "./schema-fingerprint.ts";

export type { Entry } from "./analysis-cache.ts";

export type Outcome =
  | { ok: true; analysis: Analysis; source: "cache" | "database"; entry: string }
  | { ok: false; message: string; code: number };

/**
 * A connection the engine holds (src/engine.ts): `analyze` runs a statement's whole analysis over
 * it, `query` runs the schema's fingerprint, and `forget` drops the answers the engine keeps once
 * the schema changes. On SQLite, `drivers` are the app's own, which each statement is prepared on
 * too (src/sqlite-drivers.ts).
 */
interface Io { analyze(sql: string): Promise<Analysis>; query(sql: string, params: unknown[]): Promise<unknown[][]>; forget: () => Promise<void>; close: () => Promise<void>; drivers?: SqliteDriver[] }

const DIGEST_START = 0;
const SERVER_DIGEST_LENGTH = 16;
const SCHEMA_DIGEST_LENGTH = 16;
const STATEMENT_DIGEST_LENGTH = 32;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const digestPrefix = (text: string, length: number): string => sha256(text).slice(DIGEST_START, length);

// How long a schema fingerprint is trusted, as long as a statement answer: a migration shows up
// In a running dev server or editor within seconds. Once the database is found unreachable, the
// Session stays offline for a minute instead of paying the connect timeout per file.
const SCHEMA_TTL = 5000;
const OFFLINE_TTL = 60_000;
// A build step's session closes its connection a moment after its last file, so that a build
// Process ends when its work does: the plugins whose bundler says when a build ends close it then
// (`releaseConnections`), and a loader (webpack, Rspack, Turbopack) has no such signal. The type
// Check's session keeps its connection.
const BUILD_IDLE = 250;

const sessions = new Map<string, Session>();

/**
 * The project a directory belongs to, its file read by the engine's core, and the engine of its own
 * database, or why that cannot be run.
 */
const openProject = async function (dir: string, env: Record<string, string | undefined>): Promise<{ project: ResolvedProject; engine: Engine | MissingEngine }> {
  const project = resolveProject(await anyEngine(), dir, env);
  const own = await engine(project.dialect).catch((error: unknown) => (error instanceof MissingEngine ? error : new MissingEngine((error as Error).message)));
  return { project, engine: own };
};

export class Session {
  /** The project as resolved when the session opened, or again once a failed `direct_url` command succeeds (`#reread`). */
  public project!: ResolvedProject;
  /** The project's directory, which holds `.reylo/`. */
  public readonly root: string;
  /** The engine of the project's database, or why there is none, which an analysis reports. */
  #engine!: Engine | MissingEngine;
  #engineFingerprint!: string;
  readonly #idle: number;
  /** Where the project was resolved from, and with what environment, for `#reread`. */
  readonly #dir: string;
  readonly #env: Record<string, string | undefined>;
  #io: Promise<Io> | undefined;
  /** The URL the connection opens: the project's, until a command in `direct_url` gives a fresh one. */
  #url: string | undefined;
  #busy = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #schema: { value: string | null; at: number; error?: string; fatal?: boolean } | undefined;
  #hclHash: string | undefined;

  private constructor(engine: Engine | MissingEngine, project: ResolvedProject, idle: number, dir: string, env: Record<string, string | undefined>) {
    this.root = project.root;
    this.#idle = idle;
    this.#dir = dir;
    this.#env = env;
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
    if (!this.project.error || !this.project.refreshUrl) {return;}
    const { project, engine } = await openProject(this.#dir, this.#env);
    if (project.error) {return;}
    this.#adopt(engine, project);
    this.#schema = undefined;
  }

  /** The build steps' session for the project a file or directory belongs to: one per project (and connection) and process. */
  public static async for(from: string, env: Record<string, string | undefined> = process.env): Promise<Session> {
    // From the package's directory, so that a message names a file as the project sees it.
    const dir = packageDir(from);
    const { project, engine } = await openProject(dir, env);
    // A setting the build step reads (`sqlcommenter`) is part of the key, so a change to it in the
    // Project file reaches a running watch process.
    const key = JSON.stringify([project.root, project.url ?? null, project.error ?? null, project.sqlcommenter, engine instanceof MissingEngine ? engine.message : null]);
    let session = sessions.get(key);
    if (!session) {sessions.set(key, (session = new Session(engine, project, BUILD_IDLE, dir, env)));}
    return session;
  }

  /** A session of its own, for a caller that must not share one (the type check, a test); it keeps its connection until closed. */
  public static async open(from: string, env: Record<string, string | undefined> = process.env, idle = Infinity): Promise<Session> {
    const { project, engine } = await openProject(from, env);
    return new Session(engine, project, idle, from, env);
  }

  /** Every build-step session this process opened, for a caller that ends them (`reylo generate`). */
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
   * statement where it has none of its own (`#offlineEntry`).
   */
  public entryFile(sql: string): string {
    return this.#cacheFile(this.#statementKey(sql));
  }

  #cacheFile(statementKey: string): string {
    return cacheEntryFile(this.root, statementKey, digestPrefix(this.#server(), SERVER_DIGEST_LENGTH));
  }

  #statementKey(sql: string): string {
    return digestPrefix(JSON.stringify([CACHE_ENTRY_VERSION, this.#engineFingerprint, this.project.dialect, sql]), STATEMENT_DIGEST_LENGTH);
  }

  /** The statement's entry from this session's server, else the newest from any other: for a session that cannot reach its database, or has no URL. */
  async #offlineEntry(sql: string): ReturnType<typeof readOfflineEntry> {
    const statementKey = this.#statementKey(sql);
    return readOfflineEntry(this.root, statementKey, this.#cacheFile(statementKey));
  }

  /**
   * The statement's analysis: from `.reylo/` when the entry matches the schema, else from the
   * database. `store: false` neither reads nor writes `.reylo/`, for a statement that is no file of
   * the project (`reylo play`'s, analyzed at each keystroke).
   */
  public async analyze(sql: string, options: { force?: boolean; store?: boolean } = {}): Promise<Outcome> {
    clearTimeout(this.#timer);
    this.#busy++;
    try {
      await this.#reread();
      const outcome = await this.#analyze(sql, options);
      return outcome.ok && this.project.dialect === "sqlite" ? await this.#onDrivers(sql, outcome) : outcome;
    } finally {
      if (--this.#busy === 0 && this.#io && Number.isFinite(this.#idle)) {this.#timer = setTimeout(() => this.#release(), this.#idle).unref();}
    }
  }

  /** Rows of a catalog query on the session's connection, as arrays of values: what `reylo play` completes. */
  public async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    return (await this.#connection()).query(sql, params);
  }

  /**
   * A SQLite statement prepared on the app's own drivers too, whose SQLite may be older than the
   * engine's: the first that refuses it is an error at the place SQLite names. Not kept in
   * `.reylo/`, since the drivers are the project's and not the database's; a session that cannot
   * open the database checks nothing. One whose connection was released while its schema is still
   * trusted opens it again, so a `.reylo/` hit is checked however long the session sat idle.
   */
  async #onDrivers(sql: string, outcome: Extract<Outcome, { ok: true }>): Promise<Outcome> {
    const { analysis } = outcome;
    if (analysis.diagnostics.length || matchesNullish(this.#schema?.value)) {return outcome;}
    const io = await this.#connection().catch(() => undefined);
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

  async #analyze(sql: string, options: { force?: boolean; store?: boolean }): Promise<Outcome> {
    if (this.project.error) {return { ok: false, message: this.project.error, code: 11 };}
    // With no URL, `.reylo/` answers as it does where the database cannot be reached (the dialect
    // Is the installed engine's), and a statement it lacks needs a URL.
    if (!this.project.url) {
      const hit = this.#engine instanceof MissingEngine || options.force ? undefined : await this.#offlineEntry(sql);
      return hit ? { ok: true, analysis: hit.entry.analysis, source: "cache", entry: hit.file } : { ok: false, message: this.project.missingUrl, code: 4 };
    }
    // The URL names the database, whose engine package the project has to have installed.
    const engine = this.#engine;
    if (engine instanceof MissingEngine) {return { ok: false, message: engine.message, code: 11 };}
    const file = this.entryFile(sql);
    const schema = await this.schema();
    if (schema.fatal) {return { ok: false, message: schema.error!, code: 5 };}
    if (matchesNull(schema.value)) {
      const hit = options.force ? undefined : await this.#offlineEntry(sql);
      if (hit) {return { ok: true, analysis: hit.entry.analysis, source: "cache", entry: hit.file };}
      return { ok: false, message: `${this.cannotConnect(schema.error)}; .reylo has no analysis of this statement, so run reylo generate where the database can be reached.`, code: 5 };
    }
    const entry = options.force || options.store === false ? undefined : await readCacheEntry(file);
    if (entry && entry.schema === schema.value) {return { ok: true, analysis: entry.analysis, source: "cache", entry: file };}
    let analysis: Analysis;
    const io = this.#connection();
    try {
      analysis = await (await io).analyze(sql);
    } catch (error) {
      // A dead connection is reopened by the next call; a server error is reported.
      if (error instanceof Unreachable) {
        this.#drop(io);
        this.#schema = { value: null, at: Date.now(), error: reason(error) };
        return { ok: false, message: this.cannotConnect(reason(error)), code: 5 };
      }
      if (error instanceof NotMysql) {
        this.#drop(io);
        this.#schema = { value: null, at: Date.now(), error: this.notMysql(error), fatal: true };
        return { ok: false, message: this.#schema.error!, code: 5 };
      }
      return { ok: false, message: (error as Error).message, code: 5 };
    }
    if (options.store !== false) {await writeCacheEntry(this.root, file, { version: CACHE_ENTRY_VERSION, dialect: this.project.dialect, schema: schema.value, analysis, at: Date.now() });}
    return { ok: true, analysis, source: "database", entry: file };
  }

  /**
   * The fingerprint of the database's schema; null when the database cannot be reached, and
   * `fatal` when no connection can be made at all (no driver installed) or the server is one the type
   * check refuses (MariaDB, `NotMysql`). A server that refuses the
   * fingerprint query gets a value no entry matches, so every statement is analyzed live.
   */
  public async schema(): Promise<{ value: string | null; error?: string; fatal?: boolean }> {
    const now = Date.now();
    const source = this.project.url && hclPath(this.project.url, this.root);
    if (source) {
      // Unlike a remote database, a local source is checked before every cache hit, without a TTL.
      try {
        const hash = sha256(readFileSync(source, "utf8"));
        if (hash !== this.#hclHash || matchesNull(this.#schema?.value)) {
          await this.#release();
          this.#schema = undefined;
          this.#hclHash = hash;
        }
      } catch (error) {
        await this.#release();
        this.#schema = { value: null, at: now, error: `Cannot read HCL schema ${source}: ${(error as Error).message}`, fatal: true };
        return this.#schema;
      }
    }
    if (this.#schema && now - this.#schema.at < (matchesNull(this.#schema.value) ? OFFLINE_TTL : SCHEMA_TTL)) {return this.#schema;}
    const pending = this.#connection();
    let io: Io;
    try {
      io = await pending;
    } catch (error) {
      this.#drop(pending);
      this.#schema = error instanceof Unreachable ? { value: null, at: now, error: reason(error) } : { value: null, at: now, error: error instanceof NotMysql ? this.notMysql(error) : (error as Error).message, fatal: true };
      return this.#schema;
    }
    try {
      // HCL is the complete schema source. Its content hash replaces a live catalog fingerprint.
      const rows = source ? [] : await io.query(FINGERPRINT[this.project.dialect], []);
      const value = digestPrefix(JSON.stringify(source ? [this.#hclHash, rows] : rows), SCHEMA_DIGEST_LENGTH);
      // The engine's answers describe the old schema too.
      if (this.#schema?.value && this.#schema.value !== value) {await io.forget().catch(() => {});}
      this.#schema = { value, at: now };
    } catch (error) {
      if (source) {
        this.#drop(pending);
        this.#schema = { value: null, at: now, error: (error as Error).message, fatal: true };
      } else if (error instanceof Unreachable) {
        this.#drop(pending);
        this.#schema = { value: null, at: now, error: reason(error) };
      } else {
        this.#schema = { value: `unverified ${process.pid} ${now}`, at: now };
      }
    }
    return this.#schema;
  }

  /** Reads the schema's fingerprint again now, however recent the last read; whether it changed. */
  public async recheck(): Promise<boolean> {
    const before = this.#schema?.value;
    if (this.#schema) {this.#schema = { ...this.#schema, at: -Infinity };}
    return (await this.schema()).value !== before;
  }

  /** Where the database was looked for, and where that came from; never the credentials. */
  public cannotConnect(why?: string): string {
    const { dialect, url, root, urlSource } = this.project;
    if (dialect === "sqlite") {return `Cannot open the database ${sqlitePath(url ?? "", root)} (${urlSource})${why ? `: ${why}` : ""}`;}
    if (dialect === "duckdb") {return `Cannot open the database ${duckdbPath(url ?? "", root)} (${urlSource})${why ? `: ${why}` : ""}`;}
    return `Cannot connect to the database at ${this.where()} (${urlSource})${why ? `: ${why}` : ""}`;
  }

  /** Why a server the type check cannot read is refused, and what to point it at instead. */
  public notMysql(e: NotMysql): string {
    return `Cannot type-check against the database at ${this.where()} (${this.project.urlSource}): it is ${e.server}, and Reylo type-checks MySQL statements against MySQL. Point the type check's URL at a MySQL server, 8.4 or later, with the same schema.`;
  }

  /** The server, without credentials, that names this session's entries: none with no URL, which writes none. */
  #server(): string {
    const { dialect, url, root } = this.project;
    if (!url) {return "";}
    const source = hclPath(url, root);
    if (source) {return `hcl:${source}`;}
    if (dialect === "sqlite") {return sqlitePath(url, root);}
    if (dialect === "duckdb") {return duckdbPath(url, root);}
    try {
      const currentUrl = new URL(url);
      return `${currentUrl.protocol}//${currentUrl.username}@${currentUrl.host}${currentUrl.pathname}`;
    } catch {
      return url;
    }
  }

  /** The database as a person names it: host, port and database, or the SQLite file. */
  public where(): string {
    const { dialect, url, root } = this.project;
    if (dialect === "sqlite") {return sqlitePath(url ?? "", root);}
    if (dialect === "duckdb") {return duckdbPath(url ?? "", root);}
    try {
      const currentUrl = new URL(url ?? "");
      return `${currentUrl.hostname || currentUrl.searchParams.get("host") || "localhost"}${currentUrl.port ? `:${currentUrl.port}` : ""}${currentUrl.pathname}`;
    } catch {
      return "the database";
    }
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
    const io = this.#io;
    this.#io = undefined;
    if (io) {await io.then((i) => i.close()).catch(() => {});}
  }

  #connection(): Promise<Io> {
    this.#io ??= (async (): Promise<Io> => {
      let first: Io;
      try {
        first = await this.#open(this.#url!);
      } catch (error) {
        const fresh = this.#freshUrl(error);
        if (matchesUndefined(fresh)) {throw error;}
        first = await this.#open(fresh);
      }
      if (!this.project.refreshUrl) {return first;}
      // A refused login can surface at any call, where a token expired while the session was open:
      // The call is asked once more on a connection with the command's fresh output. The calls refused
      // Together, as every call waiting when a token expires is, share one reopen, so that the
      // Command runs once and one connection replaces the old; a call that fails on a connection
      // Already replaced is asked again on the one that replaced it.
      let current: Promise<Io> = Promise.resolve(first);
      const again = async <T>(call: (on: Io) => Promise<T>): Promise<T> => {
        const used = current;
        const on = await used;
        try {
          return await call(on);
        } catch (error) {
          if (current === used) {
            if (!refusedLogin(error)) {throw error;}
            current = (async () => {
              await on.close().catch(() => {});
              const fresh = this.#freshUrl(error);
              if (matchesUndefined(fresh)) {throw error;}
              return this.#open(fresh);
            })();
            current.catch(() => {});
          }
          return call(await current);
        }
      };
      return {
        analyze: (sql) => again((on) => on.analyze(sql)),
        query: (text, params) => again((on) => on.query(text, params)),
        forget: () => again((on) => on.forget()),
        close: () => current.then((on) => on.close(), () => {}),
        ...(first.drivers && { drivers: first.drivers }),
      };
    })();
    const io = this.#io;
    io.catch(() => {
      if (this.#io === io) {this.#io = undefined;}
    });
    return io;
  }

  /**
   * Forgets a connection a call found dead, and closes it, since one opened in its place with a
   * command's fresh output may be live. Only the connection that call ran on: a call that fails
   * late never ends one opened since.
   */
  #drop(io: Promise<Io>): void {
    if (this.#io !== io) {return;}
    this.#io = undefined;
    io.then((i) => i.close()).catch(() => {});
  }

  /**
   * A URL to try instead, when the server refused the login and `direct_url`'s command now prints
   * something else, as when a short-lived password has expired; else undefined, so that nothing
   * is tried twice on the same password.
   */
  #freshUrl(e: unknown): string | undefined {
    if (!refusedLogin(e)) {return undefined;}
    const fresh = this.project.refreshUrl?.();
    if (matchesUndefined(fresh) || fresh === this.#url) {return undefined;}
    this.#url = fresh;
    return fresh;
  }

  async #open(url: string): Promise<Io> {
    const { dialect, root } = this.project;
    // The URL names a database whose engine the project lacks: its error, as the import's.
    if (this.#engine instanceof MissingEngine) {throw this.#engine;}
    const source = hclPath(url, root);
    if (source) {return (await import("./hcl.ts")).hclCatalog(source, this.#engine);}
    // DuckDB runs inside the app: the engine's needs are answered by the project's own DuckDB
    // (src/duckdb.ts), which opens the file for each analysis and holds nothing between them.
    if (dialect === "duckdb") {
      const engine = this.#engine;
      const db = duckdbDatabase(duckdbPath(url, root), root);
      const cache = new AnswerCache();
      return {
        analyze: (sql) => db.run((io) => engine.analyze(sql, "duckdb", io, cache)),
        query: (text, params) => db.run((io) => io.query(text, params)),
        forget: async () => cache.clear(),
        close: async () => {},
      };
    }
    // The engine opens the database itself: on SQLite the file the project names, and the statement
    // Is prepared on the app's own SQLite drivers too, which are the app's, not the engine's.
    const target = dialect === "sqlite" ? sqlitePath(url, root) : url;
    const connection = await this.#engine.open(target);
    let drivers: SqliteDriver[] | undefined;
    try {
      drivers = dialect === "sqlite" ? await (await import("./sqlite-drivers.ts")).openProjectDrivers(root, target) : undefined;
    } catch (error) {
      await connection.close();
      throw error;
    }
    return {
      analyze: (sql) => connection.analyze(sql),
      query: (text, params) => connection.query(text, params),
      forget: () => connection.forget(),
      close: async () => {
        await Promise.all((drivers ?? []).map((d) => d.close().catch(() => {})));
        await connection.close();
      },
      ...(drivers && { drivers }),
    };
  }
}

/** Closes every build-step session's connection, for a build step whose build has ended: the process then ends without waiting out the idle time. */
export async function releaseConnections(): Promise<void> {
  await Promise.all([...sessions.values()].map((session) => session.release()));
}
