// oxlint-disable-next-line import/no-commonjs, typescript/no-require-imports, typescript/no-var-requires -- The fixture must load in Jest's CommonJS runner.
const assert = require("node:assert/strict");
// oxlint-disable-next-line import/no-commonjs, typescript/no-require-imports, typescript/no-var-requires -- The fixture opens SQLite under the host Node CJS loader.
const { DatabaseSync } = require("node:sqlite");

// oxlint-disable-next-line unicorn/no-null -- A missing row uses the SQL query's public null representation.
const NO_ROW = null;

/**
 * Read the executable part of the query produced by the actual runner.
 * @param {unknown} query The transformed default export.
 * @returns {(db: DatabaseSync, params: { id: number }) => Promise<unknown>} The native query method bound to its receiver.
 */
const queryRunner = (query) => {
  // oxlint-disable-next-line rules/force-predicate -- Check the real transformed module at the loader boundary.
  assert.ok(query !== NO_ROW && typeof query === "object" && "cardinality" in query && "run" in query);
  assert.equal(query.cardinality, "maybeOne");
  const { run } = query;
  // oxlint-disable-next-line rules/force-predicate -- Narrow the runtime query's execution function before calling it.
  assert.ok(typeof run === "function");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, eslint/no-inline-comments -- The check above verifies the runtime member before applying its published call signature.
  return /** @type {(db: DatabaseSync, params: { id: number }) => Promise<unknown>} */ (run.bind(query));
};

/**
 * Register a case with the actual Jest or Vitest runner.
 * @param {string} name The label reported by the runner.
 * @param {string} filename The SQLite database populated by setup.mjs.
 * @param {unknown} query The transformed default export.
 * @returns {void}
 */
const registerQueryTest = (name, filename, query) => {
  /** @type {unknown} */
  const register = Reflect.get(globalThis, "test");
  // oxlint-disable-next-line rules/force-predicate -- Check the native runner global in a fixture shared by independent test runners.
  assert.ok(typeof register === "function", "The runner must install its test global");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, eslint/no-inline-comments -- Jest and Vitest supply this same registration contract.
  const test = /** @type {(name: string, run: () => Promise<void>) => void} */ (register);
  test(name, async () => {
    const run = queryRunner(query);
    const db = new DatabaseSync(filename);
    try {
      const user = await run(db, { id: 1 });
      // oxlint-disable-next-line rules/force-predicate -- The native SQLite row may have a null prototype.
      assert.ok(user !== NO_ROW && typeof user === "object");
      assert.deepEqual({ ...user }, { email: "ada@example.com", id: 1, name: "ada" });
      assert.equal(await run(db, { id: 99 }), NO_ROW);
    } finally {
      db.close();
    }
  });
};

// oxlint-disable-next-line import/no-commonjs -- Both lab runners consume the same native CommonJS fixture.
module.exports = { registerQueryTest };
