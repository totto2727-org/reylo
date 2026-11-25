// Shared SQLite driver fixtures and the content mapper run over its JSON-RPC protocol.
// oxlint-disable-next-line rules/no-node-imports -- Assert the presence of fixture data with Nub's native test runner.
import { equal, fail, ok } from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise Node CLI entry points and streaming protocols in native subprocesses.
import { execFile } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
import { pathToFileURL } from "node:url";
import type { Cardinality, Query } from "#reylo-source/index.ts";
import { hasFunctionType, hasObjectType, isRecord, matchesNull, matchesNumber, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";
import { languageServerResponse, RpcFixture } from "./rpc-fixture.ts";

const EMPTY = 0;

// oxlint-disable-next-line typescript/no-generated-empty-object-type -- A query with no parameter keys may omit the entire parameter object.
export type EmptyParameters = Record<never, never>;

export const ROOT = path.join(import.meta.dirname, "..");
export const DRIVERS = path.join(ROOT, "lab", "drivers", "node_modules");
export const MAPPER = path.join(ROOT, "src", "mapper.ts");
export const INDEX = pathToFileURL(path.join(ROOT, "src", "index.ts")).href;

export type SqliteQueryFixture<Rows extends Cardinality> = Pick<
  Query<Record<string, unknown>, Record<string, unknown>, Rows, "sqlite">,
  "run" | "runSync" | "sql" | "inputSchema" | "outputSchema" | "~standard"
>;

export const importSqliteQueryFixture = async <Rows extends Cardinality>(
  specifier: string,
  cardinality?: Rows,
): Promise<SqliteQueryFixture<Rows>> => {
  const queryModule: unknown = await import(specifier);
  const query = isRecord(queryModule) ? queryModule.default : undefined;
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

/**
 * Construct the same native date shape that driver and application inputs provide.
 * @param {string | number} [value] - The native Date constructor's timestamp or text.
 * @returns {Date} The driver or caller's Date value.
 */
export const nativeDriverDate = (value?: string | number): Date =>
  // oxlint-disable-next-line rules/no-js-date -- These fixtures exercise the JavaScript Date type, including deliberately invalid dates.
  matchesUndefined(value) ? new Date() : new Date(value);

/**
 * @param {(...args: Arguments) => Result} implementation - The synchronous implementation of the test double.
 * @returns {(...args: Arguments) => Promise<Result>} A method with the driver's asynchronous result.
 */
export const promiseDriverStub = <Arguments extends unknown[], Result>(
  implementation: (...args: Arguments) => Result,
): ((...args: Arguments) => Promise<Result>) =>
  // oxlint-disable-next-line typescript/require-await -- Turn synchronous fixture throws into rejected driver Promises without delaying fulfilment.
  async (...args) => implementation(...args);

/**
 * @param {Iterable<Fixture>} fixtures - The fixture cases in their declared order.
 * @param {(fixture: Fixture) => Promise<void>} check - A check that completes before the next case uses the database.
 * @returns {Promise<void>} Completion of every check in order, or the first failure.
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
 * @param {string} command - The executable to run.
 * @param {string[]} args - Arguments passed directly to the executable.
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv }} options - The fixture's working directory and optional environment.
 * @returns {Promise<ChildResult>} The exit status and UTF-8 output from the child.
 */
export const runChild = async (command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<ChildResult> => {
  const { promise, reject, resolve } = Promise.withResolvers<ChildResult>();
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node's callback gives the native exit error and both output streams together.
  execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    if (matchesNull(error)) {resolve({ status: EMPTY, stderr, stdout }); return;}
    const { code } = error;
    if (matchesString(code)) {
      reject(error);
      return;
    }
    // oxlint-disable-next-line unicorn/no-null -- Node omits a numeric exit code when a signal stops the child.
    const status = code ?? null;
    resolve({ status, stderr, stdout });
  });
  return promise;
};

/**
 * Close test-owned native database sessions to make the next analysis reconnect.
 * @returns {Promise<void>} Completion of all session closures.
 */
export const closeSessions = async function closeSessions(): Promise<void> {
  const { Session } = await import("#reylo-source/analyze.ts");
  await forEachFixtureInOrder(Session.opened(), async (session) => session.close());
};

/**
 * Copy database rows for comparison with plain object fixtures.
 * @param {Readonly<object[]>} rows - The driver's row records.
 * @returns {object[]} Copies of the row records.
 */
export const plain = function plain(rows: Readonly<object[]>): object[] {
  // oxlint-disable-next-line oxc/no-map-spread -- Create a new ordinary object with each native driver's own enumerable columns.
  return [...rows].map((row) => ({ ...row }));
};

/** A diagnostic the content mapper reports. */
export interface Diagnostic { messageText: string; start: number; length: number; code: number }

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
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the existing returned mapper fixture shape.
  return { text: value.text, diagnostics: diagnostics.map((diagnostic) => readDiagnostic(diagnostic)) };
};

