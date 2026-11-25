// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this stack-boundary test in a native Node process.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Assert the native diagnostic at each tested nesting bound.
import assert from "node:assert/strict";
import type { Engine } from "#reylo-source/engine.ts";
import { engine } from "#reylo-source/engine.ts";
import { Session } from "#reylo-source/analyze.ts";
import { isEmptyArray } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder } from "./helpers.ts";
import { withProject } from "./sqlite-project-fixture.ts";

type Nest = (source: string, index: number) => string;

const fold = (count: number, start: string, wrap: Nest): string => {
  const state = { index: 0, source: start };
  while (state.index < count) {
    state.source = wrap(state.source, state.index);
    state.index += 1;
  }
  return state.source;
};

// The embedded SQLite accepts these depths. One further level must report SQLite's own limit.
const queries = {
  and_or: (count: number): string => {
    const expression = fold(count, "true", (source, index) => `id = ${index} ${index % 2 === 0 ? "or" : "and"} (${source})`);
    return `select id from users where ${expression}`;
  },
  case: (count: number): string => {
    const expression = fold(count, "0", (source, index) => `case when id = ${index} then ${index} else ${source} end`);
    return `select ${expression} as x from users`;
  },
  coalesce: (count: number): string => `select ${fold(count, "nick", (source) => `coalesce(${source}, name)`)} as x from users`,
  subquery: (count: number): string => `select (${fold(count, "select 1", (source) => `select (${source})`)}) as x from users`,
  sum: (count: number): string => `select ${Array.from({ length: count }, () => "id").join(" + ")} as x from users`,
};
const SQLITE_BOUNDS = [["sum", 350], ["and_or", 348], ["case", 348], ["coalesce", 349], ["subquery", 23]] as const;

// Both the host and the SQLite adapter share Node's main-thread stack. Allocate 45% to host frames.
const HOST_SHARE = 0.45;
const deep = <Value>(depth: number, read: () => Value): Value => depth === 0 ? read() : deep(depth - 1, read);

const room = (): number => {
  const bounds = { fits: 0, overflows: 1_048_576 };
  while (bounds.overflows - bounds.fits > 1) {
    const midpoint = Math.floor((bounds.fits + bounds.overflows) / 2);
    try {
      deep(midpoint, () => midpoint);
      bounds.fits = midpoint;
    } catch (error) {
      if (!(error instanceof RangeError)) {throw error;}
      bounds.overflows = midpoint;
    }
  }
  return bounds.fits;
};

const host = (instance: Engine): (() => void) => {
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the original method identity for restoration. Every call uses the bound wrapper.
  const original = instance.call;
  const call = original.bind(instance);
  instance.call = (request: object) => deep(Math.floor(HOST_SHARE * room()), () => call(request));
  return () => {instance.call = original;};
};

const checkBounds = async (session: Session): Promise<void> => {
  await forEachFixtureInOrder(SQLITE_BOUNDS, async ([shape, count]) => {
    const nested = queries[shape];
    const at = await session.analyze(nested(count), { force: true });
    assert.ok(at.ok && at.analysis.kind === "select" && isEmptyArray(at.analysis.diagnostics), `${shape} at ${count}: ${JSON.stringify(at).slice(0, 300)}`);
    const past = await session.analyze(nested(count + 1), { force: true });
    assert.ok(past.ok, `${shape} at ${count + 1}`);
    assert.deepEqual(past.analysis.diagnostics.map((diagnostic) => diagnostic.message), ["Expression tree is too large (maximum depth 350)"], `${shape} at ${count + 1}`);
  });
};

const SCHEMA = "create table users (id integer primary key, name text not null, nick text)";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a SQLite statement nested to the engine's bound is typed, and one level past it is SQLite's error at that bound", async (testContext) => {
  await withProject(SCHEMA, async ({ database, root }) => {
    database.close();
    const current = await engine("sqlite");
    testContext.after(host(current));
    const session = await Session.open(root, { DATABASE_URL: "file:./app.db" });
    try {
      await checkBounds(session);
      const ordinary = await session.analyze("select id, name from users where id = :id", { force: true });
      assert.ok(ordinary.ok && ordinary.analysis.cardinality === "maybeOne");
    } finally {
      await session.close();
    }
  });
});
