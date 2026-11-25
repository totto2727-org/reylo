/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Translated from hclsyntax/peeker.go, hashicorp/hcl
// 00057cf06d7b38a3f89e6e54d622eee98322b314.
import type { Range, Token } from './types.ts';

const FIRST_TOKEN = 0;
const LAST_TOKEN = -1;
const TOKEN_STEP = 1;
const BASE_STACK_DEPTH = 1;
const LINE_FEED_BYTE = 10;

const commentNewline = (token: Token): Token =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public synthetic newline token field order.
  ({ type: "TokenNewline", bytes: token.bytes.subarray(LAST_TOKEN), range: token.range });

export class Peeker {
  public nextIndex = FIRST_TOKEN;
  // oxlint-disable-next-line rules/no-readonly -- Keep the public stack reference stable while the parser changes its contents.
  public readonly includeNewlinesStack = [true];
  // oxlint-disable-next-line rules/no-readonly -- Preserve the original token stream reference in the public parser API.
  public readonly tokens: Token[];
  // oxlint-disable-next-line rules/no-readonly -- Comment visibility remains fixed for the lifetime of the public reader.
  public readonly includeComments: boolean;

  public constructor(tokens: Token[], includeComments = false) {
    this.tokens = tokens;
    this.includeComments = includeComments;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A nonempty scanner stream is dense and must end with an explicit EOF token.
    if (!tokens.length || tokens.at(LAST_TOKEN)!.type !== "TokenEOF") {
      // oxlint-disable-next-line rules/require-tagged-error -- Preserve the existing native parser invariant Error without importing Effect.
      throw new Error("peeker requires an EOF-terminated token stream");
    }
  }

  public peek(): Token {
    const [token] = this.nextToken();
    return token;
  }

  public read(): Token {
    const [token, index] = this.nextToken();
    this.nextIndex = index;
    return token;
  }

  public nextRange(): Range {
    return this.peek().range;
  }

  public prevRange(): Range {
    if (this.nextIndex === FIRST_TOKEN) {return this.nextRange();}
    // oxlint-disable-next-line typescript/no-non-null-assertion -- After a read, nextIndex points immediately after the consumed token.
    return this.tokens[this.nextIndex - TOKEN_STEP]!.range;
  }

  private visibleToken(token: Token): Token | undefined {
    if (token.type === "TokenComment" && !this.includeComments) {
      return this.includingNewlines() && token.bytes.length && token.bytes.at(LAST_TOKEN) === LINE_FEED_BYTE
        ? commentNewline(token)
        : undefined;
    }
    if (token.type === "TokenNewline" && !this.includingNewlines()) {return undefined;}
    return token;
  }

  private nextToken(): [Token, number] {
    const cursor = { index: this.nextIndex };
    while (cursor.index < this.tokens.length) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Scanner streams are dense and the cursor is within their length.
      const token = this.visibleToken(this.tokens[cursor.index]!);
      cursor.index += TOKEN_STEP;
      if (token) {return [token, cursor.index];}
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The constructor requires the final EOF that repeated reads return.
    return [this.tokens.at(LAST_TOKEN)!, this.tokens.length];
  }

  public includingNewlines(): boolean {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The newline stack always retains its initial entry.
    return this.includeNewlinesStack.at(LAST_TOKEN)!;
  }

  public pushIncludeNewlines(include: boolean): void {
    this.includeNewlinesStack.push(include);
  }

  public popIncludeNewlines(): boolean {
    if (this.includeNewlinesStack.length === BASE_STACK_DEPTH) {
      // oxlint-disable-next-line rules/require-tagged-error -- Preserve the existing native parser invariant Error without importing Effect.
      throw new Error("unbalanced IncludeNewlinesStack pop");
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A balanced pop is above the retained base entry.
    return this.includeNewlinesStack.pop()!;
  }

  public assertEmptyIncludeNewlinesStack(): void {
    if (this.includeNewlinesStack.length !== BASE_STACK_DEPTH) {
      // oxlint-disable-next-line rules/require-tagged-error -- Preserve the existing native parser invariant Error without importing Effect.
      throw new Error(`non-empty IncludeNewlinesStack after parse: ${this.includeNewlinesStack.join(",")}`);
    }
  }
}
