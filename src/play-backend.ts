import { Session } from "./analyze.ts";
import type { Dialect } from "./engine-core.ts";
import { isEmptyString, matchesNull, matchesUndefined } from "./native-predicates.ts";
import { catalog, CATALOG_QUERIES } from "./play-catalog.ts";
import type { Catalog } from "./play-catalog.ts";
import { playResult } from "./play-result.ts";
import type { PlayResult } from "./play-result.ts";
import { schemaDdl, schemaText } from "./play-schema.ts";

export interface Backend {
  analyze: (sql: string, width: number) => Promise<PlayResult>;
  catalog: Catalog;
  close: () => Promise<void>;
  dialect: Dialect;
  label: string;
  notice?: string;
  schema: string;
}

const displayedDialect = { duckdb: "SQLite", mysql: "MySQL", postgres: "Postgres", sqlite: "SQLite" };

const catalogRows = async (session: Session, sql: string | undefined): Promise<unknown[][]> => {
  if (matchesUndefined(sql) || isEmptyString(sql)) {return [];}
  try {
    return await session.query(sql);
  } catch {
    return [];
  }
};

const readCatalog = async (session: Session, dialect: Dialect): Promise<Catalog> => {
  const queries = CATALOG_QUERIES[dialect];
  return catalog(dialect, await catalogRows(session, queries.tables), await catalogRows(session, queries.functions), await catalogRows(session, queries.types));
};

const readLexed = async (session: Session, sql: string): Promise<Awaited<ReturnType<Session["lex"]>> | undefined> => {
  try {
    return await session.lex(sql);
  } catch {
    return undefined;
  }
};

interface AnalysisBackend { session: Session; project: Session["project"] }

const analyze = async ({ project, session }: AnalysisBackend, sql: string, width: number): Promise<PlayResult> => {
  const { dialect } = project;
  const started = performance.now();
  const outcome = await session.analyze(sql, { store: false });
  const ms = performance.now() - started;
  if (!outcome.ok) {
    return playResult(sql, dialect, { error: { code: outcome.code, message: outcome.message } }, { ms, width });
  }
  const lexed = await readLexed(session, sql);
  return playResult(sql, dialect, { analysis: outcome.analysis, lexed }, { ms, strictParams: project.strictParams, width });
};

const databaseBackend = async (session: Session): Promise<Backend> => {
  const { project } = session;
  const { dialect } = project;
  const schema = await session.schema();
  if (matchesNull(schema.value) || schema.fatal === true) {
    // oxlint-disable-next-line rules/require-tagged-error -- The standalone playground returns the native startup failure to its CLI.
    throw new Error(schema.fatal === true ? schema.error : session.cannotConnect(schema.error));
  }
  const cat = await readCatalog(session, dialect);
  const label = `${displayedDialect[dialect]} at ${session.where()} (${project.urlSource})`;
  const ddl = await schemaDdl(dialect, async (sql) => session.query(sql));
  return {
    analyze: async (sql, width) => analyze({ project, session }, sql, width),
    catalog: cat,
    close: async () => session.close(),
    dialect,
    label,
    ...(matchesUndefined(project.notice) || isEmptyString(project.notice) ? {} : { notice: project.notice }),
    schema: ddl ?? schemaText(dialect, cat),
  };
};

export const openBackend = async (cwd: string, env: Record<string, string | undefined>): Promise<Backend> => {
  const session = await Session.open(cwd, env);
  const { project } = session;
  const required = project.error ?? "";
  const url = project.url ?? "";
  if (!isEmptyString(required) || isEmptyString(url)) {
    await session.close();
    // oxlint-disable-next-line rules/require-tagged-error -- The dependency-free CLI prints the existing native configuration message.
    throw new Error(project.error ?? `${project.missingUrl} reylo play reads the project's own database; to try Reylo without one, open https://reylo.dev/play.`);
  }
  return databaseBackend(session);
};
