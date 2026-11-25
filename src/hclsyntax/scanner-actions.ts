/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Cursor and state effects translated from hclsyntax/scan_tokens.go.
import { action, interpolations, literalActions, midlineActions, registerActions, rewindActions } from "./scanner-action-data.ts";
import type { EndMode } from "./scanner-action-data.ts";
import type { RagelState } from "./scanner-ragel.ts";
import * as tables from "./scanner-tables.ts";
import { matchesHeredocMarker } from "./scanner-heredoc-bytes.ts";
// oxlint-disable-next-line import/no-relative-parent-imports -- Reuse the native sentinel guard in the optional-dependency-free lexer.
import { matchesUndefined } from "../native-predicates.ts";

interface Heredoc {
  marker: Uint8Array;
  startOfLine: boolean;
}

type EmitToken = (type: string, from: number, to: number) => void;

// oxlint-disable-next-line typescript/no-invalid-void-type -- Ragel actions either jump to _again or complete with no return.
type Action = (scanner: Scanner) => boolean | void;

interface Scanner {
  braces: number;
  data: Uint8Array;
  emit: EmitToken;
  heredocs: Heredoc[];
  returnBraces: number[];
  stack: number[];
  state: RagelState;
}

interface ScanActions {
  run: (id: number) => ReturnType<Action>;
  stack: number[];
}

const START = 0;
const STEP = 1;
const LAST = -1;
const CARRIAGE_RETURN = 13;
const DASH = 45;
const MARKER_START = 2;
const NO_JUMP = undefined;

// oxlint-disable-next-line eslint/sort-keys -- Keep the fixed single-byte token dictionary ordered by numeric byte value.
const selfTokens: Readonly<Record<number, string>> = {
  10: "TokenNewline", 33: "TokenBang", 37: "TokenPercent", 38: "TokenBitwiseAnd",
  39: "TokenApostrophe", 40: "TokenOParen", 41: "TokenCParen", 42: "TokenStar",
  43: "TokenPlus", 44: "TokenComma", 45: "TokenMinus", 46: "TokenDot", 47: "TokenSlash",
  58: "TokenColon", 59: "TokenSemicolon", 60: "TokenLessThan", 61: "TokenEqual",
  62: "TokenGreaterThan", 63: "TokenQuestion", 91: "TokenOBrack", 93: "TokenCBrack",
  94: "TokenBitwiseXor", 96: "TokenBacktick", 123: "TokenOBrace", 124: "TokenBitwiseOr",
  125: "TokenCBrace", 126: "TokenBitwiseNot",
};

const emit = (scanner: Scanner, type: string): void => {
  scanner.emit(type, scanner.state.ts, scanner.state.te);
};

const finishToken = (state: RagelState, mode: EndMode): void => {
  if (mode === "next") {state.te = state.p + STEP;}
  else if (mode === "hold") {
    state.te = state.p;
    state.p -= STEP;
  } else {
    state.p = state.te - STEP;
  }
};

const literal = (scanner: Scanner, type: string, mode: EndMode): void => {
  finishToken(scanner.state, mode);
  emit(scanner, type);
};

