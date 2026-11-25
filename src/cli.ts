#!/usr/bin/env node
// The `reylo` command. Its commands are the engine package's (src/commands.ts).
import { tooling } from "./engine-package.ts";

const FIRST_ARGUMENT = 2;
const FAILURE = 1;

try {
  const engine = await tooling();
  process.exitCode = await engine.runCli(process.argv.slice(FIRST_ARGUMENT));
} catch (error) {
  // oxlint-disable-next-line eslint/no-console, typescript/no-unsafe-type-assertion -- Print the native CLI failure to stderr with its existing message.
  console.error(`reylo: ${(error as Error).message}`);
  process.exitCode = FAILURE;
}
