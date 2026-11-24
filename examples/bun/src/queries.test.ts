import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import createPost from "../queries/create_post.sql";
import getUser from "../queries/get_user.sql";
import listPosts from "../queries/list_posts.sql";

const db = new Database("app.db");
afterAll(() => db.close());

test("get_user finds ada, and null for an id nobody has", async () => {
  const ada = await getUser.run(db, { id: 1 });
  expect(ada).toMatchObject({ id: 1, name: "ada", email: "ada@example.com", role: "admin" });
  expect(await getUser.run(db, { id: 999 })).toBeNull();
});

test("create_post returns the new row, which list_posts then lists", async () => {
  // A transaction rolled back at the end, so the test leaves no row behind
  db.run("begin");
  try {
    // oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo's public runSync executes SQLite through the native driver without Effect.
    const post = createPost.runSync(db, { user_id: 1, title: "From the test", body: "draft" });
    expect(post.title).toBe("From the test");

    const posts = await listPosts.run(db, { role: "admin" });
    expect(posts.slice(0, 2)).toEqual([
      { id: 1, title: "Hello", body: "first post", author: "ada" },
      { id: 2, title: "Again", body: null, author: "ada" },
    ]);
    expect(posts.at(-1)).toEqual({ id: post.id, title: "From the test", body: "draft", author: "ada" });
  } finally {
    db.run("rollback");
  }
});
