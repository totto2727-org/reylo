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

import { commandOutput } from "./project-command.ts";
import { readProjectConfig } from "./project-config.ts";
import { findProjectFile, hasProjectPath, hostEnvironment, packageDir, PROJECT_FILE, PROJECT_FILES, readEnvFile } from "./project-files.ts";
import { inUserinfo, urlParts } from "./project-url-template.ts";
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
/**
 * The project `projectDir` belongs to. `engine` reads the project file: any database's engine does
 * (src/engine.ts, `anyEngine`), and where none is installed a project file is the project's error.
 * @param {Engine | MissingEngine} engine The engine used to validate the configuration.
 * @param {string} projectDir The directory used to find the project.
 * @param {Record<string, string | undefined>} env The environment used for URL and file settings.
 * @returns {ResolvedProject} The native project settings and any configuration diagnostic.
 */
export const resolveProject = function resolveProject(engine: Engine | MissingEngine, projectDir: string, env: Record<string, string | undefined> = hostEnvironment()): ResolvedProject {
  const file = findProjectFile(projectDir, env);
  const root = matchesUndefined(file) ? packageDir(projectDir) : dirname(file);
  const shown = (path: string): string => (isAbsolute(path) ? relative(projectDir, path).split(sep).join("/") || path : path);
  const parsed = readProjectConfig(engine, file, shown);
  const { config } = parsed;
  let error = parsed.error;
  // Both names beside one package.json: whichever were read, edits to the other would do nothing.
  const both = PROJECT_FILES.map((name) => join(root, name));
  if (matchesUndefined(nonemptyText(env.REYLO_CONFIG)) && both.every((filePath) => hasProjectPath(filePath))) {error = `${both.map(shown).join(" and ")} are both project files; keep one.`;}
  const envFiles = (config.env ?? DEFAULT_ENV_FILES).map((filename) => resolve(root, filename));
  // The process environment wins; among the files, the first that sets a variable does.
  const lookup = (name: string): { value: string; source: string } | undefined => {
    if (!matchesUndefined(env[name])) {return { value: env[name], source: `${name} in the environment` };}
    for (const path of envFiles) {
      const value = readEnvFile(path)[name];
      if (!matchesUndefined(value)) {return { value, source: `${name} in ${shown(path)}` };}
    }
    return undefined;
  };
  let url: string | undefined;
  let urlSource = "DATABASE_URL";
  // Reylo never reads `url`; a file that sets `direct_url` beside it has named Reylo's connection, and is fine.
  const urlAlone = !matchesUndefined(config.url) && matchesUndefined(config.direct_url);
  const notice = urlAlone ? `${shown(file!)}: Reylo does not read url; set direct_url to the dev database Reylo reads your types from (it uses DATABASE_URL meanwhile)` : undefined;
  const missingUrl = urlAlone
    ? `No database URL: ${shown(file!)} sets url, which Reylo does not read; set direct_url there, or DATABASE_URL in the environment, .env.local or .env.`
    : `No database URL: set DATABASE_URL in the environment, .env.local or .env, or "direct_url" in ${file ? shown(file) : PROJECT_FILE}.`;
  const written = config.direct_url;
  let refreshUrl: (() => string | undefined) | undefined;
  if (matchesUndefined(written)) {
    const hit = lookup("DATABASE_URL");
    url = hit?.value;
    if (hit) {urlSource = hit.source;}
  } else {
    const missing: string[] = [];
    const sources: string[] = [];
    const parts = urlParts(written);
    urlSource = `"direct_url" in ${shown(file!)}`;
    if ("open" in parts) {
      error ??= `${shown(file!)}: "direct_url" opens $( at column ${parts.open + 1} and never closes it.`;
    } else {
      // The text's ${VAR}s are Reylo's; a command's are its shell's, so that no value is read as
      // Shell syntax, and its shell sees the variables the text would: the environment's, then
      // The `.env` files'.
      const texts = parts.map((part) =>
        "text" in part
          ? part.text.replace(/\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name: string) => {
              const hit = lookup(name);
              if (!hit) {missing.push(name);}
              else {sources.push(hit.source);}
              return hit?.value ?? "";
            })
          : undefined,
      );
      urlSource += sources.length ? `, ${sources.join(", ")}` : "";
      if (missing.length) {
        error ??= `${shown(file!)}: "direct_url" names ${missing.map((m) => `\${${m}}`).join(", ")}, which neither the environment nor ${envFiles.map(shown).join(" nor ")} sets.`;
      } else if (parts.some((part) => "command" in part)) {
        const shellEnv: Record<string, string> = {};
        Iterator.from([...envFiles].reverse()).forEach((path) => {Object.assign(shellEnv, readEnvFile(path));});
        Object.entries({ ...hostEnvironment(), ...env }).forEach(([name, value]) => {if (!matchesUndefined(value)) {shellEnv[name] = value;}});
        const encoded = inUserinfo(parts);
        const build = (fresh: boolean): { url: string } | { error: string } => {
          let built = "";
          for (const [index, part] of parts.entries()) {
            if ("text" in part) {
              built += texts[index];
              continue;
            }
            const out = commandOutput(part.command, { cwd: root, env: shellEnv }, fresh);
            if ("error" in out) {return { error: `${shown(file!)}: "direct_url" runs \`${part.command}\`, ${out.error}.` };}
            built += encoded.has(part) ? encodeURIComponent(out.value) : out.value;
          }
          return { url: built };
        };
        // A project that cannot be used anyway runs nothing, so that it asks for no password.
        if (!error) {
          const first = build(false);
          if ("error" in first) {error = first.error;}
          else {url = first.url;}
          refreshUrl = () => {
            const again = build(true);
            return "url" in again ? again.url : undefined;
          };
        }
      } else {url = texts.join("");}
    }
  }
  const dialect = url ? dialectOf(url) : "sqlite";
  if (url && !dialect) {error ??= `Cannot tell the database from the URL (${urlSource}): reylo reads postgres://, postgresql://, mysql://, file:, sqlite:, duckdb: and hcl: URLs.`;}
  // Either name, created or removed, changes the project.
  const watched = [...new Set([...(file ? [file] : []), ...both]), ...envFiles];
  try {
    const source = url && hclPath(url, root);
    if (source) {watched.push(source);}
  } catch (error_) {
    error ??= `${urlSource}: ${(error_ as Error).message}`;
  }
  // This fork supports only SQLite, including cached analysis without a URL.
  return { file, root, dialect: dialect ?? "sqlite", strictParams: config.strict_params ?? true, sqlcommenter: config.sqlcommenter ?? true, cli: config.cli ?? {}, url, urlSource, refreshUrl, watched, error, notice, missingUrl };
};
