// TypeScript starts this entry point. It answers with the missing-engine diagnostic until the
// Matching engine is installed, then opens the known projects on the real mapper.
import { tooling } from "./engine-package.ts";
import { matchesUndefined } from "./native-predicates.ts";
import { CONTENT_MAPPER_POSITION_ENCODING, serve } from "./rpc.ts";

type Handler = (params: unknown) => unknown;
type Handlers = Record<string, Handler>;
interface MapperState { handlers?: Handlers; message: string }
interface Handle { projectHandle: string }
interface Source { content: string; fileName: string }

const NO_ENGINE_TEXT = `import type { Query } from "@totto2727/reylo";\nexport type Params = unknown;\nexport type Row = unknown;\nexport type QueryError = import("@totto2727/reylo").QueryError;\ndeclare const query: Query<unknown, unknown, "many", "postgres">;\nexport default query;\n`;
const PROTOCOL_VERSION = 1;
const START_OF_SOURCE = 0;
const MAXIMUM_DIAGNOSTIC_LENGTH = 1;
const MISSING_ENGINE = 11;

const state: MapperState = { message: "" };
const opened = new Map<string, unknown>();

const replayOpened = async (handlers: Handlers): Promise<void> => {
  // oxlint-disable-next-line rules/no-for-loops -- Replay TypeScript's open requests serially in their original order.
  for (const params of opened.values()) {
    // oxlint-disable-next-line eslint/no-await-in-loop, typescript/no-non-null-assertion -- A compatible mapper provides openProject, and this replay preserves registration order.
    await handlers.openProject!(params);
  }
};

const load = async (): Promise<Handlers | undefined> => {
  if (!matchesUndefined(state.handlers)) {return state.handlers;}
  try {
    const engine = await tooling();
    const handlers = engine.mapperHandlers();
    await replayOpened(handlers);
    state.handlers = handlers;
    return handlers;
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Retain the native loader's diagnostic for virtual SQL modules.
    state.message = (error as Error).message;
    return undefined;
  }
};

const handle = (method: string, fallback: Handler): Handler => async (params) => {
  const handlers = await load();
  if (matchesUndefined(handlers)) {return fallback(params);}
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Both the fallback and compatible engine expose the same four TypeScript methods.
  return handlers[method]!(params);
};

const initialize = (params: unknown): object => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Negotiate the native TypeScript protocol version when the host supplies it.
  const protocolVersion = (params as { protocolVersion?: number } | undefined)?.protocolVersion ?? PROTOCOL_VERSION;
  // oxlint-disable-next-line eslint/sort-keys -- Keep the TypeScript handshake in its existing wire order.
  return { protocolVersion, positionEncoding: CONTENT_MAPPER_POSITION_ENCODING, diagnosticSource: "reylo" };
};

const openProject = (params: unknown): object => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Remember the handle TypeScript assigns to this project.
  const { projectHandle } = params as Handle;
  opened.set(projectHandle, params);
  // oxlint-disable-next-line eslint/sort-keys -- Keep the TypeScript project reply's existing wire order.
  return { configIdentity: state.message, watchedFiles: [], optionDiagnostics: [] };
};

const settingsFile = (filename: string): boolean => filename.endsWith(".reylo.yaml") || filename.endsWith(".reylo.yml");

const transform = (params: unknown): object => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript supplies the virtual SQL source fields.
  const { content, fileName } = params as Source;
  if (settingsFile(fileName)) {
    // oxlint-disable-next-line eslint/sort-keys -- Keep the empty config module's transform wire order.
    return { extension: ".ts", diagnostics: [], text: "export {};\n", mappings: [] };
  }
  const length = Math.min(MAXIMUM_DIAGNOSTIC_LENGTH, Buffer.byteLength(content));
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the native TypeScript diagnostic order.
  const diagnostic = { messageText: state.message, start: START_OF_SOURCE, length, code: MISSING_ENGINE };
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the virtual SQL module's transform wire order.
  return { extension: ".ts", diagnostics: [diagnostic], text: NO_ENGINE_TEXT, mappings: [] };
};

const closeProject = (params: unknown): object => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript closes the project using its own handle.
  const { projectHandle } = params as Handle;
  opened.delete(projectHandle);
  return {};
};

// oxlint-disable-next-line eslint/sort-keys -- Keep the original content mapper server method order.
serve({
  initialize: handle("initialize", initialize),
  openProject: handle("openProject", openProject),
  transform: handle("transform", transform),
  closeProject: handle("closeProject", closeProject),
});
