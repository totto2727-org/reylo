// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to assert the native driver and subprocess results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- This standalone example uses this built-in to exercise the host's real SQLite driver.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { after, test } from "node:test";
/* oxlint-disable import/no-relative-parent-imports -- The tests exercise Nub's Node runner and preload using the quick start's source-relative queries. */
import createPost from "../queries/create_post.sql";
import getUser from "../queries/get_user.sql";
import listPosts from "../queries/list_posts.sql";
/* oxlint-enable import/no-relative-parent-imports */

// oxlint-disable-next-line unicorn/no-null -- A missing row and a SQL NULL column use the native SQLite representation.
const SQL_NULL = null;
const db = new DatabaseSync("app.db");
after(() => {db.close();});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("get_user finds ada, and null for an id nobody has", async () => {
  const ada = await getUser.run(db, { id: 1 });
  assert.equal(ada?.name, "ada");
  assert.equal(ada.role, "admin");
  assert.equal(await getUser.run(db, { id: 999 }), SQL_NULL);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("create_post returns the new row, which list_posts then lists", async () => {
  // A transaction rolled back at the end, so the test leaves no row behind
  db.exec("begin");
  try {
    // oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo's public runSync executes SQLite through the native driver without Effect.
    const post = createPost.runSync(db, { body: "draft", title: "From the test", user_id: 1 });
    assert.equal(post.title, "From the test");

    const posts = await listPosts.run(db, { role: "admin" });
    assert.deepEqual(posts.map((row) => row.title).slice(0, 2), ["Hello", "Again"]);
    assert.equal(posts[1]?.body, SQL_NULL);
    assert.ok(posts.every((row) => row.author === "ada"));
    assert.equal(posts.at(-1)?.id, post.id);
  } finally {
    db.exec("rollback");
  }
});
