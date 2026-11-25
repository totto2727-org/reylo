// Creates app.db, with the tables of setup.sql and their rows.
import { file } from "bun";
import { Database } from "bun:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to inspect or write files through the host filesystem.
import { rm } from "node:fs/promises";

await rm("app.db", { force: true });
const db = new Database("app.db");
try {
  db.run(await file("setup.sql").text());
} finally {
  db.close();
}
process.stdout.write("created app.db\n");
