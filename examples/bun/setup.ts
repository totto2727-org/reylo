// Creates app.db, with the tables of setup.sql and their rows.
import { Database } from "bun:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to inspect or write files through the host filesystem.
import { rmSync } from "node:fs";

rmSync("app.db", { force: true });
const db = new Database("app.db");
db.run(await Bun.file("setup.sql").text());
db.close();
console.log("created app.db");
