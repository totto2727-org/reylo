/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Translated from hclsyntax/parser.go, parser_template.go and public.go at
// Hashicorp/hcl 00057cf06d7b38a3f89e6e54d622eee98322b314.
// The AST is data-only. cty evaluation is outside this port's boundary.
/* oxlint-disable eslint/max-lines -- Keep HCL's recursive grammar on its existing Parser prototype with one Peeker, newline stack, and diagnostic stream. */
import { lexConfig, lexExpression, lexTemplate } from './scanner.ts';
import { Peeker } from './peeker.ts';
import { TemplateParser } from './parser-template.ts';
import { readTemplateParts } from './parser-template-read.ts';
import { dynamic, error, literal } from './parser-values.ts';
import { flushHeredocTemplateParts, meldConsecutiveStringLiterals } from './parser-template-tokens.ts';
import { parseStringLiteralToken } from './string-literal.ts';
import { rangeBetween as between, emptyRangeAt, rangeString, isStringLiteral } from './types.ts';
import type { Anonymous, Attribute, Block, Body, Diagnostic, Expression, Literal, ObjectKey, Pos, Range, Token, TraversalStep } from './types.ts';
// oxlint-disable-next-line import/no-relative-parent-imports -- Reuse the package's native guards without loading Effect.
import { isEmptyString, matchesNumber, matchesString, matchesUndefined } from "../native-predicates.ts";

export * from './types.ts';
export { parseStringLiteralToken } from './string-literal.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const text = (token: Token): string => decoder.decode(token.bytes);
const keyword = (token: Token, word: string): boolean => token.type === 'TokenIdent' && text(token) === word;
// oxlint-disable-next-line eslint/sort-keys -- Keep the bracket pairs grouped by opening and closing grammar tokens.
const pairs: Record<string, string> = { TokenOBrace: 'TokenCBrace', TokenOBrack: 'TokenCBrack', TokenOParen: 'TokenCParen', TokenOQuote: 'TokenCQuote', TokenOHeredoc: 'TokenCHeredoc', TokenCBrace: 'TokenOBrace', TokenCBrack: 'TokenOBrack', TokenCParen: 'TokenOParen', TokenCQuote: 'TokenOQuote', TokenCHeredoc: 'TokenOHeredoc', TokenTemplateInterp: 'TokenTemplateSeqEnd', TokenTemplateControl: 'TokenTemplateSeqEnd', TokenTemplateSeqEnd: 'TokenTemplateInterp' };
const opposite = (type: string): string => pairs[type] ?? 'TokenNil';
const FIRST_PRECEDENCE = 0;
const PRECEDENCE_STEP = 1;
const HEREDOC_INDENT_MARKER_POSITION = 2;
const DASH_BYTE = 45;
const FIRST_EXPRESSION = 0;
const PASSTHROUGH_TOKEN_COUNT = 2;

interface ParsedTemplate {
  expressions: Expression[];
  passthru: boolean;
  range: Range;
}
// oxlint-disable-next-line unicorn/no-null -- HCL's null keyword and absent optional AST clauses use a native null value.
const HCL_NULL = null;

interface ObjectEntry {
  key: ObjectKey;
  value: Expression;
}

interface ForContext {
  closeType: "TokenCBrace" | "TokenCBrack";
  makeObject: boolean;
  open: Token;
}

interface ForVariables {
  keyVar: string;
  valueVar: string;
}

interface ForHead extends ForVariables {
  collection: Expression;
}

interface ForValue {
  key: Expression | null;
  value: Expression;
}

interface ForClause {
  condition: Expression | null;
  ellipsis: Token | undefined;
}

const INVALID_FOR = "Invalid 'for' expression";

interface TraversalState {
  base: Expression;
  diagnosticsStart: number;
  result: Expression;
}

interface SplatTail {
  first: Range;
  last: Range;
  steps: TraversalStep[];
}

const NO_LEGACY_DOT = -1;
const NO_SPLAT_STEP = undefined;
const LEGACY_INDEX_START = 0;
const SKIP_LEGACY_DOT = 1;

const dynamicIndex = (range: Range): TraversalStep =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public dynamic index step fields and their order.
  ({ kind: "index", value: HCL_NULL, dynamic: true, range });

const attributeStep = (dot: Token, attribute: Token): TraversalStep =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public traversal step order.
  ({ kind: "attribute", value: text(attribute), range: between(dot.range, attribute.range) });

interface ParsedExpression {
  expression: Expression;
  failed: boolean;
}

interface FunctionHead {
  nameEnd: Pos;
  nameString: string;
  open: Token;
}

interface FunctionSelector {
  nameRange: Range;
  nameString: string;
  open: Token;
}

interface FunctionEnd {
  close: Token | undefined;
  expandFinal: boolean;
}

interface FunctionArguments extends FunctionEnd {
  args: Expression[];
}

const functionNameRange = (name: Token, end: Pos): Range => {
  const { filename, start } = name.range;
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the source range field order.
  return { filename, start, end };
};

const ZERO_COORDINATE = 0;
// Go's zero Token carries these zero positions when recovery does not find a closer.
const zeroPosition = (): Pos =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the source position order of the public zero range.
  ({ line: ZERO_COORDINATE, column: ZERO_COORDINATE, byte: ZERO_COORDINATE });
const zeroRange = (): Range =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public range's filename, start, end order.
  ({ filename: "", start: zeroPosition(), end: zeroPosition() });

const RECOVERY_START_DEPTH = 0;
const RECOVERY_DEPTH_STEP = 1;
const BODY_OPENERS = new Set([
  "TokenOBrace", "TokenOBrack", "TokenOParen", "TokenOQuote", "TokenOHeredoc", "TokenTemplateInterp", "TokenTemplateControl",
]);
const BODY_CLOSERS = new Set(["TokenCBrace", "TokenCBrack", "TokenCParen", "TokenCQuote", "TokenCHeredoc"]);

interface RecoveryDepth {
  depth: number;
}

interface RecoveryTokens {
  end: string;
  start: string;
}

const matchesRecoveryEnd = (type: string, { end, start }: RecoveryTokens, nesting: RecoveryDepth): boolean => {
  if (type === start) {
    nesting.depth += RECOVERY_DEPTH_STEP;
    return false;
  }
  if (type !== end) {return type === "TokenEOF";}
  if (nesting.depth < RECOVERY_DEPTH_STEP) {return true;}
  nesting.depth -= RECOVERY_DEPTH_STEP;
  return false;
};

const discardOpenersThrough = (open: string[], matches: (type: string | undefined) => boolean): void => {
  while (open.length) {
    if (matches(open.pop())) {return;}
  }
};

const updateBodyRecovery = (open: string[], type: string): void => {
  if (BODY_OPENERS.has(type)) {
    open.push(type);
  } else if (BODY_CLOSERS.has(type)) {
    const opener = opposite(type);
    discardOpenersThrough(open, (candidate) => candidate === opener);
  } else if (type === "TokenTemplateSeqEnd") {
    discardOpenersThrough(open, (candidate) => candidate === "TokenTemplateInterp" || candidate === "TokenTemplateControl");
  }
};

