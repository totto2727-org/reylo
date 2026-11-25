import { matchesString, matchesUndefined } from "./native-predicates.ts";
import { driverFields, driverText, queryError, sqlState } from "./query-error-native.ts";
import type { DriverFields } from "./query-error-native.ts";
import type { PostgresCondition, PostgresErrorFields, PostgresQueryError } from "./query-error-types.ts";

type PostgresFields = Omit<PostgresErrorFields, keyof Error>;

interface PostgresDetails {
  code: string;
  fields: PostgresFields;
  message: string;
}

const postgresFields = (error: DriverFields, { position, severity }: { position: string | undefined; severity: string }): PostgresFields =>
  // oxlint-disable-next-line eslint/sort-keys -- Retain the field order in serialized Postgres query errors.
  ({ severity, detail: driverText(error.detail), hint: driverText(error.hint), position: !matchesUndefined(position) && /^\d+$/u.test(position) ? Number(position) : undefined, where: driverText(error.where), schema: driverText(error.schema ?? error.schema_name), table: driverText(error.table ?? error.table_name), column: driverText(error.column ?? error.column_name), dataType: driverText(error.dataType ?? error["data type_name"]), constraint: driverText(error.constraint ?? error.constraint_name) });

const postgresError = (error: unknown): PostgresDetails | undefined => {
  const fields = driverFields(error);
  if (matchesUndefined(fields) || !matchesString(fields.severity) || !matchesString(fields.message)) {return undefined;}
  const code = sqlState(fields.code) ?? sqlState(fields.errno);
  if (matchesUndefined(code)) {return undefined;}
  const position = driverText(fields.position);
  const { message } = fields;
  return { code, fields: postgresFields(fields, { position, severity: fields.severity }), message };
};

export const postgresQueryError = async (error: unknown): Promise<PostgresQueryError | undefined> => {
  // Slonik may wrap the driver's error in its cause.
  const read = postgresError(error) ?? postgresError(driverFields(error)?.cause);
  if (matchesUndefined(read)) {return undefined;}
  // Keep the condition table in a lazy chunk.
  const { POSTGRES_CODES } = await import("./error-codes-postgres.ts");
  const conditions: Readonly<Record<string, PostgresCondition | undefined>> = POSTGRES_CODES;
  return queryError(read.message, error, { code: read.code, condition: conditions[read.code], ...read.fields });
};
