// oxlint-disable-next-line rules/no-node-imports -- Display SQL paths relative to the native working directory.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Use Node's existing terminal styling and color settings.
import { styleText } from "node:util";
import type { Session } from "./analyze.ts";
import type { Diagnostic } from "./engine-core.ts";
import { isEmptyArray, isEmptyString, matchesUndefined } from "./native-predicates.ts";
import { findProjectFile, PROJECT_FILE } from "./project.ts";

export const SUCCESS = 0;
export const QUERY_FAILED = 1;
export const USAGE_ERROR = 2;
const START = 0;
const ONE_BASED = 1;
const DISPLAYED_SKIPS = 3;
const MILLIS_PER_SECOND = 1000;
const TIME_DIGITS = 1;

export const out = (text: string): void => {
  // oxlint-disable-next-line eslint/no-console -- Printed CLI reports are the command's output.
  console.log(text);
};

export const err = (text: string): void => {
  // oxlint-disable-next-line eslint/no-console -- Usage failures are the CLI's stderr output.
  console.error(text);
};

export const shown = (file: string): string => {
  const displayed = path.relative(process.cwd(), file).split(path.sep).join("/");
  return isEmptyString(displayed) ? "." : displayed;
};

export const paint = (format: Parameters<typeof styleText>[typeof START], text: string): string => styleText(format, text);

interface Located { at: string; frame: string[] }

const caretFrame = (line: string, number: number, { column, span }: { column: number; span: number }): string[] => {
  const gutter = String(number);
  // oxlint-disable-next-line eslint/require-unicode-regexp -- Columns are UTF-16 units, so a surrogate pair contributes two spaces before its caret.
  const padding = line.slice(START, column).replaceAll(/[^\t]/g, " ");
  return [
    `  ${paint("dim", `${gutter} |`)} ${line}`,
    `  ${paint("dim", `${" ".repeat(gutter.length)} |`)} ${padding}${paint("red", "^".repeat(span))}`,
  ];
};

const located = (text: string, { start, length }: Diagnostic): Located => {
  const bytes = Buffer.from(text, "utf8");
  const before = bytes.subarray(START, start).toString("utf8");
  const lineNumber = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n") - ONE_BASED;
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The byte prefix cannot add a newline to its decoded SQL text.
  const line = text.split("\n")[lineNumber - ONE_BASED]!.replace(/\r$/u, "");
  const span = Math.max(ONE_BASED, Math.min(bytes.subarray(start, start + length).toString("utf8").length, line.length - column));
  return { at: `${lineNumber}:${column + ONE_BASED}`, frame: caretFrame(line, lineNumber, { column, span }) };
};

export const statementDiagnostic = (file: string, sql: string, diagnostic: Diagnostic): string[] => {
  const { at, frame } = located(sql, diagnostic);
  // Some native drivers place their diagnostic across the whole statement.
  const whole = diagnostic.start === START && diagnostic.length >= Buffer.byteLength(sql.trimEnd());
  return [`${paint("bold", `${shown(file)}:${at}`)}: ${diagnostic.message}`, ...(whole ? [] : frame)];
};

export interface Result { errors: string[][]; failed: string[]; skipped: string[]; typed: number }
export interface Row { file: string; ok: boolean }

export const showRows = (rows: Row[], result: Result): void => {
  const width = Math.max(...rows.map(({ file }) => shown(file).length));
  Iterator.from(rows).forEach(({ file, ok }) => {
    if (ok) {result.typed += ONE_BASED;}
    else {result.failed.push(file);}
    out(`  ${shown(file).padEnd(width)}  ${ok ? paint("green", "✓") : paint("red", "✗")}`);
  });
};

const showSkipped = (skipped: string[]): void => {
  if (isEmptyArray(skipped)) {return;}
  const shownPaths = skipped.slice(START, DISPLAYED_SKIPS).map((file) => shown(file)).join(", ");
  const rest = skipped.length - DISPLAYED_SKIPS;
  const listed = shownPaths + (rest > START ? ` and ${rest} more` : "");
  out(paint("dim", `\nSkipped ${skipped.length === ONE_BASED ? "1 file that is" : `${skipped.length} files that are`} not one query (a migration?): ${listed}`));
};

interface Context { paths: string[]; projects: Map<Session, string[]>; started: number }

const projectWithNoQuery = ({ paths, projects }: Context): string | undefined => {
  if (projects.size === ONE_BASED) {return projects.keys().next().value?.project.file;}
  if (projects.size === START && paths.length <= ONE_BASED) {return findProjectFile(path.resolve(paths[START] ?? "."));}
  return undefined;
};

const noQuery = (context: Context, skipped: string[]): number => {
  const own = projectWithNoQuery(context);
  const paths = isEmptyArray(context.paths) ? ["."] : context.paths;
  const lead = isEmptyArray(skipped) ? "" : "\n";
  out(`${lead}No query under ${paths.join(", ")}: name the directory that holds them, or set cli.include in ${matchesUndefined(own) || isEmptyString(own) ? PROJECT_FILE : shown(own)}.`);
  return QUERY_FAILED;
};

const showStatus = ({ failed, skipped, typed }: Result, context: Context): number => {
  const seconds = ((performance.now() - context.started) / MILLIS_PER_SECOND).toFixed(TIME_DIGITS);
  const total = typed + failed.length;
  if (!isEmptyArray(failed)) {
    out(`\n${paint("red", "✗")} ${failed.length} of ${total} ${total === ONE_BASED ? "query" : "queries"} failed (${seconds} s)`);
    return QUERY_FAILED;
  }
  if (typed === START) {return noQuery(context, skipped);}
  out(`\n${paint("green", "✓")} ${typed} ${typed === ONE_BASED ? "query" : "queries"} typed (${seconds} s)`);
  return SUCCESS;
};

export const summarize = (result: Result, context: Context): number => {
  Iterator.from(result.errors).forEach((lines) => {out(`\n${lines.join("\n")}`);});
  showSkipped(result.skipped);
  return showStatus(result, context);
};
