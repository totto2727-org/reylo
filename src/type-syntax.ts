import { matchesUndefined } from "./native-predicates.ts";

// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep the public parser's member record structurally assignable.
export type Member = { doc?: string; key: string; type: TypeNode };

export type TypeNode =
  | { kind: "name"; text: string }
  | { kind: "object"; members: Member[] }
  | { kind: "union"; of: TypeNode[] }
  | { kind: "array"; of: TypeNode };

const FIRST_TOKEN = 0;
const NEXT_TOKEN = 1;
const FIRST_COMMENT_LINE = 0;
const TOKEN_PATTERN = /\/\*\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*(?:<[^<>]*>)?|\[\]|[{}()[\]|;:?,]/gu;

class TypeParser {
  #source: string;
  #tokens: string[];
  #at = FIRST_TOKEN;

  public constructor(source: string) {
    this.#source = source;
    this.#tokens = source.match(TOKEN_PATTERN) ?? [];
  }

  public parse(): TypeNode {
    const node = this.#union();
    if (this.#at !== this.#tokens.length) {
      const parsed = this.#tokens.slice(FIRST_TOKEN, this.#at).join(" ");
      // oxlint-disable-next-line rules/require-tagged-error -- This browser-compatible formatter exposes the existing native parse error.
      throw new Error(`type-format: unread text after ${parsed} in ${this.#source}`);
    }
    return node;
  }

  #peek(): string | undefined {
    return this.#tokens[this.#at];
  }

  #take(expected?: string): string {
    const token = this.#peek();
    this.#at += NEXT_TOKEN;
    if (matchesUndefined(token) || (!matchesUndefined(expected) && token !== expected)) {
      // oxlint-disable-next-line rules/require-tagged-error -- The browser formatter uses its existing native token diagnostic.
      throw new Error(`type-format: expected ${expected ?? "a token"} at ${this.#at - NEXT_TOKEN} in ${this.#source}`);
    }
    return token;
  }

  #union(): TypeNode {
    const head = this.#postfix();
    if (this.#peek() !== "|") {return head;}
    const of = [head];
    while (this.#peek() === "|") {
      this.#take("|");
      of.push(this.#postfix());
    }
    return { kind: "union", of };
  }

  #postfix(): TypeNode {
    const cursor = { node: this.#primary() };
    while (this.#peek() === "[]") {
      this.#take("[]");
      cursor.node = { kind: "array", of: cursor.node };
    }
    return cursor.node;
  }

  #primary(): TypeNode {
    if (this.#peek() === "(") {
      this.#take("(");
      const inner = this.#union();
      this.#take(")");
      return inner;
    }
    if (this.#peek() === "{") {return this.#object();}
    return { kind: "name", text: this.#take() };
  }

  #readDoc(): string | undefined {
    if (this.#peek()?.startsWith("/**") !== true) {return undefined;}
    return this.#take().split("\n")
      .map((line, index) => (index > FIRST_COMMENT_LINE ? ` ${line.trim()}` : line.trim())).join("\n");
  }

  #fieldName(): string {
    if (this.#peek() !== "[") {return this.#take();}
    this.#take("[");
    const name = this.#take();
    this.#take(":");
    const indexType = this.#take();
    this.#take("]");
    return `[${name}: ${indexType}]`;
  }

  #field(): Member {
    const doc = this.#readDoc();
    const name = this.#fieldName();
    const key = this.#peek() === "?" ? name + this.#take("?") : name;
    this.#take(":");
    const type = this.#union();
    return { key, type, ...(matchesUndefined(doc) ? {} : { doc }) };
  }

  #object(): TypeNode {
    this.#take("{");
    const members: Member[] = [];
    while (this.#peek() !== "}") {
      members.push(this.#field());
      if (this.#peek() === ";") {this.#take(";");}
    }
    this.#take("}");
    return { kind: "object", members };
  }
}

/**
 * Parse the object, union, array, and name forms that Reylo's type renderer emits.
 * @param {string} text - The TypeScript type text.
 * @returns {TypeNode} The parsed type tree.
 */
export const parseType = function parseType(text: string): TypeNode {
  return new TypeParser(text).parse();
};
