/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Template token post-processing translated from hclsyntax/parser_template.go.
import { graphemeClusters } from "./scanner.ts";
import { trimLeadingWhitespace } from "./whitespace.ts";
import type { Expression, Range } from "./types.ts";

export type TemplateToken =
  | { kind: 'literal'; value: string; range: Range }
  | { kind: 'interpolation'; expression: Expression; range: Range }
  | { kind: 'if'; condition: Expression; range: Range }
  | { kind: 'for'; keyVar: string; valueVar: string; collection: Expression; range: Range }
  | { kind: 'else' | 'endif' | 'endfor' | 'end'; range: Range };
export interface TemplateParts { tokens: TemplateToken[]; range: Range }


type LiteralToken = Extract<TemplateToken, { kind: "literal" }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const START = 0;
const STEP = 1;

interface Indentation {
  adjust: LiteralToken[];
  minSpaces: number;
  newline: boolean;
}

const nextIndent = (token: TemplateToken, adjust: LiteralToken[]): number => {
  if (token.kind !== "literal") {return START;}
  const trimmed = trimLeadingWhitespace(token.value);
  if (trimmed.length === START && token.value.endsWith("\n")) {return Number.MAX_SAFE_INTEGER;}
  const prefix = token.value.slice(START, token.value.length - trimmed.length);
  const spaces = graphemeClusters(encoder.encode(prefix)).length;
  adjust.push(token);
  return spaces;
};

const indent = (tokens: TemplateToken[]): Indentation => {
  const state: Indentation = { adjust: [], minSpaces: Number.MAX_SAFE_INTEGER, newline: true };
  // oxlint-disable-next-line rules/no-for-loops -- The parser's end marker stops the indentation scan when it follows a newline.
  for (const token of tokens) {
    if (state.newline) {
      state.newline = false;
      if (token.kind === "end") {break;}
      state.minSpaces = Math.min(state.minSpaces, nextIndent(token, state.adjust));
    }
    if (token.kind === "literal" && token.value.endsWith("\n")) {state.newline = true;}
  }
  return state;
};

const trimToken = (token: LiteralToken, spaces: number): void => {
  const bytes = encoder.encode(token.value);
  const clusters = graphemeClusters(bytes);
  const byteCount = Iterator.from(clusters).take(spaces).reduce((count, cluster) => count + cluster.length, START);
  token.value = decoder.decode(bytes.subarray(byteCount));
  token.range.start.column += spaces;
  token.range.start.byte += byteCount;
};

/**
 * Removes the common indentation from heredoc literal pieces.
 * @param {TemplateParts} parts - The parsed tokens and their source range.
 */
export const flushHeredocTemplateParts = ({ tokens }: TemplateParts): void => {
  const { adjust, minSpaces } = indent(tokens);
  Iterator.from(adjust).forEach((token) => {trimToken(token, minSpaces);});
};

/**
 * Merges adjacent literal pieces and keeps the complete source span.
 * @param {TemplateParts} parts - The parsed tokens and their source range.
 */
export const meldConsecutiveStringLiterals = ({ tokens }: TemplateParts): void => {
  const cursor = { index: STEP };
  while (cursor.index < tokens.length) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A cursor within the token array always has a current token and a predecessor.
    const [previous, current] = [tokens[cursor.index - STEP]!, tokens[cursor.index]!];
    if (previous.kind === "literal" && current.kind === "literal") {
      previous.value += current.value;
      previous.range.end = { ...current.range.end };
      tokens.splice(cursor.index, STEP);
    } else {
      cursor.index += STEP;
    }
  }
};
