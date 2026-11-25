// Each query Reylo runs is published on Node's tracing channel "reylo:query"
// (https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel), where a tracer or a logger
// Subscribes. The module is looked up at run time, never imported, so a bundle for a runtime
// Without it (a Worker without nodejs_compat, a browser) still builds, and its queries run untraced.
import type { Dialect } from "./execute.ts";
import type { Cardinality, Query } from "./index.ts";
import { matchesUndefined } from "./native-predicates.ts";

/**
 * What each event of the "reylo:query" tracing channel carries: one object per call, the same from
 * `start` to `asyncEnd`, so a subscriber may keep its span on it.
 */
export type QueryTrace = Readonly<{
  /** The query: its `source`, `sql` and `dialect` name it in a span. */
  query: Query<unknown, unknown, Cardinality, Dialect>;
  /** The client it runs on, as the call passed it. */
  client: unknown;
  /** The parameters, as the call passed them: `{}` for none. */
  params: Readonly<Record<string, unknown>>;
  /**
   * True for `.runSync()` and `.trySync()`, whose calls end on `end`; false for `.run()`, `.try()`
   * and the function `.with()` returns, whose promises settle on `asyncEnd`.
   */
  sync: boolean;
}> & {
  /** What the call returns, set before `end` when `sync`, and before `asyncEnd` otherwise. */
  result?: unknown;
  /** What the call threw or rejected with, set before `error`: a database error `.try()` returns as a value is one too. */
  error?: unknown;
};

type Channel = Readonly<{ hasSubscribers: boolean }>;
type Tracing = Readonly<{
  start: Channel;
  end: Channel;
  asyncStart: Channel;
  asyncEnd: Channel;
  error: Channel;
  traceSync: <T>(fn: () => T, context: QueryTrace) => T;
  tracePromise: <T>(fn: () => Promise<T>, context: QueryTrace) => Promise<T>;
}>;

interface ProcessHost { process?: { getBuiltinModule?: (id: string) => unknown } }
interface DiagnosticsChannel { tracingChannel?: (name: string) => Tracing }

const tracing = ((): Tracing | undefined => {
  try {
    const host = (globalThis as ProcessHost).process;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node and Bun expose this native module when diagnostics channels are available.
    const diagnostics = host?.getBuiltinModule?.("node:diagnostics_channel") as DiagnosticsChannel | undefined;
    return diagnostics?.tracingChannel?.("reylo:query");
  } catch {
    return undefined;
  }
})();

/**
 * The channel, when anything subscribes to it, so that an untraced query builds no context. Bun's
 * TracingChannel has no `hasSubscribers` of its own, so each event's channel is asked.
 * @returns {Tracing | undefined} The native query tracing channel when subscribed.
 */
export const listening = function listening(): Tracing | undefined {
  if (matchesUndefined(tracing)) {return undefined;}
  const active = tracing.start.hasSubscribers || tracing.end.hasSubscribers ||
    tracing.asyncStart.hasSubscribers || tracing.asyncEnd.hasSubscribers || tracing.error.hasSubscribers;
  return active ? tracing : undefined;
};
