import { dateFromDays, decimal, interval, MICROSECONDS, MILLISECONDS, NANOSECONDS, SECONDS, timestamp } from "./decode-duckdb-time.ts";
import { hasObjectType, matchesBigInt, matchesNullish, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { jsonValue, SQL_NULL_VALUE } from "./value-text.ts";
import { DecodeError } from "./values.ts";

export interface Reader { columnNames: () => string[]; columnTypes: () => DuckType[]; getRows: () => unknown[][] }
interface DuckType {
  typeId: number;
  alias?: string;
  valueType?: DuckType;
  keyType?: DuckType;
  entryNames?: string[];
  entryTypes?: DuckType[];
  memberTags?: string[];
  memberTypes?: DuckType[];
}

// DuckDB's type ids (duckdb_type), which node-api's types carry.
const DUCKDB_TYPE = {
  ARRAY: 33,
  BIGINT: 5,
  BIGNUM: 35,
  BIT: 29,
  BLOB: 18,
  BOOLEAN: 1,
  DATE: 13,
  DECIMAL: 19,
  DOUBLE: 11,
  ENUM: 23,
  FLOAT: 10,
  HUGEINT: 16,
  INTEGER: 4,
  INTERVAL: 15,
  LIST: 24,
  MAP: 26,
  SMALLINT: 3,
  STRUCT: 25,
  TIME: 14,
  TIMESTAMP: 12,
  TIMESTAMP_MS: 21,
  TIMESTAMP_NS: 22,
  TIMESTAMP_S: 20,
  TIMESTAMP_TZ: 31,
  TIMESTAMP_TZ_NS: 42,
  TIME_NS: 39,
  TIME_TZ: 30,
  TINYINT: 2,
  UBIGINT: 9,
  UHUGEINT: 32,
  UINTEGER: 8,
  UNION: 28,
  USMALLINT: 7,
  UTINYINT: 6,
  UUID: 27,
  VARCHAR: 17,
  VARIANT: 41,
} as const;

interface NativeDuckValue {
  bytes: unknown;
  days: number;
  entries: Record<string, unknown> | { key: unknown; value: unknown }[];
  items: unknown[];
  micros: bigint;
  millis: bigint;
  months: number;
  nanos: bigint;
  scale: unknown;
  seconds: bigint;
  tag: string;
  type?: DuckType;
  value: unknown;
}

type Scalar = (native: NativeDuckValue, value: unknown) => unknown;

const unchanged: Scalar = (_native, value) => value;
const toText: Scalar = (_native, value) => String(value);

const integer: Scalar = (_native, value) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BigInt performs the native driver's integer conversion, including number-like values.
  matchesBigInt(value) ? value : BigInt(value as number);

const dec: Scalar = (native, value) =>
  matchesBigInt(native.value) && matchesNumber(native.scale) ? decimal(native.value, native.scale) : String(value);

const SCALARS = new Map<number, Scalar>([
  [DUCKDB_TYPE.BOOLEAN, unchanged],
  [DUCKDB_TYPE.TINYINT, unchanged],
  [DUCKDB_TYPE.SMALLINT, unchanged],
  [DUCKDB_TYPE.INTEGER, unchanged],
  [DUCKDB_TYPE.UTINYINT, unchanged],
  [DUCKDB_TYPE.USMALLINT, unchanged],
  [DUCKDB_TYPE.UINTEGER, unchanged],
  [DUCKDB_TYPE.FLOAT, unchanged],
  [DUCKDB_TYPE.DOUBLE, unchanged],
  [DUCKDB_TYPE.BIGINT, integer],
  [DUCKDB_TYPE.UBIGINT, integer],
  [DUCKDB_TYPE.HUGEINT, integer],
  [DUCKDB_TYPE.UHUGEINT, integer],
  [DUCKDB_TYPE.BIGNUM, integer],
  [DUCKDB_TYPE.ENUM, toText],
  [DUCKDB_TYPE.UUID, toText],
  [DUCKDB_TYPE.BIT, toText],
  [DUCKDB_TYPE.TIME, toText],
  [DUCKDB_TYPE.TIME_NS, toText],
  [DUCKDB_TYPE.TIME_TZ, toText],
  [DUCKDB_TYPE.BLOB, (native, value) => native.bytes instanceof Uint8Array ? native.bytes : value],
  [DUCKDB_TYPE.DECIMAL, dec],
  [DUCKDB_TYPE.DATE, dateFromDays],
  [DUCKDB_TYPE.TIMESTAMP, (native) => timestamp(native.micros, MICROSECONDS, "")],
  [DUCKDB_TYPE.TIMESTAMP_S, (native) => timestamp(native.seconds, SECONDS, "")],
  [DUCKDB_TYPE.TIMESTAMP_MS, (native) => timestamp(native.millis, MILLISECONDS, "")],
  [DUCKDB_TYPE.TIMESTAMP_NS, (native) => timestamp(native.nanos, NANOSECONDS, "")],
  [DUCKDB_TYPE.TIMESTAMP_TZ, (native) => timestamp(native.micros, MICROSECONDS, "Z")],
  [DUCKDB_TYPE.TIMESTAMP_TZ_NS, (native) => timestamp(native.nanos, NANOSECONDS, "Z")],
  [DUCKDB_TYPE.INTERVAL, (native) => interval(native.months, native.days, native.micros)],
]);

const PREVIEW_START = 0;
const JSON_ERROR_PREVIEW = 60;
const MEMBER_NOT_FOUND = -1;
const FIRST_FIELD = 0;
const FIELD_STEP = 1;
const UNKNOWN_TYPE = { typeId: 0 };

const varchar = (value: unknown, alias: string | undefined, column: string): unknown => {
  if (alias?.toUpperCase() !== "JSON" || !matchesString(value)) {return value;}
  try {
    return jsonValue(value);
  } catch {
    throw new DecodeError(`Column "${column}" is JSON, and holds text that is not: ${JSON.stringify(value.slice(PREVIEW_START, JSON_ERROR_PREVIEW))}.`);
  }
};

type Recurse = (value: unknown, type: DuckType) => unknown;
type Nested = (native: NativeDuckValue, type: DuckType, read: Recurse) => unknown;

const sequence: Nested = (native, type, read) =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Native LIST and ARRAY descriptors carry the element type.
  native.items.map((item) => read(item, type.valueType!));

const structure: Nested = (native, type, read) => {
  if (Array.isArray(native.items)) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A native tuple supplies a matching type for each field position.
    return native.items.map((item, index) => read(item, type.entryTypes![index]!));
  }
  const out: Record<string, unknown> = {};
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Named STRUCT descriptors always supply their field names.
  type.entryNames!.forEach((name, index) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Named STRUCT values expose their entries by field name.
    const fields = native.entries as Record<string, unknown>;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Native STRUCT descriptors align names and types by position.
    out[name] = read(fields[name], type.entryTypes![index]!);
  });
  return out;
};

