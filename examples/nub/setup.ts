// Creates app.db, with the tables of setup.sql and their rows.
// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to inspect or write files through the host filesystem.
import { readFile, rm } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to exercise the host's real SQLite driver.
import { DatabaseSync } from "node:sqlite";

await rm("app.db", { force: true });
const db = new DatabaseSync("app.db");
try {
  db.exec(await readFile("setup.sql", "utf8"));
} finally {
  db.close();
}
process.stdout.write("created app.db\n");