const binaryOps: Record<string, string>[] = [
  { TokenOr: '||' }, { TokenAnd: '&&' }, { TokenEqualOp: '==', TokenNotEqual: '!=' },
  { TokenGreaterThan: '>', TokenGreaterThanEq: '>=', TokenLessThan: '<', TokenLessThanEq: '<=' },
  { TokenMinus: '-', TokenPlus: '+' }, { TokenPercent: '%', TokenSlash: '/', TokenStar: '*' },
];
// oxlint-disable-next-line unicorn/no-null -- HCL attributes can use object-prototype property names.
const NO_ATTRIBUTE_PROTOTYPE = null;
// oxlint-disable-next-line unicorn/no-null -- Missing HCL body items retain the existing parser's null sentinel.
const NO_BODY_ITEM = null;
const BLOCK_STARTS = new Set(["TokenOQuote", "TokenOBrace", "TokenIdent"]);
const MULTILINE_BLOCK_STARTS = new Set(["TokenNewline", "TokenEOF", "TokenCBrace"]);
const BLOCK_LINE_ENDS = new Set(["TokenNewline", "TokenEOF"]);
const LAST_LABEL = -1;
const INVALID_SINGLE_ARGUMENT = "Invalid single-argument block definition";
const UNCLOSED_BLOCK = "There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.";

interface BlockLabels {
  labelRanges: Range[];
  labels: string[];
}

interface BlockHeader extends BlockLabels {
  open?: Token;
}

interface BlockContent {
  body: Body;
  closeRange: Range;
  openRange: Range;
}
const blockAst = (ident: Token, { labelRanges, labels }: BlockLabels, { body, closeRange, openRange }: BlockContent): Block =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the existing block AST field order in both complete and recovered blocks.
  ({
    kind: "block", type: text(ident), labels, body, range: between(ident.range, closeRange),
    typeRange: ident.range, labelRanges, openBraceRange: openRange, closeBraceRange: closeRange,
  });

const EXPECTED_BODY_ITEM = "Argument or block definition required";
const EXPECTED_BODY_DEFINITION = 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.';
const emptyBody = (range: Range, endRange = range): Body => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fresh dictionary has no prototype and holds only parsed attributes.
  const attributes = Object.create(NO_ATTRIBUTE_PROTOTYPE) as Record<string, Attribute>;
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public configuration-body AST key order.
  return { kind: "body", attributes, blocks: [], range, endRange };
};

const relativeTraversal = function relativeTraversal(expression: Expression, step: TraversalStep): Expression {
  if (expression.kind === 'traversal' || expression.kind === 'relativeTraversal') {
    expression.steps.push(step);
    // Preserve the ergonomic index view, with raw AST steps available for all values.
    if (expression.kind === "traversal" && (matchesString(step.value) || matchesNumber(step.value))) {
      expression.parts.push(step.value);
    }
    expression.range = between(expression.range, step.range); return expression;
  }
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public traversal AST key order.
  return { kind: 'relativeTraversal', source: expression, steps: [step], range: between(expression.range, step.range) };
};
const templateExpression = (template: ParsedTemplate, range: Range): Expression => {
  if (template.passthru) {
    // oxlint-disable-next-line eslint/sort-keys, typescript/no-non-null-assertion -- Passthrough templates have one expression in their established AST field order.
    return { kind: "templateWrap", wrapped: template.expressions[FIRST_EXPRESSION]!, range };
  }
  return { kind: "template", parts: template.expressions, range };
};

const literalIndex = ({ value, numberText }: Literal, range: Range): TraversalStep => {
  const spelling = matchesUndefined(numberText) || isEmptyString(numberText) ? {} : { numberText };
  // oxlint-disable-next-line eslint/sort-keys -- Preserve literal index AST fields before optional numeric spelling.
  return { kind: "index", value, range, ...spelling };
};

const indexExpression = (state: TraversalState, { key, open, range }: { key: Expression; open: Token; range: Range }): Expression => {
  if (key.kind === "literal") {return relativeTraversal(state.result, literalIndex(key, range));}
  if (key.kind === "dynamic" && !key.diagnostics) {return relativeTraversal(state.result, dynamicIndex(range));}
  if (isStringLiteral(key)) {
    const part = key.parts[FIRST_EXPRESSION];
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the string index AST field order.
    const step: TraversalStep = part.kind === "literal" ? { kind: "index", value: part.value, range } : dynamicIndex(range);
    return relativeTraversal(state.result, step);
  }
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public computed index expression fields.
  return { kind: "index", collection: state.result, key, range: between(state.base.range, range), openRange: open.range, bracketRange: range };
};

/** Stateful translation of the upstream recursive-descent parser. */
export class Parser extends Peeker {
  public recovery = false;
  // oxlint-disable-next-line rules/no-readonly -- Parser exposes a stable diagnostics list without introducing an Effect runtime dependency.
  public readonly diagnostics: Diagnostic[] = [];
  private errorsSince(index: number): boolean { return this.diagnostics.slice(index).some(diag => diag.severity === 'error') }
  private failedSince(index: number): boolean { return this.recovery && this.errorsSince(index) }
  // oxlint-disable-next-line eslint/max-params -- Keep the HCL diagnostic message and the subject and optional context ranges separate.
  private diag(summary: string, detail: string, subject: Range, context?: Range): void { this.diagnostics.push(error(summary, detail, subject, context)) }

  private includeBodyItem(body: Body): void {
    const item = this.parseBodyItem();
    if (item?.kind === "block") {body.blocks.push(item);}
    if (item?.kind === "attribute") {
      const existing = body.attributes[item.name];
      if (existing) {
        this.diag("Attribute redefined", `The argument ${JSON.stringify(item.name)} was already set at ${rangeString(existing.nameRange)}. Each argument may be set only once.`, item.nameRange);
      } else {
        body.attributes[item.name] = item;
      }
    }
  }

  private reportBadBodyToken(bad: Token, end: string, startRange: Range): void {
    if (this.recovery) {return;}
    if (bad.type === "TokenOQuote") {
      this.diag("Invalid argument name", "Argument names must not be quoted.", bad.range);
    } else if (bad.type !== "TokenEOF") {
      this.diag("Argument or block definition required", "An argument or block definition is required here.", bad.range);
    } else if (end === "TokenCBrace") {
      this.diag("Unclosed configuration block", UNCLOSED_BLOCK, startRange);
    } else {
      this.diag("Unclosed configuration body", "Found end of file before the end of this configuration body.", startRange);
    }
  }

  private recoverBodyEnd(end: string, startRange: Range): Range {
    const bad = this.read();
    this.reportBadBodyToken(bad, end, startRange);
    const endRange = this.prevRange();
    this.recover(end);
    return endRange;
  }

  private readBodyEnd(end: string, startRange: Range, body: Body): Range {
    // oxlint-disable-next-line rules/no-for-loops -- Each iteration advances the parser or returns at the requested closing token.
    for (;;) {
      const next = this.peek();
      if (next.type === end) {
        const endRange = this.nextRange();
        this.read();
        return endRange;
      }
      if (next.type === "TokenNewline") {this.read();}
      else if (next.type === "TokenIdent") {this.includeBodyItem(body);}
      else {return this.recoverBodyEnd(end, startRange);}
    }
  }