const selfToken = (scanner: Scanner, mode: EndMode): void => {
  const { data, state } = scanner;
  finishToken(state, mode);
  if (state.te - state.ts !== STEP) {
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the generated scanner's native invariant error without importing Effect.
    throw new Error("selfToken only works for single-character tokens");
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The scanner state selected exactly one source byte above.
  const type = selfTokens[data[state.ts]!];
  if (matchesUndefined(type)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the generated scanner's native invariant error without importing Effect.
    throw new Error("Unrecognized scanner self token");
  }
  emit(scanner, type);
};

const enter = ({ stack, state }: Scanner, position: number): true => {
  stack.push(state.cs);
  state.cs = position;
  return true;
};

const leave = ({ stack, state }: Scanner): true => {
  const parent = stack.pop();
  if (matchesUndefined(parent)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the generated scanner's native invariant error without importing Effect.
    throw new Error("HCL scanner return stack underflow");
  }
  state.cs = parent;
  return true;
};

const activeHeredoc = ({ heredocs }: Scanner): Heredoc =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Ragel reaches heredoc-only actions after the opener pushes its delimiter.
  heredocs.at(LAST)!;

const interpolation = (scanner: Scanner, type: string, mode: "next" | "hold"): true => {
  literal(scanner, type, mode);
  scanner.braces += STEP;
  scanner.returnBraces.push(scanner.braces);
  if (scanner.heredocs.length) {activeHeredoc(scanner).startOfLine = false;}
  return enter(scanner, tables.en_main);
};

const midline = (scanner: Scanner, mode: "hold" | "rewind"): void => {
  finishToken(scanner.state, mode);
  activeHeredoc(scanner).startOfLine = false;
  emit(scanner, "TokenStringLit");
};

const emitHeredocNewline = (scanner: Scanner, start: number, end: number): void => {
  scanner.state.ts = start;
  scanner.state.te = end;
  emit(scanner, "TokenNewline");
};

const closeHeredoc = (scanner: Scanner): true => {
  const { data, heredocs, state } = scanner;
  const newlineEnd = state.te;
  const lfStart = newlineEnd - STEP;
  const newlineStart = data[lfStart - STEP] === CARRIAGE_RETURN ? lfStart - STEP : lfStart;
  state.te = newlineStart;
  emit(scanner, "TokenCHeredoc");
  emitHeredocNewline(scanner, newlineStart, newlineEnd);
  heredocs.pop();
  return leave(scanner);
};

const heredocLine = (scanner: Scanner): true | undefined => {
  const { data, state } = scanner;
  finishToken(state, "next");
  const document = activeHeredoc(scanner);
  if (document.startOfLine && matchesHeredocMarker(data.subarray(state.ts, state.te), document.marker)) {
    return closeHeredoc(scanner);
  }
  document.startOfLine = true;
  emit(scanner, "TokenStringLit");
  return NO_JUMP;
};

const openHeredoc = (scanner: Scanner): true => {
  const { data, heredocs, state } = scanner;
  literal(scanner, "TokenOHeredoc", "next");
  const header = data.subarray(state.ts + MARKER_START, state.te - STEP);
  const delimiter = header[START] === DASH ? header.subarray(STEP) : header;
  const marker = delimiter.at(LAST) === CARRIAGE_RETURN ? delimiter.subarray(START, LAST) : delimiter;
  heredocs.push({ marker, startOfLine: true });
  return enter(scanner, tables.en_heredocTemplate);
};

const openBrace = (scanner: Scanner): void => {
  literal(scanner, "TokenOBrace", "next");
  scanner.braces += STEP;
};

const closeBrace = (scanner: Scanner, type: string): true | undefined => {
  const { returnBraces, state } = scanner;
  finishToken(state, "next");
  const endsInterpolation = returnBraces.at(LAST) === scanner.braces;
  emit(scanner, endsInterpolation ? "TokenTemplateSeqEnd" : type);
  scanner.braces -= STEP;
  if (endsInterpolation) {
    returnBraces.pop();
    return leave(scanner);
  }
  return NO_JUMP;
};

const rewind = (scanner: Scanner, fallback: NonNullable<ReturnType<typeof rewindActions.get>>): true | undefined => {
  const { state } = scanner;
  if (fallback.stopAtZero && state.act === START) {
    state.cs = START;
    return true;
  }
  if (!matchesUndefined(fallback.midline) && state.act === fallback.midline) {
    midline(scanner, "rewind");
  } else {
    const token = fallback.matches.get(state.act);
    if (!matchesUndefined(token)) {literal(scanner, token, "rewind");}
  }
  return NO_JUMP;
};

const controls = new Map<number, Action>([
  [action.holdByte, ({ state }) => {state.p -= STEP;}],
  [action.resetStart, ({ state }) => {state.ts = START;}],
  [action.startToken, ({ state }) => {state.ts = state.p;}],
  [action.endToken, ({ state }) => {state.te = state.p + STEP;}],
  [action.closeQuote, (scanner) => {
    literal(scanner, "TokenCQuote", "next");
    return leave(scanner);
  }],
  [action.closeHeredoc, (scanner) => heredocLine(scanner)],
  [action.nextSelfToken, (scanner) => {selfToken(scanner, "next");}],
  [action.openBrace, (scanner) => {openBrace(scanner);}],
  [action.closeBrace, (scanner) => closeBrace(scanner, "TokenCBrace")],
  [action.closeTrimmedBrace, (scanner) => closeBrace(scanner, "TokenTemplateSeqEnd")],
  [action.openQuote, (scanner) => {
    literal(scanner, "TokenOQuote", "next");
    return enter(scanner, tables.en_stringTemplate);
  }],
  [action.openHeredoc, (scanner) => openHeredoc(scanner)],
  [action.skipWhitespace, ({ state }) => {finishToken(state, "hold");}],
  [action.holdSelfToken, (scanner) => {selfToken(scanner, "hold");}],
  [action.rewindSelfToken, (scanner) => {selfToken(scanner, "rewind");}],
]);

const simpleTokenAction = (scanner: Scanner, id: number): boolean => {
  const emitToken = literalActions.get(id);
  if (emitToken) {
    literal(scanner, ...emitToken);
    return true;
  }
  const mode = midlineActions.get(id);
  if (mode) {
    midline(scanner, mode);
    return true;
  }
  return false;
};

const simpleAction = (scanner: Scanner, id: number): boolean => {
  const register = registerActions.get(id);
  if (!matchesUndefined(register)) {
    scanner.state.act = register;
    return true;
  }
  return simpleTokenAction(scanner, id);
};

const complexAction = (scanner: Scanner, id: number): ReturnType<Action> => {
  const fallback = rewindActions.get(id);
  if (fallback) {return rewind(scanner, fallback);}
  const control = controls.get(id);
  if (!control) {
    // oxlint-disable-next-line rules/require-tagged-error -- Keep the native error if the generated action table is out of sync.
    throw new Error(`Unknown HCL scanner action ${id}`);
  }
  return control(scanner);
};

const step = (scanner: Scanner, id: number): ReturnType<Action> => {
  const interp = interpolations.get(id);
  if (interp) {return interpolation(scanner, ...interp);}
  if (simpleAction(scanner, id)) {return NO_JUMP;}
  return complexAction(scanner, id);
};

/**
 * Binds the Ragel token actions to one scanner cursor.
 * @param {RagelState} state - The generated machine's cursor.
 * @param {Uint8Array} data - The source bytes without a BOM.
 * @param {EmitToken} emitToken - Accumulates a source token.
 * @returns {ScanActions} The callback and live return stack.
 */
export const scannerActions = (state: RagelState, data: Uint8Array, emitToken: EmitToken): ScanActions => {
  const scanner: Scanner = { braces: START, data, emit: emitToken, heredocs: [], returnBraces: [], stack: [], state };
  return { run: (id) => step(scanner, id), stack: scanner.stack };
};
