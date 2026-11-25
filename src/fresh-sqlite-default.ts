import { matchesUndefined } from "./native-predicates.ts";

export const asciiLower = (text: string): string =>
  text.replaceAll(/[A-Z]+/gu, (letters) => letters.toLowerCase());

const asciiUpper = (text: string): string =>
  text.replaceAll(/[a-z]+/gu, (letters) => letters.toUpperCase());

const TEXT_START = 0;
const CODE_UNIT_WIDTH = 1;
const DOUBLED_QUOTE_WIDTH = 2;
const DEPTH_STEP = 1;
const NO_NESTING = 0;
const NO_CLOSING_PAREN = -1;

const closingQuote = (text: string, opening: number): number => {
  const cursor = { offset: opening + CODE_UNIT_WIDTH };
  while (cursor.offset < text.length) {
    const { offset } = cursor;
    if (text[offset] === "'") {
      if (text[offset + CODE_UNIT_WIDTH] !== "'") {return offset;}
      cursor.offset += DOUBLED_QUOTE_WIDTH;
    } else {
      cursor.offset += CODE_UNIT_WIDTH;
    }
  }
  return cursor.offset;
};

const adjustDepth = (cursor: { depth: number; offset: number }, text: string): void => {
  const character = text[cursor.offset];
  if (character === "'") {cursor.offset = closingQuote(text, cursor.offset);}
  else if (character === "(") {cursor.depth += DEPTH_STEP;}
  else if (character === ")") {cursor.depth -= DEPTH_STEP;}
};

// Find the matching parenthesis, skipping quoted strings.
const closes = (text: string): number => {
  const cursor = { depth: NO_NESTING, offset: TEXT_START };
  while (cursor.offset < text.length) {
    adjustDepth(cursor, text);
    if (cursor.depth === NO_NESTING) {return cursor.offset;}
    cursor.offset += CODE_UNIT_WIDTH;
  }
  return NO_CLOSING_PAREN;
};

// Bare identifiers retain the scanner's original range, including lone surrogates and astral code points.
const SQLITE_IDENTIFIER = /^(?:"(?<doubleQuoted>(?:[^"]|"")*)"|`(?<backtickQuoted>(?:[^`]|``)*)`|\[(?<bracketed>[^\]]*)\]|(?<bare>[A-Za-z_\u0080-\u{10FFFF}][\w$\u0080-\u{10FFFF}]*))$/u;
const SQLITE_DEFAULT_KEYWORD = /^(?:true|false|null|current_time|current_date|current_timestamp)$/u;

const quoteSqliteIdentifier = (name: string): string => `'${name.replaceAll("'", "''")}'`;

const identifierDefault = (text: string): string | undefined => {
  const identifier = SQLITE_IDENTIFIER.exec(text)?.groups;
  if (matchesUndefined(identifier)) {return undefined;}
  const { backtickQuoted, bare, bracketed, doubleQuoted } = identifier;
  const name = doubleQuoted?.replaceAll('""', '"') ?? backtickQuoted?.replaceAll("``", "`") ?? bracketed;
  if (!matchesUndefined(name)) {return quoteSqliteIdentifier(name);}
  return matchesUndefined(bare) || SQLITE_DEFAULT_KEYWORD.test(asciiLower(bare))
    ? undefined
    : quoteSqliteIdentifier(bare);
};

const appendQuoted = (cursor: { offset: number; text: string }, source: string): void => {
  const next = closingQuote(source, cursor.offset) + CODE_UNIT_WIDTH;
  cursor.text += source.slice(cursor.offset, next);
  cursor.offset = next;
};

const expressionText = (source: string): string => {
  const cursor = { offset: TEXT_START, text: "" };
  while (cursor.offset < source.length) {
    const character = source.charAt(cursor.offset);
    if (character === "'") {
      appendQuoted(cursor, source);
    } else {
      cursor.text += /\s/u.test(character) ? "" : asciiUpper(character);
      cursor.offset += CODE_UNIT_WIDTH;
    }
  }
  return cursor.text;
};

const stripWrappingParentheses = (expression: string): string => {
  const state = { text: expression };
  while (state.text.startsWith("(") && state.text.endsWith(")") &&
    closes(state.text) === state.text.length - CODE_UNIT_WIDTH) {
    state.text = state.text.slice(CODE_UNIT_WIDTH, -CODE_UNIT_WIDTH);
  }
  return state.text;
};

/**
 * A SQLite default's text in one spelling, since engines that read the same schema write it
 * differently: `pragma_table_xinfo` gives the text as written on SQLite (`member`,
 * `lower(hex(randomblob(4)))`, `-7`, `current_timestamp`), and Turso's engine writes it again
 * (`'member'`, `(lower (hex (randomblob (4))))`, `- 7`, `CURRENT_TIMESTAMP`), which evaluates the
 * same (wiki/structured-params/default-extraction.md). Outside its strings the text loses its
 * spaces and its ASCII case and the parentheses around it all, and a lone identifier is the string
 * SQLite stores for it, as the upstream engine copies it (engine/core/src/structured.rs).
 * @param {string} text - The SQL expression emitted by the catalog.
 * @returns {string} The spelling used to compare SQLite defaults.
 */
export const sqliteDefault = function sqliteDefault(text: string): string {
  const trimmed = text.trim();
  return identifierDefault(trimmed) ?? stripWrappingParentheses(expressionText(trimmed));
};
