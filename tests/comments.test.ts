// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { fieldComment } from "#reylo-source/module-types.ts";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a doc comment is one line, or a block of lines, with a star and a slash kept apart", () => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- An absent field comment is the input under test.
  assert.equal(fieldComment(undefined), "");
  assert.equal(fieldComment(" \n "), "");
  assert.equal(fieldComment("Age (in years)"), "/** Age (in years) */");
  assert.equal(fieldComment("a */ b"), String.raw`/** a *\/ b */`);
  assert.equal(fieldComment("Line 1\r\nLine 2\n\nLine 4  \n", "  "), "/**\n   * Line 1\n   * Line 2\n   *\n   * Line 4\n   */");
});
