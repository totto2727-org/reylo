// oxlint-disable-next-line rules/no-node-imports -- Use the established host digest for persistent analysis and schema identifiers.
import { createHash } from "node:crypto";
import { duckdbPath, hclPath, resolveProject, sqlitePath } from "./project.ts";
import type { ResolvedProject } from "./project.ts";
import { anyEngine, engine as installedEngine, MissingEngine } from "./engine.ts";
import type { Engine } from "./engine.ts";
import { errorMessage } from "./analysis-results.ts";
import { CACHE_ENTRY_VERSION } from "./analysis-cache.ts";
import { isEmptyString, matchesUndefined, nonemptyText } from "./native-predicates.ts";

const DIGEST_START = 0;

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const digestPrefix = (text: string, length: number): string => sha256(text).slice(DIGEST_START, length);

const remoteDatabaseLocation = (url: string | undefined): string => {
  try {
    const currentUrl = new URL(url ?? "");
    const host = nonemptyText(currentUrl.hostname) ?? nonemptyText(currentUrl.searchParams.get("host")) ?? "localhost";
    const port = isEmptyString(currentUrl.port) ? "" : `:${currentUrl.port}`;
    return `${host}${port}${currentUrl.pathname}`;
  } catch {
    return "the database";
  }
};

const localDatabasePath = (dialect: ResolvedProject["dialect"], url: string, root: string): string | undefined => {
  if (dialect === "sqlite") {return sqlitePath(url, root);}
  if (dialect === "duckdb") {return duckdbPath(url, root);}
  return undefined;
};

export const databaseLocation = ({ dialect, root, url }: ResolvedProject): string =>
  localDatabasePath(dialect, url ?? "", root) ?? remoteDatabaseLocation(url);

const remoteCacheId = (url: string): string => {
  try {
    const location = new URL(url);
    return `${location.protocol}//${location.username}@${location.host}${location.pathname}`;
  } catch {
    return url;
  }
};

const cacheServer = ({ dialect, root, url: rawUrl }: ResolvedProject): string => {
  const url = nonemptyText(rawUrl);
  if (matchesUndefined(url)) {return "";}
  const source = hclPath(url, root);
  if (!matchesUndefined(source)) {return `hcl:${source}`;}
  return localDatabasePath(dialect, url, root) ?? remoteCacheId(url);
};

export const connectionDiagnostic = (project: ResolvedProject, where: () => string, why?: string): string => {
  const detail = nonemptyText(why);
  const suffix = matchesUndefined(detail) ? "" : `: ${detail}`;
  const location = `(${project.urlSource})${suffix}`;
  if (project.dialect === "sqlite" || project.dialect === "duckdb") {
    return `Cannot open the database ${databaseLocation(project)} ${location}`;
  }
  return `Cannot connect to the database at ${where()} ${location}`;
};

const SERVER_DIGEST_LENGTH = 16;
const STATEMENT_DIGEST_LENGTH = 32;

export const serverKey = (project: ResolvedProject): string => digestPrefix(cacheServer(project), SERVER_DIGEST_LENGTH);

export const statementKey = (fingerprint: string, dialect: ResolvedProject["dialect"], sql: string): string =>
  digestPrefix(JSON.stringify([CACHE_ENTRY_VERSION, fingerprint, dialect, sql]), STATEMENT_DIGEST_LENGTH);

// oxlint-disable-next-line node/no-process-env -- The public Session factories default to the current host environment when the caller supplies none.
export const hostEnvironment = (): NodeJS.ProcessEnv => process.env;

/**
 * The project a directory belongs to, its file read by the engine's core, and the engine of its own
 * database, or why that cannot be run.
 * @param {string} dir Directory used to find the project.
 * @param {Record<string, string | undefined>} env Environment used to resolve the project configuration.
 * @returns {Promise<{ project: ResolvedProject; engine: Engine | MissingEngine }>} The resolved configuration and its engine, or the reason the engine is missing.
 */
export const openProject = async function (dir: string, env: Record<string, string | undefined>): Promise<{ project: ResolvedProject; engine: Engine | MissingEngine }> {
  const project = resolveProject(await anyEngine(), dir, env);
  const own = await installedEngine(project.dialect).catch((error: unknown) => (error instanceof MissingEngine ? error : new MissingEngine(errorMessage(error))));
  return { engine: own, project };
};
