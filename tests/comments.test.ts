import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldComment } from "../src/module-types.ts";

test("a doc comment is one line, or a block of lines, with a star and a slash kept apart", () => {
  assert.equal(fieldComment(undefined), "");
  assert.equal(fieldComment(" \n "), "");
  assert.equal(fieldComment("Age (in years)"), "/** Age (in years) */");
  assert.equal(fieldComment("a */ b"), "/** a *\\/ b */");
  assert.equal(fieldComment("Line 1\r\nLine 2\n\nLine 4  \n", "  "), "/**\n   * Line 1\n   * Line 2\n   *\n   * Line 4\n   */");
});
