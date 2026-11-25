// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
import { fileURLToPath, pathToFileURL } from "node:url";
// oxlint-disable-next-line rules/no-node-imports -- Poll the native language server while its SQL project initializes.
import { setTimeout as delay } from "node:timers/promises";
import { isRecord, matchesString } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder, languageServer, requireFixtureValue, ROOT } from "./helpers.ts";

interface Position { character: number; line: number }
interface Range { end: Position; start: Position }
const START = 0;
const NEXT = 1;
const LAST = -1;
const RETRIES = 100;
const SERVER_WAIT_MS = 200;
const REVISION = 1;
const PATH_START = 3;
const ROW_START = 1;
const COLUMN_START = 2;
const SQL_PROPERTY = 7;
const STATEMENT_FIRST_LINE = 1;
const STATEMENT_LAST_LINE = 4;
const STATEMENT_END = 17;

const createDatabase = (root: string): void => {
  const db = new DatabaseSync(path.join(root, "app.db"));
  db.exec("create table posts (id integer primary key, title text not null, body text)");
  db.close();
};

const linkPackages = async (root: string): Promise<void> => {
  const packages = path.join(root, "node_modules", "@totto2727");
  await mkdir(packages, { recursive: true });
  await symlink(ROOT, path.join(packages, "reylo"));
  await symlink(path.join(ROOT, "packages", "sqlite"), path.join(packages, "reylo-sqlite"));
};

const writeTypeScriptConfig = async (root: string): Promise<void> => {
  const compilerOptions = {
    allowImportingTsExtensions: true,
    lib: ["esnext"],
    module: "nodenext",
    noEmit: true,
    paths: { "@/*": ["./*"] },
    skipLibCheck: true,
    strict: true,
    target: "esnext",
    types: [],
  };
  const contentMappers = [{ extensions: [".sql"], package: "@totto2727/reylo" }];
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions, contentMappers, include: ["main.ts"] }));
};

const writeStatements = async (root: string): Promise<void> => {
  const queries = path.join(root, "queries");
  await mkdir(queries);
  await writeFile(path.join(queries, "posts.sql"), "\n-- every post after one\nselect id, title, body\nfrom posts\nwhere id > :after\n");
  // A line starting with @name stays inside SQL in the hover's code block.
  await writeFile(path.join(queries, "add_post.sql"), "insert into posts (title, body)\nvalues (\n  @title,\n  @body\n)\n");
  await writeFile(path.join(root, "main.ts"), `import posts from "@/queries/posts.sql";\nimport type { Row } from "@/queries/posts.sql";\nexport const query = posts;\nexport type Title = Row["title"];\nexport const sent = posts.sql;\nimport addPost from "@/queries/add_post.sql";\nexport const add = addPost;\n`);
};

const project = async (): Promise<string> => {
  const temporary = await mkdtemp(path.join(tmpdir(), "reylo-definition-"));
  const root = await realpath(temporary);
  await writeFile(path.join(root, "package.json"), `{ "type": "module" }`);
  await writeFile(path.join(root, ".env"), "DATABASE_URL=file:./app.db\n");
  createDatabase(root);
  await linkPackages(root);
  await writeTypeScriptConfig(root);
  await writeStatements(root);
  return root;
};

type LanguageServer = ReturnType<typeof languageServer>;
type FindPosition = (needle: string, offset: number) => Position;
interface Document { root: string; text: string; uri: string }

const readDocument = async (root: string): Promise<Document> => {
  const main = path.join(root, "main.ts");
  return { root, text: await readFile(main, "utf8"), uri: pathToFileURL(main).href };
};

const positionIn = (text: string): FindPosition => (needle, offset) => {
  const before = text.slice(START, text.indexOf(needle) + offset).split("\n");
  return { character: requireFixtureValue(before.at(LAST)).length, line: before.length - NEXT };
};

const openDocument = async (lsp: LanguageServer, { root, text, uri }: Document): Promise<void> => {
  await lsp.request("initialize", {
    capabilities: { textDocument: { definition: { linkSupport: true }, hover: { contentFormat: ["markdown"] } } },
    initializationOptions: { runExternalCode: true },
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
  });
  lsp.notify("initialized", {});
  lsp.notify("textDocument/didOpen", { textDocument: { languageId: "typescript", text, uri, version: REVISION } });
};

