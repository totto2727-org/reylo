// One statement as the playground shows it, in `reylo play` and on the docs site's /play: the
// Diagnostics the content mapper would place in its file, by line and column, and its Params and
// Returns as the docs print them. Free of Node, since the docs run it in the reader's tab.
import type { Analysis, Diagnostic, Dialect, Lexed } from "./engine-core.ts";
import { moduleTypes } from "./module-types.ts";
import { placer } from "./play-positions.ts";
import { formatType, resultType } from "./type-format.ts";

export { placer } from "./play-positions.ts";

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public playground type alias and its structural assignability.
export type PlayDiagnostic = { message: string; code: number; line: number; column: number; endLine: number; endColumn: number };

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public playground type alias and its structural assignability.
export type PlayResult = {
  sql: string;
  /** `{ id: number }`; absent where the statement takes no parameters. */
  params?: string;
  /** What `.run()` resolves to. */
  returns: string;
  /** One row's type, as the query's `element`: what `returns` holds one or many of, by `cardinality`. */
  element?: string;
  /** How many rows it returns: `many`, `one`, `maybeOne` or `none`; absent where it cannot be analyzed. */
  cardinality?: string;
  diagnostics: PlayDiagnostic[];
  /** How long the analysis took, in milliseconds. */
  ms: number;
};

type Outcome = { analysis: Analysis; lexed?: Pick<Lexed, "params" | "placeholders"> | undefined } |
  { error: { message: string; code?: number } };

interface PlayOptions { strictParams?: boolean; width?: number; ms?: number }
interface Display { ms: number; place: ReturnType<typeof placer>; width: number }

const NO_DURATION = 0;
const ERROR_START = 0;
const ERROR_LENGTH = 1;
const UNKNOWN_DIAGNOSTIC = 5;
const DEFAULT_OPTIONS = {};

const placed = ({ code, length, message, start }: Diagnostic, place: Display["place"]): PlayDiagnostic =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the response's established diagnostic key order.
  ({ message, code, ...place(start, length) });

const failed = (
  sql: string, { message, code }: { code?: number | undefined; message: string }, { ms, place }: Display,
): PlayResult => {
  const diagnostic = placed({ code: code ?? UNKNOWN_DIAGNOSTIC, length: ERROR_LENGTH, message, start: ERROR_START }, place);
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public playground error response's JSON order.
  return { sql, params: "unknown", returns: "unknown", diagnostics: [diagnostic], ms };
};

const displayed = (sql: string, types: ReturnType<typeof moduleTypes>, { ms, place, width }: Display): PlayResult =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public playground response's JSON order.
  ({
    sql,
    ...(types.params === "Record<never, never>" ? {} : { params: formatType(types.params, width) }),
    returns: formatType(types.row === "unknown" ? "unknown" : resultType(types.row, types.cardinality), width),
    element: formatType(types.row, width),
    cardinality: types.cardinality,
    diagnostics: types.diagnostics.map((diagnostic) => placed(diagnostic, place)),
    ms,
  });

const displayFor = (sql: string, options: PlayOptions): Display => {
  const place = placer(sql);
  const width = options.width ?? Infinity;
  const ms = options.ms ?? NO_DURATION;
  return { ms, place, width };
};

/**
 * Render one statement's inferred types or the native diagnostic that stopped its analysis.
 * @param {string} sql - The statement text.
 * @param {Dialect} dialect - The database dialect.
 * @param {Outcome} outcome - The analysis and lexer result, or the failure.
 * @param {PlayOptions} options - Type formatting and timing options.
 * @returns {PlayResult} The hosted or local playground response.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the existing playground function signature.
export const playResult = function playResult(
  sql: string,
  dialect: Dialect,
  outcome: Outcome,
  options: PlayOptions = DEFAULT_OPTIONS,
): PlayResult {
  const display = displayFor(sql, options);
  if ("error" in outcome) {
    // oxlint-disable-next-line eslint/sort-keys -- Read the native message before its optional error code.
    return failed(sql, { message: outcome.error.message, code: outcome.error.code }, display);
  }
  try {
    const types = moduleTypes(sql, outcome.analysis, dialect, outcome.lexed, options.strictParams ?? true);
    return displayed(sql, types, display);
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the native diagnostic supplied to the playground.
    return failed(sql, { message: (error as Error).message }, display);
  }
};
