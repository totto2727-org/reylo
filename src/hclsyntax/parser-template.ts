/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Template control parsing translated from hclsyntax/parser_template.go.
import type { TemplateToken } from "./parser-template-tokens.ts";
import { dynamic, error, literal } from "./parser-values.ts";
import { emptyRangeAt, rangeBetween as between, rangeString } from "./types.ts";
import type { Diagnostic, Expression, ForExpression, Range } from "./types.ts";

type IfToken = Extract<TemplateToken, { kind: "if" }>;
type ForToken = Extract<TemplateToken, { kind: "for" }>;

const FIRST_PART = 0;
const TOKEN_STEP = 1;
const DIRECTIVES = new Set<TemplateToken["kind"]>(["else", "endif", "endfor", "end"]);
const UNBALANCED = "The control directives within this template are unbalanced.";
// oxlint-disable-next-line unicorn/no-null -- These optional parts are absent in the serialized HCL for-expression.
const ABSENT_CLAUSE = null;

const branch = (expressions: Expression[], defaultRange: Range): Expression => {
  if (!expressions.length) {expressions.push(literal("", defaultRange));}
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Every branch has at least its empty literal before reading the endpoints.
  const range = between(expressions[FIRST_PART]!.range, expressions.at(-TOKEN_STEP)!.range);
  return { kind: "template", parts: expressions, range };
};

const ifExpression = (open: IfToken, end: Range, clauses: { falseParts: Expression[]; trueParts: Expression[] }): Expression => {
  const trueResult = branch(clauses.trueParts, emptyRangeAt(open.range));
  const falseResult = branch(clauses.falseParts, emptyRangeAt(end, "start"));
  // oxlint-disable-next-line eslint/sort-keys -- Keep the existing conditional AST order.
  return { kind: "conditional", condition: open.condition, trueResult, falseResult, range: between(open.range, end) };
};

const forExpression = (open: ForToken, end: Range, expressions: Expression[]): Expression => {
  const value = branch(expressions, emptyRangeAt(open.range));
  // oxlint-disable-next-line eslint/sort-keys -- Keep the existing template for-expression AST order.
  const tuple: ForExpression = {
    kind: "for", keyVar: open.keyVar, valueVar: open.valueVar, collection: open.collection,
    key: ABSENT_CLAUSE, value, condition: ABSENT_CLAUSE, group: false, range: between(open.range, end),
    openRange: open.range, closeRange: end,
  };
  // oxlint-disable-next-line eslint/sort-keys -- Keep the existing template join AST order.
  return { kind: "templateJoin", tuple, range: tuple.range };
};

export class TemplateParser {
  private pos = FIRST_PART;
  private tokens: TemplateToken[];
  private diagnostics: Diagnostic[];

  public constructor(tokens: TemplateToken[], diagnostics: Diagnostic[]) {
    this.tokens = tokens;
    this.diagnostics = diagnostics;
  }

  private peek(): TemplateToken {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Template scanning guarantees a final end marker, which read never advances past.
    return this.tokens[this.pos]!;
  }

  private read(): TemplateToken {
    const token = this.peek();
    if (token.kind !== "end") {this.pos += TOKEN_STEP;}
    return token;
  }

  public parseRoot(): Expression[] {
    const expressions: Expression[] = [];
    while (this.peek().kind !== "end") {expressions.push(this.parseExpr());}
    return expressions;
  }

  private untilDirective(): Expression[] {
    const expressions: Expression[] = [];
    while (!DIRECTIVES.has(this.peek().kind)) {expressions.push(this.parseExpr());}
    return expressions;
  }

  private unexpected(summary: string, detail: string, range: Range): Expression {
    this.diagnostics.push(error(summary, detail, range));
    return dynamic(range);
  }

  private parseExpr(): Expression {
    const token = this.peek();
    if (token.kind === "if" || token.kind === "for") {
      return token.kind === "if" ? this.parseIf() : this.parseFor();
    }
    this.read();
    if (token.kind === "literal" || token.kind === "interpolation") {
      return token.kind === "literal" ? literal(token.value, token.range) : token.expression;
    }
    const summary = token.kind === "end" ? "Unexpected end of template" : `Unexpected ${token.kind} directive`;
    return this.unexpected(summary, UNBALANCED, token.range);
  }

  private finishIf(open: IfToken, trueParts: Expression[], falseParts: Expression[]): Expression {
    const end = this.read();
    if (end.kind === "endif") {return ifExpression(open, end.range, { falseParts, trueParts });}
    return this.badIfEnd(open, end.kind, end.range);
  }

  private badIfEnd(open: IfToken, kind: TemplateToken["kind"], range: Range): Expression {
    if (kind === "end") {
      return this.unexpected("Unexpected end of template", `The if directive at ${rangeString(open.range)} is missing its corresponding endif directive.`, range);
    }
    if (kind === "else") {
      return this.unexpected("Unexpected else directive", `Already in the else clause for the if started at ${rangeString(open.range)}.`, range);
    }
    return this.unexpected(`Unexpected ${kind} directive`, `Expecting an endif directive for the if started at ${rangeString(open.range)}.`, range);
  }

  private parseIf(): Expression {
    const open = this.read();
    if (open.kind !== "if") {
      // oxlint-disable-next-line rules/require-tagged-error -- An internal parser invariant has a native Error and requires no Effect runtime.
      throw new Error("parseIf called with peeker not pointing at if token");
    }
    const trueParts = this.untilDirective();
    if (this.peek().kind === "else") {
      this.read();
      return this.finishIf(open, trueParts, this.untilDirective());
    }
    return this.finishIf(open, trueParts, []);
  }

  private badForEnd(open: ForToken, kind: TemplateToken["kind"], range: Range): Expression {
    if (kind === "end") {
      return this.unexpected("Unexpected end of template", `The for directive at ${rangeString(open.range)} is missing its corresponding endfor directive.`, range);
    }
    if (kind === "else") {
      return this.unexpected("Unexpected else directive", "An else clause is not expected for a for directive.", range);
    }
    return this.unexpected(`Unexpected ${kind} directive`, `Expecting an endfor directive corresponding to the for directive at ${rangeString(open.range)}.`, range);
  }

  private parseFor(): Expression {
    const open = this.read();
    if (open.kind !== "for") {
      // oxlint-disable-next-line rules/require-tagged-error -- An internal parser invariant has a native Error and requires no Effect runtime.
      throw new Error("parseFor called with peeker not pointing at for token");
    }
    const expressions = this.untilDirective();
    const end = this.read();
    if (end.kind === "endfor") {return forExpression(open, end.range, expressions);}
    return this.badForEnd(open, end.kind, end.range);
  }
}