type Hover = (position: Position) => Promise<string>;

const hoverReader = (lsp: LanguageServer, uri: string): Hover => async (position) => {
  const reply = await lsp.request("textDocument/hover", { position, textDocument: { uri } });
  if (!isRecord(reply) || !isRecord(reply.contents) || !matchesString(reply.contents.value)) {return "";}
  return reply.contents.value;
};

const awaitHover = async (position: Position, hover: Hover, includes: string): Promise<string> => {
  const state = { attempt: START, text: "" };
  while (state.attempt < RETRIES && !state.text.includes(includes)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll one real language-server response at a time while the project initializes.
    if (state.attempt > START) {await delay(SERVER_WAIT_MS);}
    // oxlint-disable-next-line eslint/no-await-in-loop -- A new hover waits for the previous attempt before retrying.
    state.text = await hover(position);
    state.attempt += NEXT;
  }
  return state.text;
};

const assertTypedHovers = async (at: FindPosition, hover: Hover): Promise<void> => {
  const inferred = await awaitHover(at("query = posts", START), hover, "title: string");
  assert.match(inferred, /title: string;\s+body: string \| null;/u);
  const imported = await hover(at("posts from", START));
  const statementBlock = "```sql\nselect id, title, body\nfrom posts\nwhere id > :after\n```";
  assert.ok(imported.endsWith(`\nevery post after one\n\n${statementBlock}`), imported);
  const sent = await hover(at("posts.sql;", SQL_PROPERTY));
  assert.match(sent, /^\(property\) sql: "\\n-- every post after one\\nselect id, title, body\\nfrom posts\\nwhere id > \?"$/mu);
  assert.ok(!sent.includes("```sql"), sent);
  const added = await awaitHover(at("addPost from", START), hover, "```sql");
  assert.ok(added.endsWith("\n```sql\ninsert into posts (title, body)\nvalues (\n  @title,\n  @body\n)\n```"), added);
};

const nativePath = (uri: string): string => {
  const name = fileURLToPath(uri);
  return process.platform === "win32" ? name.toLowerCase() : name;
};

interface DefinitionReader { at: FindPosition; lsp: LanguageServer; root: string; uri: string }

const definitionLinks = (reply: unknown): [string, unknown][] => {
  assert.ok(Array.isArray(reply), "Expected native TypeScript definition links");
  return reply.map((link: unknown) => {
    assert.ok(isRecord(link) && matchesString(link.targetUri));
    return [nativePath(link.targetUri), link.targetSelectionRange];
  });
};

const assertDefinitions = async ({ at, lsp, root, uri }: DefinitionReader): Promise<void> => {
  const sql = nativePath(pathToFileURL(path.join(root, "queries", "posts.sql")).href);
  const statement: Range = {
    end: { character: STATEMENT_END, line: STATEMENT_LAST_LINE },
    start: { character: START, line: STATEMENT_FIRST_LINE },
  };
  const origins = [
    ["the import's path", at(`"@/queries/posts.sql"`, PATH_START)],
    ["the query", at("= posts", PATH_START)],
    ["Row", at(`Row["title"]`, ROW_START)],
    ["a column", at(`"title"]`, COLUMN_START)],
  ] as const;
  await forEachFixtureInOrder(origins, async ([part, position]) => {
    const reply = await lsp.request("textDocument/definition", { position, textDocument: { uri } });
    assert.deepEqual(definitionLinks(reply), [[sql, statement]], part);
  });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("go-to-definition on a query, its import's path, its Row and a column opens the .sql file at its statement, and a hover shows its comment and statement", async () => {
  const root = await project();
  const document = await readDocument(root);
  const at = positionIn(document.text);
  const lsp = languageServer(root);
  try {
    await openDocument(lsp, document);
    await assertTypedHovers(at, hoverReader(lsp, document.uri));
    await assertDefinitions({ at, lsp, root, uri: document.uri });
  } finally {
    await lsp.close();
  }
});
