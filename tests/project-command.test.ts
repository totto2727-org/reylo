// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs these controlled local shell fixtures through Node's test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Assert exact resolver messages and shell execution counts.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Check the real files written by the local test shell.
import { access, readFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve those files within the isolated fixture.
import path from "node:path";
import { engine } from "#reylo-source/engine.ts";
import { resolveProject } from "#reylo-source/project.ts";
import { requireFixtureValue } from "./helpers.ts";
import { tree } from "./project-tree.ts";

type Reader = Awaited<ReturnType<typeof engine>>;
type Project = ReturnType<typeof resolveProject>;

const fileExists = async (filename: string): Promise<boolean> => {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
};

// A project file's command runs in the system's shell, cmd.exe on Windows, and these tests write theirs for a POSIX shell.
const posixShell = process.platform === "win32" && "its command is written for a POSIX shell, and Windows runs it in cmd.exe";

const assertOptionalCommand = async (currentEngine: Reader): Promise<void> => {
  // A URL with no command has nothing to refresh.
  assert.equal(resolveProject(currentEngine, await tree({ ".reylo.yaml": "direct_url: postgres://x/db\n", "package.json": "{}" }), {}).refreshUrl, undefined);
  // A command that is the whole value prints a URL, taken as printed.
  const whole = await tree({ ".reylo.yaml": "direct_url: $(printf 'mysql://root:p@ss@127.0.0.1:3306/app')\n", "package.json": "{}" });
  assert.deepEqual([resolveProject(currentEngine, whole, {}).url, resolveProject(currentEngine, whole, {}).dialect], ["mysql://root:p@ss@127.0.0.1:3306/app", "mysql"]);
};

const runs = async (root: string): Promise<number> => {
  const text = await readFile(path.join(root, "runs.txt"), "utf8");
  return text.split("\n").filter(Boolean).length;
};

const assertRefreshes = async (currentEngine: Reader, root: string, resolved: Project): Promise<void> => {
  // Resolved again, as every build step and the type check do, the command does not run again.
  assert.equal(resolveProject(currentEngine, root, {}).url, resolved.url);
  assert.equal(await runs(root), 1);
  // A refused login runs it again.
  assert.ok(resolved.refreshUrl);
  assert.equal(resolved.refreshUrl(), resolved.url);
  assert.equal(await runs(root), 2);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a $(command) in direct_url is replaced by what it prints, once per process, percent-encoded in the user or password", { skip: posixShell }, async () => {
  const currentEngine = await engine("sqlite");
  // The command counts its runs in a file beside it, and prints a password a URL cannot hold as it is.
  const root = await tree({ ".reylo.yaml": "direct_url: postgres://app:$(echo run >> runs.txt; printf 'p@ss/w?rd&x')@db.internal:5432/app\n", "package.json": "{}" });
  const resolved = resolveProject(currentEngine, root, {});
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.url, "postgres://app:p%40ss%2Fw%3Frd%26x@db.internal:5432/app");
  assert.equal(decodeURIComponent(new URL(resolved.url).password), "p@ss/w?rd&x");
  // Where the URL came from, never what the command printed.
  assert.equal(resolved.urlSource, '"direct_url" in .reylo.yaml');
  assert.equal(resolved.dialect, "postgres");
  await assertRefreshes(currentEngine, root, resolved);
  await assertOptionalCommand(currentEngine);

});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a command's variables are its shell's, from the environment and the env files, and no value is read as shell syntax", { skip: posixShell }, async () => {
  const currentEngine = await engine("sqlite");
  const root = await tree({
    ".env": "DB_PASSWORD=$(touch pwned)\nDB_HOST=from-env-file\n",
    ".reylo.yaml": "direct_url: postgres://app:$(printf %s \"$DB_PASSWORD\")@$(printf %s \"$DB_HOST\")/app\n",
    "package.json": "{}",
  });
  const resolved = resolveProject(currentEngine, root, { DB_HOST: "from-environment" });
  assert.equal(resolved.url, `postgres://app:${encodeURIComponent("$(touch pwned)")}@from-environment/app`);
  assert.equal(await fileExists(path.join(root, "pwned")), false);
  // Reylo's own ${VAR}, outside a command, puts its value in as it is, never as a command.
  const text = await tree({ ".env": "DB_PASSWORD=$(touch pwned)\n", ".reylo.yaml": `direct_url: postgres://app:\${DB_PASSWORD}@h/app\n`, "package.json": "{}" });
  assert.equal(resolveProject(currentEngine, text, {}).url, "postgres://app:$(touch pwned)@h/app");
  assert.equal(await fileExists(path.join(text, "pwned")), false);
});

const assertAbsentVariablePrecedesCommand = async (currentEngine: Reader): Promise<void> => {
  // A variable nothing sets is said first, and the command, which may ask for a password, never runs.
  const unset = await tree({ ".reylo.yaml": `direct_url: postgres://\${NOPE}:$(touch ran; printf x)@h/app\n`, "package.json": "{}" });
  assert.match(requireFixtureValue(resolveProject(currentEngine, unset, {}).error), /names \$\{NOPE\}/u);
  assert.equal(await fileExists(path.join(unset, "ran")), false);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a command that fails, prints nothing or is left open is an error that names it, and runs nothing more", { skip: posixShell }, async () => {
  const currentEngine = await engine("sqlite");
  const failing = await tree({ ".reylo.yaml": "direct_url: postgres://app:$(echo 'no item matches' >&2; exit 3)@h/app\n", "package.json": "{}" });
  const resolved = resolveProject(currentEngine, failing, {});
  assert.equal(resolved.url, undefined);
  assert.equal(resolved.error, `.reylo.yaml: "direct_url" runs \`echo 'no item matches' >&2; exit 3\`, which exited with code 3: no item matches.`);
  const empty = await tree({ ".reylo.yaml": "direct_url: postgres://app:$(true)@h/app\n", "package.json": "{}" });
  assert.equal(resolveProject(currentEngine, empty, {}).error, '.reylo.yaml: "direct_url" runs `true`, which printed nothing.');
  const open = await tree({ ".reylo.yaml": "direct_url: postgres://app:$(printf x@h/app\n", "package.json": "{}" });
  assert.equal(resolveProject(currentEngine, open, {}).error, '.reylo.yaml: "direct_url" opens $( at column 16 and never closes it.');
  await assertAbsentVariablePrecedesCommand(currentEngine);

});
