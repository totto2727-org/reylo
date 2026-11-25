// oxlint-disable-next-line rules/no-node-imports -- Resolve libpq TLS paths with the same native path rules as the consumer process.
import nodePath from "node:path";
import { isEmptyString, matchesUndefined, nonemptyText } from "./native-predicates.ts";

const FILES = new Set(["sslrootcert", "sslcert", "sslkey"]);
const SCHEME_SEPARATOR = "://";
const DEFAULT_POSTGRES_PORT = "5432";
const URL_START = 0;
const NOT_FOUND = -1;

export type SocketDialect = "postgres" | "mysql";

const splitQuery = function splitQuery(url: string): [string, string?] {
  const separator = "?";
  const queryStart = url.indexOf(separator);
  return queryStart === NOT_FOUND ? [url] : [url.slice(URL_START, queryStart), url.slice(queryStart + separator.length)];
};

const decodeQueryPart = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

export const splitPair = function splitPair(pair: string): [string, string] {
  const separator = "=";
  const assignment = pair.indexOf(separator);
  return assignment === NOT_FOUND
    ? [decodeQueryPart(pair), ""]
    : [decodeQueryPart(pair.slice(URL_START, assignment)), decodeQueryPart(pair.slice(assignment + separator.length))];
};

export const joinHost = function joinHost(base: string, pairs: string[]): string {
  return pairs.length ? `${base}?${pairs.join("&")}` : base;
};

const detectDialect = (url: string): SocketDialect | undefined => {
  const separator = url.indexOf(SCHEME_SEPARATOR);
  const scheme = separator === NOT_FOUND ? "" : url.slice(URL_START, separator).toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") {return "postgres";}
  if (scheme === "mysql") {return "mysql";}
  return undefined;
};

// The authority follows scheme and user information and ends at the path.
const authorityRange = (base: string): { end: number; start: number } => {
  const authorityStart = base.indexOf(SCHEME_SEPARATOR) + SCHEME_SEPARATOR.length;
  const pathStart = base.indexOf("/", authorityStart);
  const end = pathStart === NOT_FOUND ? base.length : pathStart;
  const firstAt = base.indexOf("@", authorityStart);
  const start = firstAt >= authorityStart && firstAt < end ? firstAt + "@".length : authorityStart;
  return { end, start };
};

// Keep the user, password and path when replacing the host and port.
export const withHost = (base: string, host: string): string => {
  const { end, start } = authorityRange(base);
  return `${base.slice(URL_START, start)}${host}${base.slice(end)}`;
};

const resolvePostgresFile = (pair: string): string => {
  const [key, value] = splitPair(pair);
  if (!FILES.has(key) || isEmptyString(value) || value === "system") {return pair;}
  return `${key}=${encodeURIComponent(nodePath.resolve(value))}`;
};

interface SocketOptions {
  params: string[];
  path: string;
}

const authorityHost = (encoded: string, params: Map<string, string>, env: Record<string, string | undefined>): string | undefined => {
  if (!isEmptyString(encoded)) {return decodeURIComponent(encoded);}
  if (!matchesUndefined(nonemptyText(params.get("hostaddr")))) {return undefined;}
  return env.PGHOST;
};

// A host naming a directory selects the socket file for the effective Postgres port.
const postgresSocket = (base: string, pairs: string[], env: Record<string, string | undefined>): SocketOptions | undefined => {
  const params = new Map(pairs.map((pair) => splitPair(pair)));
  const { end, start } = authorityRange(base);
  const authority = base.slice(start, end);
  const { encodedHost = "", port: authorityPort } = /^(?<encodedHost>.*?)(?::(?<port>\d+))?$/u.exec(authority)?.groups ?? {};
  const host = params.get("host") ?? authorityHost(encodedHost, params, env);
  if (matchesUndefined(host) || !host.startsWith("/") || host.includes(",")) {return undefined;}
  const port = nonemptyText(params.get("port")) ?? nonemptyText(authorityPort) ?? nonemptyText(env.PGPORT) ?? DEFAULT_POSTGRES_PORT;
  return { params: ["host", "port", "sslmode"], path: `${host.replace(/\/$/u, "")}/.s.PGSQL.${port}` };
};

const mysqlSocket = (pairs: string[]): SocketOptions | undefined => {
  const params = new Map(pairs.map((pair) => splitPair(pair)));
  const path = nonemptyText(params.get("socketPath")) ?? nonemptyText(params.get("socket"));
  // A Unix socket does not use TLS. Remove the corresponding TCP URL options.
  return matchesUndefined(path) ? undefined : { params: ["socketPath", "socket", "ssl", "ssl-mode", "sslmode", "ssl_mode", "sslaccept"], path };
};

export interface SocketAddress {
  base: string;
  dialect: SocketDialect;
  pairs: string[];
  socket: SocketOptions;
}

export const prepareHostUrl = (url: string, env: Record<string, string | undefined>): { url: string } | SocketAddress => {
  const dialect = detectDialect(url);
  if (matchesUndefined(dialect)) {return { url };}
  const [base, query = ""] = splitQuery(url);
  const options = isEmptyString(query) ? [] : query.split("&");
  const pairs = dialect === "postgres" ? options.map((pair) => resolvePostgresFile(pair)) : options;
  const socket = dialect === "postgres" ? postgresSocket(base, pairs, env) : mysqlSocket(pairs);
  return matchesUndefined(socket) ? { url: joinHost(base, pairs) } : { base, dialect, pairs, socket };
};
