import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, engine } from "../src/engine.ts";
import { Session } from "../src/analyze.ts";

// The embedded SQLite reads an expression 350 deep, where SQLite's own bound is 1,000.
function nested(shape: string, n: number): string {
  const fold = (start: string, f: (s: string, i: number) => string) => Array.from({ length: n }, (_, i) => i).reduce(f, start);
  switch (shape) {
    case "sum": return `select ${Array(n).fill("id").join(" + ")} as x from users`;
    case "concat": return `select ${Array(n).fill("name").join(" || ")} as x from users`;
    case "and_or": return `select id from users where ${fold("true", (s, i) => `id = ${i} ${i % 2 === 0 ? "or" : "and"} (${s})`)}`;
    case "case": return `select ${fold("0", (s, i) => `case when id = ${i} then ${i} else ${s} end`)} as x from users`;
    case "coalesce": return `select ${fold("nick", (s) => `coalesce(${s}, name)`)} as x from users`;
    case "json": return `select ${fold("id", (s) => `json_build_object('a', ${s})`)} as x from users`;
    case "subquery": return `select (${fold("select 1", (s) => `select (${s})`)}) as x from users`;
    case "or": return `select id from users where ${Array.from({ length: n }, (_, i) => `id = ${i}`).join(" or ")}`;
    case "parens": return `select ${"(".repeat(n)}id${")".repeat(n)} as x from users`;
  }
  throw new Error(`no shape ${shape}`);
}
const SQLITE_BOUNDS: [string, number][] = [["sum", 350], ["and_or", 348], ["case", 348], ["coalesce", 349], ["subquery", 23]];
// The host's own frames on the stack below every call into the engine: 45% of the stack Node
// gives its main thread, which the engine shares with its caller. They are counted before each
// call as a share of the frames of `deep` that fit, since a frame's size is whatever V8 has
// compiled `deep` to by then: a fixed 4,000 frames were 45% of the stack while it was interpreted
// and a third once it was optimized.
const HOST_SHARE = 0.45;
const deep = <T>(n: number, f: () => T): T => (n === 0 ? f() : deep(n - 1, f));
/** How many frames of `deep` fit on the stack from here. */
function room(): number {
  let fits = 0;
  let overflows = 1 << 20;
  while (overflows - fits > 1) {
    const n = (fits + overflows) >>> 1;
    try {
      deep(n, () => n);
      fits = n;
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      overflows = n;
    }
  }
  return fits;
}
/** The engine, with every call it is made beneath the host's frames. */
function hosted(instance: Engine): Engine {
  const call = instance.call.bind(instance);
  instance.call = (request: object) => deep(Math.floor(HOST_SHARE * room()), () => call(request));
  return instance;
}

test("a SQLite statement nested to the engine's bound is typed, and one level past it is SQLite's error at that bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "reylo-depth-"));
  writeFileSync(join(root, "package.json"), "{}");
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table users (id integer primary key, name text not null, nick text)");
  db.close();
  // The session analyzes with the process's one instance of the SQLite engine, which this wraps.
  hosted(await engine("sqlite", root));
  const session = await Session.open(root, { DATABASE_URL: "file:./app.db" });
  try {
    for (const [shape, n] of SQLITE_BOUNDS) {
      const at = await session.analyze(nested(shape, n), { force: true });
      assert.ok(at.ok && at.analysis.kind === "select" && at.analysis.diagnostics.length === 0, `${shape} at ${n}: ${JSON.stringify(at).slice(0, 300)}`);
      const past = await session.analyze(nested(shape, n + 1), { force: true });
      assert.ok(past.ok, `${shape} at ${n + 1}`);
      assert.deepEqual(past.ok && past.analysis.diagnostics.map((d) => d.message), ["Expression tree is too large (maximum depth 350)"], `${shape} at ${n + 1}`);
    }
    const plain = await session.analyze("select id, name from users where id = :id", { force: true });
    assert.ok(plain.ok && plain.analysis.cardinality === "maybeOne");
  } finally {
    await session.close();
  }
});
