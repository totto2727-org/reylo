// ESM: Jest's own linker (--experimental-vm-modules) loads the .sql file.
// oxlint-disable-next-line rules/no-node-imports -- Resolve the native SQLite file from this ESM fixture's URL.
import { fileURLToPath } from "node:url";
// oxlint-disable-next-line rules/consistent-import-extension -- Both lab runners load this native CommonJS fixture.
import fixture from "./fixture.cjs";
import query from "./query.sql";

fixture.registerQueryTest(
  "a .sql file imported by an ESM test runs",
  fileURLToPath(new URL("lab.db", import.meta.url)),
  query,
);
