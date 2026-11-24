// The doc comments of a statement's module: the comment written at the top of the `.sql` file as
// Prose, then the statement in a `sql` code block, so an editor's hover over the import (or over
// Its `.sql`) shows them as it shows any declaration's JSDoc. It imports nothing from Node.
import type { Dialect } from "./engine.ts";

/** The comments before a statement, as prose, and the offset where they end. */
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
  while (trimmed.length && !trimmed[START]) {trimmed.shift();}
  while (trimmed.length && !trimmed.at(LAST)) {trimmed.pop();}
  const indent = Math.min(...trimmed.filter((line) => line).map((line) => leadingIndent(line)));
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

const readComment = (sql: string, start: number, dialect: Dialect | undefined): Comment | undefined => {
  const marker = lineMarkerLength(sql, start, dialect);
  if (marker > EMPTY) {
    const stop = sql.indexOf("\n", start);
    const end = stop === NOT_FOUND ? sql.length : stop;
    return { end, kind: "line", lines: [sql.slice(start + marker, end)] };
  }
  if (!sql.startsWith(BLOCK_START, start)) {
    return undefined;
  }
  const contentStart = start + BLOCK_START.length;
  if (dialect === "mysql" && (sql[contentStart] === "!" || sql[contentStart] === "+")) {
    return undefined;
  }
  return readBlock(sql, contentStart, dialect === "postgres" || dialect === "duckdb");
};

/**
 * The `--` lines and `/* … *\/` blocks before the statement's first token, markers stripped and
 * lines kept: a blank line between two comments, or a change from one form to the other, starts a
 * paragraph. Read as the dialect reads comments: Postgres nests block comments, MySQL's `--` is one
 * only before a space or a control character and `#` starts one too, and MySQL's `/*!` and `/*+`
 * are code to the server, so they end the prose. With no dialect (no project), `--` and `/* *\/`.
 * @param sql - The SQL file's source.
 * @param dialect - The comment syntax used by the project.
 * @returns The leading prose and the offset of the last comment.
 */
export const leadingComment = (sql: string, dialect?: Dialect): Leading => {
  const paragraphs: string[][] = [];
  const cursor: { end: number; lineParagraph?: string[] } = { end: START };
  while (cursor.end < sql.length) {
    const whitespace = /^\s*/u.exec(sql.slice(cursor.end))?.[START] ?? "";
    const start = cursor.end + whitespace.length;
    const comment = readComment(sql, start, dialect);
    if (!comment) {break;}
    const blankBefore = (whitespace.match(/\n/gu)?.length ?? EMPTY) > ONE_LINE_BREAK;
    if (comment.kind === "line" && cursor.lineParagraph && !blankBefore) {
      cursor.lineParagraph.push(...comment.lines);
    } else {
      paragraphs.push(comment.lines);
      if (comment.kind === "line") {cursor.lineParagraph = comment.lines;}
      else {delete cursor.lineParagraph;}
    }
    cursor.end = comment.end;
  }
  const prose = paragraphs
    .map((lines) => dedent(lines))
    .filter((lines) => lines.length)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
  // oxlint-disable-next-line eslint/sort-keys -- Keep the prose and offset in their existing order for consumers.
  return { prose, end: cursor.end };
};

/** The statement after its leading comments, its blank edges trimmed. */
export function statementAfter(sql: string, leading: Leading): string {
  return sql.slice(leading.end).trim();
}

/** The fence a Markdown text opens and never closes, which would take in what follows it. */
function openFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const regexMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (!regexMatch) {continue;}
    if (!open) {open = regexMatch[1];}
    else if (regexMatch[1]![0] === open[0] && regexMatch[1]!.length >= open.length && !line.slice(regexMatch[0].length).trim()) {open = undefined;}
  }
  return open;
}

/**
 * A JSDoc comment, indented by `indent`: the prose, then `sql` in a fenced `sql` block, then
 * `note`, each a paragraph where it is given. A star before a slash would end the comment, so a
 * backslash goes between them; the fence is longer than any run of backticks in the statement, and
 * a fence the prose leaves open is closed before the block. Empty when there is nothing to say.
 */
export function docComment(prose: string, sql: string | undefined, note = "", indent = ""): string {
  const parts: string[] = [];
  if (prose) {
    const open = openFence(prose);
    parts.push(open ? `${prose}\n${open}` : prose);
  }
  if (sql) {
    const longest = Math.max(0, ...(sql.match(/`+/gu) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    parts.push(`${fence}sql\n${sql}\n${fence}`);
  }
  if (note) {parts.push(note);}
  if (!parts.length) {return "";}
  const body = parts.join("\n\n").replaceAll("*/", "*\\/").split("\n");
  return [`${indent}/**`, ...body.map((l) => (l ? `${indent} * ${l}` : `${indent} *`)), `${indent} */`, ""].join("\n");
}
