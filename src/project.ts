// The project file, `.reylo.yaml` (or `.reylo.yml`), and the connection it names. The file sits
// Beside the project's `package.json` (the nearest one at or above the tsconfig's directory;
// `REYLO_CONFIG` names another file), is parsed by the engine so that every reylo tool reads the same YAML, and is
// Resolved here against the environment: the process environment first, then the `.env` files the
// Project file names under `env` (by default `.env.local`, then `.env`, beside it), and a `${VAR}`
// In a URL is replaced from that. A `$(command)` in `direct_url` is replaced by what the command
// Prints, so that a secret can come from a password manager or a cloud's token command instead of
// A file. The URL's scheme names the dialect. The connection is
// `direct_url`, else `${DATABASE_URL}`, and never `url`, which the file keeps for another use
// (wiki/project-config.md section 4). A file that sets `url` without `direct_url` is told so by
// `reylo generate`, once, and by the error a project with no connection gets; never by an error of
// Its own, since TypeScript makes every content mapper diagnostic one. With no URL, this fork
// Defaults to SQLite for cached analysis.
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to resolve paths using the host platform's filesystem conventions.
import nodePath from "node:path";
import type { Engine, MissingEngine } from "./engine.ts";
import { matchesUndefined, nonemptyText } from "./native-predicates.ts";

import { nativeErrorText } from "./native-error-text.ts";
import { resolveConnection } from "./project-connection.ts";
import { readProjectConfig } from "./project-config.ts";
import { findProjectFile, hasProjectPath, hostEnvironment, packageDir, PROJECT_FILE, PROJECT_FILES } from "./project-files.ts";
import { dialectOf, hclPath } from "./project-address.ts";
import type { Dialect } from "./project-address.ts";

export { dialectOf, duckdbPath, hclPath, sqlitePath } from "./project-address.ts";
export type { Dialect } from "./project-address.ts";
export { findProjectFile, packageDir, PROJECT_FILE, PROJECT_FILES, readEnvFile, sourceName } from "./project-files.ts";

const { dirname, isAbsolute, join, relative, resolve, sep } = nodePath;

/** What the engine reads out of `.reylo.yaml`: the keys the library looks at. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the exported configuration type's structural Record assignability.
export type ProjectFile = {
  /** Never the type check's connection: read only to say so. */
  url?: string;
  /** A database URL, or hcl:./schema.hcl for a local Atlas SQLite schema. */
  direct_url?: string;
  env?: string[];
  strict_params?: boolean;
  sqlcommenter?: boolean;
  cli?: Cli;
};

/** The files `reylo generate` analyzes, as globs relative to the project file's directory. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep the exported CLI configuration assignable to structural record consumers.
export type Cli = { include?: string[]; exclude?: string[] };

// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep the resolved configuration assignable to existing structural record consumers.
export type ResolvedProject = {
  /** The project file, when there is one. */
  file: string | undefined;
  /** The directory a relative path in the project resolves against: the package's. */
  root: string;
  dialect: Dialect;
  /** Whether a parameter the statement does not type is an error rather than `unknown`: true unless the file says `strict_params: false`. */
  strictParams: boolean;
  /** Whether each statement ends with a sqlcommenter comment naming its file (src/sqlcommenter.ts): true unless the file says `sqlcommenter: false`. */
  sqlcommenter: boolean;
  /** Which files `reylo generate` analyzes: `include` replaces every `.sql` file, `exclude` adds to what is left out. */
  cli: Cli;
  /** The connection the type check uses: `direct_url` when the file names one, else `DATABASE_URL`; never `url`. */
  url: string | undefined;
  /** Where the URL came from, for a diagnostic: never the URL itself. */
  urlSource: string;
  /**
   * Where `direct_url` runs a `$(command)`: runs each command again, past the output this process
   * keeps, and returns the URL they make now, or undefined when one fails. The session calls it
   * when the database refuses the login, as when a short-lived token has expired. Set too when a
   * command failed, whose failure is then `error`.
   */
  refreshUrl: (() => string | undefined) | undefined;
  /** The files a change to which changes the project: the project file, `.env` files and any HCL source. */
  watched: string[];
  /** Why the project cannot be used, already placed (`.reylo.yaml:3:1: ...`); every transform reports it. */
  error: string | undefined;
  /** That the file sets `url`, which Reylo does not read, and no `direct_url`: said once per project, never an error. */
  notice: string | undefined;
  /** What the project is told when it has no connection: where to set one. */
  missingUrl: string;
};

const DEFAULT_ENV_FILES = [".env.local", ".env"];

