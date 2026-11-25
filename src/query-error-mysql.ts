import type { MYSQL_CODES } from "./error-codes-mysql.ts";
import { matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { driverFields, driverText, messageGroup, queryError, sqlState } from "./query-error-native.ts";
import type { MysqlCode, MysqlQueryError } from "./query-error-types.ts";

const FIRST_POSITIVE_ERROR = 1;
const MARIADB_CLIENT_ERROR_START = 45_000;
const MARIADB_CLIENT_ERROR_END = 46_000;

const ER_DUP_ENTRY = 1062;
const ER_DUP_ENTRY_WITH_KEY_NAME = 1586;
const ER_ROW_IS_REFERENCED_2 = 1451;
const ER_NO_REFERENCED_ROW_2 = 1452;
const ER_CHECK_CONSTRAINT_VIOLATED = 3819;
const ER_BAD_NULL_ERROR = 1048;
const ER_NO_DEFAULT_FOR_FIELD = 1364;
const ER_WARN_DATA_OUT_OF_RANGE = 1264;
const WARN_DATA_TRUNCATED = 1265;
const ER_TRUNCATED_WRONG_VALUE = 1292;
const ER_TRUNCATED_WRONG_VALUE_FOR_FIELD = 1366;
const ER_DATA_TOO_LONG = 1406;

interface Candidate {
  errno: unknown;
  message: string;
  sqlState: unknown;
}

interface MysqlDetails {
  errno: number;
  message: string;
  sqlState: string;
}

const wrappedError = (message: string): Candidate | undefined => {
  // PlanetScale includes Vitess's optional prefix and puts the server fields in the message.
  const fields = /^(?:[\s\S]*?desc = )?(?<message>[\s\S]*?) \(errno (?<errno>\d+)\) \(sqlstate (?<sqlState>[0-9A-Z]{5})\)/u.exec(message)?.groups;
  if (matchesUndefined(fields)) {return undefined;}
  return { errno: Number(fields.errno), message: fields.message ?? "", sqlState: fields.sqlState };
};

const readDetails = (candidate: Candidate, raw: string): MysqlDetails | undefined => {
  const { errno, message } = candidate;
  const state = sqlState(candidate.sqlState);
  // The host's system errors use negative numbers. Client-only MariaDB errors have their own prefix.
  if (!matchesNumber(errno) || !Number.isInteger(errno) || errno < FIRST_POSITIVE_ERROR || matchesUndefined(state)) {return undefined;}
  if (errno > MARIADB_CLIENT_ERROR_START && errno < MARIADB_CLIENT_ERROR_END && /^\(conn[:=]/u.test(raw)) {return undefined;}
  return { errno, message, sqlState: state };
};

const mysqlError = (error: unknown): MysqlDetails | undefined => {
  const fields = driverFields(error);
  if (matchesUndefined(fields) || !matchesString(fields.message)) {return undefined;}
  const { errno, sqlState: reported } = fields;
  const message = driverText(fields.sqlMessage) ?? driverText(fields.text) ?? fields.message;
  const candidate = matchesUndefined(errno) ? wrappedError(fields.message) : { errno, message, sqlState: reported };
  return matchesUndefined(candidate) ? undefined : readDetails(candidate, fields.message);
};

interface MysqlNames {
  column: string | undefined;
  constraint: string | undefined;
  key: string | undefined;
  table: string | undefined;
}

const duplicate = (message: string): Partial<MysqlNames> => ({
  key: messageGroup(/^Duplicate entry '[\s\S]*' for key '(?<key>[\s\S]*)'$/u, message, "key"),
});

const foreignKey = (message: string): Partial<MysqlNames> => {
  const fields = /a foreign key constraint fails \(`(?:[^`]|``)*`\.`(?<table>(?:[^`]|``)*)`, CONSTRAINT `(?<constraint>(?:[^`]|``)*)`/u.exec(message)?.groups;
  return { constraint: fields?.constraint?.replaceAll("``", "`"), table: fields?.table?.replaceAll("``", "`") };
};

const check = (message: string): Partial<MysqlNames> => ({
  constraint: messageGroup(/^Check constraint '(?<constraint>[\s\S]*)' is violated\.$/u, message, "constraint"),
});

const notNull = (message: string): Partial<MysqlNames> => ({
  column: messageGroup(/^Column '(?<column>[\s\S]*)' cannot be null$/u, message, "column"),
});

const missingDefault = (message: string): Partial<MysqlNames> => ({
  column: messageGroup(/^Field '(?<column>[\s\S]*)' doesn't have a default value$/u, message, "column"),
});

const dataColumn = (message: string): Partial<MysqlNames> => ({
  column: messageGroup(/ for column '(?<column>[\s\S]*)' at row \d+$/u, message, "column"),
});

const NAME_READERS = new Map<number, (message: string) => Partial<MysqlNames>>([
  [ER_DUP_ENTRY, duplicate],
  [ER_DUP_ENTRY_WITH_KEY_NAME, duplicate],
  [ER_ROW_IS_REFERENCED_2, foreignKey],
  [ER_NO_REFERENCED_ROW_2, foreignKey],
  [ER_CHECK_CONSTRAINT_VIOLATED, check],
  [ER_BAD_NULL_ERROR, notNull],
  [ER_NO_DEFAULT_FOR_FIELD, missingDefault],
  [ER_WARN_DATA_OUT_OF_RANGE, dataColumn],
  [WARN_DATA_TRUNCATED, dataColumn],
  [ER_TRUNCATED_WRONG_VALUE, dataColumn],
  [ER_TRUNCATED_WRONG_VALUE_FOR_FIELD, dataColumn],
  [ER_DATA_TOO_LONG, dataColumn],
]);

const namesOf = (errno: number, message: string): MysqlNames => {
  const names = NAME_READERS.get(errno)?.(message);
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the MySQL error's established serialized name order.
  return { key: names?.key, constraint: names?.constraint, table: names?.table, column: names?.column };
};

const codeOf = (table: typeof MYSQL_CODES, errno: number): MysqlCode | undefined => {
  const group = table.findLast(([first, names]) => errno >= first && errno < first + names.length);
  if (matchesUndefined(group)) {return undefined;}
  const [first, names] = group;
  return names[errno - first];
};

export const mysqlQueryError = async (error: unknown): Promise<MysqlQueryError | undefined> => {
  const read = mysqlError(error);
  if (matchesUndefined(read)) {return undefined;}
  const { MYSQL_CODES } = await import("./error-codes-mysql.ts");
  const { errno, message, sqlState: reported } = read;
  return queryError(message, error, { code: codeOf(MYSQL_CODES, errno), errno, sqlState: reported, ...namesOf(errno, message) });
};