  public parseBody(end: string): Body {
    const body = emptyBody(this.prevRange());
    const startRange = this.prevRange();
    const endRange = this.readBodyEnd(end, startRange, body);
    body.range = between(startRange, endRange);
    body.endRange = emptyRangeAt(endRange);
    return body;
  }

  private readBodyIdentifier(): Token | null {
    const ident = this.read();
    if (ident.type === "TokenIdent") {return ident;}
    this.recoverAfterBodyItem();
    this.diag(EXPECTED_BODY_ITEM, "An argument or block definition is required here.", ident.range);
    return NO_BODY_ITEM;
  }

  private rejectBodyDefinition(ident: Token): null {
    this.recoverAfterBodyItem();
    this.diag(EXPECTED_BODY_ITEM, EXPECTED_BODY_DEFINITION, ident.range);
    return NO_BODY_ITEM;
  }

  public parseBodyItem(): Attribute | Block | null {
    const ident = this.readBodyIdentifier();
    if (!ident) {return NO_BODY_ITEM;}
    const next = this.peek();
    if (next.type === "TokenEqual") {return this.finishParsingBodyAttribute(ident, false);}
    if (BLOCK_STARTS.has(next.type)) {return this.finishParsingBodyBlock(ident);}
    return this.rejectBodyDefinition(ident);
  }

  private rejectSingleAttribute(ident: Token, next: Token): null {
    if (!BLOCK_STARTS.has(next.type)) {return this.rejectBodyDefinition(ident);}
    this.recoverAfterBodyItem();
    this.diag("Argument definition required", `A single-line block definition can contain only a single argument. If you meant to define argument ${JSON.stringify(text(ident))}, use an equals sign to assign it a value. To define a nested block, place it on a line of its own within its parent block.`, between(ident.range, next.range));
    return NO_BODY_ITEM;
  }

  private parseSingleAttrBody(): Body | null {
    const ident = this.readBodyIdentifier();
    if (!ident) {return NO_BODY_ITEM;}
    const next = this.peek();
    if (next.type !== "TokenEqual") {return this.rejectSingleAttribute(ident, next);}
    const attribute = this.finishParsingBodyAttribute(ident, true);
    const body = emptyBody(attribute.range, emptyRangeAt(attribute.range));
    body.attributes[text(ident)] = attribute;
    return body;
  }

  private reportAttributeLineEnd(ident: Token, end: Token): void {
    if (this.recovery) {return;}
    const comma = end.type === "TokenComma";
    this.diag(comma ? "Unexpected comma after argument" : "Missing newline after argument", `${comma ? "Argument definitions must be separated by newlines, not commas. " : ""}An argument definition must end with a newline.`, end.range, between(ident.range, end.range));
  }

  private finishAttributeLine(ident: Token): Range {
    const end = this.peek();
    if (end.type === "TokenNewline" || end.type === "TokenEOF") {
      const endRange = this.prevRange();
      this.read();
      return endRange;
    }
    this.reportAttributeLineEnd(ident, end);
    const endRange = this.prevRange();
    this.recoverAfterBodyItem();
    return endRange;
  }

  private attributeEnd(ident: Token, singleLine: boolean, before: number): Range {
    const endRange = this.prevRange();
    if (this.failedSince(before)) {
      this.recoverAfterBodyItem();
      return endRange;
    }
    return singleLine ? endRange : this.finishAttributeLine(ident);
  }

  private finishParsingBodyAttribute(ident: Token, singleLine: boolean): Attribute {
    const equals = this.read();
    if (equals.type !== "TokenEqual") {
      // oxlint-disable-next-line rules/require-tagged-error -- The internal parser invariant keeps its native Error without importing Effect.
      throw new Error("finishParsingBodyAttribute called with next not equals");
    }
    const before = this.diagnostics.length;
    const expression = this.parseExpression();
    const endRange = this.attributeEnd(ident, singleLine, before);
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public attribute AST key order.
    return { kind: "attribute", name: text(ident), expression, range: between(ident.range, endRange), nameRange: ident.range, equalsRange: equals.range };
  }

  private reportBlockHeader(ident: Token, token: Token): void {
    const { range, type } = token;
    if (type === "TokenEqual") {
      this.diag("Invalid block definition", 'The equals sign "=" indicates an argument definition, and must not be used when defining a block.', range, between(ident.range, range));
    } else if (type === "TokenNewline") {
      this.diag("Invalid block definition", 'A block definition must have block content delimited by "{" and "}", starting on the same line as the block header.', range, between(ident.range, range));
    } else if (!this.recovery) {
      this.diag("Invalid block definition", 'Either a quoted string block label or an opening brace ("{") is expected here.', range, between(ident.range, range));
    }
  }

  private readBlockLabel(token: Token): { range: Range; value: string } | null {
    if (token.type === "TokenOQuote") {return this.parseQuotedStringLiteral();}
    if (token.type !== "TokenIdent") {return NO_BODY_ITEM;}
    this.read();
    return { range: token.range, value: text(token) };
  }

  private recoverBlockHeader(ident: Token, token: Token, header: BlockHeader): BlockHeader {
    this.reportBlockHeader(ident, token);
    this.recoverAfterBodyItem();
    return header;
  }

  private readBlockHeader(ident: Token): BlockHeader {
    const header: BlockHeader = { labelRanges: [], labels: [] };
    // oxlint-disable-next-line rules/no-for-loops -- Consume one header token at a time through the brace or the first invalid label.
    for (;;) {
      const token = this.peek();
      if (token.type === "TokenOBrace") {return { ...header, open: this.read() };}
      const label = this.readBlockLabel(token);
      if (!label) {return this.recoverBlockHeader(ident, token, header);}
      header.labels.push(label.value);
      header.labelRanges.push(label.range);
    }
  }

  private reportSingleArgumentEnd(ident: Token, open: Token, next: Token): void {
    if (next.type === "TokenComma") {
      this.diag(INVALID_SINGLE_ARGUMENT, "Single-line block syntax can include only one argument definition. To define multiple arguments, use the multi-line block syntax with one argument definition per line.", next.range);
    } else if (next.type === "TokenNewline") {
      this.diag(INVALID_SINGLE_ARGUMENT, "An argument definition on the same line as its containing block creates a single-line block definition, which must also be closed on the same line. Place the block's closing brace immediately after the argument definition.", next.range);
    } else if (!this.recovery) {
      if (next.type === "TokenEOF") {this.diag("Unclosed configuration block", UNCLOSED_BLOCK, open.range, between(ident.range, open.range));}
      else {this.diag(INVALID_SINGLE_ARGUMENT, "A single-line block definition must end with a closing brace immediately after its single argument definition.", next.range);}
    }
  }

  private singleArgumentBody(ident: Token, open: Token): Body | null {
    const before = this.diagnostics.length;
    const body = this.parseSingleAttrBody();
    // Upstream emits the delimiter diagnostics before the nested-body diagnostics.
    const bodyDiagnostics = this.diagnostics.splice(before);
    const next = this.peek();
    if (next.type === "TokenCBrace") {this.read();}
    else {
      this.reportSingleArgumentEnd(ident, open, next);
      this.recover("TokenCBrace");
    }
    this.diagnostics.push(...bodyDiagnostics);
    return body;
  }