const showPath = (directory: string, path: string): string => {
  if (!isAbsolute(path)) {return path;}
  return nonemptyText(relative(directory, path).split(sep).join("/")) ?? path;
};

interface ProjectSettings {
  both: string[];
  config: ProjectFile;
  envFiles: string[];
  error: string | undefined;
  file: string | undefined;
  root: string;
  shown: (path: string) => string;
}

const settings = (
  engine: Engine | MissingEngine,
  projectDir: string,
  env: Record<string, string | undefined>,
): ProjectSettings => {
  const shown = (path: string): string => showPath(projectDir, path);
  const file = findProjectFile(projectDir, env);
  const root = matchesUndefined(file) ? packageDir(projectDir) : dirname(file);
  const { config, error: parseError } = readProjectConfig(engine, file, shown);
  // Edits to the second filename would do nothing. Refuse both names beside one package.
  const both = PROJECT_FILES.map((name) => join(root, name));
  const conflict = matchesUndefined(nonemptyText(env.REYLO_CONFIG)) && both.every((path) => hasProjectPath(path));
  const error = conflict ? `${both.map((path) => shown(path)).join(" and ")} are both project files; keep one.` : parseError;
  const envFiles = (config.env ?? DEFAULT_ENV_FILES).map((filename) => resolve(root, filename));
  return { both, config, envFiles, error, file, root, shown };
};

const connectionNotices = (config: ProjectFile, label: string): { missingUrl: string; notice?: string } => {
  if (!matchesUndefined(config.url) && matchesUndefined(config.direct_url)) {
    return {
      missingUrl: `No database URL: ${label} sets url, which Reylo does not read; set direct_url there, or DATABASE_URL in the environment, .env.local or .env.`,
      notice: `${label}: Reylo does not read url; set direct_url to the dev database Reylo reads your types from (it uses DATABASE_URL meanwhile)`,
    };
  }
  return { missingUrl: `No database URL: set DATABASE_URL in the environment, .env.local or .env, or "direct_url" in ${label}.` };
};

interface CheckedAddress {
  dialect: Dialect;
  error: string | undefined;
  source?: string | undefined;
}

interface ConnectionAddress {
  url: string | undefined;
  urlSource: string;
}

const checkAddress = ({ url, urlSource }: ConnectionAddress, root: string, problem: string | undefined): CheckedAddress => {
  const address = nonemptyText(url);
  if (matchesUndefined(address)) {return { dialect: "sqlite", error: problem };}
  const dialect = dialectOf(address);
  const error = problem ?? (matchesUndefined(dialect)
    ? `Cannot tell the database from the URL (${urlSource}): reylo reads postgres://, postgresql://, mysql://, file:, sqlite:, duckdb: and hcl: URLs.`
    : undefined);
  try {
    return { dialect: dialect ?? "sqlite", error, source: hclPath(address, root) };
  } catch (error_) {
    return { dialect: dialect ?? "sqlite", error: error ?? `${urlSource}: ${nativeErrorText(error_, "message")}` };
  }
};

/**
 * The project `projectDir` belongs to. `engine` reads the project file: any database's engine does
 * (src/engine.ts, `anyEngine`), and where none is installed a project file is the project's error.
 * @param {Engine | MissingEngine} engine The engine used to validate the configuration.
 * @param {string} projectDir The directory used to find the project.
 * @param {Record<string, string | undefined>} env The environment used for URL and file settings.
 * @returns {ResolvedProject} The native project settings and any configuration diagnostic.
 */
export const resolveProject = function resolveProject(engine: Engine | MissingEngine, projectDir: string, env: Record<string, string | undefined> = hostEnvironment()): ResolvedProject {
  const { both, config, envFiles, error: problem, file, root, shown } = settings(engine, projectDir, env);
  const label = matchesUndefined(file) ? PROJECT_FILE : shown(file);
  const { missingUrl, notice } = connectionNotices(config, label);
  const { error: connectionError, refreshUrl, url, urlSource } = resolveConnection(config.direct_url, { env, envFiles, error: problem, label, root, shown });
  const { dialect, error, source } = checkAddress({ url, urlSource }, root, connectionError);
  // Creating or removing either project filename changes the project.
  const watched = [...new Set([...matchesUndefined(file) ? [] : [file], ...both]), ...envFiles];
  if (!matchesUndefined(source)) {watched.push(source);}
  // oxlint-disable-next-line eslint/sort-keys -- Preserve property order for consumers serializing resolved project configuration.
  return { file, root, dialect, strictParams: config.strict_params ?? true, sqlcommenter: config.sqlcommenter ?? true, cli: config.cli ?? {}, url, urlSource, refreshUrl, watched, error, notice, missingUrl };
};
