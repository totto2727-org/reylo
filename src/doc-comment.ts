// The doc comments of a statement's module: the comment written at the top of the `.sql` file as
// Prose, then the statement in a `sql` code block, so an editor's hover over the import (or over
// Its `.sql`) shows them as it shows any declaration's JSDoc. It imports nothing from Node.
import type { Dialect } from "./engine-core.ts";
import { isEmptyString, matchesNull, matchesNullish, matchesUndefined } from "./native-predicates.ts";

/** The comments before a statement, as prose, and the offset where they end. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public leading-comment record's structural assignability.
export type Leading = { prose: string; end: number };

const START = 0;
const EMPTY = 0;
const LAST = -1;
const NOT_FOUND = -1;
const ONE_CODE_UNIT = 1;
const ONE_LINE_BREAK = 1;
const OUTERMOST_BLOCK_DEPTH = 1;
const ASCII_SPACE = 32;
const ASCII_DELETE = 127;
const LINE_MARKER = "--";
const MYSQL_LINE_MARKER = "#";
const BLOCK_START = "/*";
const BLOCK_END = "*/";
const MIN_FENCE_LENGTH = 3;

interface Comment {
  end: number;
  kind: "line" | "block";
  lines: string[];
}

const blockLines = (text: string): string[] => {
  const [first = "", ...tail] = text.replace(/^\*+/u, "").split(/\r?\n/u);
  const remaining = tail.filter((line) => line.trim().length);
  if (remaining.length && remaining.every((line) => /^\s*\*/u.test(line))) {
    return [first, ...tail.map((line) => line.replace(/^\s*\*(?!\/) ?/u, ""))];
  }
  return [first, ...tail];
};

const leadingIndent = (line: string): number => /^[ \t]*/u.exec(line)?.[START].length ?? EMPTY;

const dedent = (lines: string[]): string[] => {
  const trimmed = lines.map((line) => line.replace(/\s+$/u, ""));
  while (trimmed.length > EMPTY && isEmptyString(trimmed[START] ?? "")) {trimmed.shift();}
  while (trimmed.length > EMPTY && isEmptyString(trimmed.at(LAST) ?? "")) {trimmed.pop();}
  const indent = Math.min(...trimmed.filter(Boolean).map((line) => leadingIndent(line)));
  return trimmed.map((line) => line.slice(Math.min(indent, leadingIndent(line))));
};

const lineMarkerLength = (sql: string, start: number, dialect: Dialect | undefined): number => {
  if (dialect === "mysql" && sql.startsWith(MYSQL_LINE_MARKER, start)) {
    return MYSQL_LINE_MARKER.length;
  }
  if (!sql.startsWith(LINE_MARKER, start)) {
    return EMPTY;
  }
  const markerEnd = start + LINE_MARKER.length;
  const following = sql.codePointAt(markerEnd) ?? ASCII_SPACE;
  const permitted = following <= ASCII_SPACE || following === ASCII_DELETE;
  return dialect === "mysql" && !permitted ? EMPTY : LINE_MARKER.length;
};

const readBlock = (sql: string, contentStart: number, nested: boolean): Comment => {
  const cursor = { depth: OUTERMOST_BLOCK_DEPTH, end: contentStart };
  while (cursor.end < sql.length && cursor.depth > EMPTY) {
    if (sql.startsWith(BLOCK_END, cursor.end)) {
      cursor.depth -= OUTERMOST_BLOCK_DEPTH;
      cursor.end += BLOCK_END.length;
    } else if (nested && sql.startsWith(BLOCK_START, cursor.end)) {
      cursor.depth += OUTERMOST_BLOCK_DEPTH;
      cursor.end += BLOCK_START.length;
    } else {
      cursor.end += ONE_CODE_UNIT;
    }
  }
  const contentEnd = cursor.depth === EMPTY ? cursor.end - BLOCK_END.length : sql.length;
  return { end: cursor.end, kind: "block", lines: blockLines(sql.slice(contentStart, contentEnd)) };
};

const readLine = (sql: string, start: number, marker: number): Comment => {
  const stop = sql.indexOf("\n", start);
  const end = stop === NOT_FOUND ? sql.length : stop;
  return { end, kind: "line", lines: [sql.slice(start + marker, end)] };
};

const readComment = (sql: string, start: number, dialect: Dialect | undefined): Comment | undefined => {
  const marker = lineMarkerLength(sql, start, dialect);
  if (marker > EMPTY) {return readLine(sql, start, marker);}
  if (!sql.startsWith(BLOCK_START, start)) {
    return undefined;
  }
  const contentStart = start + BLOCK_START.length;
  if (dialect === "mysql" && (sql[contentStart] === "!" || sql[contentStart] === "+")) {
    return undefined;
  }
  return readBlock(sql, contentStart, dialect === "postgres" || dialect === "duckdb");
};

interface Comments { end: number; lineParagraph?: string[]; paragraphs: string[][] }

