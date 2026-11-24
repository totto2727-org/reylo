/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Translated from hclsyntax/peeker.go, hashicorp/hcl
// 00057cf06d7b38a3f89e6e54d622eee98322b314.
import type { Range, Token } from './types.ts';

export class Peeker {
  public nextIndex = 0;
  public readonly includeNewlinesStack = [true];
  public readonly tokens: Token[];
  public readonly includeComments: boolean;
  public constructor(tokens: Token[], includeComments = false) {
    this.tokens = tokens;
    this.includeComments = includeComments;
    if (!tokens.length || tokens.at(-1)!.type !== 'TokenEOF') {throw new Error('peeker requires an EOF-terminated token stream');}
  }
  public peek(): Token { return this.nextToken()[0] }
  public read(): Token { const [token, index] = this.nextToken(); this.nextIndex = index; return token }
  public nextRange(): Range { return this.peek().range }
  public prevRange(): Range { return this.nextIndex === 0 ? this.nextRange() : this.tokens[this.nextIndex - 1]!.range }
  private nextToken(): [Token, number] {
    for (let i = this.nextIndex; i < this.tokens.length; i++) {
      const token = this.tokens[i]!;
      if (token.type === 'TokenComment' && !this.includeComments) {
        if (this.includingNewlines() && token.bytes.length && token.bytes.at(-1) === 10) {
          return [{ type: 'TokenNewline', bytes: token.bytes.subarray(- 1), range: token.range }, i + 1];
        }
        continue;
      }
      if (token.type === 'TokenNewline' && !this.includingNewlines()) {continue;}
      return [token, i + 1];
    }
    return [this.tokens.at(-1)!, this.tokens.length];
  }
  public includingNewlines(): boolean { return this.includeNewlinesStack.at(-1)! }
  public pushIncludeNewlines(include: boolean): void { this.includeNewlinesStack.push(include) }
  public popIncludeNewlines(): boolean {
    if (this.includeNewlinesStack.length === 1) {throw new Error('unbalanced IncludeNewlinesStack pop');}
    return this.includeNewlinesStack.pop()!;
  }
  public assertEmptyIncludeNewlinesStack(): void {
    if (this.includeNewlinesStack.length !== 1) {throw new Error(`non-empty IncludeNewlinesStack after parse: ${this.includeNewlinesStack}`);}
  }
}
