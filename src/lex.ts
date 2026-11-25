import { isEmptyArray } from "./native-predicates.ts";

// Placeholder lexing for the runtime loader: finds `:name` (and SQLite's `@name` and `$name`), and
// The dialect's own positional form (`$1` on Postgres, `?` on MySQL, `?` and `?NNN` on SQLite, and
// All three on DuckDB),
// Outside strings and comments, and
// Returns the binding order. A name may be dotted
// (`:auth.user_id`); each segment starts like a name, so `arr[1:2]` is a slice, and on Postgres a
// Colon that opens a subscript is a slice with no lower bound (`tags[:n]`). MySQL text is read
// As a session in the default `sql_mode` reads it: a backslash in a string escapes the character
// After it, `"` quotes a string, `#` starts a line comment, and `--` does only before a space or
// A control character. This is the provisional JavaScript version of the engine's lexer; the Rust
// Engine owns the authoritative one (dollar quoting, E'' strings, nested comments, array slices,
// MySQL's other modes).
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep the published placeholder range structurally assignable.
export type Placeholder = { name: string; start: number; end: number };

const BLOCK_COMMENT_END = "*/";
const CAST_MARKER = "::";
const CODE_UNIT_LENGTH = 1;
const ESCAPED_CODE_UNITS = 2;
const ASCII_DELETE = 0x7F;
const ASCII_SPACE = 0x20;
const FIRST_POSITION = 1;
const LINE_COMMENT_MARKER = "--";
const NOT_FOUND = -1;

// MySQL needs a space, a control code or the end of the input after `--`.
const allowsMysqlLineComment = (sql: string, offset: number): boolean => {
  const afterMarker = offset + LINE_COMMENT_MARKER.length;
  const code = sql.codePointAt(afterMarker) ?? ASCII_SPACE;
  return code <= ASCII_SPACE || code === ASCII_DELETE;
};

const START_OFFSET = 0;

interface Quote { backslashes: boolean; quote: string }

const escapedQuote = (sql: string, offset: number, { backslashes, quote }: Quote): boolean => {
  const current = sql[offset];
  return (backslashes && current === "\\") || (current === quote && sql[offset + CODE_UNIT_LENGTH] === quote);
};

const skipQuoted = (sql: string, start: number, token: Quote): number => {
  const cursor = { offset: start + CODE_UNIT_LENGTH };
  while (cursor.offset < sql.length) {
    if (escapedQuote(sql, cursor.offset, token)) {cursor.offset += ESCAPED_CODE_UNITS;}
    else if (sql[cursor.offset] === token.quote) {return cursor.offset + CODE_UNIT_LENGTH;}
    else {cursor.offset += CODE_UNIT_LENGTH;}
  }
  return cursor.offset;
};

/**
 * @param {string} name - A placeholder name with its prefix removed.
 * @returns {boolean} Whether the name consists of decimal digits and represents a position.
 */
export const isPositional = (name: string): boolean => /^\d+$/u.test(name);

type Dialect = "postgres" | "mysql" | "sqlite" | "duckdb";
type Context = "other" | "operand" | "subscript";
interface Character { current: string; next: string; nextOffset: number }
// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve structural assignment to the exported lexer's result.
type Binding = { params: string[]; placeholders: Placeholder[] };

const NORMAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*/u;
const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/u;
const NAME_START = /[A-Za-z_]/u;
const NAME_CHARACTER = /[A-Za-z0-9_]/u;
const WHOLE_WORD = /^[A-Za-z0-9_]+/u;

const namedPrefix = (value: string, dialect: Dialect): boolean =>
  value === ":" || (dialect === "sqlite" && (value === "@" || value === "$"));

const numberedPrefix = (value: string, dialect: Dialect): boolean => {
  if (value === "$") {return dialect === "postgres" || dialect === "duckdb";}
  return value === "?" && (dialect === "sqlite" || dialect === "duckdb");
};

class PlaceholderScanner {
  #sql: string;
  #dialect: Dialect;
  #offset = START_OFFSET;
  #largest = START_OFFSET;
  #last: Context = "other";
  #params: string[] = [];
  #placeholders: Placeholder[] = [];

  public constructor(sql: string, dialect: Dialect) {
    this.#sql = sql;
    this.#dialect = dialect;
  }

  #character(): Character {
    const nextOffset = this.#offset + CODE_UNIT_LENGTH;
    return { current: this.#sql.charAt(this.#offset), next: this.#sql.charAt(nextOffset), nextOffset };
  }

  #record(name: string, end: number): void {
    // oxlint-disable-next-line eslint/sort-keys -- Preserve each public placeholder's property order.
    this.#placeholders.push({ name, start: this.#offset, end });
    if (!this.#params.includes(name)) {this.#params.push(name);}
    this.#offset = end;
    this.#last = "operand";
  }

