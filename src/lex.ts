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

/**
 * Skip to the end of a quoted token. A doubled quote, or an enabled backslash escape,
 * consumes both code units as a single character.
 * @param {string} sql - The original SQL text.
 * @param {number} start - The offset of the opening quote.
 * @param {string} quote - The character that ends the token.
 * @param {boolean} escapes - Whether this dialect recognizes a backslash escape in the token.
 * @returns {number} The first offset after the quoted token.
 */
const skipQuoted = function skipQuoted(sql: string, start: number, quote: string, escapes: boolean): number {
  let offset = start + CODE_UNIT_LENGTH;
  while (offset < sql.length) {
    if (escapes && sql[offset] === "\\") { offset += ESCAPED_CODE_UNITS; continue; }
    if (sql[offset] === quote) {
      if (sql[offset + CODE_UNIT_LENGTH] === quote) { offset += ESCAPED_CODE_UNITS; continue; }
      return offset + CODE_UNIT_LENGTH;
    }
    offset += CODE_UNIT_LENGTH;
  }
  return offset;
};

/**
 * @param {string} name - A placeholder name with its prefix removed.
 * @returns {boolean} Whether the name consists of decimal digits and represents a position.
 */
export const isPositional = (name: string): boolean => /^\d+$/u.test(name);

/**
 * Strip each named parameter's prefix (`:id` becomes `id`). `$2` and `?2` use the name `2`.
 * A bare `?` takes the next number after the largest one already read.
 * @param {string} sql - The original SQL text with dialect-specific placeholders.
 * @param {"postgres" | "mysql" | "sqlite" | "duckdb"} dialect - The dialect that defines placeholder, comment, and string syntax.
 * @returns {{ params: string[], placeholders: Placeholder[] }} The parameter binding order and the matching spans in the original SQL.
 */
export const lexPlaceholders = function lexPlaceholders(sql: string, dialect: "postgres" | "mysql" | "sqlite" | "duckdb"): { params: string[]; placeholders: Placeholder[] } {
  const placeholders: Placeholder[] = [];
  const params: string[] = [];
  let largest = 0;
  let offset = 0;
  const push = (name: string, start: number, end: number): void => {
    placeholders.push({ name, start, end });
    if (!params.includes(name)) {params.push(name);}
  };
  const position = (digits: string): string => {
    const normalized = digits.replace(/^0+(?=\d)/u, "");
    largest = Math.max(largest, Number(normalized));
    return normalized;
  };
  const mysql = dialect === "mysql";
  // What was read last, past whitespace and comments: an operand (a name other than `array`, a
  // Number, a quoted name, a placeholder, `)` or `]`), the `[` of a subscript after one, or other.
  let last: "other" | "operand" | "subscript" = "other";
  while (offset < sql.length) {
    const character = sql.charAt(offset);
    const nextOffset = offset + CODE_UNIT_LENGTH;
    const next = sql.charAt(nextOffset);
    if (character === "'" || (character === '"' && mysql)) { offset = skipQuoted(sql, offset, character, mysql); last = "other"; continue; }
    if (character === '"' || character === "`") { offset = skipQuoted(sql, offset, character, false); last = "operand"; continue; }
    const beginsLineComment = character === "-" && next === "-";
    const comment = character === "#" ? mysql : beginsLineComment && (!mysql || allowsMysqlLineComment(sql, offset));
    if (comment) { offset = sql.indexOf("\n", offset); if (offset === NOT_FOUND) {break;} continue; }
    if (character === "/" && next === "*") {
      const end = sql.indexOf(BLOCK_COMMENT_END, offset + "/*".length);
      offset = end === NOT_FOUND ? sql.length : end + BLOCK_COMMENT_END.length;
      continue;
    }
    if (character === ":" && next === ":") {
      // A `::` cast: the type name after it is not a parameter.
      const typeStart = offset + CAST_MARKER.length;
      const typeName = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(sql.slice(typeStart))?.[0] ?? "";
      offset = typeStart + typeName.length;
      last = "operand";
      continue;
    }
    // A colon that opens a Postgres subscript is a slice with no lower bound, since no expression
    // Starts with a colon there; an array constructor's `[` follows `array` or another `[`.
    if (character === ":" && last === "subscript" && dialect === "postgres") { offset = nextOffset; last = "other"; continue; }
    // `arr[lo:hi]` is a slice: a name character before the colon means it opens nothing. SQLite's
    // Own `@name` and `$name` are named placeholders there too.
    const previous = sql.charAt(offset - CODE_UNIT_LENGTH);
    if ((character === ":" || (dialect === "sqlite" && (character === "@" || character === "$"))) && /[A-Za-z_]/u.test(next) && !/[A-Za-z0-9_]/u.test(previous)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/u.exec(sql.slice(nextOffset))?.[0] ?? next;
      const end = nextOffset + name.length;
      push(name, offset, end);
      offset = end;
      last = "operand";
      continue;
    }
    const numberedDollar = character === "$" && (dialect === "postgres" || dialect === "duckdb");
    const numberedQuestion = character === "?" && (dialect === "sqlite" || dialect === "duckdb");
    if ((numberedDollar || numberedQuestion) && /[0-9]/u.test(next)) {
      const digits = /^[0-9]+/u.exec(sql.slice(nextOffset))?.[0] ?? next;
      const end = nextOffset + digits.length;
      push(position(digits), offset, end);
      offset = end;
      last = "operand";
      continue;
    }
    if (character === "?" && dialect !== "postgres") {
      largest += FIRST_POSITION;
      push(String(largest), offset, nextOffset);
      offset = nextOffset;
      last = "operand";
      continue;
    }
    if (/\s/u.test(character)) { offset = nextOffset; continue; }
    if (/[A-Za-z0-9_]/u.test(character)) {
      // A name or a number, whole: `array` opens a constructor, anything else is an operand.
      const operand = /^[A-Za-z0-9_]+/u.exec(sql.slice(offset))?.[0] ?? character;
      last = operand.toLowerCase() === "array" ? "other" : "operand";
      offset += operand.length;
      continue;
    }
    const closesOperand = character === ")" || character === "]" || (character === "$" && /[A-Za-z0-9_]/u.test(previous));
    const opensSubscript: boolean = character === "[" && last === "operand";
    if (closesOperand) {last = "operand";}
    else {last = opensSubscript ? "subscript" : "other";}
    offset = nextOffset;
  }
  // Positional parameters bind by number, whatever order they appear in.
  if (params.length && params.every((name) => isPositional(name))) {params.sort((left, right) => Number(left) - Number(right));}
  return { params, placeholders };
};
