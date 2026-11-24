import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import getUser from "./get_user.sql";

// The application creates its runtime schema independently of HCL analysis.
const db = new DatabaseSync(":memory:");
try {
  db.exec("create table users (id integer primary key, name text not null)");
  db.prepare("insert into users (id, name) values (?, ?)").run(1, "Ada");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo's public runSync executes SQLite through the native driver without Effect.
  const user = getUser.runSync(db, { id: 1 });
  assert.equal(user?.name, "Ada");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo's public runSync executes SQLite through the native driver without Effect.
  assert.equal(getUser.runSync(db, { id: 2 }), null);
  console.log(user);
} finally {
  db.close();
}