  private finishBlockLine(ident: Token): void {
    const eol = this.peek();
    if (BLOCK_LINE_ENDS.has(eol.type)) {
      this.read();
      return;
    }
    if (!this.recovery) {
      this.diag("Missing newline after block definition", "A block definition must end with a newline.", eol.range, between(ident.range, eol.range));
    }
    this.recoverAfterBodyItem();
  }

  private finishParsingBodyBlock(ident: Token): Block {
    const header = this.readBlockHeader(ident);
    const { open } = header;
    if (!open) {
      const closeRange = header.labelRanges.at(LAST_LABEL) ?? ident.range;
      return blockAst(ident, header, { body: emptyBody(ident.range), closeRange, openRange: ident.range });
    }
    const body = MULTILINE_BLOCK_STARTS.has(this.peek().type) ? this.parseBody("TokenCBrace") : this.singleArgumentBody(ident, open);
    const closeRange = this.prevRange();
    this.finishBlockLine(ident);
    return blockAst(ident, header, { body: body ?? emptyBody(between(open.range, closeRange), closeRange), closeRange, openRange: open.range });
  }

  public parseExpression(): Expression {
    return this.parseTernaryConditional();
  }

  private expressionAttempt(parse: () => Expression): ParsedExpression {
    const before = this.diagnostics.length;
    const expression = parse();
    return { expression, failed: this.failedSince(before) };
  }

  private readConditionalColon(start: Range): boolean {
    const colon = this.peek();
    if (colon.type === "TokenColon") {
      this.read();
      return true;
    }
    this.diag("Missing false expression in conditional", "The conditional operator (...?...:...) requires a false expression, delimited by a colon.", colon.range, between(start, colon.range));
    return false;
  }

  private parseConditionalBranches(condition: Expression, start: Range): Expression {
    this.read();
    const truth = this.expressionAttempt(() => this.parseExpression());
    if (truth.failed || !this.readConditionalColon(start)) {return condition;}
    const falsity = this.expressionAttempt(() => this.parseExpression());
    if (falsity.failed) {return condition;}
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public conditional AST key order.
    return { kind: "conditional", condition, trueResult: truth.expression, falseResult: falsity.expression, range: between(start, falsity.expression.range) };
  }

  private parseTernaryConditional(): Expression {
    const start = this.nextRange();
    const { expression, failed } = this.expressionAttempt(() => this.parseBinaryOps(FIRST_PRECEDENCE));
    if (failed || this.peek().type !== "TokenQuestion") {return expression;}
    return this.parseConditionalBranches(expression, start);
  }

  private binaryTail(left: Expression, operators: Record<string, string>, operandLevel: number): Expression {
    const chain = { left };
    // oxlint-disable-next-line rules/no-for-loops -- Advance left-associative operators until the grammar or recovery stops this precedence level.
    for (;;) {
      const operator = operators[this.peek().type];
      if (matchesUndefined(operator) || isEmptyString(operator)) {return chain.left;}
      this.read();
      const right = this.expressionAttempt(() => this.parseBinaryOps(operandLevel));
      if (right.failed) {return chain.left;}
      // oxlint-disable-next-line eslint/sort-keys -- Preserve the public binary AST key order.
      chain.left = { kind: "binary", operator, left: chain.left, right: right.expression, range: between(chain.left.range, right.expression.range) };
    }
  }

  private parseBinaryOps(level: number): Expression {
    const operators = binaryOps[level];
    if (!operators) {return this.parseExpressionWithTraversals();}
    const operandLevel = level + PRECEDENCE_STEP;
    const { expression, failed } = this.expressionAttempt(() => this.parseBinaryOps(operandLevel));
    return failed ? expression : this.binaryTail(expression, operators, operandLevel);
  }

  private parseExpressionWithTraversals(): Expression {
    return this.parseExpressionTraversals(this.parseExpressionTerm());
  }

  private numberLiteral(token: Token): Expression {
    const numberText = text(token);
    if (!/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(numberText)) {
      this.diag("Invalid number literal", "Failed to recognize the value of this number literal.", token.range);
      return dynamic(token.range);
    }
    // NumberText is the authoritative, lossless decimal representation.
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public numeric literal AST key order.
    return { kind: "literal", value: Number(numberText), numberText, range: token.range };
  }

  private consumeClosingParen(start: Range): Token {
    const close = this.peek();
    if (close.type !== "TokenCParen") {
      this.diag("Unbalanced parentheses", "Expected a closing parenthesis to terminate the expression.", close.range, between(start, close.range));
      this.recovery = true;
    }
    return this.read();
  }

  private recoverParentheses(expression: Expression): Expression {
    this.recover("TokenCParen");
    this.popIncludeNewlines();
    return expression;
  }

  private parseParentheses(start: Token): Expression {
    const open = this.read();
    this.pushIncludeNewlines(false);
    const before = this.diagnostics.length;
    const expression = this.parseExpression();
    if (this.errorsSince(before)) {return this.recoverParentheses(expression);}
    const close = this.consumeClosingParen(start.range);
    this.popIncludeNewlines();
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public parentheses AST key order.
    return { kind: "parentheses", expression, range: between(open.range, close.range) };
  }

  private parseIdentifier(): Expression {
    const token = this.read();
    if (this.peek().type === "TokenOParen" || this.peek().type === "TokenDoubleColon") {
      return this.finishParsingFunctionCall(token);
    }
    const name = text(token);
    if (name === "true" || name === "false" || name === "null") {
      return literal(name === "null" ? HCL_NULL : name === "true", token.range);
    }
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public root traversal step order.
    const step: TraversalStep = { kind: "root", value: name, range: token.range };
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public root traversal AST order.
    return { kind: "traversal", parts: [name], steps: [step], range: token.range };
  }

  private parseTemplateTerm(): Expression {
    const open = this.read();
    const inner = this.parseTemplateInner(opposite(open.type), open.type === "TokenOHeredoc" && open.bytes[HEREDOC_INDENT_MARKER_POSITION] === DASH_BYTE);
    const range = between(open.range, this.prevRange());
    return templateExpression(inner, range);
  }

  private parseUnary(): Expression {
    const token = this.read();
    const operand = this.parseExpressionWithTraversals();
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public unary AST key order.
    return { kind: "unary", operator: token.type === "TokenMinus" ? "-" : "!", operand, range: between(token.range, operand.range), symbolRange: token.range };
  }

  private invalidTerm(start: Token): Expression {
    if (!this.recovery) {
      if (start.type === "TokenEOF") {
        this.diag("Missing expression", "Expected the start of an expression, but found the end of the file.", start.range);
      } else {
        this.diag("Invalid expression", "Expected the start of an expression, but found an invalid expression token.", start.range);
      }
    }
    this.recovery = true;
    return dynamic(start.range);
  }

  private parseExpressionTerm(): Expression {
    const start = this.peek();
    switch (start.type) {
      case "TokenOParen": {return this.parseParentheses(start);}
      case "TokenNumberLit": {return this.numberLiteral(this.read());}
      case "TokenIdent": {return this.parseIdentifier();}
      case "TokenOQuote": case "TokenOHeredoc": {return this.parseTemplateTerm();}
      case "TokenMinus": case "TokenBang": {return this.parseUnary();}
      case "TokenOBrack": {return this.parseTupleCons();}
      case "TokenOBrace": {return this.parseObjectCons();}
      default: {return this.invalidTerm(start);}
    }
  }

