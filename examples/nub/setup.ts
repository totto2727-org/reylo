// Creates app.db, with the tables of setup.sql and their rows.
// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to inspect or write files through the host filesystem.
import { readFileSync, rmSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to exercise the host's real SQLite driver.
import { DatabaseSync } from "node:sqlite";

rmSync("app.db", { force: true });
const db = new DatabaseSync("app.db");
db.exec(readFileSync("setup.sql", "utf8"));
db.close();
console.log("created app.db");
