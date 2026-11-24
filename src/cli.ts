#!/usr/bin/env node
// The `reylo` command. Its commands are the engine package's (src/commands.ts).
import { tooling } from "./engine-package.ts";

try {
  process.exitCode = await (await tooling()).runCli(process.argv.slice(2));
} catch (error) {
  console.error(`reylo: ${(error as Error).message}`);
  process.exitCode = 1;
}
