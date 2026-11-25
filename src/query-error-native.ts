import { hasObjectType, matchesNull, matchesString, nonemptyText } from "./native-predicates.ts";

export type DriverFields = Record<string, unknown>;

export const driverFields = (value: unknown): DriverFields | undefined => {
  if (!hasObjectType(value) || matchesNull(value)) {return undefined;}
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A native error may expose optional driver fields on its prototype or on an array.
  return value as DriverFields;
};

export const driverText = (value: unknown): string | undefined => matchesString(value) ? nonemptyText(value) : undefined;

const SQLSTATE = /^[0-9A-Z]{5}$/u;
export const sqlState = (value: unknown): string | undefined => matchesString(value) && SQLSTATE.test(value) ? value : undefined;

export const messageGroup = (pattern: RegExp, message: string, key: string): string | undefined => pattern.exec(message)?.groups?.[key];

// oxlint-disable-next-line rules/require-tagged-error -- The exported synchronous query methods use a native Error with its original driver cause.
class DatabaseError extends Error {
  // oxlint-disable-next-line unicorn/custom-error-definition -- Keep the existing public name QueryError and the DatabaseError constructor identity.
  public constructor(message: string, cause: unknown, fields: DriverFields) {
    super(message, { cause });
    Object.assign(this, fields);
  }
}
Object.defineProperty(DatabaseError.prototype, "name", { configurable: true, value: "QueryError", writable: true });

type NativeQueryError = Error & Readonly<{ cause: unknown; name: "QueryError" }>;

export const queryError = <Fields extends DriverFields>(message: string, cause: unknown, fields: Fields): NativeQueryError & Readonly<Fields> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native constructor installs the supplied fields, original cause, and QueryError prototype name.
  new DatabaseError(message, cause, fields) as NativeQueryError & Readonly<Fields>;
