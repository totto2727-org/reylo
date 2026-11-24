// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
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
import { hasFunctionType } from "#reylo-source/native-predicates.ts";

// Every query Reylo runs is published on the tracing channel "reylo:query" (src/trace.ts): one
// Call per `.run()`, `.runSync()`, `.try()`, `.trySync()` and call of the function `.with()`
// Returns, with the query, the client, the parameters, whether it is synchronous, and its result
// Or error.
const channel = tracingChannel<QueryTrace>("reylo:query");

const getUser = defineQuery<{ id: number }, { id: number; email: string }, "one", "sqlite">({ dialect: "sqlite", sql: "select id, email from users where id = :id", params: ["id"], cardinality: "one", source: "queries/get_user.sql" });
const createUser = defineQuery<{ email: string }, never, "none", "sqlite">({ dialect: "sqlite", sql: "insert into users (email) values (:email)", params: ["email"], cardinality: "none", source: "queries/create_user.sql" });

const database = function () {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text not null unique); insert into users (email) values ('ada@example.com')");
  return db;
};

interface Event { name: string; ctx: QueryTrace; result?: unknown; error?: unknown }

/** Runs `fn` with a subscriber to every event, and returns the events with the result and error each saw. */
const traced = async function (fn: () => unknown): Promise<Event[]> {
  const events: Event[] = [];
  const at = (name: string) => (ctx: QueryTrace) => events.push({ name, ctx, result: ctx.result, error: ctx.error });
  const subscribers = { start: at("start"), end: at("end"), asyncStart: at("asyncStart"), asyncEnd: at("asyncEnd"), error: at("error") };
  channel.subscribe(subscribers);
  try {
    await fn();
  } finally {
    channel.unsubscribe(subscribers);
  }
  return events;
};

const names = (events: Event[]): string[] => events.map((currentEvent) => currentEvent.name);

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".run() publishes one call, which ends when its promise settles", async () => {
  const db = database();
  const events = await traced(async () => assert.deepEqual(await getUser.run(db, { id: 1 }), { email: "ada@example.com", id: 1 }));
  assert.deepEqual(names(events), ["start", "end", "asyncStart", "asyncEnd"]);
  const { ctx } = events[0]!;
  assert.ok(events.every((currentEvent) => currentEvent.ctx === ctx), "one context from start to asyncEnd");
  assert.equal(ctx.query, getUser);
  assert.equal(ctx.query.source, "queries/get_user.sql");
  assert.equal(ctx.client, db);
  assert.deepEqual(ctx.params, { id: 1 });
  assert.equal(ctx.sync, false);
  assert.equal(events[1]!.result, undefined, "end comes before the promise settles");
  assert.deepEqual(events[3]!.result, { email: "ada@example.com", id: 1 });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".runSync() publishes one synchronous call, which ends on end", async () => {
  const db = database();
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  const events = await traced(() => getUser.runSync(db, { id: 1 }));
  assert.deepEqual(names(events), ["start", "end"]);
  assert.equal(events[0]!.ctx.sync, true);
  assert.deepEqual(events[1]!.result, { email: "ada@example.com", id: 1 });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a failed call publishes its error: the driver's own, or Reylo's about the row count", async () => {
  const db = database();
  const rowCount = await traced(() => getUser.run(db, { id: 2 }).catch(() => {}));
  assert.deepEqual(names(rowCount), ["start", "end", "error", "asyncStart", "asyncEnd"]);
  assert.match((rowCount[2]!.error as Error).message, /^queries\/get_user\.sql: Expected exactly one row, got 0$/u);

  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  const unique = await traced(() => assert.throws(() => createUser.runSync(db, { email: "ada@example.com" }), /UNIQUE constraint failed/u));
  assert.deepEqual(names(unique), ["start", "error", "end"]);
  assert.match((unique[1]!.error as Error).message, /UNIQUE constraint failed: users\.email/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".try() and .trySync() publish the database's error they return as a value, once each", async () => {
  const db = database();
  let result: unknown;
  const async = await traced(async () => (result = await createUser.try(db, { email: "ada@example.com" })));
  assert.equal((result as { error?: { code: string } }).error?.code, "SQLITE_CONSTRAINT_UNIQUE");
  assert.deepEqual(names(async), ["start", "end", "error", "asyncStart", "asyncEnd"]);

  const sync = await traced(() => (result = createUser.trySync(db, { email: "ada@example.com" })));
  assert.equal((result as { error?: { code: string } }).error?.code, "SQLITE_CONSTRAINT_UNIQUE");
  assert.deepEqual(names(sync), ["start", "error", "end"]);
  assert.equal(sync[0]!.ctx.sync, true);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".with() publishes nothing itself, and each call of its function publishes one", async () => {
  const db = database();
  let get: ReturnType<typeof getUser.with> | undefined;
  assert.deepEqual(await traced(() => (get = getUser.with(db))), []);
  const events = await traced(async () => {
    await get!({ id: 1 });
    await get!({ id: 1 });
  });
  assert.deepEqual(names(events).filter((n) => n === "start").length, 2);
  assert.deepEqual(events[0]!.ctx.params, { id: 1 });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a call without parameters publishes them as {}", async () => {
  const count = defineQuery<{}, { n: number }, "one", "sqlite">({ dialect: "sqlite", sql: "select count(*) as n from users", params: [], cardinality: "one" });
  const events = await traced(() => count.run(database()));
  assert.deepEqual(events[0]!.ctx.params, {});
  assert.equal(events[0]!.ctx.query.source, undefined);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a store bound to start is the current one while the driver runs, so its spans nest under the query's", async () => {
  const store = new AsyncLocalStorage<string>();
  // The same channel, by its name, with a store of the subscriber's own type.
  const spans = tracingChannel<QueryTrace, string>("reylo:query");
  spans.start.bindStore(store, (ctx) => `span for ${ctx.query.source}`);
  try {
    const db = database();
    const seen: (string | undefined)[] = [];
    // The app's database, whose prepare() notes the current store, as a driver's own tracing would.
    const watched = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (!hasFunctionType(value)) {return value;}
        return key === "prepare" ? (sql: string) => {
          seen.push(store.getStore());
          return target.prepare(sql);
        } : value.bind(target);
      },
    });
    await getUser.run(watched, { id: 1 });
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    getUser.runSync(new Proxy(watched, {}), { id: 1 });
    assert.deepEqual(seen, ["span for queries/get_user.sql", "span for queries/get_user.sql"]);
    assert.equal(store.getStore(), undefined);
  } finally {
    spans.start.unbindStore(store);
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query builds no context while nothing subscribes, and is published once anything subscribes to any event", () => {
  assert.equal(listening(), undefined);
  Iterator.from(["start", "end", "asyncStart", "asyncEnd", "error"] as const).forEach((event) => {
    const listener = (): void => {};
    channel[event].subscribe(listener);
    assert.ok(listening(), event);
    channel[event].unsubscribe(listener);
  });
  assert.equal(listening(), undefined);
});
