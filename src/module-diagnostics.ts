import type { Analysis, Dialect, Lexed } from "./engine-core.ts";
import { isEmptyArray, isEmptyString, matchesUndefined } from "./native-predicates.ts";

/** SQL file diagnostic positions are UTF-8 byte offsets. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep the exported diagnostic structurally assignable.
export type FileDiagnostic = { message: string; start: number; length: number; code: number };

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const FIRST_UTF8_BYTE = 0;
const SINGLE_BYTE_RANGE = 1;
const UNTYPED_PARAMETER = 12;
const INVALID_STATEMENT = 6;

interface Placeholder { start: number; end: number; name: string | undefined }
interface StatementParameters { names: string[]; placeholders: Placeholder[] }

export const statementParameters = (
  analysis: Analysis, dialect: Dialect, lexed: Pick<Lexed, "params" | "placeholders"> | undefined,
): StatementParameters => {
  if (dialect !== "mysql") {return { names: lexed?.params ?? [], placeholders: lexed?.placeholders ?? [] };}
  // The analysis uses the MySQL session's sql_mode, which the independent lexer does not know.
  const names = analysis.params.map((parameter) => parameter.name);
  const { order, spans } = analysis.rewritten;
  return { names, placeholders: spans.map(([start, end], index) => ({ end, name: order[index], start })) };
};

/**
 * Clamp a byte range to the checked SQL file before returning it to TypeScript.
 * @param {number} start - The UTF-8 byte offset.
 * @param {number} length - The range length in bytes.
 * @param {number} size - The file size in bytes.
 * @returns {{ start: number, length: number }} The range inside the file.
 */
export const withinFile = function withinFile(start: number, length: number, size: number): { start: number; length: number } {
  const from = Math.max(FIRST_UTF8_BYTE, Math.min(start, size));
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the exported content mapper range's enumeration order.
  return { start: from, length: Math.max(FIRST_UTF8_BYTE, Math.min(length, size - from)) };
};

const copyDiagnostic = ({ message, start, length, code }: FileDiagnostic): FileDiagnostic =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve each public content mapper diagnostic's JSON order.
  ({ message, start, length, code });

interface DiagnosticInput { projectFile: string; sql: string; strictParams: boolean }
interface UnknownContext { bytes: Uint8Array; placeholders: Placeholder[]; projectFile: string }

const untypedParameter = (name: string, { bytes, placeholders, projectFile }: UnknownContext): FileDiagnostic => {
  const at = placeholders.find((placeholder) => placeholder.name === name);
  const span = matchesUndefined(at) ? `:${name}` : fromUtf8.decode(bytes.subarray(at.start, at.end));
  // MySQL's span can include a cast the engine rewrote past the parameter name.
  const written = span.replace(/\s*::[\s\S]*$/u, "");
  const length = matchesUndefined(at) ? SINGLE_BYTE_RANGE : utf8.encode(written).length;
  const message = `Nothing in the statement gives the parameter ${written} a type; cast it, as in ${written}::text, or set strict_params: false in ${projectFile}.`;
  // oxlint-disable-next-line eslint/sort-keys -- Preserve each public content mapper diagnostic's JSON order.
  return { message, start: at?.start ?? FIRST_UTF8_BYTE, length, code: UNTYPED_PARAMETER };
};

export const fileDiagnostics = (
  { diagnostics, params }: Analysis, placeholders: Placeholder[], { projectFile, sql, strictParams }: DiagnosticInput,
): FileDiagnostic[] => {
  const copied = diagnostics.map((diagnostic) => copyDiagnostic(diagnostic));
  // An existing engine diagnostic explains the failed analysis first.
  if (!strictParams || !isEmptyArray(diagnostics)) {return copied;}
  const context = { bytes: utf8.encode(sql), placeholders, projectFile };
  const untyped = Iterator.from(params).filter(({ type }) => type.kind === "unknown").map(({ name }) => untypedParameter(name, context));
  return [...copied, ...untyped];
};

export const invalidAnalysis = (analysis: Analysis, dialect: Dialect): boolean =>
  analysis.diagnostics.some(({ code }) => code === INVALID_STATEMENT) || (dialect === "postgres" && isEmptyString(analysis.kind));