const mapping: Nested = (native, type, read) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DuckDB MAP values carry the ordered entries as an array.
  const entries = native.entries as { key: unknown; value: unknown }[];
  // oxlint-disable-next-line typescript/no-non-null-assertion -- DuckDB MAP descriptors carry separate key and value types.
  return entries.map((entry) => ({ key: read(entry.key, type.keyType!), value: read(entry.value, type.valueType!) }));
};

const union: Nested = (native, type, read) => {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- DuckDB UNION metadata carries the member tags.
  const at = type.memberTags!.indexOf(native.tag);
  // oxlint-disable-next-line typescript/no-non-null-assertion -- A matching tag names one of the descriptor's member types.
  return { tag: native.tag, value: at === MEMBER_NOT_FOUND ? native.value : read(native.value, type.memberTypes![at]!) };
};

const NESTED = new Map<number, Nested>([
  [DUCKDB_TYPE.LIST, sequence],
  [DUCKDB_TYPE.ARRAY, sequence],
  [DUCKDB_TYPE.STRUCT, structure],
  [DUCKDB_TYPE.MAP, mapping],
  [DUCKDB_TYPE.UNION, union],
  [DUCKDB_TYPE.VARIANT, (native, _type, read) => read(native.value, native.type ?? UNKNOWN_TYPE)],
]);

const extensionType: Nested = (value) =>
  // oxlint-disable-next-line typescript/no-base-to-string -- Native extension values supply their own text. Preserve the driver's fallback coercion for other objects.
  value instanceof Uint8Array || !hasObjectType(value) ? value : String(value);

const decode = function decode(value: unknown, type: DuckType, column: string): unknown {
  if (matchesNullish(value)) {return SQL_NULL_VALUE;}
  const { typeId } = type;
  if (typeId === DUCKDB_TYPE.VARCHAR) {return varchar(value, type.alias, column);}
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The result field's native type ID selects which fields its value exposes.
  const native = value as NativeDuckValue;
  const scalar = SCALARS.get(typeId);
  if (!matchesUndefined(scalar)) {return scalar(native, value);}
  return (NESTED.get(typeId) ?? extensionType)(native, type, (entry, kind) => decode(entry, kind, column));
};

const rowOf = (row: unknown[], names: string[], kinds: DuckType[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const cursor = { index: FIRST_FIELD };
  while (cursor.index < names.length) {
    const { index } = cursor;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Native reader metadata provides both a name and a type for every field position.
    out[names[index]!] = decode(row[index], kinds[index]!, names[index]!);
    cursor.index += FIELD_STEP;
  }
  return out;
};

export const readDuckRows = (reader: Reader): Record<string, unknown>[] => {
  const names = reader.columnNames();
  const kinds = reader.columnTypes();
  return reader.getRows().map((row) => rowOf(row, names, kinds));
};
