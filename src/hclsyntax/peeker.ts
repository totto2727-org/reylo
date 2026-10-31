/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Translated from hclsyntax/peeker.go, hashicorp/hcl
// 00057cf06d7b38a3f89e6e54d622eee98322b314.
import type { Range, Token } from './types.ts';

export class Peeker {
  nextIndex = 0;
  readonly includeNewlinesStack = [true];
  readonly tokens: Token[];
  readonly includeComments: boolean;
  constructor(tokens: Token[], includeComments = false) {
    this.tokens = tokens;
    this.includeComments = includeComments;
    if (!tokens.length || tokens[tokens.length - 1]!.type !== 'TokenEOF') throw new Error('peeker requires an EOF-terminated token stream');
  }
  peek(): Token { return this.nextToken()[0] }
  read(): Token { const [token, index] = this.nextToken(); this.nextIndex = index; return token }
  nextRange(): Range { return this.peek().range }
  prevRange(): Range { return this.nextIndex === 0 ? this.nextRange() : this.tokens[this.nextIndex - 1]!.range }
  private nextToken(): [Token, number] {
    for (let i = this.nextIndex; i < this.tokens.length; i++) {
      const token = this.tokens[i]!;
      if (token.type === 'TokenComment' && !this.includeComments) {
        if (this.includingNewlines() && token.bytes.length && token.bytes[token.bytes.length - 1] === 10) {
          return [{ type: 'TokenNewline', bytes: token.bytes.subarray(token.bytes.length - 1), range: token.range }, i + 1];
        }
        continue;
      }
      if (token.type === 'TokenNewline' && !this.includingNewlines()) continue;
      return [token, i + 1];
    }
    return [this.tokens[this.tokens.length - 1]!, this.tokens.length];
  }
  includingNewlines(): boolean { return this.includeNewlinesStack[this.includeNewlinesStack.length - 1]! }
  pushIncludeNewlines(include: boolean): void { this.includeNewlinesStack.push(include) }
  popIncludeNewlines(): boolean {
    if (this.includeNewlinesStack.length === 1) throw new Error('unbalanced IncludeNewlinesStack pop');
    return this.includeNewlinesStack.pop()!;
  }
  assertEmptyIncludeNewlinesStack(): void {
    if (this.includeNewlinesStack.length !== 1) throw new Error(`non-empty IncludeNewlinesStack after parse: ${this.includeNewlinesStack}`);
  }
}
