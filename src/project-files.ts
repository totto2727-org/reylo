// oxlint-disable-next-line rules/no-node-imports -- Resolve project and dotenv files through the native host filesystem.
import { existsSync, readFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Resolve package paths using the host platform's filesystem conventions.
import path from "node:path";
import { matchesUndefined, nonemptyText } from "./native-predicates.ts";

export const PROJECT_FILE = ".reylo.yaml";
/** The names the project file may take; the first is the one messages name. */
export const PROJECT_FILES = [PROJECT_FILE, ".reylo.yml"] as const;
// oxlint-disable-next-line node/no-process-env -- Project lookup defaults to the native environment supplied to this process.
export const hostEnvironment = (): NodeJS.ProcessEnv => process.env;

export const hasProjectPath = (file: string): boolean =>
  // oxlint-disable-next-line node/no-sync -- The synchronous module and project resolvers inspect the same package snapshot before returning.
  existsSync(file);

export const readProjectText = (file: string): string =>
  // oxlint-disable-next-line node/no-sync -- The synchronous project resolver reads settings and dotenv files before resolving a database URL.
  readFileSync(file, "utf8");

/**
 * Finds the nearest package directory at or above a path.
 * @param {string} from The directory where the package lookup starts.
 * @returns {string} The package directory if present, otherwise the absolute starting directory.
 */
export const packageDir = function packageDir(from: string): string {
  const start = path.resolve(from);
  // oxlint-disable-next-line rules/no-let -- Traverse parent directories iteratively, including very deep supplied paths.
  let directory = start;
  while (!hasProjectPath(path.join(directory, "package.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory) {return start;}
    directory = parent;
  }
  return directory;
};

/**
 * Finds the project file next to the package or at the explicit configuration path.
 * @param {string} from The directory where the project lookup starts.
 * @param {Record<string, string | undefined>} env The configuration environment.
 * @returns {string | undefined} The absolute path of the project file if one was specified or found.
 */
export const findProjectFile = function findProjectFile(from: string, env: Record<string, string | undefined> = hostEnvironment()): string | undefined {
  const override = nonemptyText(env.REYLO_CONFIG);
  if (!matchesUndefined(override)) {return path.resolve(override);}
  const directory = packageDir(from);
  return PROJECT_FILES.map((name) => path.join(directory, name)).find((file) => hasProjectPath(file));
};

/**
 * Computes the SQL source name used in emitted modules and SQL comments.
 * @param {string} filename The source SQL file.
 * @param {Record<string, string | undefined>} env The configuration environment.
 * @returns {string} The source path relative to its project, with forward slashes.
 */
export const sourceName = function sourceName(filename: string, env: Record<string, string | undefined> = hostEnvironment()): string {
  const directory = path.dirname(filename);
  const file = findProjectFile(directory, env);
  const root = matchesUndefined(file) ? packageDir(directory) : path.dirname(file);
  return path.relative(root, filename).split(path.sep).join("/");
};

export const readEnvFile = function readEnvFile(file: string): Record<string, string> {
  if (!hasProjectPath(file)) {return {};}
  const entries: Record<string, string> = {};
  const lines = readProjectText(file).split("\n");
  Iterator.from(lines).forEach((line) => {
    const assignment = /^\s*(?:export\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*?)\s*$/u.exec(line)?.groups;
    const name = assignment?.name;
    if (!matchesUndefined(name)) {
      entries[name] = (assignment?.value ?? "").replace(/^(?<quote>["'])(?<text>.*)\k<quote>$/u, "$<text>");
    }
  });
  return entries;
};
