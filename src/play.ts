// `reylo play`: the playground of reylo.dev/play on this machine, against the project's own
// Database. It serves the page and an API on 127.0.0.1: each statement the page or a caller sends
// Is analyzed as the type check analyzes a file (never run), and answered with its Params, Returns
// And diagnostics by line and column (src/play-result.ts). The database is the one the type check
// Reads, and nothing else: a project that names none is told so, and pointed at reylo.dev/play.
// oxlint-disable-next-line rules/no-node-imports -- Open the local playground page through the platform's existing command.
import { spawn } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Find the built page in the installed or development package.
import { existsSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Run the playground through the native loopback HTTP server.
import { createServer } from "node:http";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the published runtime from a project or the CLI's own directory.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Read the runtime's built page using the host platform's paths.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Preserve the CLI's native terminal styling.
import { styleText } from "node:util";
import { isEmptyString, matchesNull, matchesString, matchesUndefined } from "./native-predicates.ts";
import { openBackend } from "./play-backend.ts";
import type { Backend } from "./play-backend.ts";
import { handler } from "./play-http.ts";

export const PLAY_USAGE = `Usage: reylo play [--port <n>] [--no-open]

Serves the playground on http://127.0.0.1: a query editor whose Params, Returns and errors are
Reylo's analysis of the query against the project's database, at every keystroke. Nothing is run.
The database is the project's own, the one the type check reads; with none, it says how to set it.
It opens the page in the browser; --no-open leaves it closed, for a script or an agent.

  http://127.0.0.1:<port>/?q=<sql>              the page, with a query in it
  GET  /api/analyze?q=<sql>                       a query's Params, Returns and diagnostics, as JSON
  POST /api/analyze  {"sql": "<sql>"}             the same
  GET  /api/schema                                the tables, their columns, functions and types`;

const DEFAULT_PORT = 4983;
const DEFAULT_PORT_ATTEMPTS = 20;
const LOWEST_PORT = 0;
const HIGHEST_PORT = 65_535;
const FIRST_ARG = 0;
const FIRST_ATTEMPT = 0;
const NEXT = 1;
const SUCCESS = 0;
const ERROR = 1;
const USAGE_ERROR = 2;
const LOOPBACK = "127.0.0.1";

interface CliOptions { help: boolean; open: boolean; port?: number }

interface Flag { name: string; value: string | undefined }

const parseFlag = (argument: string): Flag => {
  const separator = argument.indexOf("=");
  if (!argument.startsWith("--") || separator < FIRST_ARG) {return { name: argument, value: undefined };}
  return { name: argument.slice(FIRST_ARG, separator), value: argument.slice(separator + NEXT) };
};

interface ArgCursor { index: number; values: string[] }

const validPort = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= LOWEST_PORT && parsed <= HIGHEST_PORT ? parsed : undefined;
};

const takeArg = (cursor: ArgCursor): string | undefined => {
  const next = cursor.values[cursor.index];
  cursor.index += NEXT;
  return next;
};

const applyPort = (value: string | undefined, options: CliOptions): string | undefined => {
  const port = validPort(value);
  if (matchesUndefined(port)) {return "--port takes a port number";}
  options.port = port;
  return undefined;
};

const applyArg = (argument: string, cursor: ArgCursor, options: CliOptions): string | undefined => {
  const { name, value } = parseFlag(argument);
  if (name === "--help" || name === "-h") {options.help = true; return undefined;}
  if (name === "--no-open") {options.open = false; return undefined;}
  return name === "--port" ? applyPort(value ?? takeArg(cursor), options) : `unknown argument ${argument}`;
};

const parseArgs = (args: string[]): CliOptions | string => {
  const options: CliOptions = { help: false, open: true };
  const cursor = { index: FIRST_ARG, values: args };
  while (cursor.index < args.length) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The CLI's dense argv bounds are checked by the cursor.
    const problem = applyArg(takeArg(cursor)!, cursor, options);
    if (!matchesUndefined(problem)) {return problem;}
  }
  return options;
};

const opener = (url: string): [string, string[]] => {
  if (process.platform === "darwin") {return ["open", [url]];}
  if (process.platform === "win32") {return ["cmd", ["/c", "start", "", url]];}
  return ["xdg-open", [url]];
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve structural assignment to the published Playground alias.
export type Playground = { url: string; label: string; notice?: string; close: () => Promise<void> };

const packagePage = (origin: string): string | undefined => {
  try {
    const cursor = { directory: path.dirname(createRequire(origin).resolve("@totto2727/reylo")) };
    // oxlint-disable-next-line node/no-sync -- The native resolver and its package marker are read during playground startup.
    while (cursor.directory !== path.dirname(cursor.directory) && !existsSync(path.join(cursor.directory, "package.json"))) {
      cursor.directory = path.dirname(cursor.directory);
    }
    return path.join(cursor.directory, "play");
  } catch {
    return undefined;
  }
};

const hasPage = (directory: string | undefined): boolean =>
  // oxlint-disable-next-line node/no-sync -- Check for the installed page once during startup.
  !matchesUndefined(directory) && !isEmptyString(directory) && existsSync(path.join(directory, "index.html"));

const pageDir = (cwd: string): string | undefined => {
  // oxlint-disable-next-line node/no-process-env -- This standalone CLI honors the existing installed page override.
  const candidates = [process.env.REYLO_PLAY_PAGE, packagePage(path.join(cwd, "noop.js")), packagePage(import.meta.filename), path.join(import.meta.dirname, "..", "dist", "reylo", "play")];
  return candidates.find((directory) => hasPage(directory));
};

type Server = ReturnType<typeof createServer>;

const boundPort = (server: Server): number | undefined => {
  const address = server.address();
  return matchesNull(address) || matchesString(address) ? undefined : address.port;
};

interface BindResult { port?: number | undefined }

const listen = async (server: Server, port: number | undefined): Promise<number | undefined> => {
  const tries = matchesUndefined(port) ? Array.from({ length: DEFAULT_PORT_ATTEMPTS }, (_unused, index) => DEFAULT_PORT + index) : [port];
  const { promise, resolve } = Promise.withResolvers<BindResult>();
  const attempt = (portIndex: number): void => {
    const nextPort = tries[portIndex];
    if (matchesUndefined(nextPort)) {resolve({}); return;}
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {attempt(portIndex + NEXT);}
      else {resolve({});}
    });
    server.listen(nextPort, LOOPBACK, () => {
      server.removeAllListeners("error");
      resolve({ port: boundPort(server) });
    });
  };
  attempt(FIRST_ATTEMPT);
  const bound = await promise;
  return bound.port;
};

