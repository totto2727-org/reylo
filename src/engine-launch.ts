// oxlint-disable-next-line rules/no-node-imports -- The synchronous engine entry must wait for the native process that answers it.
import { spawnSync } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Resolve certificate locations from the host working directory before launching a child.
import path from "node:path";
import type { Dialect } from "./engine-core.ts";
import { isEmptyString, matchesNull, matchesUndefined, nonemptyText } from "./native-predicates.ts";

const FILE_VARIABLES = ["NODE_EXTRA_CA_CERTS", "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY"];
const DIAGNOSTIC_LINES = 3;
const MAX_CAPTURE_BYTES = 1_073_741_824;
const SUCCESS = 0;

/**
 * Resolve native certificate inputs from the current working directory.
 * @returns {NodeJS.ProcessEnv} The environment passed to the native child.
 */
export const engineEnvironment = (): NodeJS.ProcessEnv => {
  // oxlint-disable-next-line node/no-process-env -- The packaged native engine inherits the host's current environment.
  const env = { ...process.env };
  FILE_VARIABLES.forEach((name) => {
    const file = nonemptyText(env[name]);
    if (!matchesUndefined(file) && file !== "system") {env[name] = path.resolve(file);}
  });
  return env;
};

export const diagnosticTail = (stderr: string): string => {
  const lines = stderr.trim().split("\n").slice(-DIAGNOSTIC_LINES).join("\n");
  return isEmptyString(lines) ? "" : `: ${lines}`;
};

interface OneShotResult {
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const errorResponse = (message: string): string =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the native error response order.
  JSON.stringify({ status: "error", message });

const oneShot = (binary: string, run: OneShotResult): string => {
  if (run.error) {return errorResponse(`the engine ${binary} could not start: ${run.error.message}`);}
  const line = run.stdout.trim();
  if (run.status === SUCCESS && !isEmptyString(line)) {return line;}
  const outcome = matchesNull(run.status) ? `ended on ${run.signal}` : `exited with code ${run.status}`;
  return errorResponse(`the engine ${binary} ${outcome}${diagnosticTail(run.stderr)}`);
};

export const callSync = (binary: string, dialect: Dialect, request: string): string => {
  // oxlint-disable-next-line node/no-sync -- The public config and lexer calls are synchronous.
  const run = spawnSync(binary, ["engine", dialect, "call"], {
    encoding: "utf8", env: engineEnvironment(), input: request, maxBuffer: MAX_CAPTURE_BYTES, windowsHide: true,
  });
  return oneShot(binary, run);
};