const keepComment = (cursor: Comments, comment: Comment, whitespace: string): void => {
  const blankBefore = (whitespace.match(/\n/gu)?.length ?? EMPTY) > ONE_LINE_BREAK;
  if (comment.kind === "line" && cursor.lineParagraph && !blankBefore) {cursor.lineParagraph.push(...comment.lines);}
  else {
    cursor.paragraphs.push(comment.lines);
    if (comment.kind === "line") {cursor.lineParagraph = comment.lines;}
    else {delete cursor.lineParagraph;}
  }
  cursor.end = comment.end;
};

/**
 * The `--` lines and `/* … *\/` blocks before the statement's first token, markers stripped and
 * lines kept: a blank line between two comments, or a change from one form to the other, starts a
 * paragraph. Read as the dialect reads comments: Postgres nests block comments, MySQL's `--` is one
 * only before a space or a control character and `#` starts one too, and MySQL's `/*!` and `/*+`
 * are code to the server, so they end the prose. With no dialect (no project), `--` and `/* *\/`.
 * @param {string} sql - The SQL file's source.
 * @param {Dialect} [dialect] - The comment syntax for the project.
 * @returns {Leading} The leading prose and the end offset of the last comment.
 */
export const leadingComment = (sql: string, dialect?: Dialect): Leading => {
  const cursor: Comments = { end: START, paragraphs: [] };
  while (cursor.end < sql.length) {
    const whitespace = /^\s*/u.exec(sql.slice(cursor.end))?.[START] ?? "";
    const start = cursor.end + whitespace.length;
    const comment = readComment(sql, start, dialect);
    if (matchesUndefined(comment)) {break;}
    keepComment(cursor, comment, whitespace);
  }
  const prose = cursor.paragraphs
    .map((lines) => dedent(lines))
    .filter((lines) => lines.length)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
  // oxlint-disable-next-line eslint/sort-keys -- Keep the prose and offset in their existing order for consumers.
  return { prose, end: cursor.end };
};

/**
 * The statement after its leading comments, its blank edges trimmed.
 * @param {string} sql - The SQL file's source.
 * @param {Leading} leading - The end offset from `leadingComment`.
 * @returns {string} The statement without leading and trailing blank space.
 */
export const statementAfter = function statementAfter(sql: string, leading: Leading): string {
  return sql.slice(leading.end).trim();
};

/**
 * The fence a Markdown text opens and never closes, which would take in what follows it.
 * @param {string} text - The Markdown text before the SQL code block.
 * @returns {string | undefined} The open fence, if there is one.
 */
const openFence = function openFence(text: string): string | undefined {
  const state: { open?: string } = {};
  Iterator.from(text.split("\n")).forEach((line) => {
    const match = /^ {0,3}(?<fence>`{3,}|~{3,})/u.exec(line);
    if (matchesNull(match)) {return;}
    const fence = match.groups?.fence;
    if (matchesUndefined(fence)) {return;}
    const { open } = state;
    if (matchesUndefined(open)) {state.open = fence;}
    else if (fence.startsWith(open.charAt(START)) && fence.length >= open.length && isEmptyString(line.slice(match[START].length).trim())) {
      delete state.open;
    }
  });
  return state.open;
};

const sqlBlock = (sql: string): string => {
  const longest = Math.max(EMPTY, ...(sql.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(MIN_FENCE_LENGTH, longest + ONE_CODE_UNIT));
  return `${fence}sql\n${sql}\n${fence}`;
};

const markdownParts = (prose: string, sql: string | undefined, note: string): string[] => {
  const parts: string[] = [];
  if (prose) {
    const open = openFence(prose);
    parts.push(matchesUndefined(open) ? prose : `${prose}\n${open}`);
  }
  if (!matchesNullish(sql) && !isEmptyString(sql)) {parts.push(sqlBlock(sql));}
  if (note) {parts.push(note);}
  return parts;
};


/**
 * A JSDoc comment, indented by `indent`: the prose, then `sql` in a fenced `sql` block, then
 * `note`, each a paragraph where it is given. A star before a slash would end the comment, so a
 * backslash goes between them; the fence is longer than any run of backticks in the statement, and
 * a fence the prose leaves open is closed before the block. Empty when there is nothing to say.
 * @param {string} prose - The text before the SQL code block.
 * @param {string | undefined} sql - The SQL text for the code block.
 * @param {string} [note] - The text after the SQL code block.
 * @param {string} [indent] - The prefix before each JSDoc line.
 * @returns {string} The JSDoc comment, including its final line break.
 */
// oxlint-disable-next-line eslint/max-params -- Keep the public JSDoc renderer's positional arguments.
export const docComment = function docComment(prose: string, sql: string | undefined, note = "", indent = ""): string {
  const parts = markdownParts(prose, sql, note);
  if (!parts.length) {return "";}
  const body = parts.join("\n\n").replaceAll("*/", String.raw`*\/`).split("\n");
  return [`${indent}/**`, ...body.map((line) => (line ? `${indent} * ${line}` : `${indent} *`)), `${indent} */`, ""].join("\n");
};
