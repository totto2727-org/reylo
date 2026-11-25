// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Register native database cleanup with Nub’s test context.
import type { TestContext } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to preserve asynchronous trace context through the native runtime.
import { AsyncLocalStorage } from "node:async_hooks";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to exercise the native tracing channel subscription.
import { tracingChannel } from "node:diagnostics_channel";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { defineQuery } from '#reylo-source/index.ts';
import type { QueryTrace } from '#reylo-source/index.ts';
import { listening } from "#reylo-source/trace.ts";
import { hasFunctionType, isRecord, matchesString } from "#reylo-source/native-predicates.ts";
import { requireFixtureValue } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";

// Every query Reylo runs is published on the tracing channel "reylo:query" (src/trace.ts): one
// Call per `.run()`, `.runSync()`, `.try()`, `.trySync()` and call of the function `.with()`
// Returns, with the query, the client, the parameters, whether it is synchronous, and its result
// Or error.
const channel = tracingChannel<QueryTrace>("reylo:query");

const getUser = defineQuery<{ id: number }, { id: number; email: string }, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: ["id"], source: "queries/get_user.sql", sql: "select id, email from users where id = :id" });
const createUser = defineQuery<{ email: string }, never, "none", "sqlite">({ cardinality: "none", dialect: "sqlite", params: ["email"], source: "queries/create_user.sql", sql: "insert into users (email) values (:email)" });

const database = function (testContext: TestContext): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  testContext.after(() => {db.close();});
  db.exec("create table users (id integer primary key, email text not null unique); insert into users (email) values ('ada@example.com')");
  return db;
};

interface Event { name: string; ctx: QueryTrace; result: unknown; error: unknown }

interface CapturedTrace<Result> { events: Event[]; result: Result }

const traced = async function <Result>(run: () => Result): Promise<CapturedTrace<Awaited<Result>>> {
  const events: Event[] = [];
  const at = (name: string) => (ctx: QueryTrace): void => {
    events.push({ ctx, error: ctx.error, name, result: ctx.result });
  };
  const subscribers = { asyncEnd: at("asyncEnd"), asyncStart: at("asyncStart"), end: at("end"), error: at("error"), start: at("start") };
  channel.subscribe(subscribers);
  try {
    const result = await run();
    return { events, result };
  } finally {
    channel.unsubscribe(subscribers);
  }
};
const names = (events: Event[]): string[] => events.map((currentEvent) => currentEvent.name);

