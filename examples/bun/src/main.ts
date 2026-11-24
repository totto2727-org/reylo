import { Database } from "bun:sqlite";
/* oxlint-disable import/no-relative-parent-imports -- The Bun quick start demonstrates the default preload with source-relative SQL imports. */
import createPost from "../queries/create_post.sql";
import getUser from "../queries/get_user.sql";
import listPosts from "../queries/list_posts.sql";
/* oxlint-enable import/no-relative-parent-imports */

const db = new Database("app.db");

const user = await getUser.run(db, { id: 1 });
//    ^? { id: number; name: string; email: string | null; role: string; created_at: string } | null
if (user) {process.stdout.write(`${user.name} (${user.role}) joined ${user.created_at}\n`);}

// Bun:sqlite runs synchronously, so runSync returns the row itself
// oxlint-disable-next-line rules/no-effect-runtime-run, unicorn/no-null -- The native SQLite runSync call binds SQL NULL for the optional body.
const post = createPost.runSync(db, { body: null, title: "From main.ts", user_id: 1 });
//    ^? { id: number; title: string }
process.stdout.write(`created #${post.id} ${post.title}\n`);

const posts = await listPosts.run(db, { role: "admin" });
//    ^? { id: number; title: string; body: string | null; author: string }[]
posts.forEach((listedPost) => {process.stdout.write(`#${listedPost.id} ${listedPost.title} by ${listedPost.author}\n`);});

db.close();
