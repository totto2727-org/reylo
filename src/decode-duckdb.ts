// The run time on DuckDB, over @duckdb/node-api's DuckDBConnection: `runAndReadAll(sql, values)`
// Runs the statement, and each value is given its type's one representation (src/values.ts) by
// The result's own column types, which hold every field of a STRUCT and every element of a LIST:
// A BIGINT or HUGEINT is a BigInt, a DECIMAL its exact text, a DATE `YYYY-MM-DD`, a TIMESTAMP its
// Wall-clock text with `T`, a TIMESTAMPTZ its ISO 8601 instant in UTC, an INTERVAL an ISO 8601
// Duration, a BLOB a Uint8Array, a JSON its value, a LIST an array, a STRUCT an object of its
// Fields, a MAP its entries as `{ key, value }`, and a UNION `{ tag, value }`. A year outside 0000
// To 9999 is written as ISO 8601 extends it (`+010000`, `-000044`), and an infinite date or
// Timestamp as `infinity` or `-infinity`.
//
// Node-api binds a string, a number, a BigInt and a boolean as it is, and DuckDB casts each to its
// Parameter's type, checking its range. A list, a struct, a map or binary data it binds only as
// A value of its own classes with its type said, so the run time builds those with node-api's own
// Constructors, loaded from the app beside the connection: each element a type node-api takes
// From JavaScript (an integer a HUGEINT, a decimal or a date its text), which DuckDB casts in turn.
import { dateFromDays, decimal, duckdbInterval, interval, MICROSECONDS, MILLISECONDS, NANOSECONDS, SECONDS, timestamp } from "./decode-duckdb-time.ts";
import { DecodeError, ParameterError } from "./values.ts";
import type { EngineType } from "./engine-type.ts";
import type { Columns } from "./values.ts";
import { hasFunctionType, hasObjectType, matchesBigInt, matchesNull, matchesNullish, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

export { duckdbInterval } from "./decode-duckdb-time.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- Keep the published structural driver contracts compatible with each driver's own parameter and callback types.
export type DriverValue = any;

/** @duckdb/node-api's DuckDBConnection, a connection of a DuckDBInstance: `run` takes it. */
export type DuckdbClient = {
  runAndReadAll(sql: string, values?: DriverValue, types?: DriverValue): Promise<unknown>;
  prepare(sql: string): Promise<unknown>;
};

interface Reader { columnNames: () => string[]; columnTypes: () => DuckType[]; getRows: () => unknown[][] }
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

/** The slice of @duckdb/node-api that builds a nested or binary value with its type. */
interface Api {
  DuckDBConnection: unknown;
  listValue(items: unknown[]): unknown;
  structValue(entries: Record<string, unknown>): unknown;
  mapValue(entries: { key: unknown; value: unknown }[]): unknown;
  unionValue(tag: string, value: unknown): unknown;
  blobValue(bytes: Uint8Array): unknown;
  LIST(of: unknown): unknown;
  STRUCT(fields: Record<string, unknown>): unknown;
  MAP(key: unknown, value: unknown): unknown;
  UNION(members: Record<string, unknown>): unknown;
  TUPLE(items: unknown[]): unknown;
  tupleValue(items: unknown[]): unknown;
  BOOLEAN: unknown;
  HUGEINT: unknown;
  DOUBLE: unknown;
  VARCHAR: unknown;
  BLOB: unknown;
}

// Named in a variable and loaded with a `require`, so that a bundler leaves it to the run time: only
// A DuckDB app has the package, and it loads it itself. An `import()` of it is wrapped by tsc in a
// Helper of its own, which moves a `webpackIgnore` comment where Rspack no longer reads it.
const NODE_API = "@duckdb/node-api";
/** The module path of node-api's entry, as Node's CommonJS cache keys it. */
const NODE_API_ENTRY = /[\\/]@duckdb[\\/]node-api[\\/]lib[\\/]index\.js$/u;
const apis = new WeakMap<object, Promise<Api>>();

type ModuleCache = Record<string, { exports?: unknown } | undefined>;
interface NodeRequire { (id: string): unknown; cache?: ModuleCache }
interface NodeProcess { argv?: string[]; cwd: () => string; getBuiltinModule?(id: string): { createRequire(from: string): NodeRequire } | undefined }

/**
 * The @duckdb/node-api the connection `c` came from. node-api takes a nested or binary value only
 * as an instance of its own classes, built over its own native binding, so a second copy of the
 * package (another version, or the same one installed twice, as a workspace or a linked package
 * can have it) builds values the connection refuses. node-api is CommonJS, so the copy that made
 * `c` is in Node's module cache however the app imported it: the one whose DuckDBConnection `c`
 * is an instance of, a subclass's included. For a connection that only wraps one, the copy is
 * the one loaded where there is one, else the copy the app's install resolves, which is refused only
 * when `c` is another copy's DuckDBConnection.
 */
const nodeApiOf = function (c: DuckdbClient): Promise<Api> {
  // A connection's class decides its copy; an object that only wraps one is its own.
  const proto = Reflect.getPrototypeOf(c);
  const own = matchesNull(proto) || proto === Object.prototype ? c : proto;
  let found = apis.get(own);
  if (matchesUndefined(found)) {
    found = loadNodeApi(c);
    apis.set(own, found);
    found.catch(() => apis.delete(own));
  }
  return found;
};

/** The classes on `c`'s prototype chain. */
const classesOf = function (c: object): unknown[] {
  const out: unknown[] = [];
  for (let p = Object.getPrototypeOf(c) as { constructor?: unknown } | null; !matchesNull(p) && p !== Object.prototype; p = Object.getPrototypeOf(p)) {out.push(p.constructor);}
  return out;
};

async function loadNodeApi(c: DuckdbClient): Promise<Api> {
  const classes = classesOf(c);
  const proc = (globalThis as { process?: NodeProcess }).process;
  let cache: ModuleCache | undefined;
  try {
    cache = proc?.getBuiltinModule?.("node:module")?.createRequire(`${proc.cwd()}/`).cache;
  } catch {}
  const loaded: Api[] = [];
  for (const [path, value] of Object.entries(cache ?? {})) {
    const exports = NODE_API_ENTRY.test(path) ? (value?.exports as Api | undefined) : undefined;
    if (matchesUndefined(exports?.DuckDBConnection)) {continue;}
    if (classes.includes(exports.DuckDBConnection)) {return exports;}
    loaded.push(exports);
  }
  if (loaded.length === 1) {return loaded[0]!;}
  let imported: Api | undefined;
  let failure: unknown;
  const createRequire = proc?.getBuiltinModule?.("node:module")?.createRequire;
  for (const from of [proc?.argv?.[1], proc && `${proc.cwd()}/`]) {
    if (!from || !createRequire) {continue;}
    try {
      imported = createRequire(from)(NODE_API) as Api;
      break;
    } catch (error) {
      failure ??= error;
    }
  }
  if (matchesUndefined(imported)) {
    throw new TypeError(`A list, a struct, a map or binary data is bound with @duckdb/node-api's own values, and the copy the connection came from cannot be found, nor one installed in the project: ${(failure as Error | undefined)?.message ?? "this runtime has no process.getBuiltinModule"}`);
  }
  const another = classes.some((k) => k !== imported.DuckDBConnection && (k as { name?: unknown })?.name === "DuckDBConnection");
  if (loaded.length > 1 || another) {
    const why = another ? "the copy the app's install resolves is another" : "the app has loaded several, and the connection is none of their DuckDBConnection";
    throw new TypeError(`A list, a struct, a map or binary data is bound with @duckdb/node-api's own values, which must come from the copy of the package the connection came from, and ${why}: install a single @duckdb/node-api.`);
  }
  return imported;
}

/** Whether a client is @duckdb/node-api's DuckDBConnection. */
export const isDuckdb = function isDuckdb(c: Record<string, unknown> | null | undefined): boolean {
  return !matchesNullish(c) && hasFunctionType(c.runAndReadAll) && hasFunctionType(c.prepare) && hasFunctionType(c.run);
};

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

/** `v` as node-api builds it for `bindType`'s type: a scalar its text, a JSON value its JSON. */
const bindValue = function bindValue(a: Api, t: EngineType | undefined, v: unknown): unknown {
  if (matchesNull(v) || matchesUndefined(v)) {return null;}
  if (v instanceof Uint8Array) {return a.blobValue(v);}
  if (t?.kind === "tuple" && Array.isArray(v)) {return a.tupleValue(t.items.map((item, index) => bindValue(a, item, v[index])));}
  if (Array.isArray(v)) {
    if (t?.kind === "map") {return a.mapValue(v.map((e) => ({ key: bindValue(a, t.key, (e as { key?: unknown } | null)?.key), value: bindValue(a, t.value, (e as { value?: unknown } | null)?.value) })));}
    return a.listValue(v.map((e) => bindValue(a, t?.kind === "array" ? t.of : undefined, e)));
  }
  if (hasObjectType(v)) {
    if (t?.kind === "struct") {return a.structValue(Object.fromEntries(t.fields.map((field) => [field.name, bindValue(a, field.type, (v as Record<string, unknown>)[field.name])])));}
    if (t?.kind === "union") {
      const { tag, value } = v as { tag?: unknown; value?: unknown };
      return a.unionValue(String(tag), bindValue(a, t.members.find((m) => m.name === tag)?.type, value));
    }
    return JSON.stringify(v);
  }
  return String(v);
};

/**
 * Runs `text` with `values`, each bound by `types` (the engine's type of each parameter), and
 * returns its rows, each value given its kind. `columns` is empty for a statement that returns no
 * rows, whose count DuckDB returns as a row.
 */
export const runDuckdb = async function runDuckdb(c: DuckdbClient, text: string, values: unknown[], types: (EngineType | undefined)[], columns: Columns | undefined): Promise<unknown[]> {
  let bound = values;
  let bindTypes: unknown[] | undefined;
  if (values.some((currentValue) => !matchesNull(currentValue) && hasObjectType(currentValue))) {
    const a = await nodeApiOf(c);
    bindTypes = values.map((currentValue, index) => (!matchesNull(currentValue) && hasObjectType(currentValue) ? bindType(a, types[index], currentValue) : undefined));
    bound = values.map((currentValue, index) => (!matchesNull(currentValue) && hasObjectType(currentValue) ? bindValue(a, types[index], currentValue) : currentValue));
  }
  const reader = (await c.runAndReadAll(text, bound, bindTypes)) as Reader;
  if (!matchesUndefined(columns) && columns.length === 0) {return [];}
  const names = reader.columnNames();
  const kinds = reader.columnTypes();
  return reader.getRows().map((row) => {
    const out: Record<string, unknown> = {};
    for (let nameIndex = 0; nameIndex < names.length; nameIndex++) {out[names[nameIndex]!] = decode(row[nameIndex], kinds[nameIndex]!, names[nameIndex]!);}
    return out;
  });
};

// --- Binding ---------------------------------------------------------------------------------

/**
 * The type node-api builds a nested or binary value with, standing where the engine's type `t`
 * does: its shape (a LIST, a STRUCT, a TUPLE, a MAP, a UNION) with every scalar inside it a VARCHAR
 * of the value's text, and binary data a BLOB. DuckDB casts the text to the parameter's own type,
 * exactly and checking its range, so no integer is narrowed to a type node-api picks.
 */
function bindType(a: Api, t: EngineType | undefined, v: unknown): unknown {
  if (v instanceof Uint8Array) {return a.BLOB;}
  if (t?.kind === "tuple" && Array.isArray(v)) {return a.TUPLE(t.items.map((item, index) => bindType(a, item, v[index])));}
  if (Array.isArray(v)) {
    if (t?.kind === "map") {return a.MAP(bindType(a, t.key, firstOf(v, "key")), bindType(a, t.value, firstOf(v, "value")));}
    return a.LIST(bindType(a, t?.kind === "array" ? t.of : undefined, v.find((e) => !matchesNullish(e))));
  }
  if (t?.kind === "struct" && !matchesNull(v) && hasObjectType(v)) {
    return a.STRUCT(Object.fromEntries(t.fields.map((field) => [field.name, bindType(a, field.type, (v as Record<string, unknown>)[field.name])])));
  }
  if (t?.kind === "union" && !matchesNull(v) && hasObjectType(v)) {
    return a.UNION(Object.fromEntries(t.members.map((m) => [m.name, bindType(a, m.type, (v as { tag?: unknown; value?: unknown }).tag === m.name ? (v as { value?: unknown }).value : undefined)])));
  }
  return a.VARCHAR;
}

function firstOf(entries: unknown[], key: "key" | "value"): unknown {
  for (const entry of entries) {if (!matchesNull(entry) && hasObjectType(entry) && !matchesNullish((entry as Record<string, unknown>)[key])) {return (entry as Record<string, unknown>)[key];}}
  return undefined;
}

const INTEGERS = new Set(["tinyint", "smallint", "integer", "bigint", "hugeint", "utinyint", "usmallint", "uinteger", "ubigint", "uhugeint", "bignum"]);

/**
 * A value bound to a DuckDB parameter, checked and written as DuckDB reads it (the round-trip
 * rule): an integer takes no fraction, which DuckDB's cast would round away, and an ISO 8601
 * duration, which `.run()` returns for an INTERVAL and DuckDB does not read, goes as DuckDB's own
 * text. An array's elements and a struct's fields are checked by their own types.
 */
export const encodeDuckdb = function encodeDuckdb(type: EngineType | undefined, v: unknown, name: string): unknown {
  if (matchesUndefined(type) || matchesNullish(v)) {return v;}
  if (type.kind === "array" && Array.isArray(v)) {return v.map((e) => encodeDuckdb(type.of, e, name));}
  if (type.kind === "tuple" && Array.isArray(v)) {return v.map((e, index) => encodeDuckdb(type.items[index], e, name));}
  if (type.kind === "map" && Array.isArray(v)) {return v.map((e) => (!matchesNull(e) && hasObjectType(e) ? { ...e, key: encodeDuckdb(type.key, (e as { key?: unknown }).key, name), value: encodeDuckdb(type.value, (e as { value?: unknown }).value, name) } : e));}
  if (type.kind === "struct" && hasObjectType(v) && !Array.isArray(v)) {
    const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    Iterator.from(type.fields).forEach((field) => {out[field.name] = encodeDuckdb(field.type, out[field.name], name);});
    return out;
  }
  // A UNION takes `{ tag, value }`, its tag one of its members and its value that member's.
  // Node-api cannot build a union whose member is NULL, which DuckDB keeps apart from a NULL union.
  if (type.kind === "union") {
    const { tag, value } = (hasObjectType(v) ? v : {}) as { tag?: unknown; value?: unknown };
    const member = type.members.find((m) => m.name === tag);
    const tags = type.members.map((m) => JSON.stringify(m.name)).join(", ");
    if (matchesUndefined(member)) {throw new ParameterError(`Parameter "${name}" is a UNION, so it takes { tag, value } with the tag one of ${tags}; got ${JSON.stringify(v)}.`);}
    if (matchesNullish(value)) {throw new ParameterError(`Parameter "${name}" is a UNION, and @duckdb/node-api cannot bind one whose ${JSON.stringify(tag)} member is null: pass null for the whole parameter, or a value of the member.`);}
    return { tag, value: encodeDuckdb(member.type, value, name) };
  }
  if (type.kind !== "scalar") {return v;}
  if (INTEGERS.has(type.name)) {
    if (matchesNumber(v) && !Number.isInteger(v)) {throw new ParameterError(`Parameter "${name}" is an integer, and ${v} has a fraction, which DuckDB would round away.`);}
    if (matchesString(v) && !/^\s*[+-]?\d+\s*$/u.test(v)) {throw new ParameterError(`Parameter "${name}" is an integer, so a string for it holds the digits alone; got ${JSON.stringify(v)}.`);}
  }
  if (type.name === "interval" && matchesString(v)) {return duckdbInterval(v);}
  // A number goes as its text, which DuckDB casts to the parameter's type exactly: bound as it
  // Is, node-api would type a whole number as an integer (a float's 3.4e38 overflows a BIGINT)
  // And a BigInt as a signed HUGEINT (a UHUGEINT's maximum overflows it).
  if (matchesNumber(v) || matchesBigInt(v)) {return String(v);}
  // DuckDB reads a year past 9999 without the sign ISO 8601 writes before it (`+10000-01-01`).
  if (matchesString(v) && TIMES.has(type.name)) {return v.replace(/^\+0*(\d{4,})/u, "$1");}
  return v;
};

const TIMES = new Set(["date", "timestamp", "timestamp_s", "timestamp_ms", "timestamp_ns", "timestamptz", "timestamptz_ns"]);

// --- Decoding --------------------------------------------------------------------------------

const JSON_ERROR_PREVIEW = 60;
const MEMBER_NOT_FOUND = -1;

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

/** A value of DuckDB's type `t`, as node-api reads it, in its kind's form; `column` names it in an error. */
function decode(v: unknown, t: DuckType, column: string): unknown {
  if (matchesNull(v) || matchesUndefined(v)) {return null;}
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Each DuckDB type ID selects the corresponding fields of the node-api value.
  const native = v as NativeDuckValue;
  switch (t.typeId) {
    case DUCKDB_TYPE.BOOLEAN: case DUCKDB_TYPE.TINYINT: case DUCKDB_TYPE.SMALLINT: case DUCKDB_TYPE.INTEGER: case DUCKDB_TYPE.UTINYINT: case DUCKDB_TYPE.USMALLINT: case DUCKDB_TYPE.UINTEGER: case DUCKDB_TYPE.FLOAT: case DUCKDB_TYPE.DOUBLE: {
      return v;
    }
    case DUCKDB_TYPE.BIGINT: case DUCKDB_TYPE.UBIGINT: case DUCKDB_TYPE.HUGEINT: case DUCKDB_TYPE.UHUGEINT: case DUCKDB_TYPE.BIGNUM: {
      return matchesBigInt(v) ? v : BigInt(v as number);
    }
    case DUCKDB_TYPE.VARCHAR: {
      if (t.alias?.toUpperCase() === "JSON" && matchesString(v)) {
        try {
          return JSON.parse(v);
        } catch {
          throw new DecodeError(`Column "${column}" is JSON, and holds text that is not: ${JSON.stringify(v.slice(0, JSON_ERROR_PREVIEW))}.`);
        }
      }
      return v;
    }
    case DUCKDB_TYPE.ENUM: case DUCKDB_TYPE.UUID: case DUCKDB_TYPE.BIT: case DUCKDB_TYPE.TIME: case DUCKDB_TYPE.TIME_NS: case DUCKDB_TYPE.TIME_TZ: {
      return String(v);
    }
    case DUCKDB_TYPE.BLOB: {
      return native.bytes instanceof Uint8Array ? native.bytes : v;
    }
    case DUCKDB_TYPE.DECIMAL: {
      return matchesBigInt(native.value) && matchesNumber(native.scale) ? decimal(native.value, native.scale) : String(v);
    }
    case DUCKDB_TYPE.DATE: {
      return dateFromDays(native, v);
    }
    case DUCKDB_TYPE.TIMESTAMP: { return timestamp(native.micros, MICROSECONDS, ""); }
    case DUCKDB_TYPE.TIMESTAMP_S: { return timestamp(native.seconds, SECONDS, ""); }
    case DUCKDB_TYPE.TIMESTAMP_MS: { return timestamp(native.millis, MILLISECONDS, ""); }
    case DUCKDB_TYPE.TIMESTAMP_NS: { return timestamp(native.nanos, NANOSECONDS, ""); }
    case DUCKDB_TYPE.TIMESTAMP_TZ: { return timestamp(native.micros, MICROSECONDS, "Z"); }
    case DUCKDB_TYPE.TIMESTAMP_TZ_NS: { return timestamp(native.nanos, NANOSECONDS, "Z"); }
    case DUCKDB_TYPE.INTERVAL: { return interval(native.months, native.days, native.micros); }
    case DUCKDB_TYPE.LIST: case DUCKDB_TYPE.ARRAY: {
      return native.items.map((currentItem) => decode(currentItem, t.valueType!, column));
    }
    case DUCKDB_TYPE.STRUCT: {
      // A tuple, a struct whose fields have no names, is its values in order.
      if (Array.isArray(native.items)) {return native.items.map((currentItem, index) => decode(currentItem, t.entryTypes![index]!, column));}
      const out: Record<string, unknown> = {};
      t.entryNames!.forEach((name, index) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DuckDB's named STRUCT exposes fields as an object.
        const fields = native.entries as Record<string, unknown>;
        out[name] = decode(fields[name], t.entryTypes![index]!, column);
      });
      return out;
    }
    case DUCKDB_TYPE.MAP: {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DuckDB's MAP exposes its ordered key and value entries as an array.
      const entries = native.entries as { key: unknown; value: unknown }[];
      return entries.map((entry) => ({ key: decode(entry.key, t.keyType!, column), value: decode(entry.value, t.valueType!, column) }));
    }
    case DUCKDB_TYPE.UNION: {
      const at = t.memberTags!.indexOf(native.tag);
      return { tag: native.tag, value: at === MEMBER_NOT_FOUND ? native.value : decode(native.value, t.memberTypes![at]!, column) };
    }
    case DUCKDB_TYPE.VARIANT: {
      // A VARIANT holds a value of any type, which it carries beside it.
      return decode(native.value, native.type ?? { typeId: 0 }, column);
    }
    default: {
      // A type an extension adds (GEOMETRY): its text, where node-api gives a value of its own.
      if (v instanceof Uint8Array) {return v;}
      return hasObjectType(v) ? String(v) : v;
    }
  }
}
