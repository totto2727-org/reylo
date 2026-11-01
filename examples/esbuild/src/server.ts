import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import postgres from "postgres";
// Each .sql import is a typed query: the type check types it from the database, and
// @totto2727/reylo/esbuild (or @totto2727/reylo/register in dev) builds it into a module that runs it.
import createPost from "../queries/create_post.sql";
import getUser from "../queries/get_user.sql";
import listPosts from "../queries/list_posts.sql";

const db = postgres(process.env.DATABASE_URL!);
const port = Number(process.env.PORT ?? 3000);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const userId = /^\/users\/(\d+)$/.exec(url.pathname)?.[1];

    if (req.method === "GET" && url.pathname === "/posts") {
      return send(res, 200, await listPosts.run(db));
    }
    if (req.method === "GET" && userId) {
      const user = await getUser.run(db, { id: Number(userId) });
      return user ? send(res, 200, user) : send(res, 404, { error: "not found" });
    }
    if (req.method === "POST" && url.pathname === "/posts") {
      const { user_id, title, body = null } = JSON.parse(await read(req));
      return send(res, 201, await createPost.run(db, { user_id, title, body }));
    }
    send(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "internal error" });
  }
});

server.listen(port, () => console.log(`listening on http://localhost:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close();
    void db.end();
  });
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function read(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}
