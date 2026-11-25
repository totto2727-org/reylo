// Development-only: Go is never needed by the maintained TypeScript tests.
// oxlint-disable-next-line rules/no-node-imports -- Validate the pinned oracle and its fixtures before publishing them.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Run the pinned Go tests and read the Git revision and Go version.
import { execFile, spawn } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Wait for the native child process to close before reading its output files.
import { once } from "node:events";
// oxlint-disable-next-line rules/no-node-imports -- Stage the oracle's records and license on the host filesystem.
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the default Go executable below the user's actual home directory.
import { homedir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- Use the host filesystem's path conventions.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Adapt Node's buffered execFile callback without changing stdout collection.
import { promisify } from "node:util";
import { isRecord, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";

const TOOLING = import.meta.dirname;
const OUTPUT = path.resolve(TOOLING, "..");
const ROOT = path.resolve(OUTPUT, "../..");
const REVISION = "00057cf06d7b38a3f89e6e54d622eee98322b314";
const FILE_MODE = 0o644;
const FIRST_INPUT = 2;
const JSON_INDENT = 2;
const EMPTY = 0;
const SUCCESS = 0;
const ONE_CASE = 1;
const PEEKER_CASES = 3;
const NATIVE_SPEC_FILES = 15;
const FUZZ_CONFIG = 7;
const FUZZ_EXPRESSION = 10;
const FUZZ_TEMPLATE = 8;
const EXCLUDED_TRAVERSAL_SEEDS = 4;
const REGEN_DIRECTORY = path.join(ROOT, "tmp/direct-hcl");
const upstream = path.resolve(process.argv[FIRST_INPUT] ?? path.join(REGEN_DIRECTORY, "upstream"));
// oxlint-disable-next-line node/no-process-env -- Keep the developer's GO and HOME overrides and forward the native Go environment to the pinned tests.
const environment = process.env;
const go = environment.GO ?? path.join(environment.HOME ?? homedir(), ".nix-profile/bin/go");
// oxlint-disable-next-line typescript/strict-void-return -- Node defines a promisify overload for execFile even though the callback API also returns a child process.
const exec = promisify(execFile);

/**
 * @param {unknown} value - The failure from the native filesystem call.
 * @returns {boolean} Whether the file has never been exported.
 */
const missingFile = (value) => isRecord(value) && value.code === "ENOENT";

/**
 * @param {string} source - The upstream license.
 * @param {string} target - The exported license.
 * @returns {Promise<void>} Completion after the copied license is written.
 */
const copyLicense = async (source, target) => {
  try {
    await chmod(target, FILE_MODE);
  } catch (error) {
    if (!missingFile(error)) {throw error;}
  }
  await writeFile(target, await readFile(source), { mode: FILE_MODE });
};

/**
 * @param {string[]} args - The native Go arguments.
 * @param {import("node:child_process").SpawnOptions} options - The host working directory and environment.
 * @returns {Promise<void>} Completion of the child while its stdout and stderr remain attached.
 */
const runGo = async (args, options) => {
  const child = spawn(go, args, { ...options, stdio: "inherit" });
  /** @type {unknown[]} */
  const exit = await once(child, "close");
  const [status, signal] = exit;
  assert.equal(status, SUCCESS, `Go ${args[0]} stopped with status ${String(status)} and signal ${String(signal)}`);
};

/**
 * @param {string} line - One complete JSON line from the upstream Go process.
 * @returns {{ api: string, name: string, source: string, value: Record<string, unknown> }} The checked sort fields and the original serialized record.
 */
const fixture = (line) => {
  /** @type {unknown} */
  const parsed = JSON.parse(line);
  assert.ok(isRecord(parsed));
  const { api, name, source } = parsed;
  assert.ok(matchesString(api) && matchesString(name) && matchesString(source));
  return { api, name, source, value: parsed };
};

/**
 * @param {{ name: string, api: string, source: string }} item - An upstream fixture.
 * @returns {string} The unchanged key used to sort the emitted Go fixtures.
 */
const fixtureKey = (item) => `${item.name}\0${item.api}\0${item.source}`;

/** @typedef {{ calls: number, apis: Record<string, number>, cases: Set<string> }} FixtureCounts */
/** @type {Map<string, FixtureCounts>} */
const counts = new Map();

/**
 * @param {{ name: string, api: string }} item - The case and parser API to count.
 * @returns {void} Updates the overall counts in fixture order.
 */
const countCase = (item) => {
  const [name = ""] = item.name.split("/");
  /** @type {FixtureCounts} */
  const count = counts.get(name) ?? { apis: {}, calls: EMPTY, cases: new Set() };
  counts.set(name, count);
  count.calls += ONE_CASE;
  count.apis[item.api] = (count.apis[item.api] ?? EMPTY) + ONE_CASE;
  count.cases.add(item.name);
};

/**
 * @param {string} filename - The upstream test file.
 * @param {FixtureCounts | undefined} count - The captured calls, when applicable.
 * @returns {string} The corresponding statement of parser coverage.
 */
const coverage = (filename, count) => {
  if (matchesUndefined(count)) {return "Excluded: evaluation or static AST helper API not included in the native parser scope.";}
  if (filename.startsWith("expression")) {
    return "Parsing result, complete AST and parsing diagnostics only. Evaluation assertions execute in Go but are not claimed as ported.";
  }
  return "Every original table input with complete oracle result and diagnostics.";
};

/**
 * @param {[string, unknown][]} entries - Fields in the original exported order.
 * @returns {Record<string, unknown>} A JSON object with those fields.
 */
const ordered = (entries) => Object.fromEntries(entries);

/**
 * @param {string} filename - The source file that declares the functions.
 * @param {unknown} names - The literal function names emitted by the Go AST tool.
 * @returns {Record<string, unknown>[]} The manifest entries in the original declared function order.
 */
const describeFunctions = (filename, names) => {
  assert.ok(Array.isArray(names));
  /** @type {unknown[]} */
  const entries = names;
  assert.ok(entries.every((name) => matchesString(name)));
  return entries.map((name) => {
    const count = counts.get(name);
    return ordered([
      ["name", name], ["calls", count?.calls ?? EMPTY], ["cases", count?.cases.size ?? EMPTY],
      ["apis", count?.apis ?? {}], ["coverage", coverage(filename, count)],
    ]);
  });
};

const revision = await exec("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" });
const actual = revision.stdout.trim();
assert.equal(actual, REVISION, `Expected upstream ${REVISION}, found ${actual}`);
await mkdir(REGEN_DIRECTORY, { recursive: true });
const work = await mkdtemp(path.join(REGEN_DIRECTORY, "test-export-"));
const raw = path.join(work, "raw.jsonl");
await runGo(["run", path.join(TOOLING, "instrument.go"), upstream, work, path.join(TOOLING, "oracle.go.txt")], {});
await runGo(["test", "-overlay", path.join(work, "overlay.json"), "./hclsyntax", "-count=1"], {
  cwd: upstream,
  env: { ...environment, HCL_ORACLE_OUTPUT: raw },
});

const rawFixtures = await readFile(raw, "utf8");
const fixtures = rawFixtures.trimEnd().split("\n").map((line) => fixture(line));
fixtures.sort((left, right) => fixtureKey(left).localeCompare(fixtureKey(right), "en"));
fixtures.forEach((item) => {countCase(item);});
const functionsSource = await readFile(path.join(work, "functions.json"), "utf8");
/** @type {unknown} */
const functions = JSON.parse(functionsSource);
assert.ok(isRecord(functions));
const version = await exec(go, ["version"], { encoding: "utf8" });

// These entries are serialized in the order of the published oracle manifest.
const metadata = ordered([
  ["repository", "https://github.com/hashicorp/hcl"],
  ["tag", "v2.25.0"],
  ["revision", REVISION],
  ["license", "MPL-2.0"],
  ["go", version.stdout.trim()],
]);
const peeker = ordered([
  ["file", "peeker_test.go"], ["function", "TestPeeker"], ["cases", PEEKER_CASES],
  ["coverage", "All three original scenarios transcribed directly with Peek/Read equality and exact token sequences."],
]);
const corpus = ordered([
  ["cases", counts.get("TestReyloOfficialCorpus")?.cases.size ?? EMPTY],
  ["nativeSpecFiles", NATIVE_SPEC_FILES], ["fuzzConfig", FUZZ_CONFIG], ["fuzzExpression", FUZZ_EXPRESSION],
  ["fuzzTemplate", FUZZ_TEMPLATE], ["excludedTraversalSeeds", EXCLUDED_TRAVERSAL_SEEDS],
  ["coverage", "Pinned Go parser AST and diagnostics, not hcldec evaluation parity."],
]);
const manifest = ordered([
  ["upstream", metadata],
  ["oracle", "Unchanged upstream test assertions execute through a Go AST call-wrapper overlay. Expected values are serialized exclusively from the pinned Go implementation, never from the TypeScript port."],
  ["fixtures", fixtures.length],
  ["functions", Object.fromEntries(Object.entries(functions).map(([filename, names]) => [filename, describeFunctions(filename, names)]))],
  ["peeker", peeker],
  ["corpus", corpus],
  ["exclusions", [
    "Expression.Value and cty evaluation assertions",
    "Standalone traversal parsing, JSON parsing, hcldec body decoding, navigation, variable enumeration, walking",
    "BenchmarkLexConfig performance benchmark, which has no correctness assertions",
    "pos_test.go helpers not copied into the parser are outside scope",
  ]],
]);
const serialized = fixtures.map(({ value }) => JSON.stringify(value)).join("\n");
await writeFile(path.join(OUTPUT, "fixtures.jsonl"), `${serialized}\n`);
await writeFile(path.join(OUTPUT, "manifest.json"), `${JSON.stringify(manifest, undefined, JSON_INDENT)}\n`);
await copyLicense(path.join(upstream, "LICENSE"), path.join(OUTPUT, "LICENSE"));
process.stdout.write(`Exported ${fixtures.length} official Go fixtures to ${OUTPUT}\n`);