  private invalidFunctionSelector(name: Token, next: Token, kind: "scope" | "parenthesis"): Expression {
    const summary = kind === "scope" ? "Missing function name" : "Missing open parenthesis";
    const detail = kind === "scope"
      ? "Function scope resolution symbol :: must be followed by a function name in this scope."
      : "Function selector must be followed by an open parenthesis to begin the function call.";
    const diagnostic = error(summary, detail, next.range, between(name.range, next.range));
    this.diagnostics.push(diagnostic);
    this.recoverOver("TokenOParen");
    return dynamic(between(name.range, next.range), [diagnostic]);
  }

  private consumeFunctionNamePart(head: FunctionHead, next: Token): void {
    head.nameString += `::${text(next)}`;
    head.nameEnd = next.range.end;
    head.open = this.read();
  }

  private scopedFunctionName(name: Token, head: FunctionHead): FunctionSelector | Expression {
    while (head.open.type === "TokenDoubleColon") {
      const nextName = this.read();
      if (nextName.type !== "TokenIdent") {return this.invalidFunctionSelector(name, nextName, "scope");}
      this.consumeFunctionNamePart(head, nextName);
    }
    const nameRange = functionNameRange(name, head.nameEnd);
    if (head.open.type !== "TokenOParen") {return this.invalidFunctionSelector(name, head.open, "parenthesis");}
    return { nameRange, nameString: head.nameString, open: head.open };
  }

  private readFunctionSelector(name: Token): FunctionSelector | Expression {
    const open = this.read();
    const nameString = text(name);
    const nameEnd = name.range.end;
    if (open.type !== "TokenOParen" && open.type !== "TokenDoubleColon") {
      // oxlint-disable-next-line rules/require-tagged-error -- The internal parser invariant keeps its native Error without importing Effect.
      throw new Error("finishParsingFunctionCall called with unsupported next token");
    }
    return this.scopedFunctionName(name, { nameEnd, nameString, open });
  }

  private expandedArgumentEnd(name: Token, separator: Token): Token {
    if (this.peek().type === "TokenCParen") {return this.read();}
    if (!this.recovery) {
      this.diag("Missing closing parenthesis", "An expanded function argument (with ...) must be immediately followed by closing parentheses.", separator.range, between(name.range, separator.range));
    }
    return this.recover("TokenCParen");
  }

  private reportFunctionSeparator(name: Token, open: Token, separator: Token): Token {
    if (separator.type === "TokenEOF") {
      this.diag("Unterminated function call", "There is no closing parenthesis for this function call before the end of the file. This may be caused by incorrect parenthesis nesting elsewhere in this file.", between(name.range, open.range));
    } else {
      this.diag("Missing argument separator", "A comma is required to separate each function argument from the next.", separator.range, between(name.range, separator.range));
    }
    return this.recover("TokenCParen");
  }

  private recoveredFunctionClose(): Token | undefined {
    const recovered = this.recover("TokenCParen");
    return recovered.type === "TokenCParen" ? recovered : undefined;
  }

  private nextFunctionSeparator(args: Expression[]): Token | undefined {
    const before = this.diagnostics.length;
    args.push(this.parseExpression());
    if (this.failedSince(before)) {return undefined;}
    return this.read();
  }

  private functionArgumentEnd(name: Token, open: Token, separator: Token | undefined): FunctionEnd {
    if (!separator) {
      return { close: this.recoveredFunctionClose(), expandFinal: false };
    }
    if (separator.type === "TokenCParen") {return { close: separator, expandFinal: false };}
    if (separator.type === "TokenEllipsis") {
      return { close: this.expandedArgumentEnd(name, separator), expandFinal: true };
    }
    return { close: this.reportFunctionSeparator(name, open, separator), expandFinal: false };
  }

  private readFunctionArguments(name: Token, open: Token): FunctionArguments {
    const args: Expression[] = [];
    // oxlint-disable-next-line rules/no-for-loops -- Parse each function argument through its separator or recovery before advancing.
    for (;;) {
      if (this.peek().type === "TokenCParen") {return { args, close: this.read(), expandFinal: false };}
      const separator = this.nextFunctionSeparator(args);
      if (separator?.type !== "TokenComma") {return { args, ...this.functionArgumentEnd(name, open, separator) };}
    }
  }

  private finishParsingFunctionCall(name: Token): Expression {
    const selector = this.readFunctionSelector(name);
    if ("kind" in selector) {return selector;}
    const { nameRange, nameString, open } = selector;
    this.pushIncludeNewlines(false);
    const { args, close, expandFinal } = this.readFunctionArguments(name, open);
    this.popIncludeNewlines();
    const closeRange = close?.range ?? zeroRange();
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public function call AST key order.
    return {
      kind: "call", name: nameString, args, expandFinal, nameRange, openParenRange: open.range,
      closeParenRange: closeRange, range: between(nameRange, closeRange),
    };
  }

  private invalidTupleSeparator(open: Token, next: Token): Token {
    if (!this.recovery) {
      if (next.type === "TokenEOF") {
        this.diag("Unterminated tuple constructor expression", "There is no corresponding closing bracket before the end of the file. This may be caused by incorrect bracket nesting elsewhere in this file.", open.range);
      } else {
        this.diag("Missing item separator", "Expected a comma to mark the beginning of the next item.", next.range, between(open.range, next.range));
      }
    }
    return this.recover("TokenCBrack");
  }

  private tupleDelimiter(open: Token): Token | undefined {
    const next = this.peek();
    if (next.type === "TokenCBrack") {return this.read();}
    if (next.type !== "TokenComma") {return this.invalidTupleSeparator(open, next);}
    this.read();
    return undefined;
  }

  private appendTupleExpression(expressions: Expression[]): boolean {
    const before = this.diagnostics.length;
    expressions.push(this.parseExpression());
    return !this.failedSince(before);
  }

  private readTupleItems(open: Token, expressions: Expression[]): Token {
    // oxlint-disable-next-line rules/no-for-loops -- Read one tuple expression at a time through the closing bracket or recovery.
    for (;;) {
      if (this.peek().type === "TokenCBrack") {return this.read();}
      if (!this.appendTupleExpression(expressions)) {return this.recover("TokenCBrack");}
      const end = this.tupleDelimiter(open);
      if (end) {return end;}
    }
  }

  private parseTupleCons(): Expression {
    const open = this.read();
    this.pushIncludeNewlines(false);
    try {
      if (keyword(this.peek(), "for")) {return this.finishParsingForExpr(open);}
      const expressions: Expression[] = [];
      const close = this.readTupleItems(open, expressions);
      // oxlint-disable-next-line eslint/sort-keys -- Preserve the public tuple AST order.
      return { kind: "tuple", expressions, range: between(open.range, close.range), openRange: open.range };
    } finally {
      this.popIncludeNewlines();
    }
  }

  private unterminatedObject(open: Token): void {
    this.diag("Unterminated object constructor expression", "There is no corresponding closing brace before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.", open.range);
  }

