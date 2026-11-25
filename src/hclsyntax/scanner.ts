/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Port of hclsyntax/scan_tokens.go and token.go at HCL revision
// 00057cf06d7b38a3f89e6e54d622eee98322b314. Generated action numbers are retained.
import type { Token, Pos, Diagnostic } from './types.ts';
import * as tables from './scanner-tables.ts';
import { checkInvalidTokens } from './scanner-diagnostics.ts';
import * as stringTables from './string-literal-tables.ts';
import { RagelState, runRagel } from './scanner-ragel.ts';
import { scannerActions } from './scanner-actions.ts';
import { tokenCollector } from './scanner-position.ts';
// oxlint-disable-next-line import/no-relative-parent-imports -- Reuse the package's native guards without loading Effect.
import { isEmptyArray, matchesString } from "../native-predicates.ts";

export { checkInvalidTokens } from './scanner-diagnostics.ts';
export { graphemeClusters } from './scanner-grapheme.ts';

type ScanMode = "normal" | "template" | "ident";

const MODE_START: Record<ScanMode, number> = {
  ident: tables.en_identOnly,
  normal: tables.en_main,
  template: tables.en_bareTemplate,
};

const utf8Bom = new TextEncoder().encode("\uFEFF");
const noBom = 0;
const sourceStart = 0;
const firstLine = 1;
const firstColumn = 1;
const identifierTokenCount = 2;
const firstToken = 0;
const secondToken = 1;

const runScanner = (data: Uint8Array, mode: ScanMode, emit: (type: string, from: number, to: number) => void): void => {
  const state = new RagelState(MODE_START[mode]);
  const { run, stack } = scannerActions(state, data, emit);
  runRagel(data, tables, state, run);
  if (state.cs < tables.first_final) {
    emit(mode === "template" && isEmptyArray(stack) ? "TokenStringLit" : "TokenInvalid", state.ts, data.length);
  }
  emit("TokenEOF", data.length, data.length);
};

// Accumulate grapheme columns per token, as the upstream token scanner does.
const scanTokens = (input: Uint8Array, source: { filename: string; start: Pos }, mode: ScanMode): Token[] => {
  const { filename, start } = source;
  const bom = utf8Bom.every((byte, index) => input[index] === byte) ? utf8Bom.length : noBom;
  const data = input.subarray(bom);
  const startByte = start.byte + bom;
  const { emit, tokens } = tokenCollector(data, { filename, start, startByte });
  runScanner(data, mode, emit);
  return tokens;
};

// oxlint-disable-next-line eslint/sort-keys -- Match the original public default source position order.
const beginningOfFile = { line: firstLine, column: firstColumn, byte: sourceStart };

export const lexConfig = function lexConfig(input: Uint8Array, filename: string, start: Pos = beginningOfFile): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens = scanTokens(input, { filename, start }, 'normal');
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public lexer result order.
  return { tokens, diagnostics: checkInvalidTokens(tokens) };
};
// oxlint-disable-next-line rules/no-local-export-list -- Both public HCL lexer names refer to the same function.
export { lexConfig as lexExpression };
export const lexTemplate = function lexTemplate(input: Uint8Array, filename: string, start: Pos = beginningOfFile): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens = scanTokens(input, { filename, start }, 'template');
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public lexer result order.
  return { tokens, diagnostics: checkInvalidTokens(tokens) };
};
const beginningOfIdentifier = { byte: sourceStart, column: sourceStart, line: sourceStart };
const identifierSource = { filename: "", start: beginningOfIdentifier };

export const validIdentifier = function validIdentifier(value: string | Uint8Array): boolean {
  const tokens = scanTokens(matchesString(value) ? new TextEncoder().encode(value) : value, identifierSource, "ident");
  return tokens.length === identifierTokenCount && tokens[firstToken]?.type === "TokenIdent" && tokens[secondToken]?.type === "TokenEOF";
};

// The action operands are shared with the generated string-literal transition tables.
const BEGIN_SPAN_ACTION = 0;
const FINISH_SPAN_ACTION = 1;

// Exact escape/literal segmentation from scan_string_lit.go.
export const scanStringLit = function scanStringLit(data: Uint8Array, quoted: boolean): Uint8Array[] {
  const state = new RagelState(quoted ? stringTables.en_quoted : stringTables.en_unquoted);
  const spans: Uint8Array[] = [];
  runRagel(data, stringTables, state, (id) => {
    switch (id) {
      case BEGIN_SPAN_ACTION: {
        if (state.te < state.p) {spans.push(data.subarray(state.te, state.p));}
        state.ts = state.p;
        break;
      }
      case FINISH_SPAN_ACTION: {
        state.te = state.p;
        spans.push(data.subarray(state.ts, state.te));
        break;
      }
      default: {
        // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native error if generated string-literal actions are out of sync.
        throw new Error(`Unknown string literal scanner action ${id}`);
      }
    }
  });
  if (state.te < state.p) {spans.push(data.subarray(state.te, state.p));}
  if (state.cs < stringTables.first_final) {spans.push(data.subarray(state.p));}
  return spans;
};
