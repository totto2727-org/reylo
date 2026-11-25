// Shared SQLite driver fixtures and the content mapper run over its JSON-RPC protocol.
// oxlint-disable-next-line rules/no-node-imports -- Assert the presence of fixture data with Nub's native test runner.
import { equal, fail, ok } from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise Node CLI entry points and streaming protocols in native subprocesses.
import { execFile, spawn } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to use the host resolver for the installed driver or fixture package.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import { join } from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
import { pathToFileURL } from "node:url";
import type { Cardinality, Query } from "#reylo-source/index.ts";
// oxlint-disable-next-line import/no-relative-parent-imports -- The native test runner loads these private guards directly from the source tree.
import { hasFunctionType, hasObjectType, isRecord, matchesNull, matchesNumber, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";

export const ROOT = join(import.meta.dirname, "..");
export const DRIVERS = join(ROOT, "lab", "drivers", "node_modules");
export const MAPPER = join(ROOT, "src", "mapper.ts");
export const INDEX = pathToFileURL(join(ROOT, "src", "index.ts")).href;

export type SqliteQueryFixture<Rows extends Cardinality> = Pick<
  Query<Record<string, unknown>, Record<string, unknown>, Rows, "sqlite">,
  "run" | "runSync" | "sql" | "inputSchema" | "outputSchema" | "~standard"
>;

export const importSqliteQueryFixture = async <Rows extends Cardinality>(
  specifier: string,
  cardinality?: Rows,
): Promise<SqliteQueryFixture<Rows>> => {
  const queryModule: { default?: unknown } = await import(specifier);
  const query = queryModule.default;
  ok(isRecord(query) && query.dialect === "sqlite", "Expected a generated SQLite query");
  if (!matchesUndefined(cardinality)) {equal(query.cardinality, cardinality);}
  ok(hasFunctionType(query.run) && hasFunctionType(query.runSync));
  ok(Object.hasOwn(query, "sql") && Object.hasOwn(query, "inputSchema") && Object.hasOwn(query, "outputSchema"));
  const standard = query["~standard"];
  ok(isRecord(standard) && isRecord(standard.jsonSchema) && hasFunctionType(standard.jsonSchema.input));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture is emitted without a paired declaration and calls the checked-in SQLite query factory.
  return query as SqliteQueryFixture<Rows>;
};


// oxlint-disable-next-line unicorn/no-null -- These fixtures bind or receive SQL NULL as JavaScript null.
export const SQL_NULL = null;
// oxlint-disable-next-line unicorn/no-null -- Native database callbacks use null in the error slot on success.
export const NO_DRIVER_ERROR = null;
// oxlint-disable-next-line unicorn/no-null -- Query and driver APIs use null for an absent row.
export const NO_ROW = null;

export const requireFixtureValue = <Value>(value: Value): NonNullable<Value> =>
  value ?? fail("Expected the database fixture to contain this value");

/** Construct the same native date shape that driver and application inputs provide. */
export const nativeDriverDate = (value?: string | number): Date =>
  // oxlint-disable-next-line rules/no-js-date -- These fixtures exercise the JavaScript Date type, including deliberately invalid dates.
  matchesUndefined(value) ? new Date() : new Date(value);

/**
 * @param implementation - The synchronous implementation of the test double.
 * @returns A driver method that fulfills or rejects the same way as an asynchronous database driver.
 */
export const promiseDriverStub = <Arguments extends unknown[], Result>(
  implementation: (...args: Arguments) => Result,
): ((...args: Arguments) => Promise<Result>) =>
  // oxlint-disable-next-line typescript/require-await -- Turn synchronous fixture throws into rejected driver Promises without delaying fulfilment.
  async (...args) => implementation(...args);

/**
 * @param fixtures - The fixture cases in their declared order.
 * @param check - A check that completes before the next case uses the database.
 * @returns Completion of every check in order, or the first failure.
 */
export const forEachFixtureInOrder = async <Fixture>(
  fixtures: Iterable<Fixture>,
  check: (fixture: Fixture) => Promise<void>,
): Promise<void> => {
  // oxlint-disable-next-line rules/no-for-loops -- Iterate the fixture cases in order without changing the test runner.
  for (const fixture of fixtures) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each test case must finish with its shared database before the next starts.
    await check(fixture);
  }
};

interface ChildResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

/**
 * @param command - The executable to run.
 * @param args - Arguments passed directly to the executable.
 * @param options - The fixture's working directory and optional environment.
 * @returns The exit status and UTF-8 output from the child.
 */
export const runChild = (command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<ChildResult> => {
  const { promise, reject, resolve } = Promise.withResolvers<ChildResult>();
  execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    const status = error ? (error.code ?? null) : 0;
    if (matchesString(status)) {
      reject(error);
    } else {
      resolve({ status, stderr, stdout });
    }
  });
  return promise;
};

/** A driver as `lab/drivers` installs it. */
export function driver(name: string): any {
  const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!;
  return createRequire(join(DRIVERS, pkg, "package.json"))(name);
}

/** Closes every session the tests opened, so that the next analysis connects afresh. */
export async function closeSessions(): Promise<void> {
  const { Session } = await import("#reylo-source/analyze.ts");
  for (const session of Session.opened()) {await session.close();}
}