const PROJECT_HANDLE = "p";
const PROTOCOL_VERSION = 1;
const mapperFiles = async (root: string, files: Record<string, string>, rpc: RpcFixture): Promise<Record<string, MappedFile>> => {
  await rpc.request("initialize", { protocolVersion: PROTOCOL_VERSION });
  await rpc.request("openProject", { configFileName: path.join(root, "tsconfig.json"), options: {}, projectHandle: PROJECT_HANDLE });
  const out: Record<string, MappedFile> = {};
  await forEachFixtureInOrder(Object.entries(files), async ([name, content]) => {
    const reply = await rpc.request("transform", { content, fileName: path.join(root, name), projectHandle: PROJECT_HANDLE });
    out[name] = readMappedFile(reply);
  });
  await rpc.request("closeProject", { projectHandle: PROJECT_HANDLE });
  return out;
};

/**
 * Run SQL fixtures through the real TypeScript content mapper over its stdio protocol.
 * @param {string} root - The disposable project directory.
 * @param {Record<string, string>} files - SQL source keyed by project-relative path.
 * @returns {Promise<Record<string, MappedFile>>} The declaration and diagnostics for each SQL file.
 */
export const transform = async function transform(root: string, files: Record<string, string>): Promise<Record<string, MappedFile>> {
  const rpc = new RpcFixture({ args: [MAPPER], cwd: root, stderr: "inherit" });
  try {
    return await mapperFiles(root, files, rpc);
  } finally {
    rpc.endInput();
    await rpc.wait();
  }
};

/**
 * Read each generated declaration when the native type check reports no diagnostics.
 * @param {string} root - The disposable project directory.
 * @param {Record<string, string>} files - SQL source keyed by project-relative path.
 * @returns {Promise<Record<string, string>>} The virtual TypeScript source for each file.
 */
export const declarations = async function declarations(root: string, files: Record<string, string>): Promise<Record<string, string>> {
  const results = await transform(root, files);
  return Object.fromEntries(Object.entries(results).map(([name, { text, diagnostics }]) => {
    if (diagnostics.length > EMPTY) {
      // oxlint-disable-next-line rules/require-tagged-error -- An unexpected mapper diagnostic fails the existing Node test.
      throw new Error(`${name}: ${JSON.stringify(diagnostics)}`);
    }
    return [name, text];
  }));
};

interface LanguageServer {
  close: () => Promise<void>;
  notify: (method: string, params: unknown) => void;
  request: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * Start the same TypeScript language server an editor uses for the fixture project.
 * @param {string} root - The disposable project directory.
 * @returns {LanguageServer} The native request, notification, and shutdown operations.
 */
export const languageServer = function languageServer(root: string): LanguageServer {
  const compiler = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const rpc = new RpcFixture({ args: [compiler, "--lsp", "--stdio"], cwd: root, stderr: "ignore" }, languageServerResponse);
  const close = async (): Promise<void> => {
    await rpc.request("shutdown");
    rpc.notify("exit");
    await rpc.wait();
  };
  return {
    close,
    notify: (method, params) => {rpc.notify(method, params);},
    request: async (method, params) => rpc.request(method, params),
  };
};