  private invalidObjectValue(open: Token, separator: Token): Token {
    if (!this.recovery) {this.reportObjectValueSeparator(open, separator);}
    return this.recover("TokenCBrace");
  }

  private reportObjectValueSeparator(open: Token, separator: Token): void {
    const { range, type } = separator;
    switch (type) {
      case "TokenNewline": case "TokenComma": {
        this.diag("Missing attribute value", 'Expected an attribute value, introduced by an equals sign ("=").', range, between(open.range, range));
        break;
      }
      case "TokenIdent": {
        this.diag("Missing key/value separator", 'Expected an equals sign ("=") to mark the beginning of the attribute value. If you intended to given an attribute name containing periods or spaces, write the name in quotes to create a string literal.', range, between(open.range, range));
        break;
      }
      case "TokenEOF": {
        this.unterminatedObject(open);
        break;
      }
      default: {
        this.diag("Missing key/value separator", 'Expected an equals sign ("=") to mark the beginning of the attribute value.', range, between(open.range, range));
      }
    }
  }

  private invalidObjectDelimiter(open: Token, next: Token): Token {
    if (!this.recovery) {
      if (next.type === "TokenEOF") {this.unterminatedObject(open);}
      else {
        this.diag("Missing attribute separator", "Expected a newline or comma to mark the beginning of the next attribute.", next.range, between(open.range, next.range));
      }
    }
    return this.recover("TokenCBrace");
  }

  private objectDelimiter(open: Token): Token | undefined {
    const next = this.peek();
    if (next.type === "TokenCBrace") {return this.read();}
    if (next.type !== "TokenComma" && next.type !== "TokenNewline") {return this.invalidObjectDelimiter(open, next);}
    this.read();
    return undefined;
  }

  private parseObjectValue(open: Token, items: ObjectEntry[], key: ObjectKey): Token | undefined {
    this.read();
    const before = this.diagnostics.length;
    const value = this.parseExpression();
    items.push({ key, value });
    return this.failedSince(before) ? this.recover("TokenCBrace") : this.objectDelimiter(open);
  }

  private parseObjectEntry(open: Token, items: ObjectEntry[], next: Token): Token | undefined {
    const forceNonLiteral = next.type === "TokenOParen";
    const { expression: wrapped, failed } = this.expressionAttempt(() => this.parseExpression());
    if (failed) {return this.recover("TokenCBrace");}
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public object key order.
    const key: ObjectKey = { kind: "objectKey", wrapped, forceNonLiteral, range: wrapped.range };
    const separator = this.peek();
    if (separator.type !== "TokenEqual" && separator.type !== "TokenColon") {return this.invalidObjectValue(open, separator);}
    return this.parseObjectValue(open, items, key);
  }

  private readObjectEntries(open: Token, items: ObjectEntry[]): Token {
    // oxlint-disable-next-line rules/no-for-loops -- Read one object attribute at a time through the closing brace or recovery.
    for (;;) {
      const next = this.peek();
      if (next.type === "TokenNewline") {this.read();}
      else if (next.type === "TokenCBrace") {return this.read();}
      else {
        const end = this.parseObjectEntry(open, items, next);
        if (end) {return end;}
      }
    }
  }

  private objectStartsWithFor(): boolean {
    this.pushIncludeNewlines(false);
    const isFor = keyword(this.peek(), "for");
    this.popIncludeNewlines();
    return isFor;
  }

  private parseObjectCons(): Expression {
    const open = this.read();
    if (this.objectStartsWithFor()) {return this.finishParsingForExpr(open);}
    this.pushIncludeNewlines(true);
    try {
      const items: ObjectEntry[] = [];
      const close = this.readObjectEntries(open, items);
      // oxlint-disable-next-line eslint/sort-keys -- Preserve the public object AST order.
      return { kind: "object", items, range: between(open.range, close.range), openRange: open.range };
    } finally {
      this.popIncludeNewlines();
    }
  }

  private recoverFor({ closeType, open }: ForContext): Expression {
    return dynamic(between(open.range, this.recover(closeType).range));
  }

  private reportForSyntax({ open }: ForContext, detail: string): void {
    if (!this.recovery) {
      this.diag(INVALID_FOR, detail, this.peek().range, between(open.range, this.peek().range));
    }
  }

  private invalidFor(context: ForContext, detail: string): Expression {
    this.reportForSyntax(context, detail);
    return this.recoverFor(context);
  }

  private readForVariables(context: ForContext): ForVariables | Expression {
    if (this.peek().type !== "TokenIdent") {
      return this.invalidFor(context, "For expression requires variable name after 'for'.");
    }
    const first = text(this.read());
    if (this.peek().type !== "TokenComma") {return { keyVar: "", valueVar: first };}
    this.read();
    if (this.peek().type !== "TokenIdent") {
      return this.invalidFor(context, "For expression requires value variable name after comma.");
    }
    return { keyVar: first, valueVar: text(this.read()) };
  }

  private readForHead(context: ForContext): ForHead | Expression {
    const variables = this.readForVariables(context);
    if ("kind" in variables) {return variables;}
    if (!keyword(this.peek(), "in")) {
      return this.invalidFor(context, "For expression requires the 'in' keyword after its name declarations.");
    }
    this.read();
    return this.readForCollection(context, variables);
  }

  private readForCollection(context: ForContext, variables: ForVariables): ForHead | Expression {
    const { expression: collection, failed } = this.expressionAttempt(() => this.parseExpression());
    if (failed) {return this.recoverFor(context);}
    if (this.peek().type !== "TokenColon") {
      return this.invalidFor(context, "For expression requires a colon after the collection expression.");
    }
    this.read();
    return { collection, ...variables };
  }

  private readForValue(): ForValue {
    const first = this.parseExpression();
    if (this.peek().type !== "TokenFatArrow") {return { key: HCL_NULL, value: first };}
    this.read();
    return { key: first, value: this.parseExpression() };
  }

  private parseForValue(context: ForContext): ForValue | Expression {
    const before = this.diagnostics.length;
    const value = this.readForValue();
    return this.failedSince(before) ? this.recoverFor(context) : value;
  }

  private forClause(context: ForContext): ForClause | Expression {
    const ellipsis = this.peek().type === "TokenEllipsis" ? this.read() : undefined;
    if (!keyword(this.peek(), "if")) {return { condition: HCL_NULL, ellipsis };}
    this.read();
    const { expression: condition, failed } = this.expressionAttempt(() => this.parseExpression());
    if (failed) {
      const close = this.recover(opposite(context.open.type));
      return dynamic(between(context.open.range, close.range));
    }
    return { condition, ellipsis };
  }

  private closeFor(context: ForContext): Token {
    if (this.peek().type === context.closeType) {return this.read();}
    this.reportForSyntax(context, "Extra characters after the end of the 'for' expression.");
    return this.recover(context.closeType);
  }

