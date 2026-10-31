/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Translated from hclsyntax/parser.go, parser_template.go and public.go at
// hashicorp/hcl 00057cf06d7b38a3f89e6e54d622eee98322b314.
// The AST is data-only. cty evaluation is outside this port's boundary.
import { lexConfig, lexExpression, lexTemplate, scanStringLit, scanGraphemeCluster } from './scanner.ts';
import { Peeker } from './peeker.ts';
import { rangeBetween as between, emptyRangeAt, rangeString, isStringLiteral } from './types.ts';
import type { Attribute, Block, Body, Diagnostic, Expression, ForExpression, Literal, ObjectKey, Pos, Range, Token, TraversalStep } from './types.ts';
export * from './types.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
function graphemeClusters(bytes: Uint8Array): Uint8Array[] {
  const clusters: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = scanGraphemeCluster(bytes.subarray(offset));
    clusters.push(bytes.subarray(offset, offset + length)); offset += length;
  }
  return clusters;
}
const text = (token: Token): string => decoder.decode(token.bytes);
const keyword = (token: Token, word: string): boolean => token.type === 'TokenIdent' && text(token) === word;
const error = (summary: string, detail: string, subject: Range, context?: Range): Diagnostic => ({ severity: 'error', summary, detail, subject, ...(context ? { context } : {}) });
const dynamic = (range: Range, diagnostics?: Diagnostic[]): Expression => ({ kind: 'dynamic', range, ...(diagnostics ? { diagnostics } : {}) });
const literal = (value: Literal['value'], range: Range): Literal => ({ kind: 'literal', value: typeof value === 'string' ? value.normalize('NFC') : value, range });
const pairs: Record<string, string> = { TokenOBrace: 'TokenCBrace', TokenOBrack: 'TokenCBrack', TokenOParen: 'TokenCParen', TokenOQuote: 'TokenCQuote', TokenOHeredoc: 'TokenCHeredoc', TokenCBrace: 'TokenOBrace', TokenCBrack: 'TokenOBrack', TokenCParen: 'TokenOParen', TokenCQuote: 'TokenOQuote', TokenCHeredoc: 'TokenOHeredoc', TokenTemplateInterp: 'TokenTemplateSeqEnd', TokenTemplateControl: 'TokenTemplateSeqEnd', TokenTemplateSeqEnd: 'TokenTemplateInterp' };
const opposite = (type: string): string => pairs[type] ?? 'TokenNil';
const binaryOps: Record<string, string>[] = [
  { TokenOr: '||' }, { TokenAnd: '&&' }, { TokenEqualOp: '==', TokenNotEqual: '!=' },
  { TokenGreaterThan: '>', TokenGreaterThanEq: '>=', TokenLessThan: '<', TokenLessThanEq: '<=' },
  { TokenPlus: '+', TokenMinus: '-' }, { TokenStar: '*', TokenSlash: '/', TokenPercent: '%' },
];
const emptyBody = (range: Range, endRange = range): Body => ({ kind: 'body', attributes: Object.create(null) as Record<string, Attribute>, blocks: [], range, endRange });

export function parseConfig(source: string | Uint8Array, filename = '', start: Pos = { line: 1, column: 1, byte: 0 }): { body: Body; diagnostics: Diagnostic[] } {
  const result = lexConfig(typeof source === 'string' ? encoder.encode(source) : source, filename, start);
  const parser = new Parser(result.tokens);
  const body = parser.parseBody('TokenEOF');
  parser.assertEmptyIncludeNewlinesStack();
  return { body, diagnostics: [...result.diagnostics, ...parser.diagnostics] };
}
export function parseExpression(source: string | Uint8Array, filename = '', start: Pos = { line: 1, column: 1, byte: 0 }): { expression: Expression; diagnostics: Diagnostic[] } {
  const result = lexExpression(typeof source === 'string' ? encoder.encode(source) : source, filename, start);
  const parser = new Parser(result.tokens);
  parser.pushIncludeNewlines(false);
  const expression = parser.parseExpression();
  const next = parser.peek();
  if (next.type !== 'TokenEOF' && !parser.recovery) parser.diagnostics.push(error('Extra characters after expression', 'An expression was successfully parsed, but extra characters were found after it.', next.range));
  parser.popIncludeNewlines();
  parser.assertEmptyIncludeNewlinesStack();
  return { expression, diagnostics: [...result.diagnostics, ...parser.diagnostics] };
}
export function parseTemplate(source: string | Uint8Array, filename = '', start: Pos = { line: 1, column: 1, byte: 0 }): { expression: Expression; diagnostics: Diagnostic[] } {
  const result = lexTemplate(typeof source === 'string' ? encoder.encode(source) : source, filename, start);
  const parser = new Parser(result.tokens);
  const expression = parser.parseTemplate('TokenEOF', false);
  parser.assertEmptyIncludeNewlinesStack();
  return { expression, diagnostics: [...result.diagnostics, ...parser.diagnostics] };
}

/** Stateful translation of the upstream recursive-descent parser. */
export class Parser extends Peeker {
  recovery = false;
  readonly diagnostics: Diagnostic[] = [];
  private errorsSince(index: number): boolean { return this.diagnostics.slice(index).some(diag => diag.severity === 'error') }
  private failedSince(index: number): boolean { return this.recovery && this.errorsSince(index) }
  private diag(summary: string, detail: string, subject: Range, context?: Range): void { this.diagnostics.push(error(summary, detail, subject, context)) }

