/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Template interpolation recovery translated from hclsyntax/parser.go.
import { error } from "./parser-values.ts";
import { rangeBetween as between } from "./types.ts";
import type { Diagnostic, Expression, Range, Token } from "./types.ts";

export interface TemplateHost {
  diagnostics: Diagnostic[];
  nextRange: () => Range;
  parseExpression: () => Expression;
  peek: () => Token;
  popIncludeNewlines: () => void;
  pushIncludeNewlines: (include: boolean) => void;
  read: () => Token;
  recover: (end: string) => Token;
  recovery: boolean;
}

export interface TemplateSequence {
  end: string;
  host: TemplateHost;
  startRange: Range;
  trimFollowing: boolean;
}

const TRIM_CLOSE_LENGTH = 2;
const CLOSE_TRIM_BYTE = 0;
export const TILDE_BYTE = 126;
export const SEQUENCE_END = "TokenTemplateSeqEnd";
const UNCLOSED_INTERPOLATION = "Unclosed template interpolation sequence";
const EXTRA_INTERPOLATION = "Extra characters after interpolation expression";

/**
 * Consumes a template sequence terminator, retaining the first token's range for the AST.
 * @param {TemplateSequence} state - The template scanner state.
 * @param {(token: Token) => void} report - Reports an invalid terminator before recovery.
 * @returns {Token} The closing token as originally observed.
 */
export const sequenceEnd = (state: TemplateSequence, report: (token: Token) => void): Token => {
  const { host } = state;
  const close = host.peek();
  if (close.type === SEQUENCE_END) {
    host.read();
    state.trimFollowing = close.bytes.length === TRIM_CLOSE_LENGTH && close.bytes[CLOSE_TRIM_BYTE] === TILDE_BYTE;
  } else {
    if (!host.recovery) {report(close);}
    host.recover(SEQUENCE_END);
  }
  return close;
};

const unclosedInterpolation = (type: "file" | "quoted template", start: Range): Diagnostic =>
  error(UNCLOSED_INTERPOLATION, `There is no closing brace for this interpolation sequence before the end of the ${type}. This might be caused by incorrect nesting inside the given expression.`, start);

const interpolationDetail = (type: string): string =>
  type === "TokenColon"
    ? 'Template interpolation doesn\'t expect a colon at this location. Did you intend this to be a literal sequence to be processed as part of another language? If so, you can escape it by starting with "$${" instead of just "${".'
    : 'Expected a closing brace to end the interpolation expression, but found extra characters.\n\nThis can happen when you include interpolation syntax for another language, such as shell scripting, but forget to escape the interpolation start token. If this is an embedded sequence for another language, escape it by starting with "$${" instead of just "${".';

const interpolationDiagnostic = ({ end, startRange }: TemplateSequence, close: Token): Diagnostic => {
  const { range, type } = close;
  if (type === "TokenEOF") {return unclosedInterpolation("file", startRange);}
  if (end === "TokenCQuote" && (type === "TokenCQuote" || type === "TokenOQuote")) {
    return unclosedInterpolation("quoted template", startRange);
  }
  return error(EXTRA_INTERPOLATION, interpolationDetail(type), range, between(startRange, range));
};


/**
 * Reads the value and source range of a template interpolation.
 * @param {TemplateSequence} state - The template scanner state.
 * @param {Token} opening - The interpolation opener.
 * @returns {{ expression: Expression; range: Range }} The parsed interpolation.
 */
export const readInterpolation = (state: TemplateSequence, opening: Token): { expression: Expression; range: Range } => {
  const { host } = state;
  host.pushIncludeNewlines(false);
  const expression = host.parseExpression();
  const close = sequenceEnd(state, (token) => {
    host.diagnostics.push(interpolationDiagnostic(state, token));
  });
  host.popIncludeNewlines();
  return { expression, range: between(opening.range, close.range) };
};
