import { docComment, leadingComment, statementAfter } from "./doc-comment.ts";
import type { Dialect } from "./engine-core.ts";
import { queryErrorType, reyloImport, withinFile } from "./module-types.ts";
import { matchesUndefined } from "./native-predicates.ts";

export const FIRST_BYTE_OFFSET = 0;
export const ONE_BYTE_DIAGNOSTIC = 1;
const BYTE_WIDTH = 1;
const GENERAL_DIAGNOSTIC = 1;
const ATOM = 1;
const DEFINITION = 8;
const TYPE_DEFINITION = 16;
const IMPLEMENTATION = 32;

interface DiagnosticRange { code?: number | undefined; length: number; start: number }
export interface MapperDiagnostic { code: number; length: number; messageText: string; start: number }

export const diagnostic = (size: number, messageText: string, { code = GENERAL_DIAGNOSTIC, length, start }: DiagnosticRange): MapperDiagnostic =>
  ({ messageText, ...withinFile(start, length, size), code });

const byteIsWhitespace = (byte: number): boolean => /\s/u.test(String.fromCodePoint(byte));

export const mapToStatement = (text: string, sql: string): number[][] => {
  const bytes = Buffer.from(sql, "utf8");
  const range = { end: bytes.length, start: FIRST_BYTE_OFFSET };
  while (range.start < range.end && byteIsWhitespace(bytes.readUInt8(range.start))) {range.start += BYTE_WIDTH;}
  while (range.end > range.start && byteIsWhitespace(bytes.readUInt8(range.end - BYTE_WIDTH))) {range.end -= BYTE_WIDTH;}
  // TypeScript maps definitions only when a whole range fits in one segment.
  return [[FIRST_BYTE_OFFSET, Buffer.byteLength(text), range.start, range.end - range.start, ATOM, DEFINITION + TYPE_DEFINITION + IMPLEMENTATION]];
};

interface Source {
  dialect: Dialect;
  leading: ReturnType<typeof leadingComment>;
  sql: string;
}

export const declarationSource = (sql: string, dialect: Dialect): Source =>
  ({ dialect, leading: leadingComment(sql, dialect), sql });

interface Declaration { cardinality: string; compiled?: string | undefined; names: string[]; paramsType: string; queryError?: string; rowType: string }

const broadQueryError = (dialect: Dialect): string =>
  // oxlint-disable-next-line unicorn/no-useless-undefined -- The declaration helper's public signature requires the error fields position.
  queryErrorType(dialect, undefined);

export const declarationText = (
  { dialect, leading, sql }: Source, { cardinality, compiled, names, paramsType, queryError = broadQueryError(dialect), rowType }: Declaration,
): string => {
  const written = statementAfter(sql, leading);
  return [
    reyloImport(paramsType, rowType),
    `export type Params = ${paramsType};`,
    `export type Row = ${rowType};`,
    `export type QueryError = ${queryError};`,
    `export declare const sql: ${matchesUndefined(compiled) ? "string" : JSON.stringify(compiled)};`,
    `export declare const raw: ${JSON.stringify(sql)};`,
    `export declare const params: readonly [${names.map((name) => JSON.stringify(name)).join(", ")}];`,
    // Use literal types for the row and parameters in the query hover.
    `${docComment(leading.prose, written)}declare const query: Query<${paramsType}, ${rowType}, ${JSON.stringify(cardinality)}, ${JSON.stringify(dialect)}, QueryError> & {`,
    `  readonly sql: typeof sql;`,
    `  readonly raw: typeof raw;`,
    `  readonly source: string;`,
    `};`,
    `export default query;`,
    ``,
  ].join("\n");
};

export const missingProjectText = (sql: string): string => {
  const leading = leadingComment(sql);
  const doc = docComment(leading.prose, statementAfter(sql, leading));
  return `import type { Query } from "@totto2727/reylo";\nexport type Params = unknown;\nexport type Row = unknown;\nexport type QueryError = import("@totto2727/reylo").QueryError;\n${doc}declare const query: Query<unknown, unknown, "many", "postgres">;\nexport default query;\n`;
};