  parseBody(end: string): Body {
    const body = emptyBody(this.prevRange());
    const startRange = this.prevRange();
    let endRange = startRange;
    for (;;) {
      const next = this.peek();
      if (next.type === end) { endRange = this.nextRange(); this.read(); break }
      if (next.type === 'TokenNewline') { this.read(); continue }
      if (next.type === 'TokenIdent') {
        const item = this.parseBodyItem();
        if (item?.kind === 'block') body.blocks.push(item);
        else if (item?.kind === 'attribute') {
          const existing = body.attributes[item.name];
          if (existing) this.diag('Attribute redefined', `The argument ${JSON.stringify(item.name)} was already set at ${rangeString(existing.nameRange)}. Each argument may be set only once.`, item.nameRange);
          else body.attributes[item.name] = item;
        }
        continue;
      }
      const bad = this.read();
      if (!this.recovery) {
        if (bad.type === 'TokenOQuote') this.diag('Invalid argument name', 'Argument names must not be quoted.', bad.range);
        else if (bad.type === 'TokenEOF') {
          if (end === 'TokenCBrace') this.diag('Unclosed configuration block', 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', startRange);
          else this.diag('Unclosed configuration body', 'Found end of file before the end of this configuration body.', startRange);
        } else this.diag('Argument or block definition required', 'An argument or block definition is required here.', bad.range);
      }
      endRange = this.prevRange();
      this.recover(end);
      break;
    }
    body.range = between(startRange, endRange);
    body.endRange = emptyRangeAt(endRange);
    return body;
  }

  parseBodyItem(): Attribute | Block | null {
    const ident = this.read();
    if (ident.type !== 'TokenIdent') {
      this.recoverAfterBodyItem();
      this.diag('Argument or block definition required', 'An argument or block definition is required here.', ident.range);
      return null;
    }
    const next = this.peek();
    if (next.type === 'TokenEqual') return this.finishParsingBodyAttribute(ident, false);
    if (['TokenOQuote', 'TokenOBrace', 'TokenIdent'].includes(next.type)) return this.finishParsingBodyBlock(ident);
    this.recoverAfterBodyItem();
    this.diag('Argument or block definition required', 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.', ident.range);
    return null;
  }

  private parseSingleAttrBody(): Body | null {
    const ident = this.read();
    if (ident.type !== 'TokenIdent') {
      this.recoverAfterBodyItem();
      this.diag('Argument or block definition required', 'An argument or block definition is required here.', ident.range);
      return null;
    }
    const next = this.peek();
    if (next.type !== 'TokenEqual') {
      this.recoverAfterBodyItem();
      if (['TokenOQuote', 'TokenOBrace', 'TokenIdent'].includes(next.type)) this.diag('Argument definition required', `A single-line block definition can contain only a single argument. If you meant to define argument ${JSON.stringify(text(ident))}, use an equals sign to assign it a value. To define a nested block, place it on a line of its own within its parent block.`, between(ident.range, next.range));
      else this.diag('Argument or block definition required', 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.', ident.range);
      return null;
    }
    const attribute = this.finishParsingBodyAttribute(ident, true);
    const body = emptyBody(attribute.range, emptyRangeAt(attribute.range));
    body.attributes[text(ident)] = attribute;
    return body;
  }

  private finishParsingBodyAttribute(ident: Token, singleLine: boolean): Attribute {
    const equals = this.read();
    if (equals.type !== 'TokenEqual') throw new Error('finishParsingBodyAttribute called with next not equals');
    const before = this.diagnostics.length;
    const expression = this.parseExpression();
    let endRange = this.prevRange();
    if (this.failedSince(before)) this.recoverAfterBodyItem();
    else if (!singleLine) {
      const end = this.peek();
      if (end.type !== 'TokenNewline' && end.type !== 'TokenEOF') {
        if (!this.recovery) {
          const comma = end.type === 'TokenComma';
          this.diag(comma ? 'Unexpected comma after argument' : 'Missing newline after argument', `${comma ? 'Argument definitions must be separated by newlines, not commas. ' : ''}An argument definition must end with a newline.`, end.range, between(ident.range, end.range));
        }
        endRange = this.prevRange();
        this.recoverAfterBodyItem();
      } else { endRange = this.prevRange(); this.read() }
    }
    return { kind: 'attribute', name: text(ident), expression, range: between(ident.range, endRange), nameRange: ident.range, equalsRange: equals.range };
  }

  private finishParsingBodyBlock(ident: Token): Block {
    const labels: string[] = [], labelRanges: Range[] = [];
    let open: Token;
    for (;;) {
      const token = this.peek();
      if (token.type === 'TokenOBrace') { open = this.read(); break }
      if (token.type === 'TokenOQuote') {
        const label = this.parseQuotedStringLiteral(); labels.push(label.value); labelRanges.push(label.range); continue;
      }
      if (token.type === 'TokenIdent') { this.read(); labels.push(text(token)); labelRanges.push(token.range); continue }
      if (token.type === 'TokenEqual') this.diag('Invalid block definition', 'The equals sign "=" indicates an argument definition, and must not be used when defining a block.', token.range, between(ident.range, token.range));
      else if (token.type === 'TokenNewline') this.diag('Invalid block definition', 'A block definition must have block content delimited by "{" and "}", starting on the same line as the block header.', token.range, between(ident.range, token.range));
      else if (!this.recovery) this.diag('Invalid block definition', 'Either a quoted string block label or an opening brace ("{") is expected here.', token.range, between(ident.range, token.range));
      this.recoverAfterBodyItem();
      const endRange = labelRanges.at(-1) ?? ident.range;
      return { kind: 'block', type: text(ident), labels, body: emptyBody(ident.range), range: between(ident.range, endRange), typeRange: ident.range, labelRanges, openBraceRange: ident.range, closeBraceRange: endRange };
    }
    // The upstream implementation appends nested-body diagnostics after the
    // single-line delimiter diagnostics. Preserve that observable ordering.
    const before = this.diagnostics.length;
    let body: Body | null;
    if (['TokenNewline', 'TokenEOF', 'TokenCBrace'].includes(this.peek().type)) body = this.parseBody('TokenCBrace');
    else {
      body = this.parseSingleAttrBody();
      const bodyDiagnostics = this.diagnostics.splice(before);
      const next = this.peek();
      if (next.type === 'TokenCBrace') this.read();
      else {
        if (next.type === 'TokenComma') this.diag('Invalid single-argument block definition', 'Single-line block syntax can include only one argument definition. To define multiple arguments, use the multi-line block syntax with one argument definition per line.', next.range);
        else if (next.type === 'TokenNewline') this.diag('Invalid single-argument block definition', "An argument definition on the same line as its containing block creates a single-line block definition, which must also be closed on the same line. Place the block's closing brace immediately after the argument definition.", next.range);
        else if (!this.recovery) {
          if (next.type === 'TokenEOF') this.diag('Unclosed configuration block', 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', open.range, between(ident.range, open.range));
          else this.diag('Invalid single-argument block definition', 'A single-line block definition must end with a closing brace immediately after its single argument definition.', next.range);
        }
        this.recover('TokenCBrace');
      }
      this.diagnostics.push(...bodyDiagnostics);
    }
    const closeRange = this.prevRange();
    const eol = this.peek();
    if (eol.type === 'TokenNewline' || eol.type === 'TokenEOF') this.read();
    else {
      if (!this.recovery) this.diag('Missing newline after block definition', 'A block definition must end with a newline.', eol.range, between(ident.range, eol.range));
      this.recoverAfterBodyItem();
    }
    body ??= emptyBody(between(open.range, closeRange), closeRange);
    return { kind: 'block', type: text(ident), labels, body, range: between(ident.range, closeRange), typeRange: ident.range, labelRanges, openBraceRange: open.range, closeBraceRange: closeRange };
  }

  parseExpression(): Expression { return this.parseTernaryConditional() }
  private parseTernaryConditional(): Expression {
    const start = this.nextRange(), before = this.diagnostics.length;
    const condition = this.parseBinaryOps(0);
    if (this.failedSince(before) || this.peek().type !== 'TokenQuestion') return condition;
    this.read();
    const trueBefore = this.diagnostics.length;
    const trueResult = this.parseExpression();
    if (this.failedSince(trueBefore)) return condition;
    const colon = this.peek();
    if (colon.type !== 'TokenColon') {
      this.diag('Missing false expression in conditional', 'The conditional operator (...?...:...) requires a false expression, delimited by a colon.', colon.range, between(start, colon.range));
      return condition;
    }
    this.read();
    const falseBefore = this.diagnostics.length;
    const falseResult = this.parseExpression();
    if (this.failedSince(falseBefore)) return condition;
    return { kind: 'conditional', condition, trueResult, falseResult, range: between(start, falseResult.range) };
  }
  private parseBinaryOps(level: number): Expression {
    if (level === binaryOps.length) return this.parseExpressionWithTraversals();
    const before = this.diagnostics.length;
    let left = this.parseBinaryOps(level + 1);
    if (this.failedSince(before)) return left;
    for (;;) {
      const operator = binaryOps[level]![this.peek().type];
      if (!operator) return left;
      this.read();
      const rightBefore = this.diagnostics.length;
      const right = this.parseBinaryOps(level + 1);
      if (this.failedSince(rightBefore)) return left;
      left = { kind: 'binary', operator, left, right, range: between(left.range, right.range) };
    }
  }
  private parseExpressionWithTraversals(): Expression { return this.parseExpressionTraversals(this.parseExpressionTerm()) }

  private numberLiteral(token: Token): Literal | Expression {
    const numberText = text(token);
    if (!/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(numberText)) {
      this.diag('Invalid number literal', 'Failed to recognize the value of this number literal.', token.range);
      return dynamic(token.range);
    }
    // numberText is the authoritative, lossless decimal representation. The
    // numeric convenience field is not used for semantic equality or folding.
    return { kind: 'literal', value: Number(numberText), numberText, range: token.range };
  }
  private parseExpressionTerm(): Expression {
    const start = this.peek();
    switch (start.type) {
      case 'TokenOParen': {
        const open = this.read(); this.pushIncludeNewlines(false);
        const before = this.diagnostics.length;
        const expression = this.parseExpression();
        if (this.errorsSince(before)) { this.recover('TokenCParen'); this.popIncludeNewlines(); return expression }
        const close = this.peek();
        if (close.type !== 'TokenCParen') { this.diag('Unbalanced parentheses', 'Expected a closing parenthesis to terminate the expression.', close.range, between(start.range, close.range)); this.recovery = true }
        const consumed = this.read(); this.popIncludeNewlines();
        return { kind: 'parentheses', expression, range: between(open.range, consumed.range) };
      }
      case 'TokenNumberLit': return this.numberLiteral(this.read());
      case 'TokenIdent': {
        const token = this.read();
        if (this.peek().type === 'TokenOParen' || this.peek().type === 'TokenDoubleColon') return this.finishParsingFunctionCall(token);
        const name = text(token);
        if (name === 'true' || name === 'false' || name === 'null') return literal(name === 'null' ? null : name === 'true', token.range);
        return { kind: 'traversal', parts: [name], steps: [{ kind: 'root', value: name, range: token.range }], range: token.range };
      }
      case 'TokenOQuote': case 'TokenOHeredoc': {
        const open = this.read();
        const inner = this.parseTemplateInner(opposite(open.type), open.type === 'TokenOHeredoc' && open.bytes[2] === 45);
        const range = between(open.range, this.prevRange());
        return inner.passthru ? { kind: 'templateWrap', wrapped: inner.expressions[0]!, range } : { kind: 'template', parts: inner.expressions, range };
      }
      case 'TokenMinus': case 'TokenBang': {
        const token = this.read(), operand = this.parseExpressionWithTraversals();
        return { kind: 'unary', operator: token.type === 'TokenMinus' ? '-' : '!', operand, range: between(token.range, operand.range), symbolRange: token.range };
      }
      case 'TokenOBrack': return this.parseTupleCons();
      case 'TokenOBrace': return this.parseObjectCons();
      default:
        if (!this.recovery) {
          if (start.type === 'TokenEOF') this.diag('Missing expression', 'Expected the start of an expression, but found the end of the file.', start.range);
          else this.diag('Invalid expression', 'Expected the start of an expression, but found an invalid expression token.', start.range);
        }
        this.recovery = true;
        return dynamic(start.range);
    }
  }

  private finishParsingFunctionCall(name: Token): Expression {
    let open = this.read(), nameString = text(name), nameEnd = name.range.end;
    if (open.type !== 'TokenOParen' && open.type !== 'TokenDoubleColon') throw new Error('finishParsingFunctionCall called with unsupported next token');
    while (open.type === 'TokenDoubleColon') {
      const nextName = this.read();
      if (nextName.type !== 'TokenIdent') {
        const diagnostic = error('Missing function name', 'Function scope resolution symbol :: must be followed by a function name in this scope.', nextName.range, between(name.range, nextName.range));
        this.diagnostics.push(diagnostic); this.recoverOver('TokenOParen');
        return dynamic(between(name.range, nextName.range), [diagnostic]);
      }
      nameString += `::${text(nextName)}`; nameEnd = nextName.range.end; open = this.read();
    }
    const nameRange = { filename: name.range.filename, start: name.range.start, end: nameEnd };
    if (open.type !== 'TokenOParen') {
      const diagnostic = error('Missing open parenthesis', 'Function selector must be followed by an open parenthesis to begin the function call.', open.range, between(name.range, open.range));
      this.diagnostics.push(diagnostic); this.recoverOver('TokenOParen');
      return dynamic(between(name.range, open.range), [diagnostic]);
    }
    const args: Expression[] = [];
    let expandFinal = false;
    let close: Token | undefined;
    this.pushIncludeNewlines(false);
    for (;;) {
      if (this.peek().type === 'TokenCParen') { close = this.read(); break }
      const before = this.diagnostics.length;
      args.push(this.parseExpression());
      if (this.failedSince(before)) {
        const recovered = this.recover('TokenCParen');
        if (recovered.type === 'TokenCParen') close = recovered;
        break;
      }
      const sep = this.read();
      if (sep.type === 'TokenCParen') { close = sep; break }
      if (sep.type === 'TokenEllipsis') {
        expandFinal = true;
        if (this.peek().type !== 'TokenCParen') {
          if (!this.recovery) this.diag('Missing closing parenthesis', 'An expanded function argument (with ...) must be immediately followed by closing parentheses.', sep.range, between(name.range, sep.range));
          close = this.recover('TokenCParen');
        } else close = this.read();
        break;
      }
      if (sep.type !== 'TokenComma') {
        if (sep.type === 'TokenEOF') this.diag('Unterminated function call', 'There is no closing parenthesis for this function call before the end of the file. This may be caused by incorrect parenthesis nesting elsewhere in this file.', between(name.range, open.range));
        else this.diag('Missing argument separator', 'A comma is required to separate each function argument from the next.', sep.range, between(name.range, sep.range));
        close = this.recover('TokenCParen'); break;
      }
      if (this.peek().type === 'TokenCParen') { close = this.read(); break }
    }
    this.popIncludeNewlines();
    // Go's zero Token has a zero range when recovery never found a closer.
    const closeRange = close?.range ?? { filename: '', start: { line: 0, column: 0, byte: 0 }, end: { line: 0, column: 0, byte: 0 } };
    return { kind: 'call', name: nameString, args, expandFinal, nameRange, openParenRange: open.range, closeParenRange: closeRange, range: between(nameRange, closeRange) };
  }

  private parseTupleCons(): Expression {
    const open = this.read();
    this.pushIncludeNewlines(false);
    try {
      if (keyword(this.peek(), 'for')) return this.finishParsingForExpr(open);
      const expressions: Expression[] = [];
      let close: Token;
      for (;;) {
        if (this.peek().type === 'TokenCBrack') { close = this.read(); break }
        const before = this.diagnostics.length;
        expressions.push(this.parseExpression());
        if (this.failedSince(before)) { close = this.recover('TokenCBrack'); break }
        const next = this.peek();
        if (next.type === 'TokenCBrack') { close = this.read(); break }
        if (next.type !== 'TokenComma') {
          if (!this.recovery) {
            if (next.type === 'TokenEOF') this.diag('Unterminated tuple constructor expression', 'There is no corresponding closing bracket before the end of the file. This may be caused by incorrect bracket nesting elsewhere in this file.', open.range);
            else this.diag('Missing item separator', 'Expected a comma to mark the beginning of the next item.', next.range, between(open.range, next.range));
          }
          close = this.recover('TokenCBrack'); break;
        }
        this.read();
      }
      return { kind: 'tuple', expressions, range: between(open.range, close.range), openRange: open.range };
    } finally { this.popIncludeNewlines() }
  }

  private parseObjectCons(): Expression {
    const open = this.read();
    this.pushIncludeNewlines(false);
    const isFor = keyword(this.peek(), 'for');
    this.popIncludeNewlines();
    if (isFor) return this.finishParsingForExpr(open);
    this.pushIncludeNewlines(true);
    try {
      const items: { key: ObjectKey; value: Expression }[] = [];
      let close: Token;
      for (;;) {
        let next = this.peek();
        if (next.type === 'TokenNewline') { this.read(); continue }
        if (next.type === 'TokenCBrace') { close = this.read(); break }
        const forceNonLiteral = next.type === 'TokenOParen', before = this.diagnostics.length;
        const wrapped = this.parseExpression();
        if (this.failedSince(before)) { close = this.recover('TokenCBrace'); break }
        const key: ObjectKey = { kind: 'objectKey', wrapped, forceNonLiteral, range: wrapped.range };
        next = this.peek();
        if (next.type !== 'TokenEqual' && next.type !== 'TokenColon') {
          if (!this.recovery) {
            if (next.type === 'TokenNewline' || next.type === 'TokenComma') this.diag('Missing attribute value', 'Expected an attribute value, introduced by an equals sign ("=").', next.range, between(open.range, next.range));
            else if (next.type === 'TokenIdent') this.diag('Missing key/value separator', 'Expected an equals sign ("=") to mark the beginning of the attribute value. If you intended to given an attribute name containing periods or spaces, write the name in quotes to create a string literal.', next.range, between(open.range, next.range));
            else if (next.type === 'TokenEOF') this.diag('Unterminated object constructor expression', 'There is no corresponding closing brace before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', open.range);
            else this.diag('Missing key/value separator', 'Expected an equals sign ("=") to mark the beginning of the attribute value.', next.range, between(open.range, next.range));
          }
          close = this.recover('TokenCBrace'); break;
        }
        this.read();
        const valueBefore = this.diagnostics.length;
        const value = this.parseExpression(); items.push({ key, value });
        if (this.failedSince(valueBefore)) { close = this.recover('TokenCBrace'); break }
        next = this.peek();
        if (next.type === 'TokenCBrace') { close = this.read(); break }
        if (next.type !== 'TokenComma' && next.type !== 'TokenNewline') {
          if (!this.recovery) {
            if (next.type === 'TokenEOF') this.diag('Unterminated object constructor expression', 'There is no corresponding closing brace before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', open.range);
            else this.diag('Missing attribute separator', 'Expected a newline or comma to mark the beginning of the next attribute.', next.range, between(open.range, next.range));
          }
          close = this.recover('TokenCBrace'); break;
        }
        this.read();
      }
      return { kind: 'object', items, range: between(open.range, close.range), openRange: open.range };
    } finally { this.popIncludeNewlines() }
  }

  private finishParsingForExpr(open: Token): Expression {
    this.pushIncludeNewlines(false);
    try {
      if (!keyword(this.read(), 'for')) throw new Error("finishParsingForExpr called without peeker pointing to 'for' identifier");
      const makeObject = open.type === 'TokenOBrace', closeType = makeObject ? 'TokenCBrace' : 'TokenCBrack';
      const invalid = (detail: string): Expression => {
        if (!this.recovery) this.diag("Invalid 'for' expression", detail, this.peek().range, between(open.range, this.peek().range));
        return dynamic(between(open.range, this.recover(closeType).range));
      };
      if (this.peek().type !== 'TokenIdent') return invalid("For expression requires variable name after 'for'.");
      let valueVar = text(this.read()), keyVar = '';
      if (this.peek().type === 'TokenComma') {
        keyVar = valueVar; this.read();
        if (this.peek().type !== 'TokenIdent') return invalid('For expression requires value variable name after comma.');
        valueVar = text(this.read());
      }
      if (!keyword(this.peek(), 'in')) return invalid("For expression requires the 'in' keyword after its name declarations.");
      this.read();
      const collBefore = this.diagnostics.length, collection = this.parseExpression();
      if (this.failedSince(collBefore)) return dynamic(between(open.range, this.recover(closeType).range));
      if (this.peek().type !== 'TokenColon') return invalid('For expression requires a colon after the collection expression.');
      this.read();
      const valueBefore = this.diagnostics.length;
      let value = this.parseExpression(), key: Expression | null = null;
      if (this.peek().type === 'TokenFatArrow') { this.read(); key = value; value = this.parseExpression() }
      if (this.failedSince(valueBefore)) return dynamic(between(open.range, this.recover(closeType).range));
      let group = false, ellipsis: Token | undefined;
      if (this.peek().type === 'TokenEllipsis') { ellipsis = this.read(); group = true }
      let condition: Expression | null = null;
      if (keyword(this.peek(), 'if')) {
        this.read(); const before = this.diagnostics.length; condition = this.parseExpression();
        if (this.failedSince(before)) return dynamic(between(open.range, this.recover(opposite(open.type)).range));
      }
      let close: Token;
      if (this.peek().type === closeType) close = this.read();
      else {
        if (!this.recovery) this.diag("Invalid 'for' expression", "Extra characters after the end of the 'for' expression.", this.peek().range, between(open.range, this.peek().range));
        close = this.recover(closeType);
      }
      if (!makeObject) {
        if (key) this.diag("Invalid 'for' expression", 'Key expression is not valid when building a tuple.', key.range, between(open.range, close.range));
        if (group) this.diag("Invalid 'for' expression", 'Grouping ellipsis (...) cannot be used when building a tuple.', ellipsis!.range, between(open.range, close.range));
      } else if (!key) this.diag("Invalid 'for' expression", 'Key expression is required when building an object.', value.range, between(open.range, close.range));
      return { kind: 'for', keyVar, valueVar, collection, key, value, condition, group, range: between(open.range, close.range), openRange: open.range, closeRange: close.range };
    } finally { this.popIncludeNewlines() }
  }

  private parseExpressionTraversals(from: Expression): Expression {
    const diagnosticsStart = this.diagnostics.length;
    let result = from;
    traversal: for (;;) {
      const next = this.peek();
      if (next.type === 'TokenDot') {
        const dot = this.read();
        let attr = this.peek();
        if (attr.type === 'TokenIdent') {
          attr = this.read();
          result = relativeTraversal(result, { kind: 'attribute', value: text(attr), range: between(dot.range, attr.range) });
        } else if (attr.type === 'TokenNumberLit') {
          attr = this.read();
          result = relativeTraversal(result, this.legacyIndex(dot, attr, false, attr.range));
        } else if (attr.type === 'TokenStar') {
          const marker = this.read(), steps: TraversalStep[] = [];
          const firstRange = this.nextRange();
          let lastRange = marker.range;
          while (this.peek().type === 'TokenDot') {
            const stepDot = this.read();
            if (this.peek().type === 'TokenNumberLit') {
              const num = this.read(); steps.push(this.legacyIndex(stepDot, num, true, attr.range)); lastRange = num.range; continue;
            }
            if (this.peek().type !== 'TokenIdent') {
              if (!this.recovery) {
                if (this.peek().type === 'TokenStar') this.diag('Nested splat expression not allowed', 'A splat expression (*) cannot be used inside another attribute-only splat expression.', this.peek().range);
                else this.diag('Invalid attribute name', 'An attribute name is required after a dot.', attr.range);
              }
              this.recovery = true;
              continue traversal;
            }
            const attrToken = this.read();
            steps.push({ kind: 'attribute', value: text(attrToken), range: between(stepDot.range, attrToken.range) }); lastRange = attrToken.range;
          }
          const item: Expression & { kind: 'anonymous' } = { kind: 'anonymous', range: between(dot.range, marker.range) };
          const each: Expression = steps.length ? { kind: 'relativeTraversal', source: item, steps, range: between(firstRange, lastRange) } : item;
          result = { kind: 'splat', source: result, each, item, attributeOnly: true, range: between(from.range, lastRange), markerRange: between(dot.range, marker.range) };
        } else {
          this.diag('Invalid attribute name', 'An attribute name is required after a dot.', attr.range);
          result = dynamic(between(from.range, dot.range), this.diagnostics.slice(diagnosticsStart)); this.recovery = true;
        }
      } else if (next.type === 'TokenOBrack') {
        const open = this.read();
        if (this.peek().type === 'TokenStar') {
          this.read(); let close = this.read();
          if (close.type !== 'TokenCBrack' && !this.recovery) {
            this.diag('Missing close bracket on splat index', 'The star for a full splat operator must be immediately followed by a closing bracket ("]").', close.range);
            close = this.recover('TokenCBrack');
          }
          const item: Expression & { kind: 'anonymous' } = { kind: 'anonymous', range: between(open.range, close.range) };
          const each = this.parseExpressionTraversals(item);
          result = { kind: 'splat', source: result, each, item, attributeOnly: false, range: between(from.range, each.range), markerRange: between(open.range, close.range) };
        } else {
          this.pushIncludeNewlines(false);
          const before = this.diagnostics.length, key = this.parseExpression();
          let close: Token;
          if (this.failedSince(before)) close = this.recover('TokenCBrack');
          else {
            close = this.read();
            if (close.type !== 'TokenCBrack' && !this.recovery) {
              this.diag('Missing close bracket on index', 'The index operator must end with a closing bracket ("]").', close.range); close = this.recover('TokenCBrack');
            }
          }
          this.popIncludeNewlines();
          const range = between(open.range, close.range);
          if (key.kind === 'literal') result = relativeTraversal(result, { kind: 'index', value: key.value, range, ...(key.numberText ? { numberText: key.numberText } : {}) });
          else if (key.kind === 'dynamic' && !key.diagnostics) result = relativeTraversal(result, { kind: 'index', value: null, dynamic: true, range });
          else if (isStringLiteral(key)) {
            const part = key.parts[0];
            result = relativeTraversal(result, part.kind === 'literal' ? { kind: 'index', value: part.value, range } : { kind: 'index', value: null, dynamic: true, range });
          }
          else result = { kind: 'index', collection: result, key, range: between(from.range, range), openRange: open.range, bracketRange: range };
        }
      } else break;
    }
    return result;
  }

  private legacyIndex(dot: Token, number: Token, splat: boolean, subject: Range): TraversalStep {
    const numberText = text(number), dotIndex = numberText.indexOf('.'), range = between(dot.range, number.range);
    if (dotIndex >= 0) {
      const first = numberText.slice(0, dotIndex), second = numberText.slice(dotIndex + 1);
      this.diag('Invalid legacy index syntax', `When using the legacy index syntax, chaining two indexes together is not permitted. Use the proper index syntax${splat ? ' with a full splat expression [*]' : ''} instead, like [${first}][${second}].`, subject);
      return { kind: 'index', value: null, dynamic: true, range };
    }
    const value = this.numberLiteral(number);
    return value.kind === 'literal' ? { kind: 'index', value: value.value, numberText, range } : { kind: 'index', value: null, dynamic: true, range };
  }

  private parseQuotedStringLiteral(): { value: string; range: Range } {
    const open = this.read();
    if (open.type !== 'TokenOQuote') { this.diag('Invalid string literal', 'A quoted string is required here.', open.range); return { value: '', range: open.range } }
    let value = '', endRange: Range;
    for (;;) {
      const token = this.read();
      if (token.type === 'TokenCQuote') { endRange = token.range; break }
      if (token.type === 'TokenQuotedLit') {
        const result = parseStringLiteralToken(token); this.diagnostics.push(...result.diagnostics); value += result.value; continue;
      }
      if (token.type === 'TokenTemplateControl' || token.type === 'TokenTemplateInterp') {
        const which = token.type === 'TokenTemplateControl' ? '%' : '$';
        this.diag('Invalid string literal', `Template sequences are not allowed in this string. To include a literal ${JSON.stringify(which)}, double it (as "${which}${which}") to escape it.`, token.range, between(open.range, token.range));
        value += `${which}{ ... }`; this.recover('TokenTemplateSeqEnd'); continue;
      }
      if (token.type === 'TokenEOF') this.diag('Unterminated string literal', 'Unable to find the closing quote mark before the end of the file.', token.range, between(open.range, token.range));
      else { this.diag('Invalid string literal', 'This item is not valid in a string literal.', token.range, between(open.range, token.range)); this.recover('TokenCQuote') }
      endRange = token.range; break;
    }
    return { value, range: between(open.range, endRange) };
  }

  recover(end: string): Token {
    const start = opposite(end); this.recovery = true;
    let nest = 0;
    for (;;) {
      const token = this.read();
      let type = token.type;
      if (end === 'TokenTemplateSeqEnd' && type === 'TokenTemplateControl') type = 'TokenTemplateInterp';
      if (type === start) nest++;
      else if (type === end) { if (nest < 1) return token; nest-- }
      else if (type === 'TokenEOF') return token;
    }
  }
  private recoverOver(start: string): void {
    for (;;) { const token = this.read(); if (token.type === start || token.type === 'TokenEOF') break }
    this.recover(opposite(start));
  }
  private recoverAfterBodyItem(): void {
    this.recovery = true;
    const open: string[] = [];
    for (;;) {
      const token = this.read();
      if ((token.type === 'TokenNewline' && !open.length) || token.type === 'TokenEOF') break;
      if (['TokenOBrace', 'TokenOBrack', 'TokenOParen', 'TokenOQuote', 'TokenOHeredoc', 'TokenTemplateInterp', 'TokenTemplateControl'].includes(token.type)) open.push(token.type);
      else if (['TokenCBrace', 'TokenCBrack', 'TokenCParen', 'TokenCQuote', 'TokenCHeredoc'].includes(token.type)) {
        const opener = opposite(token.type); while (open.length && open.at(-1) !== opener) open.pop(); if (open.length) open.pop();
      } else if (token.type === 'TokenTemplateSeqEnd') {
        while (open.length && open.at(-1) !== 'TokenTemplateInterp' && open.at(-1) !== 'TokenTemplateControl') open.pop();
        if (open.length) open.pop();
      }
    }
  }

  parseTemplate(end: string, flush: boolean): Expression {
    const inner = this.parseTemplateInner(end, flush);
    return inner.passthru ? { kind: 'templateWrap', wrapped: inner.expressions[0]!, range: inner.range } : { kind: 'template', parts: inner.expressions, range: inner.range };
  }
  private parseTemplateInner(end: string, flush: boolean): { expressions: Expression[]; passthru: boolean; range: Range } {
    const parts = this.parseTemplateParts(end);
    if (flush) flushHeredocTemplateParts(parts);
    meldConsecutiveStringLiterals(parts);
    const parser = new TemplateParser(parts.tokens, this.diagnostics);
    const expressions = parser.parseRoot();
    return { expressions, passthru: parts.tokens.length === 2 && parts.tokens[0]!.kind === 'interpolation', range: parts.range };
  }

  private parseTemplateParts(end: string): TemplateParts {
    const parts: TemplateToken[] = [];
    const startRange = this.nextRange();
    let ltrimNext = false, nextCanTrimPrevious = false, endRange: Range;
    tokens: for (;;) {
      const next = this.read();
      if (next.type === end) { endRange = next.range; break }
      const ltrim = ltrimNext, canTrimPrevious = nextCanTrimPrevious;
      ltrimNext = false; nextCanTrimPrevious = false;
      if (next.type === 'TokenStringLit' || next.type === 'TokenQuotedLit') {
        const result = parseStringLiteralToken(next); this.diagnostics.push(...result.diagnostics);
        parts.push({ kind: 'literal', value: ltrim ? trimLeft(result.value) : result.value, range: cloneRange(next.range) });
        nextCanTrimPrevious = true;
      } else if (next.type === 'TokenTemplateInterp') {
        if (canTrimPrevious && next.bytes.length === 3 && next.bytes[2] === 126 && parts.length) {
          const previous = parts.at(-1)!; if (previous.kind === 'literal') previous.value = trimRight(previous.value);
        }
        this.pushIncludeNewlines(false);
        const expression = this.parseExpression(), close = this.peek();
        if (close.type !== 'TokenTemplateSeqEnd') {
          if (!this.recovery) {
            if (close.type === 'TokenEOF') this.diag('Unclosed template interpolation sequence', 'There is no closing brace for this interpolation sequence before the end of the file. This might be caused by incorrect nesting inside the given expression.', startRange);
            else if (close.type === 'TokenColon') this.diag('Extra characters after interpolation expression', 'Template interpolation doesn\'t expect a colon at this location. Did you intend this to be a literal sequence to be processed as part of another language? If so, you can escape it by starting with "$${" instead of just "${".', close.range, between(startRange, close.range));
            else if ((close.type === 'TokenCQuote' || close.type === 'TokenOQuote') && end === 'TokenCQuote') this.diag('Unclosed template interpolation sequence', 'There is no closing brace for this interpolation sequence before the end of the quoted template. This might be caused by incorrect nesting inside the given expression.', startRange);
            else this.diag('Extra characters after interpolation expression', 'Expected a closing brace to end the interpolation expression, but found extra characters.\n\nThis can happen when you include interpolation syntax for another language, such as shell scripting, but forget to escape the interpolation start token. If this is an embedded sequence for another language, escape it by starting with "$${" instead of just "${".', close.range, between(startRange, close.range));
          }
          this.recover('TokenTemplateSeqEnd');
        } else { this.read(); if (close.bytes.length === 2 && close.bytes[0] === 126) ltrimNext = true }
        this.popIncludeNewlines();
        parts.push({ kind: 'interpolation', expression, range: between(next.range, close.range) });
      } else if (next.type === 'TokenTemplateControl') {
        if (canTrimPrevious && next.bytes.length === 3 && next.bytes[2] === 126 && parts.length) {
          const previous = parts.at(-1)!; if (previous.kind === 'literal') previous.value = trimRight(previous.value);
        }
        this.pushIncludeNewlines(false);
        const kw = this.peek();
        if (kw.type !== 'TokenIdent') {
          if (!this.recovery) this.diag('Invalid template directive', 'A template directive keyword ("if", "for", etc) is expected at the beginning of a %{ sequence.', kw.range, between(next.range, kw.range));
          this.recover('TokenTemplateSeqEnd'); this.popIncludeNewlines(); continue;
        }
        this.read();
        const word = text(kw);
        switch (word) {
          case 'if': {
            const condition = this.parseExpression(); parts.push({ kind: 'if', condition, range: between(next.range, this.nextRange()) }); break;
          }
          case 'else': case 'endif': case 'endfor': parts.push({ kind: word, range: between(next.range, this.nextRange()) }); break;
          case 'for': {
            if (this.peek().type !== 'TokenIdent') {
              if (!this.recovery) this.diag("Invalid 'for' directive", "For directive requires variable name after 'for'.", this.peek().range);
              this.recover('TokenTemplateSeqEnd'); this.popIncludeNewlines(); continue tokens;
            }
            let valueVar = text(this.read()), keyVar = '';
            if (this.peek().type === 'TokenComma') {
              keyVar = valueVar; this.read();
              if (this.peek().type !== 'TokenIdent') {
                if (!this.recovery) this.diag("Invalid 'for' directive", 'For directive requires value variable name after comma.', this.peek().range);
                this.recover('TokenTemplateSeqEnd'); this.popIncludeNewlines(); continue tokens;
              }
              valueVar = text(this.read());
            }
            if (!keyword(this.peek(), 'in')) {
              if (!this.recovery) this.diag("Invalid 'for' directive", "For directive requires 'in' keyword after names.", this.peek().range);
              this.recover('TokenTemplateSeqEnd'); this.popIncludeNewlines(); continue tokens;
            }
            this.read();
            const collection = this.parseExpression(); parts.push({ kind: 'for', keyVar, valueVar, collection, range: between(next.range, this.nextRange()) }); break;
          }
          default: {
            if (!this.recovery) {
              const suggestion = nameSuggestion(word, ['if', 'for', 'else', 'endif', 'endfor']);
              this.diag('Invalid template control keyword', `${JSON.stringify(word)} is not a valid template control keyword.${suggestion ? ` Did you mean ${JSON.stringify(suggestion)}?` : ''}`, kw.range, between(next.range, kw.range));
            }
            this.recover('TokenTemplateSeqEnd'); this.popIncludeNewlines(); continue;
          }
        }
        const close = this.peek();
        if (close.type !== 'TokenTemplateSeqEnd') {
          if (!this.recovery) this.diag(`Extra characters in ${word} marker`, 'Expected a closing brace to end the sequence, but found extra characters.', close.range, between(startRange, close.range));
          this.recover('TokenTemplateSeqEnd');
        } else { this.read(); if (close.bytes.length === 2 && close.bytes[0] === 126) ltrimNext = true }
        this.popIncludeNewlines();
      } else {
        if (!this.recovery) this.diag('Unterminated template string', 'No closing marker was found for the string.', next.range, between(startRange, next.range));
        endRange = this.recover(end).range; break;
      }
    }
    if (!parts.length) parts.push({ kind: 'literal', value: '', range: emptyRangeAt(startRange) });
    parts.push({ kind: 'end', range: endRange });
    return { tokens: parts, range: between(startRange, endRange) };
  }
}

function relativeTraversal(expression: Expression, step: TraversalStep): Expression {
  if (expression.kind === 'traversal' || expression.kind === 'relativeTraversal') {
    expression.steps.push(step);
    if (expression.kind === 'traversal') {
      // parts is the ergonomic adapter view. steps retains non-string/number
      // index keys and unknown placeholders without discarding AST information.
      if (typeof step.value === 'string' || typeof step.value === 'number') expression.parts.push(step.value);
    }
    expression.range = between(expression.range, step.range); return expression;
  }
  return { kind: 'relativeTraversal', source: expression, steps: [step], range: between(expression.range, step.range) };
}

// Unicode White_Space as used by Go unicode.IsSpace. JavaScript's \s differs
// for FEFF and NEL, so do not use String.trim() here.
const spaceLeft = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
const spaceRight = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u;
const trimLeft = (value: string): string => value.replace(spaceLeft, '');
const trimRight = (value: string): string => value.replace(spaceRight, '');
const cloneRange = (range: Range): Range => ({ filename: range.filename, start: { ...range.start }, end: { ...range.end } });

type TemplateToken =
  | { kind: 'literal'; value: string; range: Range }
  | { kind: 'interpolation'; expression: Expression; range: Range }
  | { kind: 'if'; condition: Expression; range: Range }
  | { kind: 'for'; keyVar: string; valueVar: string; collection: Expression; range: Range }
  | { kind: 'else' | 'endif' | 'endfor' | 'end'; range: Range };
interface TemplateParts { tokens: TemplateToken[]; range: Range }

class TemplateParser {
  private pos = 0;
  private readonly tokens: TemplateToken[];
  private readonly diagnostics: Diagnostic[];
  constructor(tokens: TemplateToken[], diagnostics: Diagnostic[]) { this.tokens = tokens; this.diagnostics = diagnostics }
  private peek(): TemplateToken { return this.tokens[this.pos]! }
  private read(): TemplateToken { const token = this.peek(); if (token.kind !== 'end') this.pos++; return token }
  parseRoot(): Expression[] {
    const expressions: Expression[] = [];
    while (this.peek().kind !== 'end') expressions.push(this.parseExpr());
    return expressions;
  }
  private parseExpr(): Expression {
    const token = this.peek();
    switch (token.kind) {
      case 'literal': this.read(); return literal(token.value, token.range);
      case 'interpolation': this.read(); return token.expression;
      case 'if': return this.parseIf();
      case 'for': return this.parseFor();
      case 'end':
        this.read(); this.diagnostics.push(error('Unexpected end of template', 'The control directives within this template are unbalanced.', token.range)); return dynamic(token.range);
      default:
        this.read(); this.diagnostics.push(error(`Unexpected ${token.kind} directive`, 'The control directives within this template are unbalanced.', token.range)); return dynamic(token.range);
    }
  }
  private parseIf(): Expression {
    const open = this.read();
    if (open.kind !== 'if') throw new Error('parseIf called with peeker not pointing at if token');
    const ifExpressions: Expression[] = [], elseExpressions: Expression[] = [];
    let current = ifExpressions, endRange: Range;
    for (;;) {
      const next = this.peek();
      if (next.kind === 'end') {
        this.diagnostics.push(error('Unexpected end of template', `The if directive at ${rangeString(open.range)} is missing its corresponding endif directive.`, next.range)); return dynamic(next.range);
      }
      if (next.kind === 'else' || next.kind === 'endif' || next.kind === 'endfor') {
        this.read();
        if (next.kind === 'else') {
          if (current === ifExpressions) { current = elseExpressions; continue }
          this.diagnostics.push(error('Unexpected else directive', `Already in the else clause for the if started at ${rangeString(open.range)}.`, next.range));
        } else if (next.kind === 'endif') { endRange = next.range; break }
        else this.diagnostics.push(error(`Unexpected ${next.kind} directive`, `Expecting an endif directive for the if started at ${rangeString(open.range)}.`, next.range));
        return dynamic(next.range);
      }
      current.push(this.parseExpr());
    }
    if (!ifExpressions.length) ifExpressions.push(literal('', emptyRangeAt(open.range)));
    if (!elseExpressions.length) elseExpressions.push(literal('', emptyRangeAt(endRange, 'start')));
    const trueResult: Expression = { kind: 'template', parts: ifExpressions, range: between(ifExpressions[0]!.range, ifExpressions.at(-1)!.range) };
    const falseResult: Expression = { kind: 'template', parts: elseExpressions, range: between(elseExpressions[0]!.range, elseExpressions.at(-1)!.range) };
    return { kind: 'conditional', condition: open.condition, trueResult, falseResult, range: between(open.range, endRange) };
  }
  private parseFor(): Expression {
    const open = this.read();
    if (open.kind !== 'for') throw new Error('parseFor called with peeker not pointing at for token');
    const expressions: Expression[] = [];
    let endRange: Range;
    for (;;) {
      const next = this.peek();
      if (next.kind === 'end') {
        this.diagnostics.push(error('Unexpected end of template', `The for directive at ${rangeString(open.range)} is missing its corresponding endfor directive.`, next.range)); return dynamic(next.range);
      }
      if (next.kind === 'else' || next.kind === 'endif' || next.kind === 'endfor') {
        this.read();
        if (next.kind === 'else') this.diagnostics.push(error('Unexpected else directive', 'An else clause is not expected for a for directive.', next.range));
        else if (next.kind === 'endfor') { endRange = next.range; break }
        else this.diagnostics.push(error(`Unexpected ${next.kind} directive`, `Expecting an endfor directive corresponding to the for directive at ${rangeString(open.range)}.`, next.range));
        return dynamic(next.range);
      }
      expressions.push(this.parseExpr());
    }
    if (!expressions.length) expressions.push(literal('', emptyRangeAt(open.range)));
    const value: Expression = { kind: 'template', parts: expressions, range: between(expressions[0]!.range, expressions.at(-1)!.range) };
    const tuple: ForExpression = { kind: 'for', keyVar: open.keyVar, valueVar: open.valueVar, collection: open.collection, key: null, value, condition: null, group: false, range: between(open.range, endRange), openRange: open.range, closeRange: endRange };
    return { kind: 'templateJoin', tuple, range: tuple.range };
  }
}

function flushHeredocTemplateParts(parts: TemplateParts): void {
  let minSpaces = Number.MAX_SAFE_INTEGER, newline = true;
  const adjust: Extract<TemplateToken, { kind: 'literal' }>[] = [];
  for (const token of parts.tokens) {
    if (newline) {
      newline = false;
      let spaces = 0;
      if (token.kind === 'literal') {
        const trimmed = trimLeft(token.value);
        if (trimmed.length === 0 && token.value.endsWith('\n')) spaces = Number.MAX_SAFE_INTEGER;
        else {
          const prefix = token.value.slice(0, token.value.length - trimmed.length);
          spaces = graphemeClusters(encoder.encode(prefix)).length; adjust.push(token);
        }
      } else if (token.kind === 'end') break;
      if (spaces < minSpaces) minSpaces = spaces;
    }
    if (token.kind === 'literal' && token.value.endsWith('\n')) newline = true;
  }
  for (const token of adjust) {
    const bytes = encoder.encode(token.value), clusters = graphemeClusters(bytes);
    let byteCount = 0;
    for (let i = 0; i < minSpaces; i++) byteCount += clusters[i]!.length;
    token.value = decoder.decode(bytes.subarray(byteCount));
    token.range.start.column += minSpaces; token.range.start.byte += byteCount;
  }
}
function meldConsecutiveStringLiterals(parts: TemplateParts): void {
  let i = 1;
  while (i < parts.tokens.length) {
    const previous = parts.tokens[i - 1]!, current = parts.tokens[i]!;
    if (previous.kind === 'literal' && current.kind === 'literal') {
      previous.value += current.value; previous.range.end = { ...current.range.end }; parts.tokens.splice(i, 1);
    } else i++;
  }
}
function nameSuggestion(given: string, suggestions: string[]): string {
  const chars = [...given];
  for (const suggestion of suggestions) {
    const candidate = [...suggestion];
    let row = candidate.map((_, i) => i + 1); row.unshift(0);
    for (let i = 0; i < chars.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < candidate.length; j++) next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (chars[i] === candidate[j] ? 0 : 1)));
      row = next;
    }
    if (row[candidate.length]! < 3) return suggestion;
  }
  return '';
}

/** Resolve the scanner's literal slices, retaining byte/grapheme diagnostic ranges. */
export function parseStringLiteralToken(token: Token): { value: string; diagnostics: Diagnostic[] } {
  if (token.type !== 'TokenQuotedLit' && token.type !== 'TokenStringLit') throw new Error('parseStringLiteralToken can only be used with TokenStringLit and TokenQuotedLit tokens');
  const quoted = token.type === 'TokenQuotedLit', diagnostics: Diagnostic[] = [], output: Uint8Array[] = [];
  let end = { ...token.range.start };
  for (const slice of scanStringLit(token.bytes, quoted)) {
    if (!slice.length) continue;
    const start = { ...end };
    for (const cluster of graphemeClusters(slice)) {
      end = { ...end, byte: end.byte + cluster.length };
      if (cluster[0] === 13 || cluster[0] === 10) { end.line++; end.column = 1 }
      else end.column++;
    }
    const range: Range = { filename: token.range.filename, start, end: { ...end } };
    const invalid = (detail: string): void => { diagnostics.push(error('Invalid escape sequence', detail, range)) };
    if (slice[0] === 92 && quoted) {
      if (slice.length < 2) invalid('Backslash must be followed by an escape sequence selector character.');
      else {
        const escapes: Record<number, string> = { 110: '\n', 114: '\r', 116: '\t', 34: '"', 92: '\\' };
        const escape = escapes[slice[1]!];
        if (escape !== undefined) { output.push(encoder.encode(escape)); continue }
        if (slice[1] === 117 || slice[1] === 85) {
          if (slice[1] === 117 && slice.length !== 6) invalid('The \\u escape sequence must be followed by four hexadecimal digits.');
          else if (slice[1] === 85 && slice.length !== 10) invalid('The \\U escape sequence must be followed by eight hexadecimal digits.');
          else {
            const num = Number.parseInt(decoder.decode(slice.subarray(2)), 16);
            if (num > 0x10ffff || num >= 0xd800 && num <= 0xdfff) invalid(`Cannot encode character U+${num.toString(16).padStart(4, '0')} in UTF-8.`);
            else { output.push(encoder.encode(String.fromCodePoint(num))); continue }
          }
        } else {
          invalid(`The symbol ${JSON.stringify(decoder.decode(slice.subarray(1)))} is not a valid escape sequence selector.`);
          output.push(slice.subarray(1)); continue;
        }
      }
    } else if ((slice[0] === 36 || slice[0] === 37) && slice.length === 3 && slice[1] === slice[0] && slice[2] === 123) {
      output.push(slice.subarray(1)); continue;
    }
    output.push(slice);
  }
  const joined = new Uint8Array(output.reduce((length, bytes) => length + bytes.length, 0));
  let offset = 0;
  for (const slice of output) { joined.set(slice, offset); offset += slice.length }
  return { value: decoder.decode(joined), diagnostics };
}
