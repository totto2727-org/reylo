// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withinFile } from "../src/module-types.ts";
import { ROOT } from "./helpers.ts";

// A statement that ends inside a string, a quoted name or a comment is an error at what it leaves
// Open, and its module is still typed. The error once sat at the end of the text, one byte past
// The end of the file, and TypeScript refused the whole transform ("The content mapper returned an
// Invalid transform response"), which made the import `any`. The type check runs as a project runs
// It, `tsc` with runExternalCode over SQLite.
// TypeScript's own launcher, run by this Node: node_modules/.bin holds a shell script, which Windows cannot start.
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

const FILES = {
  "string.sql": "select 'a",
  "quoted.sql": "select `a\n",
  "comment.sql": "select 1 /* x",
};

const check = function (url: string, engine: "sqlite" | "postgres", setup: (root: string) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reylo-unterminated-")));
  writeFileSync(join(root, "package.json"), `{ "type": "module" }`);
  writeFileSync(join(root, ".env"), `DATABASE_URL=${url}\n`);
  setup(root);
  mkdirSync(join(root, "node_modules", "@totto2727"), { recursive: true });
  symlinkSync(ROOT, join(root, "node_modules", "@totto2727/reylo"));
  symlinkSync(join(ROOT, "packages", engine), join(root, "node_modules", "@totto2727", `reylo-${engine}`));
  const compilerOptions = { target: "esnext", module: "nodenext", lib: ["esnext"], types: [], strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true };
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions, contentMappers: [{ package: "@totto2727/reylo", extensions: [".sql"] }], include: ["main.ts"] }));
  Object.entries(FILES).forEach(([name, text]) => {writeFileSync(join(root, name), text);});
  // Each module is typed: an import that became `any` would leave its expected error unused.
  writeFileSync(join(root, "main.ts"), Object.keys(FILES).map((name, i) => `import q${i} from "./${name}";\n// @ts-expect-error a typed query has no such property\nq${i}.nope;\n`).join(""));
  const r = spawnSync(process.execPath, [TSC, "-p", "tsconfig.json", "--runExternalCode", "--pretty", "false"], { cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
  return (r.stdout + r.stderr).trim();
};

const EXPECTED = [
  "comment.sql(1,10): error reylo1: unterminated block comment",
  "quoted.sql(1,8): error reylo1: unterminated quoted identifier",
  "string.sql(1,8): error reylo1: unterminated string literal",
];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: an unterminated string, quoted name or comment is an error at its start, in a typed module", () => {
  const out = check("file:./app.db", "sqlite", (root) => new DatabaseSync(join(root, "app.db")).close());
  assert.deepEqual(out.split("\n").sort(), EXPECTED, out);
});


// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a diagnostic's range is cut at the end of the file, never past it", () => {
  assert.deepEqual(withinFile(7, 1, 9), { length: 1, start: 7 });
  assert.deepEqual(withinFile(9, 1, 9), { length: 0, start: 9 });
  assert.deepEqual(withinFile(12, 3, 9), { length: 0, start: 9 });
  assert.deepEqual(withinFile(5, 10, 9), { length: 4, start: 5 });
  assert.deepEqual(withinFile(0, 1, 0), { length: 0, start: 0 });
});