  private validateForConstruction({ makeObject, open }: ForContext, { key, value }: ForValue, { close, ellipsis }: { close: Token; ellipsis: Token | undefined }): void {
    if (makeObject && !key) {
      this.diag(INVALID_FOR, "Key expression is required when building an object.", value.range, between(open.range, close.range));
    }
    if (!makeObject && key) {
      this.diag(INVALID_FOR, "Key expression is not valid when building a tuple.", key.range, between(open.range, close.range));
    }
    if (!makeObject && ellipsis) {
      this.diag(INVALID_FOR, "Grouping ellipsis (...) cannot be used when building a tuple.", ellipsis.range, between(open.range, close.range));
    }
  }

  private forExpression(context: ForContext, head: ForHead, result: ForValue & ForClause): Expression {
    const { condition, ellipsis, key, value } = result;
    const { open } = context;
    const close = this.closeFor(context);
    this.validateForConstruction(context, result, { close, ellipsis });
    const { collection, keyVar, valueVar } = head;
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public 'for' AST order.
    return { kind: "for", keyVar, valueVar, collection, key, value, condition, group: Boolean(ellipsis), range: between(open.range, close.range), openRange: open.range, closeRange: close.range };
  }

  private forInterior(context: ForContext): Expression {
    const head = this.readForHead(context);
    if ("kind" in head) {return head;}
    const value = this.parseForValue(context);
    if ("kind" in value) {return value;}
    const clause = this.forClause(context);
    if ("kind" in clause) {return clause;}
    return this.forExpression(context, head, { ...value, ...clause });
  }

  private finishParsingForExpr(open: Token): Expression {
    this.pushIncludeNewlines(false);
    try {
      if (!keyword(this.read(), "for")) {
        // oxlint-disable-next-line rules/require-tagged-error -- The internal parser invariant keeps its native Error without importing Effect.
        throw new Error("finishParsingForExpr called without peeker pointing to 'for' identifier");
      }
      const makeObject = open.type === "TokenOBrace";
      const closeType = makeObject ? "TokenCBrace" : "TokenCBrack";
      return this.forInterior({ closeType, makeObject, open });
    } finally {
      this.popIncludeNewlines();
    }
  }

  private invalidSplatAttribute(marker: Token): void {
    if (!this.recovery) {
      const next = this.peek();
      if (next.type === "TokenStar") {
        this.diag("Nested splat expression not allowed", "A splat expression (*) cannot be used inside another attribute-only splat expression.", next.range);
      } else {
        this.diag("Invalid attribute name", "An attribute name is required after a dot.", marker.range);
      }
    }
    this.recovery = true;
  }

  private nextSplatAttribute(marker: Token): { range: Range; step: TraversalStep } | undefined {
    const dot = this.read();
    const next = this.peek();
    if (next.type === "TokenNumberLit") {
      const index = this.read();
      return { range: index.range, step: this.legacyIndex(dot, index, marker.range) };
    }
    if (next.type !== "TokenIdent") {
      this.invalidSplatAttribute(marker);
      return NO_SPLAT_STEP;
    }
    const attr = this.read();
    return { range: attr.range, step: attributeStep(dot, attr) };
  }

  private splatTail(marker: Token, subject: Token): SplatTail | undefined {
    const tail: SplatTail = { first: this.nextRange(), last: marker.range, steps: [] };
    while (this.peek().type === "TokenDot") {
      const step = this.nextSplatAttribute(subject);
      if (!step) {return undefined;}
      tail.steps.push(step.step);
      tail.last = step.range;
    }
    return tail;
  }

  private attributeSplat(state: TraversalState, dot: Token, subject: Token): Expression {
    const marker = this.read();
    const tail = this.splatTail(marker, subject);
    if (!tail) {return state.result;}
    const markerRange = between(dot.range, marker.range);
    const item: Anonymous = { kind: "anonymous", range: markerRange };
    const { first, last, steps } = tail;
    const each: Expression = steps.length
      // oxlint-disable-next-line eslint/sort-keys -- Preserve the public relative traversal order inside a splat.
      ? { kind: "relativeTraversal", source: item, steps, range: between(first, last) }
      : item;
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public attribute splat AST field order.
    return { kind: "splat", source: state.result, each, item, attributeOnly: true, range: between(state.base.range, last), markerRange: between(dot.range, marker.range) };
  }

  private invalidAttribute(state: TraversalState, dot: Token, attribute: Token): Expression {
    this.diag("Invalid attribute name", "An attribute name is required after a dot.", attribute.range);
    const result = dynamic(between(state.base.range, dot.range), this.diagnostics.slice(state.diagnosticsStart));
    this.recovery = true;
    return result;
  }

  private dotTraversal(state: TraversalState): Expression {
    const dot = this.read();
    const attribute = this.peek();
    switch (attribute.type) {
      case "TokenIdent": {return relativeTraversal(state.result, attributeStep(dot, this.read()));}
      case "TokenNumberLit": {return relativeTraversal(state.result, this.legacyIndex(dot, this.read()));}
      case "TokenStar": {return this.attributeSplat(state, dot, attribute);}
      default: {return this.invalidAttribute(state, dot, attribute);}
    }
  }

  private readIndexClose(mode: "index" | "splat"): Token {
    const close = this.read();
    if (close.type === "TokenCBrack" || this.recovery) {return close;}
    if (mode === "splat") {
      this.diag("Missing close bracket on splat index", 'The star for a full splat operator must be immediately followed by a closing bracket ("]").', close.range);
    } else {
      this.diag("Missing close bracket on index", 'The index operator must end with a closing bracket ("]").', close.range);
    }
    return this.recover("TokenCBrack");
  }

  private fullSplat(state: TraversalState, open: Token): Expression {
    this.read();
    const close = this.readIndexClose("splat");
    const item: Anonymous = { kind: "anonymous", range: between(open.range, close.range) };
    const each = this.parseExpressionTraversals(item);
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public full splat AST field order.
    return { kind: "splat", source: state.result, each, item, attributeOnly: false, range: between(state.base.range, each.range), markerRange: between(open.range, close.range) };
  }

  private readBracketKey(): { close: Token; key: Expression } {
    this.pushIncludeNewlines(false);
    const { expression: key, failed } = this.expressionAttempt(() => this.parseExpression());
    const close = failed ? this.recover("TokenCBrack") : this.readIndexClose("index");
    this.popIncludeNewlines();
    return { close, key };
  }

  private bracketTraversal(state: TraversalState): Expression {
    const open = this.read();
    if (this.peek().type === "TokenStar") {return this.fullSplat(state, open);}
    const { close, key } = this.readBracketKey();
    const range = between(open.range, close.range);
    return indexExpression(state, { key, open, range });
  }

  private parseExpressionTraversals(from: Expression): Expression {
    const state: TraversalState = { base: from, diagnosticsStart: this.diagnostics.length, result: from };
    // oxlint-disable-next-line rules/no-for-loops -- Traversals consume a step or end at the first token outside the traversal.
    for (;;) {
      const next = this.peek();
      if (next.type === "TokenDot") {state.result = this.dotTraversal(state);}
      else if (next.type === "TokenOBrack") {state.result = this.bracketTraversal(state);}
      else {return state.result;}
    }
  }

