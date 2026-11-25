// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to assert the native driver and subprocess results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to exercise the host's real SQLite driver.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- This example prints the native SQLite row using Node's standard inspection format.
import { inspect } from "node:util";
import getUser from "./get_user.sql";

// The application creates its runtime schema independently of HCL analysis.
const EXISTING_USER_ID = 1;
// oxlint-disable-next-line unicorn/no-null -- The query's maybe-one contract returns null for a missing row.
const NO_ROW = null;
const db = new DatabaseSync(":memory:");
try {
  db.exec("create table users (id integer primary key, name text not null)");
  db.prepare("insert into users (id, name) values (?, ?)").run(EXISTING_USER_ID, "Ada");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo's public runSync executes SQLite through the native driver without Effect.
  const user = getUser.runSync(db, { id: EXISTING_USER_ID });
  assert.equal(user?.name, "Ada");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo's public runSync executes SQLite through the native driver without Effect.
  assert.equal(getUser.runSync(db, { id: 2 }), NO_ROW);
  process.stdout.write(`${inspect(user)}\n`);
} finally {
  db.close();
}