const assertEventContext = (events: Event[], connection: DatabaseSync): void => {
  const { ctx } = requireFixtureValue(events[0]);
  assert.ok(events.every((currentEvent) => currentEvent.ctx === ctx), "one context from start to asyncEnd");
  assert.equal(ctx.query, getUser);
  assert.equal(ctx.query.source, "queries/get_user.sql");
  assert.equal(ctx.client, connection);
  assert.deepEqual(ctx.params, { id: 1 });
  assert.equal(ctx.sync, false);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".run() publishes one call, which ends when its promise settles", async (testContext) => {
  const db = database(testContext);
  const { events, result } = await traced(async () => getUser.run(db, { id: 1 }));
  assert.deepEqual(result, { email: "ada@example.com", id: 1 });
  assert.deepEqual(names(events), ["start", "end", "asyncStart", "asyncEnd"]);
  assertEventContext(events, db);
  assert.equal(requireFixtureValue(events[1]).result, undefined, "end comes before the promise settles");
  assert.deepEqual(requireFixtureValue(events[3]).result, { email: "ada@example.com", id: 1 });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".runSync() publishes one synchronous call, which ends on end", async (testContext) => {
  const db = database(testContext);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  const { events } = await traced(() => getUser.runSync(db, { id: 1 }));
  assert.deepEqual(names(events), ["start", "end"]);
  assert.equal(requireFixtureValue(events[0]).ctx.sync, true);
  assert.deepEqual(requireFixtureValue(events[1]).result, { email: "ada@example.com", id: 1 });
});

const traceError = (event: Event | undefined): string => {
  const { error } = requireFixtureValue(event);
  assert.ok(isRecord(error) && matchesString(error.message));
  return error.message;
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a failed call publishes its error: the driver's own, or Reylo's about the row count", async (testContext) => {
  const db = database(testContext);
  const countMessage = /^queries\/get_user\.sql: Expected exactly one row, got 0$/u;
  const rowCount = await traced(async () => {await assert.rejects(getUser.run(db, { id: 2 }), { message: countMessage });});
  assert.deepEqual(names(rowCount.events), ["start", "end", "error", "asyncStart", "asyncEnd"]);
  assert.match(traceError(rowCount.events[2]), countMessage);

  const unique = await traced(() => {
    assert.throws(() => {
      // oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo's native synchronous query emits the actual SQLite constraint error.
      createUser.runSync(db, { email: "ada@example.com" });
    }, /UNIQUE constraint failed/u);
  });
  assert.deepEqual(names(unique.events), ["start", "error", "end"]);
  assert.match(traceError(unique.events[1]), /UNIQUE constraint failed: users\.email/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".try() and .trySync() publish the database's error they return as a value, once each", async (testContext) => {
  const db = database(testContext);
  const asyncTrace = await traced(async () => createUser.try(db, { email: "ada@example.com" }));
  assert.equal(asyncTrace.result.error?.code, "SQLITE_CONSTRAINT_UNIQUE");
  assert.deepEqual(names(asyncTrace.events), ["start", "end", "error", "asyncStart", "asyncEnd"]);

  // oxlint-disable-next-line node/no-sync -- Verify events from the public synchronous result API.
  const sync = await traced(() => createUser.trySync(db, { email: "ada@example.com" }));
  assert.equal(sync.result.error?.code, "SQLITE_CONSTRAINT_UNIQUE");
  assert.deepEqual(names(sync.events), ["start", "error", "end"]);
  assert.equal(requireFixtureValue(sync.events[0]).ctx.sync, true);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".with() publishes nothing itself, and each call of its function publishes one", async (testContext) => {
  const db = database(testContext);
  const bound = await traced(() => getUser.with(db));
  assert.deepEqual(bound.events, []);
  const { events } = await traced(async () => {
    await bound.result({ id: 1 });
    await bound.result({ id: 1 });
  });
  assert.deepEqual(names(events).filter((name) => name === "start"), ["start", "start"]);
  assert.deepEqual(requireFixtureValue(events[0]).ctx.params, { id: 1 });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a call without parameters publishes them as {}", async (testContext) => {
  const count = defineQuery<EmptyParameters, { n: number }, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: [], sql: "select count(*) as n from users" });
  const db = database(testContext);
  const { events } = await traced(async () => count.run(db));
  assert.deepEqual(requireFixtureValue(events[0]).ctx.params, {});
  assert.equal(requireFixtureValue(events[0]).ctx.query.source, undefined);
});

const watchPrepare = (connection: DatabaseSync, prepare: () => void): DatabaseSync => new Proxy(connection, {
  get(target, key): unknown {
    const value: unknown = Reflect.get(target, key);
    if (!hasFunctionType(value)) {return value;}
    if (key === "prepare") {
      return (sql: string): ReturnType<DatabaseSync["prepare"]> => {
        prepare();
        return target.prepare(sql);
      };
    }
    const bound: unknown = value.bind(target);
    return bound;
  },
});

const assertDriverSpan = async (store: AsyncLocalStorage<string>, connection: DatabaseSync): Promise<void> => {
  const seen: (string | undefined)[] = [];
  // The app's database, whose prepare() notes the current store, as a driver's own tracing would.
  const watched = watchPrepare(connection, () => {seen.push(store.getStore());});
  await getUser.run(watched, { id: 1 });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  getUser.runSync(new Proxy(watched, {}), { id: 1 });
  assert.deepEqual(seen, ["span for queries/get_user.sql", "span for queries/get_user.sql"]);
  assert.equal(store.getStore(), undefined);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a store bound to start is the current one while the driver runs, so its spans nest under the query's", async (testContext) => {
  const store = new AsyncLocalStorage<string>();
  // The same channel, by its name, with a store of the subscriber's own type.
  const spans = tracingChannel<QueryTrace, string>("reylo:query");
  spans.start.bindStore(store, (ctx) => `span for ${String(ctx.query.source)}`);
  try {
    const db = database(testContext);
    await assertDriverSpan(store, db);
  } finally {
    spans.start.unbindStore(store);
  }
});

const listener = (): void => {
  // Subscription alone enables collection.
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query builds no context while nothing subscribes, and is published once anything subscribes to any event", () => {
  assert.equal(listening(), undefined);
  Iterator.from(["start", "end", "asyncStart", "asyncEnd", "error"] as const).forEach((event) => {
    channel[event].subscribe(listener);
    assert.ok(listening(), event);
    channel[event].unsubscribe(listener);
  });
  assert.equal(listening(), undefined);
});