  private invalidLegacyIndex(numberText: string, dotIndex: number, marker: { range: Range; splatSubject: Range | undefined; subject: Range }): TraversalStep {
    const first = numberText.slice(LEGACY_INDEX_START, dotIndex);
    const second = numberText.slice(dotIndex + SKIP_LEGACY_DOT);
    this.diag("Invalid legacy index syntax", `When using the legacy index syntax, chaining two indexes together is not permitted. Use the proper index syntax${marker.splatSubject ? " with a full splat expression [*]" : ""} instead, like [${first}][${second}].`, marker.subject);
    return dynamicIndex(marker.range);
  }

  private legacyIndex(dot: Token, number: Token, splatSubject?: Range): TraversalStep {
    const numberText = text(number);
    const dotIndex = numberText.indexOf(".");
    const range = between(dot.range, number.range);
    if (dotIndex !== NO_LEGACY_DOT) {
      return this.invalidLegacyIndex(numberText, dotIndex, { range, splatSubject, subject: splatSubject ?? number.range });
    }
    const value = this.numberLiteral(number);
    // oxlint-disable-next-line eslint/sort-keys -- Preserve legacy numeric index field order.
    return value.kind === "literal" ? { kind: "index", value: value.value, numberText, range } : dynamicIndex(range);
  }

  private appendRejectedInterpolation(open: Token, token: Token, content: { value: string }): void {
    const which = token.type === "TokenTemplateControl" ? "%" : "$";
    this.diag("Invalid string literal", `Template sequences are not allowed in this string. To include a literal ${JSON.stringify(which)}, double it (as "${which}${which}") to escape it.`, token.range, between(open.range, token.range));
    content.value += `${which}{ ... }`;
    this.recover("TokenTemplateSeqEnd");
  }

  private appendQuotedChunk(open: Token, token: Token, content: { value: string }): boolean {
    if (token.type === "TokenQuotedLit") {
      const result = parseStringLiteralToken(token);
      this.diagnostics.push(...result.diagnostics);
      content.value += result.value;
      return true;
    }
    if (token.type === "TokenTemplateControl" || token.type === "TokenTemplateInterp") {
      this.appendRejectedInterpolation(open, token, content);
      return true;
    }
    return false;
  }

  private rejectQuotedToken(open: Token, token: Token): Range {
    if (token.type === "TokenEOF") {
      this.diag("Unterminated string literal", "Unable to find the closing quote mark before the end of the file.", token.range, between(open.range, token.range));
    } else {
      this.diag("Invalid string literal", "This item is not valid in a string literal.", token.range, between(open.range, token.range));
      this.recover("TokenCQuote");
    }
    return token.range;
  }

  private readQuotedEnd(open: Token, content: { value: string }): Range {
    // oxlint-disable-next-line rules/no-for-loops -- Each literal chunk advances the Peeker until the closing quote or invalid token.
    for (;;) {
      const token = this.read();
      if (token.type === "TokenCQuote") {return token.range;}
      if (!this.appendQuotedChunk(open, token, content)) {return this.rejectQuotedToken(open, token);}
    }
  }

  private parseQuotedStringLiteral(): { range: Range; value: string } {
    const open = this.read();
    if (open.type !== "TokenOQuote") {
      this.diag("Invalid string literal", "A quoted string is required here.", open.range);
      return { range: open.range, value: "" };
    }
    const content = { value: "" };
    const end = this.readQuotedEnd(open, content);
    return { range: between(open.range, end), value: content.value };
  }

  public recover(end: string): Token {
    const delimiters = { end, start: opposite(end) };
    this.recovery = true;
    const nesting = { depth: RECOVERY_START_DEPTH };
    // oxlint-disable-next-line rules/no-for-loops -- Recovery consumes the nested delimiter stream through the match or EOF.
    for (;;) {
      const token = this.read();
      const type = end === "TokenTemplateSeqEnd" && token.type === "TokenTemplateControl" ? "TokenTemplateInterp" : token.type;
      if (matchesRecoveryEnd(type, delimiters, nesting)) {return token;}
    }
  }

  private recoverOver(start: string): void {
    // oxlint-disable-next-line rules/no-for-loops -- Skip source tokens to the requested opener or EOF before balancing its sequence.
    for (;;) {
      const { type } = this.read();
      if (type === start || type === "TokenEOF") {break;}
    }
    this.recover(opposite(start));
  }

  private recoverAfterBodyItem(): void {
    this.recovery = true;
    const open: string[] = [];
    // oxlint-disable-next-line rules/no-for-loops -- Consume the broken body item to the next un-nested newline or EOF.
    for (;;) {
      const { type } = this.read();
      if (type === "TokenEOF" || (type === "TokenNewline" && !open.length)) {return;}
      updateBodyRecovery(open, type);
    }
  }

  public parseTemplate(end: string, flush: boolean): Expression {
    const inner = this.parseTemplateInner(end, flush);
    return templateExpression(inner, inner.range);
  }

  private parseTemplateInner(end: string, flush: boolean): ParsedTemplate {
    const parts = readTemplateParts(this, end);
    if (flush) {flushHeredocTemplateParts(parts);}
    meldConsecutiveStringLiterals(parts);
    const parser = new TemplateParser(parts.tokens, this.diagnostics);
    const expressions = parser.parseRoot();
    const passthru = parts.tokens.length === PASSTHROUGH_TOKEN_COUNT && parts.tokens[FIRST_EXPRESSION]?.kind === "interpolation";
    return { expressions, passthru, range: parts.range };
  }
}

export const parseConfig = function parseConfig(source: string | Uint8Array, filename = '', start?: Pos): { body: Body; diagnostics: Diagnostic[] } {
  const result = lexConfig(matchesString(source) ? encoder.encode(source) : source, filename, start);
  const parser = new Parser(result.tokens);
  const body = parser.parseBody('TokenEOF');
  parser.assertEmptyIncludeNewlinesStack();
  return { body, diagnostics: [...result.diagnostics, ...parser.diagnostics] };
};
export const parseExpression = function parseExpression(source: string | Uint8Array, filename = '', start?: Pos): { expression: Expression; diagnostics: Diagnostic[] } {
  const result = lexExpression(matchesString(source) ? encoder.encode(source) : source, filename, start);
  const parser = new Parser(result.tokens);
  parser.pushIncludeNewlines(false);
  const expression = parser.parseExpression();
  const next = parser.peek();
  if (next.type !== 'TokenEOF' && !parser.recovery) {parser.diagnostics.push(error('Extra characters after expression', 'An expression was successfully parsed, but extra characters were found after it.', next.range));}
  parser.popIncludeNewlines();
  parser.assertEmptyIncludeNewlinesStack();
  // oxlint-disable-next-line eslint/sort-keys -- Preserve parsed expression before diagnostics in the public result.
  return { expression, diagnostics: [...result.diagnostics, ...parser.diagnostics] };
};
export const parseTemplate = function parseTemplate(source: string | Uint8Array, filename = '', start?: Pos): { expression: Expression; diagnostics: Diagnostic[] } {
  const result = lexTemplate(matchesString(source) ? encoder.encode(source) : source, filename, start);
  const parser = new Parser(result.tokens);
  const expression = parser.parseTemplate('TokenEOF', false);
  parser.assertEmptyIncludeNewlinesStack();
  // oxlint-disable-next-line eslint/sort-keys -- Preserve parsed expression before diagnostics in the public result.
  return { expression, diagnostics: [...result.diagnostics, ...parser.diagnostics] };
};
