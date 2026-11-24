// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { sqliteSchemaFromHcl } from "#reylo-source/hcl-sqlite.ts";

const schema = (body: string): string => `schema "main" {}\n${body}\n`;
const column = (name: string, type = "text", nullable = true, extra = ""): string => `column ${JSON.stringify(name)} {\n type = ${type}\n null = ${nullable}\n ${extra}\n}\n`;
const table = (body: string, name = "items"): string => `table ${JSON.stringify(name)} {\n schema = schema.main\n${body}\n}\n`;
const open = function (source: string) {
  const db = new DatabaseSync(":memory:");
  try {
    Iterator.from(sqliteSchemaFromHcl(source, "test.hcl")).forEach((sql) => {db.prepare(sql).run();});
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("static Atlas declarations preserve SQLite constraints, defaults, indexes and nullability", () => {
  const source = schema(table(
    `${column("id") + column("part", "integer", false) + column("title", "varchar(80)", false, 'default = "can\'t"') + column("amount", "numeric", false, "default = -2.50") + column("created", "datetime", false, 'default = sql("CURRENT_TIMESTAMP")')  }
    primary_key { columns = [column.id, column.part] }
    index "sqlite_autoindex_items_2" {
      unique = true
      columns = [column.part, column.title]
    }
    index "items_title" {
      on {
        column = column.title
        desc = true
      }
      on { column = column.part }
      where = "part > 0"
    }
    check "positive" { expr = "part > 0" }
  `));
  const db = open(source);
  try {
    const columns = db.prepare('pragma table_info("items")').all();
    assert.deepEqual(columns.map((value) => [value.name, value.type, value.notnull, value.dflt_value, value.pk]), [
      ["id", "TEXT", 0, null, 1], ["part", "INTEGER", 1, null, 2], ["title", "varchar(80)", 1, "'can''t'", 0], ["amount", "numeric", 1, "-2.50", 0], ["created", "datetime", 1, "CURRENT_TIMESTAMP", 0],
    ]);
    const unique = db.prepare('pragma index_list("items")').all().find((row) => row.name === "sqlite_autoindex_items_2");
    assert.equal(unique?.unique, 1);
    assert.equal(unique?.origin, "u");
    const terms = db.prepare('pragma index_xinfo("items_title")').all().filter((row) => row.key === 1);
    assert.deepEqual(terms.map((row) => [row.name, row.desc]), [["title", 1], ["part", 0]]);
    db.prepare('insert into items (id, part) values (?, ?)').run("a", 1);
    assert.equal(db.prepare("select title from items").get()!.title, "can't");
    assert.throws(() => db.prepare('insert into items (id, part) values (?, ?)').run("b", 0), /CHECK constraint failed/u);
    assert.throws(() => db.prepare('insert into items (id, part) values (?, ?)').run("c", 1), /UNIQUE constraint failed/u);
  } finally { db.close(); }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("static Atlas references support composite foreign keys and validate all targets", () => {
  const parent = table(`${column("key") + column("part", "integer", false)  }primary_key { columns = [column.key, column.part] }`, "parents");
  const child = table(`${column("parent") + column("part", "integer", false)  }foreign_key "parent_key" {
    columns = [column.parent, column.part]
    ref_columns = [table.parents.column.key, table.parents.column.part]
    on_update = CASCADE
    on_delete = SET_NULL
  }`);
  const db = open(schema(parent + child));
  try {
    const keys = db.prepare('pragma foreign_key_list("items")').all();
    assert.deepEqual(keys.map((row) => [row.table, row.from, row.to, row.on_update, row.on_delete]), [["parents", "parent", "key", "CASCADE", "SET NULL"], ["parents", "part", "part", "CASCADE", "SET NULL"]]);
  } finally { db.close(); }
  assert.throws(() => sqliteSchemaFromHcl(schema(parent + child.replace("table.parents.column.part", "table.parents.column.missing"))), /undeclared table or column/u);
  assert.throws(() => sqliteSchemaFromHcl(schema(parent + child.replace("CASCADE", "UNKNOWN"))), /Unsupported foreign-key action/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Atlas semantic boundary rejects unsupported expressions and declarations instead of ignoring them", () => {
  const valid = table(`${column("id")  }primary_key { columns = [column.id] }`);
  const cases: [string, RegExp][] = [
    [schema(valid).replace("type = text", "type = dynamic_type"), /Unsupported Atlas SQLite column type/u],
    [schema(valid).replace("type = text", "type = var.type"), /Unsupported Atlas SQLite column type/u],
    [schema(valid).replace("null = true", "null = var.nullable"), /literal HCL boolean/u],
    [schema(valid).replace("null = true", "null = true\n generated = true"), /Unsupported Atlas SQLite attribute generated/u],
    [schema(valid).replace("columns = [column.id]", "columns = [column.missing]"), /declared column/u],
    [schema(valid).replace("columns = [column.id]", "columns = []"), /nonempty/u],
    [schema(valid).replace("columns = [column.id]", "columns = [column.id, column.id]"), /duplicates/u],
    [schema(valid).replace("schema.main", "schema.other"), /schema.main/],
    [schema(valid + valid), /Duplicate table/u],
    [schema(table(column("id") + column("id"))), /Duplicate column/u],
    [`${schema(valid)  }view "ignored" {}\n`, /Unsupported Atlas SQLite block view/u],
    [schema(valid).replace("null = true", 'null = true\n default = env("SECRET")'), /Only sql/u],
    [schema(valid).replace("null = true", 'null = true\n default = "${var.secret}"'), /static HCL string|Unsupported Atlas SQLite default/u],
    [schema(valid).replace("null = true", "null = true\n default = [1, 2]"), /Unsupported Atlas SQLite default/u],
    [schema(table(`${column("id")  }index "bad" {\n columns = [column.id]\n on { column = column.id }\n}`)), /either columns or on/u],
    [schema(table(`${column("id")  }index "sqlite_autoindex_bad" { columns = [column.id] }`)), /implicit SQLite autoindex/u],
    [schema(table(`${column("id")  }check { expr = var.check }`)), /static HCL string/u],
    ['schema "other" {}\n', /schema "main"/u],
    [schema(valid).replace("type = text", "type = varchar(-1)"), /nonnegative integer/u],
  ];
  Iterator.from(cases).forEach(([source, expected]) => {assert.throws(() => sqliteSchemaFromHcl(source, "invalid.hcl"), expected, source);});
});
