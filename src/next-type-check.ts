// oxlint-disable-next-line rules/no-node-imports -- The Next hook runs the project's compiler as a Node subprocess.
import { spawn } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Wait for the child process to close or fail before the Next build continues.
import { once } from "node:events";
// oxlint-disable-next-line rules/no-node-imports -- Read project manifests and the generated Next declaration.
import { access, readFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the consuming project's TypeScript and Next packages.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Resolve local files through the host's path conventions.
import path from "node:path";
import { isEmptyString, matchesNumber } from "./native-predicates.ts";

const SUCCESS = 0;
const CHILD_FAILURE = 1;
const MISSING_VERSION_PART = 0;
const MINIMUM_MAJOR = 7;
const MINIMUM_MINOR = 1;
const COMPILER_FLAGS = ["--noEmit", "--declarationMap", "false", "--emitDeclarationOnly", "false", "--runExternalCode"];

const run = async (args: string[], cwd: string): Promise<{ code: number; output: string }> => {
  // oxlint-disable-next-line node/no-process-env -- The project's compiler inherits the host environment, with the same color setting Next uses.
  const env = { ...process.env, ...(process.stdout.isTTY && { FORCE_COLOR: "1" }) };
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const captured = { text: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {captured.text += chunk;});
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {captured.text += chunk;});
  const completion: unknown[] = await once(child, "close");
  const [status] = completion;
  return { code: matchesNumber(status) ? status : CHILD_FAILURE, output: captured.text };
};

const stackless = (message: string): Error => {
  // oxlint-disable-next-line rules/require-tagged-error -- Next expects a native hook failure and displays the compiler text above it.
  const error = new Error(message);
  error.stack = message;
  return error;
};

const packageManifest = async <Manifest>(file: string): Promise<Manifest> => {
  const data: unknown = JSON.parse(await readFile(file, "utf8"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Read the published package fields retained by the Next compiler integration.
  return data as Manifest;
};

const tscManifest = (require: NodeJS.Require): string => {
  try {return require.resolve("typescript/package.json");}
  catch {
    throw stackless("Reylo's type check needs TypeScript 7.1 or later, whose content mappers type .sql imports, and the project has no TypeScript.");
  }
};

const validateVersion = async (manifest: string): Promise<void> => {
  const { version } = await packageManifest<{ version: string }>(manifest);
  const [major = MISSING_VERSION_PART, minor = MISSING_VERSION_PART] = version.split(".").map(Number);
  if (major < MINIMUM_MAJOR || (major === MINIMUM_MAJOR && minor < MINIMUM_MINOR)) {
    throw stackless(`Reylo's type check needs TypeScript 7.1 or later, whose content mappers type .sql imports; the project has TypeScript ${version}.`);
  }
};

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const generateEnvTypes = async (directory: string, require: NodeJS.Require): Promise<void> => {
  if (await fileExists(path.join(directory, "next-env.d.ts"))) {return;}
  const modulePath = require.resolve("next/package.json");
  const { bin } = await packageManifest<{ bin: { next: string } }>(modulePath);
  const result = await run([path.join(path.dirname(modulePath), bin.next), "typegen", directory], directory);
  if (result.code !== SUCCESS) {throw stackless(`next typegen failed:\n${result.output}`);}
};

export const typeCheck = async (directory: string, tsconfig: string): Promise<void> => {
  const require = createRequire(path.join(directory, "package.json"));
  const manifest = tscManifest(require);
  await validateVersion(manifest);
  await generateEnvTypes(directory, require);
  const tsc = path.join(path.dirname(manifest), "lib", "tsc.js");
  const { code, output } = await run([tsc, "--project", tsconfig, ...COMPILER_FLAGS], directory);
  // Next's spinner pauses for console output, including compiler diagnostics.
  if (!isEmptyString(output.trim())) {
    // oxlint-disable-next-line eslint/no-console -- Next surfaces the project's compiler diagnostics through the console.
    console.log(output.trimEnd());
  }
  if (code !== SUCCESS) {throw stackless("Failed to type check (tsc --runExternalCode).");}
};
