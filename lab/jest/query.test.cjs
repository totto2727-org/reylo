// oxlint-disable-next-line import/no-commonjs, typescript/no-require-imports, typescript/no-var-requires -- Resolve the native fixture path during the CommonJS test.
const path = require("node:path");

// oxlint-disable-next-line import/no-commonjs, typescript/no-require-imports, typescript/no-var-requires -- Jest loads this fixture in its CommonJS module graph.
const { registerQueryTest } = require("./fixture.cjs");
/** @type {{ default: unknown }} */
// oxlint-disable-next-line import/no-commonjs, typescript/no-require-imports, typescript/no-var-requires -- The lab verifies the transformer through Jest's actual CommonJS require.
const moduleResult = require("./query.sql");

registerQueryTest("a .sql file required by a CommonJS test runs", path.join(__dirname, "lab.db"), moduleResult.default);