  #skipLiteral(current: string): boolean {
    const mysql = this.#dialect === "mysql";
    const isString = current === "'" || (current === '"' && mysql);
    if (!isString && current !== '"' && current !== "`") {return false;}
    this.#offset = skipQuoted(this.#sql, this.#offset, { backslashes: isString && mysql, quote: current });
    this.#last = isString ? "other" : "operand";
    return true;
  }

  #lineComment(current: string, next: string): boolean {
    const mysql = this.#dialect === "mysql";
    if (current === "#") {return mysql;}
    return current === "-" && next === "-" && (!mysql || allowsMysqlLineComment(this.#sql, this.#offset));
  }

  #skipComment({ current, next }: Character): boolean {
    if (this.#lineComment(current, next)) {
      const newline = this.#sql.indexOf("\n", this.#offset);
      this.#offset = newline === NOT_FOUND ? this.#sql.length : newline;
      return true;
    }
    if (current !== "/" || next !== "*") {return false;}
    const end = this.#sql.indexOf(BLOCK_COMMENT_END, this.#offset + "/*".length);
    this.#offset = end === NOT_FOUND ? this.#sql.length : end + BLOCK_COMMENT_END.length;
    return true;
  }

  #skipColon({ current, next, nextOffset }: Character): boolean {
    if (current !== ":") {return false;}
    if (next === ":") {
      const start = this.#offset + CAST_MARKER.length;
      const typeName = NORMAL_NAME.exec(this.#sql.slice(start))?.[START_OFFSET] ?? "";
      this.#offset = start + typeName.length;
      this.#last = "operand";
      return true;
    }
    return this.#skipOpenSlice(nextOffset);
  }

  #skipOpenSlice(end: number): boolean {
    // A colon that opens a Postgres subscript takes no lower bound in a slice.
    if (this.#last !== "subscript" || this.#dialect !== "postgres") {return false;}
    this.#offset = end;
    this.#last = "other";
    return true;
  }

  #named({ current, next, nextOffset }: Character): boolean {
    if (!namedPrefix(current, this.#dialect) || !NAME_START.test(next)) {return false;}
    const previous = this.#sql.charAt(this.#offset - CODE_UNIT_LENGTH);
    if (NAME_CHARACTER.test(previous)) {return false;}
    const name = QUALIFIED_NAME.exec(this.#sql.slice(nextOffset))?.[START_OFFSET] ?? next;
    this.#record(name, nextOffset + name.length);
    return true;
  }

  #numbered(next: string, nextOffset: number): void {
    const digits = /^[0-9]+/u.exec(this.#sql.slice(nextOffset))?.[START_OFFSET] ?? next;
    const name = digits.replace(/^0+(?=\d)/u, "");
    this.#largest = Math.max(this.#largest, Number(name));
    this.#record(name, nextOffset + digits.length);
  }

  #positional({ current, next, nextOffset }: Character): boolean {
    if (numberedPrefix(current, this.#dialect) && /[0-9]/u.test(next)) {
      this.#numbered(next, nextOffset);
      return true;
    }
    if (current !== "?" || this.#dialect === "postgres") {return false;}
    this.#largest += FIRST_POSITION;
    this.#record(String(this.#largest), nextOffset);
    return true;
  }

  #punctuation(current: string): Context {
    const previous = this.#sql.charAt(this.#offset - CODE_UNIT_LENGTH);
    if (current === ")" || current === "]" || (current === "$" && NAME_CHARACTER.test(previous))) {return "operand";}
    return current === "[" && this.#last === "operand" ? "subscript" : "other";
  }

  #skipOther({ current, nextOffset }: Character): void {
    if (/\s/u.test(current)) {this.#offset = nextOffset; return;}
    if (NAME_CHARACTER.test(current)) {
      const operand = WHOLE_WORD.exec(this.#sql.slice(this.#offset))?.[START_OFFSET] ?? current;
      this.#last = operand.toLowerCase() === "array" ? "other" : "operand";
      this.#offset += operand.length;
      return;
    }
    this.#last = this.#punctuation(current);
    this.#offset = nextOffset;
  }

  public scan(): Binding {
    while (this.#offset < this.#sql.length) {
      const token = this.#character();
      // This order distinguishes cast syntax and Postgres slices from named placeholders.
      if (!(this.#skipLiteral(token.current) || this.#skipComment(token) ||
        this.#skipColon(token) || this.#named(token) || this.#positional(token))) {this.#skipOther(token);}
    }
    const positional = !isEmptyArray(this.#params) && this.#params.every((name) => isPositional(name));
    const params = positional ? this.#params.toSorted((left, right) => Number(left) - Number(right)) : this.#params;
    return { params, placeholders: this.#placeholders };
  }
}

/**
 * Strip named prefixes and return each placeholder's original range and binding position.
 * @param {string} sql - The original SQL text.
 * @param {Dialect} dialect - The SQL dialect's binding and quoting syntax.
 * @returns {Binding} The parameters and their original offsets.
 */
export const lexPlaceholders = function lexPlaceholders(sql: string, dialect: Dialect): Binding {
  return new PlaceholderScanner(sql, dialect).scan();
};
