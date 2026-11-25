import { isEmptyString, matchesUndefined } from "./native-predicates.ts";

export { differences } from "./fresh-catalog.ts";
export { sqliteDefault } from "./fresh-sqlite-default.ts";

// The schema freshness check at run time (wiki/structured-params.md §6):
// Any change fails. A module a build step writes carries the catalog facts its
// Statement relied on, the columns it names with their types, whether each is not null and whether
// It has a default, for an insert's table the columns that need a value, and on Postgres and SQLite
// The text of each default a structured insert copied into its statement, beside the catalog query
// That read them (upstream engine/core/src/fresh.rs). Before a query runs, the run time runs that query
// Through the caller's own client and compares: any difference fails the call, naming the table
// And the column, rather than letting the query run against a schema its types were not made for.
//
// A query is checked on its first run in a process, and again when its last check is a minute old,
// So a long-running server notices a migration that lands while it runs. A catalog query that
// Fails (a role that may not read the catalog) checks nothing, and the query runs; so does one
// Whose answer is not shaped as its rows are, which no database gives: a client that answers every
// Query with rows of its own, as a stub or a mock does, is no catalog to check against.

/**
 * What a module carries: the catalog query, which takes no parameter, and the facts as text, five
 * per column, or six on Postgres and SQLite, whose sixth is a default's text; `defaults` names the
 * `[table, column]` whose sixth is compared, each a default the statement copied.
 */
export type Fresh = Readonly<{
  query: string;
  rows: Readonly<(Readonly<string[]>)[]>;
  inserts: Readonly<string[]>;
  defaults?: Readonly<(Readonly<string[]>)[]>;
}>;

/** How long a check holds, in milliseconds. */
export const FRESH_FOR = 60_000;

const checked = new WeakMap<object, number>();

// The clock is `performance.now()`, not `Date.now()`: an interval needs only a monotonic clock, and
// Next.js's Cache Components refuse `Date.now()` while a page prerenders, which failed `next build`
// On every page that ran a query (examples/nextjs, Next.js 16.4). It is reached through
// `globalThis`, typed here, since a project that type-checks Reylo's sources need not have the
// DOM's types or Node's, which declare it (the labs' type checks failed with "Cannot find name").
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node and Bun provide the monotonic performance clock without a runtime import.
const clock = (globalThis as unknown as { performance: { now: () => number } }).performance;

/**
 * Report whether a catalog check is due.
 * @param {object} query - The compiled query identity.
 * @param {number} now - Monotonic time by default.
 * @returns {boolean} Whether the previous check has expired.
 */
export const due = function due(query: object, now = clock.now()): boolean {
  const at = checked.get(query);
  return matchesUndefined(at) || now - at >= FRESH_FOR;
};

/**
 * Record a check that passed or could not run.
 * @param {object} query - The compiled query identity.
 * @param {number} now - Monotonic time by default.
 */
export const passed = function passed(query: object, now = clock.now()): void {
  checked.set(query, now);
};

/**
 * Create the query failure that tells callers to rebuild against the new schema.
 * @param {string | undefined} source - The compiled query location, when available.
 * @param {Readonly<string[]>} lines - The catalog differences in source order.
 * @returns {Error} The existing native query failure.
 */
export const staleError = function staleError(source: string | undefined, lines: Readonly<string[]>): Error {
  const subject = matchesUndefined(source) || isEmptyString(source) ? "this query" : source;
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the runtime's native stale schema error without loading Effect.
  return new Error(`The database changed after ${subject} was built: ${lines.join("; ")}. Build it again (the type check, or reylo generate) and deploy the new build.`);
};
