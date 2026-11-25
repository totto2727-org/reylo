// oxlint-disable-next-line rules/no-node-imports -- Ask Git which candidates the project ignores.
import { spawnSync } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- A CLI path may name a file or a directory.
import { existsSync, statSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Discover SQL files using the host filesystem's glob implementation.
import { glob } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve command-line and project-relative paths on the host platform.
import path from "node:path";
import { Session } from "./analyze.ts";
import { isEmptyArray, isEmptyString, matchesUndefined } from "./native-predicates.ts";

// React Router's .server directories can hold project queries. Other dot directories stay out.
const INCLUDE = ["**/*.sql", "**/.server/**/*.sql"];
const EXCLUDE = ["**/node_modules/**", "**/{dist,build,out,target,coverage}/**"];
const GIT_FOUND_MATCHES = 0;
const NEGATION_LENGTH = 1;

const negated = (pattern: string): boolean => pattern.startsWith("!") && !pattern.startsWith("!(");

const sqlFiles = async (dir: string, include = INCLUDE, exclude: string[] = []): Promise<string[]> => {
  const patterns = include.filter((pattern) => !negated(pattern)).flatMap((pattern) => {
    const clean = pattern.replace(/\/$/u, "");
    return clean.endsWith("*") ? [clean] : [clean, `${clean}/**`];
  });
  const excluded = [...EXCLUDE, ...exclude, ...include.filter((pattern) => negated(pattern)).map((pattern) => pattern.slice(NEGATION_LENGTH))];
  const entries = await Array.fromAsync(glob(patterns, { cwd: dir, exclude: excluded, withFileTypes: true }));
  // The native glob can match names case-insensitively and can return directories.
  return entries.filter((entry) => !entry.isDirectory() && entry.name.endsWith(".sql")).map((entry) => path.resolve(entry.parentPath, entry.name));
};

const gitIgnored = (dir: string, files: string[]): Set<string> => {
  if (isEmptyArray(files)) {return new Set();}
  // oxlint-disable-next-line node/no-sync -- Read Git's exclusion result for this CLI directory before advancing to the next one.
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], { cwd: dir, encoding: "utf8", input: files.join("\0") });
  if (result.status !== GIT_FOUND_MATCHES) {return new Set();}
  return new Set(result.stdout.split("\0").filter((part) => !isEmptyString(part)).map((part) => path.resolve(dir, part)));
};

interface Targets { found: Set<string>; named: Set<string> }

const addDirectory = async (dir: string, found: Set<string>): Promise<void> => {
  const files = await sqlFiles(dir);
  const ignored = gitIgnored(dir, files);
  Iterator.from(files).forEach((file) => {if (!ignored.has(file)) {found.add(file);}});
};

const addTarget = async (argument: string, targets: Targets): Promise<string | undefined> => {
  const full = path.resolve(argument);
  // oxlint-disable-next-line node/no-sync -- Preserve the CLI's native error for the first explicit missing argument.
  if (!existsSync(full)) {return `${argument} does not exist.`;}
  // oxlint-disable-next-line node/no-sync -- Classify the explicitly named path before starting its glob or admitting a file.
  if (statSync(full).isDirectory()) {
    await addDirectory(full, targets.found);
    return undefined;
  }
  if (!full.endsWith(".sql")) {return `${argument} is not a .sql file or a directory.`;}
  targets.named.add(full);
  return undefined;
};

export const gatherTargets = async (paths: string[]): Promise<Targets | string> => {
  const targets = { found: new Set<string>(), named: new Set<string>() };
  // oxlint-disable-next-line rules/no-for-loops -- Stop when the first invalid CLI argument is reached.
  for (const argument of isEmptyArray(paths) ? ["."] : paths) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Resolve arguments in command-line order before proceeding.
    const error = await addTarget(argument, targets);
    if (!matchesUndefined(error)) {return error;}
  }
  return targets;
};

const applyProjectGlobs = async (session: Session, files: string[], names: Set<string>): Promise<string[]> => {
  const { exclude, include } = session.project.cli;
  if (matchesUndefined(include) && matchesUndefined(exclude)) {return files;}
  const allowed = new Set(await sqlFiles(session.root, include, exclude));
  return files.filter((file) => names.has(file) || allowed.has(file));
};

export const groupProjects = async ({ found, named }: Targets): Promise<Map<Session, string[]>> => {
  const projects = new Map<Session, string[]>();
  // oxlint-disable-next-line rules/no-for-loops -- Open one session per file's project in the existing sorted order.
  for (const file of [...named, ...found].toSorted()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Grouping consults the same open session before visiting the next file.
    const session = await Session.for(path.dirname(file));
    projects.set(session, [...(projects.get(session) ?? []), file]);
  }
  // oxlint-disable-next-line rules/no-for-loops -- Apply each project's own patterns before proceeding to the next project.
  for (const [session, files] of projects) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve the project's filesystem and failure order.
    projects.set(session, await applyProjectGlobs(session, files, named));
  }
  return projects;
};
