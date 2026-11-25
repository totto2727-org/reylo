// The engine's half that needs no host: a request to the engine, the lexer, and the replay loop
// That hands each round's needs to an `EngineIo` until the analysis is done, for a host that answers
// Them over a connection of its own. src/engine.ts runs it over the published native engine.
import { Unreachable } from "./connection.ts";
import { AnswerCache } from "./engine-answer-cache.ts";
import type { EngineType, JsonSchema } from "./engine-type.ts";
import { matchesUndefined } from "./native-predicates.ts";

export { AnswerCache } from "./engine-answer-cache.ts";
export type { EngineType } from "./engine-type.ts";
export type Dialect = "postgres" | "sqlite" | "mysql" | "duckdb";

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public protocol type alias and its structural assignability.
export type Diagnostic = { message: string; start: number; length: number; code: number };

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public protocol type alias and its structural assignability.
export type Analysis = {
  kind: string;
  /** `nullable`: the statement lets the caller pass null, or leave the parameter out (it casts the parameter to `nullable(…)`, or writes it whole and bare, with no cast, to a column that may hold null). */
  /** `cast`: a `::type` written on MySQL or SQLite, which the run time checks a value against (src/rows.ts). */
  /** `comment`: the comment the database keeps on the column a parameter is written to (or, on MySQL, compared with), and on the table column a result column reads as it is; the declaration prints it as the field's doc comment. */
  params: { name: string; type: EngineType; type_name: string; nullable: boolean; schema?: JsonSchema; cast?: string; comment?: string }[];
  columns: { name: string; type: EngineType; nullable: boolean; type_name: string; comment?: string }[];
  cardinality: "one" | "maybeOne" | "many" | "none";
  cardinalityReason?: string;
  /** `inserted`: text the engine added that the statement as written does not hold, as `[original offset, start, end]` (the collation MySQL's own text needs). */
  rewritten: { sql: string; order: string[]; spans: [number, number, number, number][]; inserted?: [number, number, number][] };
  style: "none" | "named" | "positional" | "mixed";
  diagnostics: Diagnostic[];
  unresolved: string[];
  /** Each structured parameter in a MySQL insert, with the lists of `rewritten.sql` (UTF-8 byte offsets) the run time writes again for a call that leaves keys out; a Postgres or SQLite insert copies its defaults into the statement instead. */
  structured?: { name: string; lists: { start: number; end: number; entries: string[] }[] }[];
  /** The catalog facts the analysis relied on, and the query that reads them (upstream engine/core/src/fresh.rs). */
  fresh?: { query: string; rows: string[][]; inserts: string[]; defaults?: string[][] };
  /**
   * By each error's code, the names each of its fields may hold, where the statement runs only its
   * database's own code (upstream engine/core/src/errors.rs): `.try()`'s error, narrowed. Absent where
   * the statement may run a user's code, which may raise any error.
   */
  errors?: Record<string, Record<string, string[]>>;
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public protocol type alias and its structural assignability.
export type Lexed = {
  params: string[];
  placeholders: { name: string; start: number; end: number }[];
  style: "none" | "named" | "positional" | "mixed";
  /** The spans the lexer read as text (strings, quoted identifiers, comments): `[start, end]` byte offsets, in order. */
  opaque: [number, number][];
};

export type Need =
  | { kind: "describe"; id: string; sql: string }
  | { kind: "query"; id: string; sql: string; params: unknown[]; scope: "session" | "statement" };

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public protocol type alias and its structural assignability.
export type Described = { params: { oid: number }[]; columns: { name: string; oid: number; table: number; attnum: number }[] };
/** MySQL's prepare metadata: the protocol type code, the flags (bit 1 is NOT NULL), the charset (63 is binary), the display length and the table the column is one of (empty for an expression). */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public protocol type alias and its structural assignability.
export type MysqlDescribed = { kind: "mysql"; columns: { name: string; type: number; flags: number; charset: number; length: number; org_table: string; org_name: string }[]; params: { type: number; flags: number; charset: number }[] };
/** A DuckDB logical type as the upstream engine reads it (engine/duckdb/src/api.rs): its id, its text, and what the id says more of. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public protocol type alias and its structural assignability.
export type DuckdbType = { id: string; text: string; alias?: string; width?: number; scale?: number; child?: DuckdbType; size?: number; fields?: { name: string; type: DuckdbType }[]; key?: DuckdbType; value?: DuckdbType; values?: string[] };
/** What DuckDB's prepared statement reports: its statement type, each parameter's type (null where DuckDB cannot tell it), each result column's name and type. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public protocol type alias and its structural assignability.
export type DuckdbDescribed = { kind: "duckdb"; statement: string; params: { name: string; type: DuckdbType | null }[]; columns: { name: string; type: DuckdbType }[] };
// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public protocol type alias and its structural assignability.
export type DbError = { message: string; code?: string; position?: number };
export type Answer =
  | { describe: { params: number[]; columns: Described["columns"] } }
  | { mysql: { columns: MysqlDescribed["columns"]; params: MysqlDescribed["params"] } }
  | { describe: { statement: string; params: DuckdbDescribed["params"]; columns: DuckdbDescribed["columns"] } }
  | { rows: unknown[][] }
  | { error: DbError };

/** What the host does for the engine: describe a statement, run a catalog query. */
export interface EngineIo {
  /** Postgres: Parse/Describe. MySQL: a server prepare. DuckDB: a prepared statement. SQLite needs none: the engine prepares inside its own SQLite. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the public host adapter method type and its existing variance.
  describe(sql: string): Promise<Described | MysqlDescribed | DuckdbDescribed>;
  /** Rows as arrays of values, in column order. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the public host adapter method type and its existing variance.
  query(sql: string, params: unknown[]): Promise<unknown[][]>;
}

export type Response =
  | { status: "ok"; version: string; fingerprint: string; database?: Dialect }
  | { status: "lexed"; lexed: Lexed }
  | { status: "need"; needs: Need[] }
  | { status: "analysis"; analysis: Analysis }
  | { status: "config"; config: unknown }
  | { status: "configError"; error: { message: string; start: number; end: number } }
  | { status: "error"; message: string };

/** An engine's request function: one JSON request in, its answer out. */
export type EngineCall = (request: string) => string;

const FIRST_ROUND = 0;
const NEXT_ROUND = 1;
const ROUND_LIMIT = 16;

const described = (reply: Described | MysqlDescribed | DuckdbDescribed): Answer => {
  if ("kind" in reply && reply.kind === "duckdb") {
    // oxlint-disable-next-line eslint/sort-keys -- Keep the engine protocol's existing field order.
    return { describe: { statement: reply.statement, params: reply.params, columns: reply.columns } };
  }
  if ("kind" in reply) {return { mysql: { columns: reply.columns, params: reply.params } };}
  // oxlint-disable-next-line eslint/sort-keys -- Keep the engine protocol's existing field order.
  return { describe: { params: reply.params.map((parameter) => parameter.oid), columns: reply.columns } };
};

const databaseFailure = (failure: unknown): DbError => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Driver errors already supply these native diagnostic fields. Preserve their original coercions.
  const driver = failure as Error & { code?: string; position?: string | number };
  const error: DbError = { message: driver.message };
  const hasCode = Boolean(driver.code);
  if (hasCode) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The driver's successful code check supplies a string. Read property getters as before.
    error.code = driver.code!;
  }
  if (!matchesUndefined(driver.position)) {error.position = Number(driver.position);}
  return error;
};

