// ESM: Jest's own linker (--experimental-vm-modules) loads the .sql file.
// oxlint-disable-next-line rules/no-node-imports -- The Node integration fixture uses this built-in to exercise the host's real SQLite driver.
import { DatabaseSync } from "node:sqlite";
import query from "./query.sql";

test("a .sql file imported by an ESM test runs", async () => {
  const db = new DatabaseSync(new URL("lab.db", import.meta.url).pathname);
  expect(query.cardinality).toBe("maybeOne");
  expect(await query.run(db, { id: 1 })).toEqual({ id: 1, name: "ada", email: "ada@example.com" });
  expect(await query.run(db, { id: 99 })).toBe(null);
});