/** Rows as plain objects, to compare with literals. */
export const plain = (rows: Readonly<object[]>) => [...rows].map((r) => ({ ...r }));

/** A diagnostic the content mapper reports. */
export type Diagnostic = { messageText: string; start: number; length: number; code: number };

interface MappedFile {
  diagnostics: Diagnostic[];
  text: string;
}

const readDiagnostic = (value: unknown): Diagnostic => {
  if (
    !hasObjectType(value) || matchesNull(value) ||
    !("code" in value) || !matchesNumber(value.code) ||
    !("length" in value) || !matchesNumber(value.length) ||
    !("messageText" in value) || !matchesString(value.messageText) ||
    !("start" in value) || !matchesNumber(value.start)
  ) {
    // oxlint-disable-next-line rules/require-tagged-error -- A malformed mapper diagnostic must fail the native test.
    throw new TypeError("The content mapper returned a malformed diagnostic");
  }
  return { ...value, code: value.code, length: value.length, messageText: value.messageText, start: value.start };
};

const readMappedFile = (value: unknown): MappedFile => {
  if (
    !hasObjectType(value) || matchesNull(value) ||
    !("text" in value) || !matchesString(value.text) ||
    !("diagnostics" in value) || !Array.isArray(value.diagnostics)
  ) {
    // oxlint-disable-next-line rules/require-tagged-error -- Require a complete transform reply from the real child process.
    throw new TypeError("The content mapper returned a malformed transform result");
  }
  const diagnostics: unknown[] = value.diagnostics;
  return { diagnostics: diagnostics.map((diagnostic) => readDiagnostic(diagnostic)), text: value.text };
};

/** The declaration the content mapper writes for each file of `files` (name to content), which it must write with no diagnostic. */
export async function declarations(root: string, files: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  Object.entries(await transform(root, files)).forEach(([name, { text, diagnostics }]) => {
    if (diagnostics.length) {throw new Error(`${name}: ${JSON.stringify(diagnostics)}`);}
    out[name] = text;
  });
  return out;
}

/** What the content mapper answers for each file of `files` (name to content) in the project at `root`, through its own JSON-RPC process, as the type check runs it: the declaration and its diagnostics. */
export async function transform(root: string, files: Record<string, string>): Promise<Record<string, MappedFile>> {
  const child = spawn(process.execPath, [MAPPER], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, PromiseWithResolvers<unknown>>();
  const settleReply = (message: unknown): void => {
    if (
      !hasObjectType(message) || matchesNull(message) ||
      !("id" in message) || !matchesNumber(message.id)
    ) {
      return;
    }
    const request = pending.get(message.id);
    if (matchesUndefined(request)) {return;}
    pending.delete(message.id);
    const error = "error" in message ? message.error : undefined;
    if (hasObjectType(error) && !matchesNull(error) && "message" in error && matchesString(error.message)) {
      // oxlint-disable-next-line rules/require-tagged-error -- Surface the child process's JSON-RPC failure in the native test.
      request.reject(new Error(error.message));
      return;
    }
    request.resolve("result" in message ? message.result : undefined);
  };
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {return;}
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))![1]);
      if (buffer.length < end + 4 + length) {return;}
      const message: unknown = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
      buffer = buffer.subarray(end + 4 + length);
      settleReply(message);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown): Promise<unknown> => {
    const request = Promise.withResolvers<unknown>();
    id += 1;
    pending.set(id, request);
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
    return request.promise;
  };
  try {
    await call("initialize", { protocolVersion: 1 });
    await call("openProject", { projectHandle: "p", configFileName: join(root, "tsconfig.json"), options: {} });
    const out: Record<string, MappedFile> = {};
    for (const [name, content] of Object.entries(files)) {
      const result = await call("transform", { fileName: join(root, name), content, projectHandle: "p" });
      const { diagnostics, text } = readMappedFile(result);
      out[name] = { text, diagnostics };
    }
    await call("closeProject", { projectHandle: "p" });
    return out;
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

/** TypeScript's language server for the project at `root`, over stdio with LSP framing, as an editor talks to it. */
export function languageServer(root: string) {
  const child = spawn(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--lsp", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (result: any) => void>();
  let buffer = Buffer.alloc(0);
  const write = (message: object): void => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {return;}
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))![1]);
      if (buffer.length < end + 4 + length) {return;}
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
      buffer = buffer.subarray(end + 4 + length);
      // A request from the server (registerCapability, workspace/configuration) is answered as a client that has nothing to add.
      if (message.method && !matchesUndefined(message.id)) {write({ id: message.id, result: message.method === "workspace/configuration" ? message.params.items.map(() => null) : null });}
      else if (!matchesUndefined(message.id)) {pending.get(message.id)?.(message.result);}
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      pending.set(++id, resolve);
      write({ id, method, params });
    });
  const notify = (method: string, params: unknown): void => write({ method, params });
  const close = async (): Promise<void> => {
    await request("shutdown", undefined);
    notify("exit", undefined);
    await new Promise((resolve) => child.once("exit", resolve));
  };
  return { request, notify, close };
}
