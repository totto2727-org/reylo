import { SQLITE_CODES } from "./error-codes-sqlite.ts";
import { isEmptyArray, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { driverFields, messageGroup, queryError } from "./query-error-native.ts";
import type { DriverFields } from "./query-error-native.ts";
import type { SqliteCode, SqliteQueryError } from "./query-error-types.ts";

const SQLITE_PRIMARY_CODE_MASK = 0xFF;
const CODE_PREFIX_SEPARATOR = ": ";
const FIRST_CODE = 0;
const SQLITE_NAME = /^SQLITE_[A-Z_]+$/u;
const SQLITE_VALUES: Readonly<Record<string, number | undefined>> = SQLITE_CODES;
const SQLITE_NAMES = new Map<number, SqliteCode>(Object.entries(SQLITE_CODES).map(([name, code]) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The keys come directly from the fixed SQLite result-code table.
  [code, name as SqliteCode]));

interface SqliteNames {
  columns: string[] | undefined;
  constraint: string | undefined;
  table: string | undefined;
}

const sqliteColumns = (columnList: string): Pick<SqliteNames, "columns" | "table"> => {
  const references = columnList.split(", ").map((part) => /^(?<table>[^.]+)\.(?<column>[\s\S]+)$/u.exec(part)?.groups);
  const table = references[0]?.table;
  if (matchesUndefined(table) || !references.every((reference) => reference?.table === table)) {
    return { columns: undefined, table: undefined };
  }
  return { columns: references.map((reference) => reference?.column ?? ""), table };
};

const primaryCode = (errcode: number): number =>
  // oxlint-disable-next-line eslint/no-bitwise -- SQLite stores its primary result code in the low byte of the native extended code.
  errcode & SQLITE_PRIMARY_CODE_MASK;

const datatypeNames = (message: string, names: SqliteNames): SqliteNames => {
  const datatype = /^cannot store \S+ value in \S+ column (?<table>[^.]+)\.(?<column>[\s\S]+)$/u.exec(message)?.groups;
  return matchesUndefined(datatype) ? names : { ...names, columns: [datatype.column ?? ""], table: datatype.table };
};

const sqliteNames = (errcode: number | undefined, message: string): SqliteNames => {
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the order of serialized name fields on QueryError.
  const names: SqliteNames = { table: undefined, columns: undefined, constraint: undefined };
  if (matchesUndefined(errcode) || primaryCode(errcode) !== SQLITE_CODES.SQLITE_CONSTRAINT) {return names;}
  const constraint = messageGroup(/^UNIQUE constraint failed: index '(?<name>[\s\S]*)'$/u, message, "name") ??
    messageGroup(/^CHECK constraint failed: (?<name>[\s\S]*)$/u, message, "name");
  if (!matchesUndefined(constraint)) {return { ...names, constraint };}
  const columns = messageGroup(/^(?:UNIQUE|NOT NULL) constraint failed: (?<columns>[\s\S]+)$/u, message, "columns");
  if (!matchesUndefined(columns)) {return { ...names, ...sqliteColumns(columns) };}
  return datatypeNames(message, names);
};

const wrappedSqliteMessage = (message: string, mayBeTurso: boolean): Readonly<Record<string, string | undefined>> | undefined =>
  /^(?:D1_ERROR: )?(?<message>[\s\S]*): (?<primary>SQLITE_[A-Z_]+)(?: \(extended: (?<extended>SQLITE_[A-Z_]+)\))?$/u.exec(message)?.groups ??
  (mayBeTurso
    ? /^(?:prepare|step) failed: (?:Runtime error: )?(?<message>[\s\S]*?)(?: \((?<code>\d+)\))?$/u.exec(message)?.groups
    : undefined);

interface SqliteDetails {
  codes: number[];
  message: string;
  named: boolean;
}

const addName = (details: SqliteDetails, name: unknown): void => {
  if (!matchesString(name) || !SQLITE_NAME.test(name)) {return;}
  details.named = true;
  const code = SQLITE_VALUES[name];
  if (!matchesUndefined(code)) {details.codes.push(code);}
};

const nativeDetails = (error: DriverFields, message: string): SqliteDetails => {
  const details: SqliteDetails = { codes: [], message, named: false };
  addName(details, error.extendedCode);
  addName(details, error.code);
  if (matchesNumber(error.errcode) && error.code === "ERR_SQLITE_ERROR") {details.codes.push(error.errcode);}
  if (matchesNumber(error.rawCode)) {details.codes.push(error.rawCode);}
  if (matchesNumber(error.errno) && details.named) {details.codes.push(error.errno);}
  return details;
};

const removeDriverPrefix = (message: string, code: unknown): string => {
  if (!matchesString(code)) {return message;}
  const prefix = code + CODE_PREFIX_SEPARATOR;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
};

const addWrapped = (details: SqliteDetails, wrapped: Readonly<Record<string, string | undefined>>): SqliteDetails => {
  details.message = wrapped.message ?? "";
  addName(details, wrapped.extended);
  addName(details, wrapped.primary);
  if (!matchesUndefined(wrapped.code)) {details.codes.push(Number(wrapped.code));}
  return details;
};

const getDetails = (error: DriverFields, message: string): SqliteDetails | undefined => {
  const details = nativeDetails(error, message);
  if (details.named) {
    details.message = removeDriverPrefix(message, error.code);
    return details;
  }
  if (!isEmptyArray(details.codes)) {return details;}
  const wrapped = wrappedSqliteMessage(message, error.code === "GenericFailure");
  return matchesUndefined(wrapped) ? undefined : addWrapped(details, wrapped);
};

export const sqliteQueryError = (error: unknown): SqliteQueryError | undefined => {
  const fields = driverFields(error);
  if (matchesUndefined(fields) || !matchesString(fields.message)) {return undefined;}
  const details = getDetails(fields, fields.message);
  if (matchesUndefined(details)) {return undefined;}
  const { codes, message } = details;
  // Prefer an extended result code over any primary code.
  const errcode = codes.find((code) => code > SQLITE_PRIMARY_CODE_MASK) ?? codes.at(FIRST_CODE);
  const code = matchesUndefined(errcode) ? undefined : SQLITE_NAMES.get(errcode);
  return queryError(message, error, { code, errcode, ...sqliteNames(errcode, message) });
};
