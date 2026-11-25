/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Literal and action-register operands from HCL's generated Ragel action table.
export type EndMode = "next" | "hold" | "rewind";

// These integer keys and operand values are referenced by the generated transition tables.
/* oxlint-disable eslint/no-magic-numbers -- Preserve the numeric Ragel action and register operands from the generated machine. */
export const literalActions = new Map<number, Readonly<[type: string, end: EndMode]>>([
  [10, ["TokenQuotedLit", "next"]],
  [11, ["TokenBadUTF8", "next"]],
  [14, ["TokenQuotedLit", "hold"]],
  [15, ["TokenQuotedNewline", "hold"]],
  [16, ["TokenInvalid", "hold"]],
  [17, ["TokenBadUTF8", "hold"]],
  [18, ["TokenQuotedLit", "rewind"]],
  [19, ["TokenBadUTF8", "rewind"]],
  [26, ["TokenBadUTF8", "next"]],
  [30, ["TokenBadUTF8", "hold"]],
  [37, ["TokenStringLit", "next"]],
  [38, ["TokenBadUTF8", "next"]],
  [41, ["TokenStringLit", "hold"]],
  [42, ["TokenBadUTF8", "hold"]],
  [43, ["TokenStringLit", "rewind"]],
  [47, ["TokenBadUTF8", "next"]],
  [48, ["TokenInvalid", "next"]],
  [49, ["TokenIdent", "hold"]],
  [50, ["TokenBadUTF8", "hold"]],
  [51, ["TokenIdent", "rewind"]],
  [52, ["TokenBadUTF8", "rewind"]],
  [56, ["TokenComment", "next"]],
  [57, ["TokenNewline", "next"]],
  [58, ["TokenEqualOp", "next"]],
  [59, ["TokenNotEqual", "next"]],
  [60, ["TokenGreaterThanEq", "next"]],
  [61, ["TokenLessThanEq", "next"]],
  [62, ["TokenAnd", "next"]],
  [63, ["TokenOr", "next"]],
  [64, ["TokenDoubleColon", "next"]],
  [65, ["TokenEllipsis", "next"]],
  [66, ["TokenFatArrow", "next"]],
  [73, ["TokenBadUTF8", "next"]],
  [74, ["TokenInvalid", "next"]],
  [76, ["TokenNumberLit", "hold"]],
  [77, ["TokenIdent", "hold"]],
  [78, ["TokenComment", "hold"]],
  [80, ["TokenBadUTF8", "hold"]],
  [81, ["TokenInvalid", "hold"]],
  [82, ["TokenNumberLit", "rewind"]],
  [83, ["TokenIdent", "rewind"]],
  [85, ["TokenBadUTF8", "rewind"]],
]);

export const interpolations = new Map<number, Readonly<[type: string, end: "next" | "hold"]>>([
  [7, ["TokenTemplateInterp", "next"]],
  [8, ["TokenTemplateControl", "next"]],
  [12, ["TokenTemplateInterp", "hold"]],
  [13, ["TokenTemplateControl", "hold"]],
  [23, ["TokenTemplateInterp", "next"]],
  [24, ["TokenTemplateControl", "next"]],
  [27, ["TokenTemplateInterp", "hold"]],
  [28, ["TokenTemplateControl", "hold"]],
  [35, ["TokenTemplateInterp", "next"]],
  [36, ["TokenTemplateControl", "next"]],
  [39, ["TokenTemplateInterp", "hold"]],
  [40, ["TokenTemplateControl", "hold"]],
]);

export const registerActions = new Map<number, number>([
  [2, 0],
  [5, 4],
  [6, 6],
  [21, 11],
  [22, 12],
  [33, 15],
  [34, 16],
  [45, 17],
  [46, 18],
  [54, 22],
  [55, 40],
]);

export const midlineActions = new Map<number, "hold" | "rewind">([
  [29, "hold"],
  [31, "rewind"],
]);

export const action = {
  closeBrace: 69,
  closeHeredoc: 25,
  closeQuote: 9,
  closeTrimmedBrace: 70,
  endToken: 4,
  holdByte: 0,
  holdSelfToken: 79,
  nextSelfToken: 67,
  openBrace: 68,
  openHeredoc: 72,
  openQuote: 71,
  resetStart: 1,
  rewindSelfToken: 84,
  skipWhitespace: 75,
  startToken: 3,
};

interface RewindFallback {
  matches: ReadonlyMap<number, string>;
  midline?: number;
  stopAtZero: boolean;
}

export const rewindActions = new Map<number, RewindFallback>([
  [20, { matches: new Map([[4, "TokenQuotedLit"], [6, "TokenInvalid"]]), stopAtZero: false }],
  [32, { matches: new Map([[12, "TokenBadUTF8"]]), midline: 11, stopAtZero: true }],
  [44, { matches: new Map([[15, "TokenStringLit"], [16, "TokenBadUTF8"]]), stopAtZero: true }],
  [53, { matches: new Map([[17, "TokenIdent"], [18, "TokenBadUTF8"]]), stopAtZero: false }],
  [86, { matches: new Map([[22, "TokenIdent"], [40, "TokenBadUTF8"]]), stopAtZero: false }],
]);

/* oxlint-enable eslint/no-magic-numbers */
