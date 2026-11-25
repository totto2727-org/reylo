// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { withinFile } from "#reylo-source/module-types.ts";
import { typeCheck, withCompilerProject, writeSql, writeTypeScript } from "./tsc-project-fixture.ts";

// A statement that ends inside a string, a quoted name or a comment is an error at what it leaves
// Open, and its module is still typed. The error once sat at the end of the text, one byte past
// The end of the file, and TypeScript refused the whole transform ("The content mapper returned an
// Invalid transform response"), which made the import `any`. The type check runs as a project runs
// It, `tsc` with runExternalCode over SQLite.
const FILES = {
  "comment.sql": "select 1 /* x",
  "quoted.sql": "select `a\n",
  "string.sql": "select 'a",
};

const EXPECTED = [
  "comment.sql(1,10): error reylo1: unterminated block comment",
  "quoted.sql(1,8): error reylo1: unterminated quoted identifier",
  "string.sql(1,8): error reylo1: unterminated string literal",
];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: an unterminated string, quoted name or comment is an error at its start, in a typed module", async () => {
  await withCompilerProject({}, async (root) => {
    await writeSql(root, FILES);
    // Each expected error proves TypeScript still has a typed SQL import.
    const main = Object.keys(FILES).map((name, index) => `import query${index} from "./${name}";\n// @ts-expect-error the typed query has no such property\nquery${index}.nope;\n`).join("");
    await writeTypeScript(root, main);
    // oxlint-disable-next-line node/no-process-env -- Keep the compiler child on this fixture's SQLite database even when the parent sets DATABASE_URL.
    const env = { ...process.env, DATABASE_URL: "file:./app.db" };
    const result = await typeCheck(root, { env });
    const output = (result.stdout + result.stderr).trim();
    assert.deepEqual(output.split("\n").toSorted(), EXPECTED, output);
    assert.notEqual(result.status, 0);
  });
});


// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a diagnostic's range is cut at the end of the file, never past it", () => {
  assert.deepEqual(withinFile(7, 1, 9), { length: 1, start: 7 });
  assert.deepEqual(withinFile(9, 1, 9), { length: 0, start: 9 });
  assert.deepEqual(withinFile(12, 3, 9), { length: 0, start: 9 });
  assert.deepEqual(withinFile(5, 10, 9), { length: 4, start: 5 });
  assert.deepEqual(withinFile(0, 1, 0), { length: 0, start: 0 });
});
