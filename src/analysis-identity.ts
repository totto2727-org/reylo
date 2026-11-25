// oxlint-disable-next-line rules/no-node-imports -- Use the established host digest for persistent analysis and schema identifiers.
import { createHash } from "node:crypto";
import { duckdbPath, hclPath, sqlitePath } from "./project.ts";
import type { ResolvedProject } from "./project.ts";
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

export const cacheServer = ({ dialect, root, url: rawUrl }: ResolvedProject): string => {
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