const fulfil = async (need: Need, io: EngineIo): Promise<Answer> => {
  try {
    if (need.kind === "describe") {return described(await io.describe(need.sql));}
    return { rows: await io.query(need.sql, need.params) };
  } catch (error) {
    if (error instanceof Unreachable) {throw error;}
    return { error: databaseFailure(error) };
  }
};

const unexpected = (reply: Response): Error =>
  // oxlint-disable-next-line rules/require-tagged-error -- The synchronous and asynchronous engine calls expose a native protocol Error.
  new Error(reply.status === "error" ? reply.message : `unexpected ${reply.status}`);

export const expectLexed = (reply: Response): Lexed => {
  if (reply.status !== "lexed") {throw unexpected(reply);}
  return reply.lexed;
};

interface RoundHost {
  answers: Record<string, Answer>;
  cache: AnswerCache;
  io: EngineIo;
}

const supply = async ({ answers, cache, io }: RoundHost, needs: Need[]): Promise<void> => {
  await Promise.all(needs.map(async (need) => {
    answers[need.id] = await cache.get(need, async () => fulfil(need, io));
  }));
};

/**
 * An engine's core: its requests that need no database, and the analysis of a statement whose
 * needs a host answers itself (`analyze` with an `EngineIo`), as the HCL catalog does.
 * A database-backed Node host lets the engine connect itself instead (src/engine.ts).
 */
export class EngineCore {
  #call: EngineCall;

  public constructor(call: EngineCall) {
    this.#call = call;
  }

  public call(request: object): Response {
    const reply: unknown = JSON.parse(this.#call(JSON.stringify(request)));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The engine serializes its published response union over this native boundary.
    return reply as Response;
  }

  /**
   * Send one request that may wait on a native host's channel.
   * @param {object} request - One engine operation and its current answers.
   * @returns {Promise<Response>} The engine's response.
   */
  // oxlint-disable-next-line typescript/require-await -- This host responds synchronously, but ask must turn a thrown engine error into a rejected Promise.
  protected async ask(request: object): Promise<Response> {
    return this.call(request);
  }

  public lex(sql: string, dialect: Dialect): Lexed {
    // oxlint-disable-next-line eslint/sort-keys -- Keep the existing request field order for native engine callers.
    return expectLexed(this.call({ op: "lex", sql, dialect }));
  }

  /**
   * Analyze one statement and replay the engine's requests to the host.
   * @param {string} sql - The statement to analyze.
   * @param {Dialect} dialect - The database dialect.
   * @param {EngineIo} io - The connection used to answer engine requests.
   * @param {AnswerCache} cache - The answers that can be reused across rounds.
   * @returns {Promise<Analysis>} The completed statement analysis.
   */
  // oxlint-disable-next-line eslint/max-params -- Keep the public analysis signature used by external engine hosts.
  public async analyze(sql: string, dialect: Dialect, io: EngineIo, cache = new AnswerCache()): Promise<Analysis> {
    const state: RoundHost & { round: number } = { answers: {}, cache, io, round: FIRST_ROUND };
    while (state.round < ROUND_LIMIT) {
      // oxlint-disable-next-line eslint/no-await-in-loop, eslint/sort-keys -- Rounds depend on earlier answers. Keep the native request order.
      const reply = await this.ask({ op: "analyze", sql, dialect, answers: state.answers });
      if (reply.status === "analysis") {return reply.analysis;}
      if (reply.status !== "need") {throw unexpected(reply);}
      // oxlint-disable-next-line eslint/no-await-in-loop -- The next engine call requires all of this round's answers.
      await supply(state, reply.needs);
      state.round += NEXT_ROUND;
    }
    // oxlint-disable-next-line rules/require-tagged-error -- Keep the replay loop's native protocol error after exhausting the round limit.
    throw new Error("the analysis engine did not converge");
  }
}
