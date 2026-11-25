// oxlint-disable-next-line rules/no-node-imports -- Read the playground's locally installed static page.
import { existsSync, readFileSync, statSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- The loopback server uses Node request and response streams.
import type { IncomingMessage, ServerResponse } from "node:http";
// oxlint-disable-next-line rules/no-node-imports -- Resolve page assets through the host filesystem.
import path from "node:path";
import { isEmptyString, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import type { Backend } from "./play-backend.ts";

const OK = 200;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const METHOD_NOT_ALLOWED = 405;
const INTERNAL_ERROR = 500;
const MINIMUM_WIDTH = 0;
const BODY_LIMIT = 1_000_000;
const INDEX_PAGE = "index.html";
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

const send = (response: ServerResponse, status: number, body: unknown): void => {
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the API's header order on the wire.
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const body = { text: "" };
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body.text += chunk;
    if (body.text.length > BODY_LIMIT) {
      // oxlint-disable-next-line rules/require-tagged-error -- Destroy the native request with its existing size-limit error.
      request.destroy(new Error("the body is over a megabyte"));
    }
  });
  request.on("end", () => {resolve(body.text);});
  request.on("error", reject);
  return promise;
};

interface QueryInput { sql: string | null; width: number }
interface PostedInput { q?: unknown; sql?: unknown; width?: unknown }

const queryInput = (url: URL): QueryInput => ({
  sql: url.searchParams.get("q") ?? url.searchParams.get("sql"),
  width: Number(url.searchParams.get("width") ?? Infinity),
});

const readPostedInput = async (request: IncomingMessage): Promise<{ body: PostedInput } | undefined> => {
  try {
    const text = await readBody(request);
    const body: unknown = JSON.parse(isEmptyString(text) ? "{}" : text);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the route's native field access for any parsed JSON. Each recognized field has its own type check.
    return { body: body as PostedInput };
  } catch {
    return undefined;
  }
};

const postedSql = (body: PostedInput, fallback: string | null): string | null => {
  if (matchesString(body.sql)) {return body.sql;}
  return matchesString(body.q) ? body.q : fallback;
};

const postedInput = async (request: IncomingMessage, initial: QueryInput): Promise<QueryInput | undefined> => {
  const posted = await readPostedInput(request);
  if (matchesUndefined(posted)) {return undefined;}
  const { body } = posted;
  return { sql: postedSql(body, initial.sql), width: matchesNumber(body.width) ? body.width : initial.width };
};

const sendAnalysis = async (response: ServerResponse, input: QueryInput, backend: Backend): Promise<void> => {
  const { sql, width } = input;
  if (matchesNull(sql)) {
    send(response, BAD_REQUEST, { error: "name the query: ?q=<sql>, or a JSON body {\"sql\": \"<sql>\"}" });
    return;
  }
  const requestedWidth = Number.isFinite(width) && width > MINIMUM_WIDTH ? width : Infinity;
  send(response, OK, await backend.analyze(sql, requestedWidth));
};

interface Request { request: IncomingMessage; response: ServerResponse; url: URL }

const postAnalysis = async ({ request, response }: Request, initial: QueryInput, backend: Backend): Promise<void> => {
  const input = await postedInput(request, initial);
  if (matchesUndefined(input)) {send(response, BAD_REQUEST, { error: "the body is not JSON" }); return;}
  return sendAnalysis(response, input, backend);
};

const analyze = async (incoming: Request, backend: Backend): Promise<void> => {
  const { request, response, url } = incoming;
  const initial = queryInput(url);
  if (request.method === "GET") {return sendAnalysis(response, initial, backend);}
  if (request.method === "POST") {return postAnalysis(incoming, initial, backend);}
  send(response, METHOD_NOT_ALLOWED, { error: "GET or POST" });
};

const sendPage = (response: ServerResponse, url: URL, page: string): void => {
  const index = path.join(page, INDEX_PAGE);
  const file = url.pathname === "/" ? index : path.join(page, decodeURIComponent(url.pathname));
  // oxlint-disable-next-line node/no-sync -- Keep the installed asset's existence check and read on the same request turn.
  const isFile = file.startsWith(page + path.sep) && existsSync(file) && statSync(file).isFile();
  const filename = isFile ? file : index;
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the static response's header order on the wire.
  response.writeHead(OK, { "content-type": CONTENT_TYPES[path.extname(filename)] ?? "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  // oxlint-disable-next-line node/no-sync -- Complete the existing native stat and read before yielding to another request.
  response.end(readFileSync(filename));
};

const route = async ({ request, response, url }: Request, backend: Backend, page: string): Promise<void> => {
  if (url.pathname === "/api/analyze") {return analyze({ request, response, url }, backend);}
  if (url.pathname === "/api/schema") {
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the Schema endpoint's established JSON order.
    send(response, OK, { dialect: backend.dialect, database: backend.label, ...backend.catalog });
    return;
  }
  if (url.pathname === "/api/page") {
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the Page endpoint's established JSON order.
    send(response, OK, { dialect: backend.dialect, label: backend.label, schema: backend.schema, catalog: backend.catalog });
    return;
  }
  sendPage(response, url, page);
};

const isLocal = (host: string | undefined, port: number): boolean =>
  !matchesUndefined(host) && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);

const isAllowed = ({ host, origin }: IncomingMessage["headers"], port: number): boolean =>
  isLocal(host, port) && (matchesUndefined(origin) || isLocal(origin.replace(/^http:\/\//u, ""), port));

interface HandlerOptions { backend: Backend; page: string; port: () => number }

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export const handler = ({ backend, page, port }: HandlerOptions): Handler => (request, response) => {
  const respond = async (): Promise<void> => {
    // The playground serves the project's database only to local pages and tools.
    if (!isAllowed(request.headers, port())) {
      send(response, FORBIDDEN, { error: "the playground answers this machine's own pages and tools only" });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    await route({ request, response, url }, backend, page);
  };
  // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Node owns the request callback. Observe the asynchronous route without returning a Promise to the server.
  respond().catch((error: unknown) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the native message field from a rejected playground route.
    send(response, INTERNAL_ERROR, { error: (error as Error).message });
  });
};
