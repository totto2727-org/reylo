// The reylo generate CLI writes analysis to the cache shared by the type checker and bundlers.
// oxlint-disable-next-line rules/no-node-imports -- Read SQL from each file discovered by the native CLI.
import { readFileSync } from "node:fs";
import { Session } from "./analyze.ts";
import { gatherTargets, groupProjects } from "./command-input.ts";
import { err, out, paint, showRows, shown, statementDiagnostic, SUCCESS, summarize, USAGE_ERROR } from "./command-output.ts";
import type { Result, Row } from "./command-output.ts";
import type { Diagnostic } from "./engine-core.ts";
import { isEmptyArray, matchesNull, matchesString, matchesUndefined, nonemptyText } from "./native-predicates.ts";

const USAGE = `Usage: reylo generate [paths...] [--force]

Analyzes every .sql file under the paths (by default the current directory) into .reylo/: the
cache that the type check and the build steps read. A file of several statements (a migration)
is skipped, and a run that finds no query fails. --force analyzes each file against the database
even when .reylo/ holds it.

Which files are queries can be set in .reylo.yaml; the globs are relative to it:

  cli:
    include: ["src/**/*.sql"]   # instead of every .sql file
    exclude: ["src/legacy/**"]  # in addition to dependencies, build output and what git ignores`;

const NOT_A_QUERY = /^A typed \.sql file holds one statement and this one holds several, |^cannot insert multiple commands into a prepared statement/u;

interface Availability { offline: boolean; unusable?: string | undefined }

const schemaAvailability = async (session: Session): Promise<Availability> => {
  const schema = await session.schema();
  if (schema.fatal === true) {return { offline: false, unusable: nonemptyText(schema.error) };}
  if (!matchesNull(schema.value)) {return { offline: false };}
  out(paint("dim", `${session.cannotConnect(schema.error)}; the files are read from .reylo/ as they are.`));
  return { offline: true };
};

const availability = async (session: Session): Promise<Availability> => {
  const { project } = session;
  const url = nonemptyText(project.url);
  const notice = nonemptyText(project.notice);
  if (!matchesUndefined(url) && !matchesUndefined(notice)) {out(paint("yellow", notice));}
  const unusable = nonemptyText(project.error ?? (matchesUndefined(url) ? project.missingUrl : undefined));
  return matchesUndefined(unusable) ? schemaAvailability(session) : { offline: false, unusable };
};

interface AnalysisContext { force: boolean; offline: boolean; result: Result; session: Session }

const failureText = ({ force, offline }: AnalysisContext, message: string): string => {
  if (!offline) {return message;}
  return force ? "--force needs the database, which cannot be reached" : "not in .reylo/, and the database cannot be reached";
};

const reportAnalysis = ({ file, sql }: { file: string; sql: string }, diagnostics: Diagnostic[], result: Result): Row | undefined => {
  if (diagnostics.some((diagnostic) => NOT_A_QUERY.test(diagnostic.message))) {
    result.skipped.push(file);
    return undefined;
  }
  if (isEmptyArray(diagnostics)) {return { file, ok: true };}
  result.errors.push(diagnostics.flatMap((diagnostic) => statementDiagnostic(file, sql, diagnostic)));
  return { file, ok: false };
};

const analyzeFile = async (file: string, context: AnalysisContext): Promise<Row | undefined> => {
  // oxlint-disable-next-line node/no-sync -- Analyze each complete SQL file in the command's ordered read pass.
  const sql = readFileSync(file, "utf8");
  const { force, result, session } = context;
  const outcome = await session.analyze(sql, { force });
  if (!outcome.ok) {
    result.errors.push([`${paint("bold", shown(file))}: ${failureText(context, outcome.message)}`]);
    return { file, ok: false };
  }
  return reportAnalysis({ file, sql }, outcome.analysis.diagnostics, result);
};

const rowsFor = async (files: string[], context: AnalysisContext): Promise<Row[]> => {
  const rows: Row[] = [];
  // oxlint-disable-next-line rules/no-for-loops -- Analyze each project's files serially through its open native session.
  for (const file of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Finish this file's analysis and cache entry before the next call.
    const row = await analyzeFile(file, context);
    if (!matchesUndefined(row)) {rows.push(row);}
  }
  return rows;
};

const projectTitle = (session: Session): void => {
  const { project } = session;
  const here = session.root === process.cwd() ? "" : `${shown(session.root)}: `;
  out(paint("dim", `${here}${project.dialect} at ${session.where()} (${project.urlSource})`));
};

interface RunOptions { force: boolean; result: Result }

const runProject = async (session: Session, files: string[], { force, result }: RunOptions): Promise<void> => {
  if (isEmptyArray(files)) {return;}
  projectTitle(session);
  const { offline, unusable } = await availability(session);
  if (matchesUndefined(unusable)) {
    const rows = await rowsFor(files, { force, offline, result, session });
    showRows(rows, result);
    return;
  }
  result.errors.push([paint("red", unusable)]);
  showRows(files.map((file) => ({ file, ok: false })), result);
};

const runProjects = async (projects: Map<Session, string[]>, force: boolean): Promise<Result> => {
  const result: Result = { errors: [], failed: [], skipped: [], typed: SUCCESS };
  // oxlint-disable-next-line rules/no-for-loops -- Project analysis and its printed rows keep the established project order.
  for (const [session, files] of projects) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each project finishes before opening the next analysis pass.
    await runProject(session, files, { force, result });
  }
  // oxlint-disable-next-line rules/no-for-loops -- Close all native sessions before printing the summary.
  for (const session of Session.opened()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Keep native session shutdown and failure order stable.
    await session.close();
  }
  return result;
};

const generatePaths = async (paths: string[], force: boolean): Promise<number> => {
  const started = performance.now();
  const targets = await gatherTargets(paths);
  if (matchesString(targets)) {
    err(`reylo generate: ${targets}`);
    return USAGE_ERROR;
  }
  const projects = await groupProjects(targets);
  const result = await runProjects(projects, force);
  return summarize(result, { paths, projects, started });
};

const generate = async (args: string[]): Promise<number> => {
  const force = args.includes("--force");
  const unknown = args.filter((argument) => argument.startsWith("-") && argument !== "--force");
  if (!isEmptyArray(unknown)) {
    err(`reylo generate: unknown option ${unknown.join(", ")}\n\n${USAGE}`);
    return USAGE_ERROR;
  }
  const paths = args.filter((argument) => !argument.startsWith("-"));
  return generatePaths(paths, force);
};

/**
 * Run one command from the native reylo CLI.
 * @param {string[]} args - The command name and its arguments.
 * @returns {Promise<number>} The CLI exit status.
 */
export const runCli = async function runCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "generate") {return generate(rest);}
  if (matchesUndefined(command) || command === "help" || command === "--help" || command === "-h") {
    out(USAGE);
    return SUCCESS;
  }
  err(`reylo: unknown command ${command}\n\n${USAGE}`);
  return USAGE_ERROR;
};