const close = async (server: Server, backend: Backend): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  server.closeAllConnections();
  server.close(() => {resolve(true);});
  await promise;
  await backend.close();
};

const started = (port: number, backend: Backend, server: Server): Playground => {
  const { label, notice } = backend;
  // oxlint-disable-next-line eslint/sort-keys -- Preserve enumeration of the public Playground handle's properties.
  return { url: `http://${LOOPBACK}:${port}/`, label, ...(matchesUndefined(notice) || isEmptyString(notice) ? {} : { notice }), close: async () => close(server, backend) };
};

interface StartOptions { cwd?: string; env?: Record<string, string | undefined>; port?: number | undefined }

const startServer = async (page: string, backend: Backend, requestedPort: number | undefined): Promise<Playground> => {
  const server = createServer();
  server.on("request", handler({ backend, page, port: () => boundPort(server) ?? LOWEST_PORT }));
  const port = await listen(server, requestedPort);
  if (matchesUndefined(port)) {
    await backend.close();
    // oxlint-disable-next-line rules/require-tagged-error -- The dependency-free CLI surfaces this native bind error to callers.
    throw new Error(`port ${requestedPort ?? DEFAULT_PORT} is in use; name another with --port.`);
  }
  return started(port, backend, server);
};

export const startPlay = async function startPlay(options: StartOptions = {}): Promise<Playground> {
  const cwd = options.cwd ?? process.cwd();
  const page = pageDir(cwd);
  if (matchesUndefined(page)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the standalone CLI's native missing-page error.
    throw new Error("the playground's page is not in this install of reylo; reinstall reylo.");
  }
  // oxlint-disable-next-line node/no-process-env -- Default to the invoking project's existing connection environment.
  const backend = await openBackend(cwd, options.env ?? process.env);
  return startServer(page, backend, options.port);
};

const ignoreBrowserFailure = (): void => {
  // The CLI keeps serving the announced URL if the browser could not start.
};

const openBrowser = (url: string): void => {
  const [command, args] = opener(url);
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", ignoreBrowserFailure).unref();
};

const waitForSignal = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const stop = (): void => {resolve(true);};
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await promise;
};

const showReady = ({ label, notice, url }: Playground): void => {
  if (!matchesUndefined(notice) && !isEmptyString(notice)) {
    // oxlint-disable-next-line eslint/no-console -- The CLI prints the project's configuration notice.
    console.log(styleText("yellow", notice));
  }
  // oxlint-disable-next-line eslint/no-console -- Report where the playground listens to the caller.
  console.log(`${styleText("bold", "Reylo playground")} at ${styleText("cyan", url)}\n${styleText("dim", `${label}. The API: GET ${url}api/analyze?q=<sql>. Ctrl-C stops it.`)}`);
};

const launch = async (port: number | undefined): Promise<Playground | undefined> => {
  try {
    return await startPlay({ port });
  } catch (error) {
    // oxlint-disable-next-line eslint/no-console, typescript/no-unsafe-type-assertion -- Print the native failure's message at the CLI boundary.
    console.error(`reylo play: ${(error as Error).message}`);
    return undefined;
  }
};

const runPlay = async (options: CliOptions): Promise<number> => {
  const running = await launch(options.port);
  if (matchesUndefined(running)) {return ERROR;}
  showReady(running);
  if (options.open) {openBrowser(running.url);}
  await waitForSignal();
  await running.close();
  return SUCCESS;
};

const usage = (problem?: string): number => {
  if (matchesUndefined(problem)) {
    // oxlint-disable-next-line eslint/no-console -- The CLI writes requested usage to stdout.
    console.log(PLAY_USAGE);
    return SUCCESS;
  }
  // oxlint-disable-next-line eslint/no-console -- The CLI writes invalid options and usage to stderr.
  console.error(`reylo play: ${problem}\n\n${PLAY_USAGE}`);
  return USAGE_ERROR;
};

export const play = async function play(args: string[]): Promise<number> {
  const options = parseArgs(args);
  if (matchesString(options)) {return usage(options);}
  return options.help ? usage() : runPlay(options);
};
