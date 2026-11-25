// oxlint-disable-next-line rules/no-node-imports -- The synchronous project API delegates its declared command to the native shell.
import { spawnSync } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Use the native shell reply type to preserve its exit and error diagnostics.
import type { SpawnSyncReturns } from "node:child_process";
import { isEmptyString, isRecord, matchesNull, matchesUndefined, nonemptyText } from "./native-predicates.ts";

const COMMAND_TIMEOUT_MS = 120_000;
const FAILED_COMMAND_TTL_MS = 60_000;
const MILLISECONDS_PER_SECOND = 1000;
const FIRST_CHARACTER = 0;
const DIAGNOSTIC_LENGTH = 300;
const COMMAND_SUCCESS = 0;

type CommandOutput = { value: string } | { error: string };
type CachedCommand = { value: string } | { error: string; at: number };
// Node can return no stderr when the process cannot start, even with text encoding.
type CommandReply = Omit<SpawnSyncReturns<string>, "stderr"> & { stderr: string | null };

// Cache stdout by project directory and command. A failed command can retry after a minute.
const commandOutputs = new Map<string, CachedCommand>();

// oxlint-disable-next-line rules/no-js-date -- Keep the native command failure TTL on the same wall clock as existing project resolution.
const commandTime = (): number => Date.now();

const failureDetail = (error: Error): string => {
  const code = isRecord(error) ? error.code : undefined;
  return code === "ETIMEDOUT"
    ? `which did not finish within ${COMMAND_TIMEOUT_MS / MILLISECONDS_PER_SECOND} s`
    : `which could not start: ${error.message}`;
};

const describeCommand = (run: CommandReply): CommandOutput => {
  const reported = run.stderr?.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  const said = nonemptyText(reported?.slice(FIRST_CHARACTER, DIAGNOSTIC_LENGTH));
  if (run.error) {return { error: failureDetail(run.error) };}
  if (run.status === COMMAND_SUCCESS) {
    const value = run.stdout.replace(/(?:\r?\n)+$/u, "");
    return isEmptyString(value) ? { error: "which printed nothing" } : { value };
  }
  const exit = matchesNull(run.status) ? `ended on ${run.signal}` : `exited with code ${run.status}`;
  const suffix = matchesUndefined(said) ? "" : `: ${said}`;
  return { error: `which ${exit}${suffix}` };
};

interface CommandContext {
  cwd: string;
  env: Record<string, string>;
}

export const commandOutput = (command: string, { cwd, env }: CommandContext, fresh: boolean): CommandOutput => {
  const key = `${cwd}\0${command}`;
  const kept = commandOutputs.get(key);
  if (!fresh && kept && ("value" in kept || commandTime() - kept.at < FAILED_COMMAND_TTL_MS)) {return kept;}
  // oxlint-disable-next-line node/no-sync -- The established project resolver returns synchronously after substituting the declared shell command.
  const run = spawnSync(command, {
    cwd,
    encoding: "utf8",
    env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  const outcome = describeCommand(run);
  commandOutputs.set(key, "value" in outcome ? outcome : { ...outcome, at: commandTime() });
  return outcome;
};
