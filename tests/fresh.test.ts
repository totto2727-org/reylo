// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { differences, sqliteDefault } from "#reylo-source/fresh.ts";
import type { Fresh } from "#reylo-source/fresh.ts";
import { SQL_NULL } from "./helpers.ts";

const accountRows = (role: string, email: string, name = ""): string[][] => [["accounts", "name", "text", "true", "false", name], ["accounts", "role", "text", "true", "true", role], ["accounts", "email", "text", "false", email ? "true" : "false", email]];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a difference is a change: a column gone, retyped, made nullable or given a default, and a column an insert must now fill; rows of another shape check nothing", () => {
  const fresh: Fresh = {
    inserts: ["users"],
    query: "…",
    rows: [
      ["users", "id", "integer", "true", "true"],
      ["users", "email", "text", "true", "false"],
    ],
  };
  assert.deepEqual(differences(fresh, [["users", "id", "integer", "true", "true"], ["users", "email", "text", "true", "false"], ["users", "bio", "text", "false", "false"]]), []);
  assert.deepEqual(differences(fresh, [{ fresh_column: "id", fresh_default: true, fresh_not_null: true, fresh_table: "users", fresh_type: "integer" }]), ["users.email was text not null and no longer exists"]);
  assert.deepEqual(differences(fresh, [["users", "id", "bigint", "true", "true"], ["users", "email", "text", "false", "false"]]), ["users.id was integer not null with a default and is now bigint not null with a default", "users.email was text not null and is now text"]);
  assert.deepEqual(differences(fresh, [...fresh.rows, ["users", "tenant", "integer", "true", "false"]]), ["users.tenant is now integer not null, which the insert does not write"]);
  // A client that answers every query with a row of its own, as lab/nextjs's edge stub does, is no catalog.
  assert.equal(differences(fresh, [{ big: "7", email: SQL_NULL, id: 1, name: "stub", role: "member" }]), undefined);
  assert.equal(differences(fresh, [["users", "id", "integer"]]), undefined);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a default a structured insert copied is a fact by its text: changed, given or dropped, it fails the call; another column's default text is no fact", () => {
  const fresh: Fresh = {
    defaults: [["accounts", "role"], ["accounts", "email"]],
    inserts: ["accounts"],
    query: "…",
    rows: [
      ["accounts", "name", "text", "true", "false", ""],
      ["accounts", "role", "text", "true", "true", "'member'::text"],
      ["accounts", "email", "text", "false", "false", ""],
    ],
  };
  assert.deepEqual(differences(fresh, accountRows("'member'::text", "", "'x'::text")), []);
  assert.deepEqual(differences(fresh, accountRows("'guest'::text", "")), ["accounts.role had the default 'member'::text, which the insert writes for a row that leaves its key out, and now has the default 'guest'::text"]);
  assert.deepEqual(differences(fresh, [{ fresh_column: "name", fresh_default: false, fresh_expr: SQL_NULL, fresh_not_null: true, fresh_table: "accounts", fresh_type: "text" }, { fresh_column: "role", fresh_default: true, fresh_expr: "'member'::text", fresh_not_null: true, fresh_table: "accounts", fresh_type: "text" }, { fresh_column: "email", fresh_default: false, fresh_expr: SQL_NULL, fresh_not_null: false, fresh_table: "accounts", fresh_type: "text" }]), []);
  // A default given to a column that had none is a change of the facts the module already compares.
  assert.deepEqual(differences(fresh, accountRows("'member'::text", "'a@x'::text")), ["accounts.email was text and is now text with a default"]);
  // Rows of five values are not this module's catalog query.
  assert.equal(differences(fresh, [["accounts", "role", "text", "true", "true"]]), undefined);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a SQLite default is compared in one spelling, as node:sqlite and Turso's engine write the same one differently", () => {
  Iterator.from([["member", "'member'"], ['"quoted"', "'quoted'"], ["lower(hex(randomblob(4)))", "(lower (hex (randomblob (4))))"], ["-7", "- 7"], ["current_timestamp", "CURRENT_TIMESTAMP"], ["true", "TRUE"], ["x'00ff'", "x'00ff'"], ["'it''s A b'", "'it''s A b'"]] as const).forEach(([sqlite, turso]) => {
    assert.equal(sqliteDefault(sqlite), sqliteDefault(turso), `${sqlite} and ${turso}`);
  });
  Iterator.from([["'member'", "'Member'"], ["'a b'", "'ab'"], ["7", "-7"], ["member", "'guest'"]] as const).forEach(([original, changed]) => {
    assert.notEqual(sqliteDefault(original), sqliteDefault(changed), `${original} and ${changed}`);
  });
  const fresh: Fresh = { defaults: [["a", "role"]], inserts: ["a"], query: "…", rows: [["a", "role", "TEXT", "1", "1", "lower(hex(randomblob(4)))"]] };
  assert.deepEqual(differences(fresh, [["a", "role", "text", "1", "1", "(lower (hex (randomblob (4))))"]], "sqlite"), []);
  assert.equal(differences(fresh, [["a", "role", "text", "1", "1", "(lower (hex (randomblob (4))))"]], "postgres")?.length, 1);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a SQLite type is compared without its case, as SQLite reads one; a Postgres or MySQL type exactly", () => {
  const fresh: Fresh = { inserts: [], query: "…", rows: [["t", "id", "INTEGER", "0", "1"], ["t", "n", "bigInt", "1", "0"]] };
  // SQLite's pragma_table_xinfo upper-cases a type name it knows; Turso's engine gives it as declared.
  const turso = [["t", "id", "integer", "0", "1"], ["t", "n", "bigint", "1", "0"]];
  assert.deepEqual(differences(fresh, turso, "sqlite"), []);
  assert.deepEqual(differences(fresh, [["t", "id", "integer", "1", "1"], ["t", "n", "text", "1", "0"]], "sqlite"), ["t.id was INTEGER with a default and is now integer not null with a default", "t.n was bigInt not null and is now text not null"]);
  assert.deepEqual(differences(fresh, turso, "postgres"), ["t.id was INTEGER with a default and is now integer with a default", "t.n was bigInt not null and is now bigint not null"]);
  assert.equal(differences(fresh, turso, "mysql")?.length, 2);
  // SQLite folds ASCII letters alone.
  assert.deepEqual(differences({ inserts: [], query: "…", rows: [["t", "x", "É", "0", "0"]] }, [["t", "x", "é", "0", "0"]], "sqlite"), ["t.x was É and is now é"]);
});
