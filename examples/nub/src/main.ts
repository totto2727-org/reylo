// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to exercise the host's real SQLite driver.
import { DatabaseSync } from "node:sqlite";
/* oxlint-disable import/no-relative-parent-imports -- The Nub quick start demonstrates the existing preload with source-relative SQL imports. */
import createPost from "../queries/create_post.sql";
import getUser from "../queries/get_user.sql";
import listPosts from "../queries/list_posts.sql";
/* oxlint-enable import/no-relative-parent-imports */

// oxlint-disable-next-line unicorn/no-null -- The optional SQL column is written as SQL NULL.
const SQL_NULL = null;
const db = new DatabaseSync("app.db");

const user = await getUser.run(db, { id: 1 });
//    ^? { id: number; name: string; email: string | null; role: string; created_at: string } | null
if (user) {process.stdout.write(`${user.name} (${user.role}) joined ${user.created_at}\n`);}

// Node:sqlite runs synchronously, so runSync returns the row itself
// oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo's public runSync executes SQLite through the native driver without Effect.
const post = createPost.runSync(db, { body: SQL_NULL, title: "From main.ts", user_id: 1 });
//    ^? { id: number; title: string }
process.stdout.write(`created #${post.id} ${post.title}\n`);

const posts = await listPosts.run(db, { role: "admin" });
//    ^? { id: number; title: string; body: string | null; author: string }[]
posts.forEach((row) => {process.stdout.write(`#${row.id} ${row.title} by ${row.author}\n`);});

db.close();
