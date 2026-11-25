// The native TypeScript content mapper. It analyzes SQL and returns its virtual declaration.
// oxlint-disable-next-line rules/no-node-imports -- Resolve TypeScript's project path through the native filesystem.
import path from "node:path";
import { Session } from "./analyze.ts";
import { anyEngine } from "./engine.ts";
import type { Lexed } from "./engine-core.ts";
import { declarationSource, declarationText, diagnostic, FIRST_BYTE_OFFSET, mapToStatement, missingProjectText, ONE_BYTE_DIAGNOSTIC } from "./mapper-declaration.ts";
import type { MapperDiagnostic } from "./mapper-declaration.ts";
import { configDigest, optionDiagnostics, projectName } from "./mapper-project.ts";
import type { OptionDiagnostic } from "./mapper-project.ts";
import { moduleTypes } from "./module-types.ts";
import { matchesUndefined } from "./native-predicates.ts";
import { PROJECT_FILES, resolveProject } from "./project.ts";
import { CONTENT_MAPPER_POSITION_ENCODING, serve } from "./rpc.ts";

interface Project { projectFile: string; session: Promise<Session>; strictParams: boolean }
interface OpenProject { configFileName: string; options?: Record<string, unknown>; projectHandle: string }
interface TransformRequest { content: string; fileName: string; projectHandle: string }
interface ProjectHandle { projectHandle: string }
interface Reply { diagnostics: MapperDiagnostic[]; extension: ".ts"; mappings: number[][]; text: string }
interface OpenReply { configIdentity: string; optionDiagnostics: OptionDiagnostic[]; watchedFiles: string[] }
interface InitializeReply { diagnosticSource: string; positionEncoding: typeof CONTENT_MAPPER_POSITION_ENCODING; protocolVersion: number }
export type MapperHandlers = Record<string, (params: unknown) => unknown>;

const projects = new Map<string, Project>();
const DEFAULT_PROTOCOL_VERSION = 1;
const MISSING_PROJECT_DIAGNOSTIC = 9;

const initialize = (params: unknown): InitializeReply => {
  const { protocolVersion } = (params ?? {}) as { protocolVersion?: number };
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the existing TypeScript handshake's serialized key order.
  return { protocolVersion: protocolVersion ?? DEFAULT_PROTOCOL_VERSION, positionEncoding: CONTENT_MAPPER_POSITION_ENCODING, diagnosticSource: "reylo" };
};

const openProject = async (params: unknown): Promise<OpenReply> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The openProject method receives TypeScript's content mapper project fields.
  const { configFileName, options, projectHandle } = params as OpenProject;
  const directory = path.dirname(configFileName);
  const resolved = resolveProject(await anyEngine(), directory);
  const projectFile = projectName(directory, resolved.file);
  const diagnostics = optionDiagnostics(options, projectFile);
  projects.set(projectHandle, { projectFile, session: Session.open(directory), strictParams: resolved.strictParams });
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the TypeScript project response's established field order.
  return { configIdentity: configDigest(resolved, options), watchedFiles: resolved.watched, optionDiagnostics: diagnostics };
};

const reply = (sql: string, text: string, diagnostics: MapperDiagnostic[]): Reply =>
  // oxlint-disable-next-line eslint/sort-keys -- Keep the TypeScript transform response's established field order.
  ({ extension: ".ts", diagnostics, text, mappings: mapToStatement(text, sql) });

const empty = (): Reply =>
  // oxlint-disable-next-line eslint/sort-keys -- Keep the same response fields even when there is no SQL statement.
  ({ extension: ".ts", diagnostics: [], text: "export {};\n", mappings: [] });

const missing = (sql: string, size: number): Reply => {
  const message = "The content mapper has no project for this file; restart the TypeScript server.";
  const failure = diagnostic(size, message, { code: MISSING_PROJECT_DIAGNOSTIC, length: ONE_BYTE_DIAGNOSTIC, start: FIRST_BYTE_OFFSET });
  return reply(sql, missingProjectText(sql), [failure]);
};

const readLexed = async (session: Session, sql: string): Promise<Lexed | undefined> => {
  try {
    return await session.lex(sql);
  } catch {
    return undefined;
  }
};

const unavailable = (source: ReturnType<typeof declarationSource>, failed: { code: number; message: string }, { names, size }: { names: string[]; size: number }): Reply => {
  const report = diagnostic(size, failed.message, { code: failed.code, length: ONE_BYTE_DIAGNOSTIC, start: FIRST_BYTE_OFFSET });
  const text = declarationText(source, { cardinality: "many", names, paramsType: "unknown", rowType: "unknown" });
  return reply(source.sql, text, [report]);
};

const analyzed = async (sql: string, size: number, project: Project): Promise<Reply> => {
  const session = await project.session;
  const outcome = await session.analyze(sql);
  // A successful direct_url retry can change the session's project.
  const { dialect } = session.project;
  const lexed = await readLexed(session, sql);
  const source = declarationSource(sql, dialect);
  if (!outcome.ok) {return unavailable(source, outcome, { names: lexed?.params ?? [], size });}
  const types = moduleTypes(sql, outcome.analysis, dialect, lexed, project.strictParams, project.projectFile);
  const diagnostics = types.diagnostics.map((item) => diagnostic(size, item.message, item));
  return reply(sql, declarationText(source, {
    cardinality: types.cardinality,
    compiled: outcome.analysis.rewritten.sql.trimEnd(),
    names: types.names,
    paramsType: types.params,
    queryError: types.queryError,
    rowType: types.row,
  }), diagnostics);
};

const transform = async (params: unknown): Promise<Reply> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript owns this wire request and its transform fields.
  const { content, fileName, projectHandle } = params as TransformRequest;
  const size = Buffer.byteLength(content);
  if (PROJECT_FILES.some((name) => fileName.endsWith(name))) {return empty();}
  const project = projects.get(projectHandle);
  return matchesUndefined(project) ? missing(content, size) : analyzed(content, size, project);
};

const closeProject = async (params: unknown): Promise<object> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript supplies the handle of the project being closed.
  const { projectHandle } = params as ProjectHandle;
  const project = projects.get(projectHandle);
  projects.delete(projectHandle);
  if (!matchesUndefined(project)) {
    const session = await project.session;
    await session.close();
  }
  return {};
};

/**
 * Return the TypeScript methods the native mapper serves over stdio.
 * @returns {MapperHandlers} The content mapper's method table.
 */
export const mapperHandlers = function mapperHandlers(): MapperHandlers {
  // oxlint-disable-next-line eslint/sort-keys -- Preserve enumeration of the content mapper's public method table.
  return { initialize, openProject, transform, closeProject };
};

/** Answer the content mapper protocol on the current process's stdin and stdout. */
export const serveMapper = function serveMapper(): void {
  serve(mapperHandlers());
};
