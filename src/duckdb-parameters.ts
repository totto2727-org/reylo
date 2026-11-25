import { duckdbInterval } from "./decode-duckdb-time.ts";
import type { Api } from "./duckdb-node-api.ts";
import type { EngineType } from "./engine-type.ts";
import { hasObjectType, matchesBigInt, matchesNull, matchesNullish, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { SQL_NULL_VALUE } from "./value-text.ts";
import { ParameterError } from "./values.ts";

export const needsBinding = (value: unknown): boolean => !matchesNull(value) && hasObjectType(value);

type RecursiveBinding = (type: EngineType | undefined, value: unknown) => unknown;

interface ArrayParameter {
  type: EngineType | undefined;
  values: unknown[];
}

interface ObjectParameter {
  type: EngineType | undefined;
  value: object;
}

interface NativeEntry {
  key?: unknown;
  value?: unknown;
}

interface NativeMember {
  tag?: unknown;
  value?: unknown;
}

const fieldsOf = (value: object): Record<string, unknown> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DuckDB STRUCT parameters carry their named fields as an indexable object.
  value as Record<string, unknown>;

const memberOf = (value: object): NativeMember => value;

const firstMapPart = (entries: unknown[], key: "key" | "value"): unknown => {
  // oxlint-disable-next-line rules/no-for-loops -- Respect the map entries' order and stop as soon as one supplies a value.
  for (const entry of entries) {
    if (!matchesNull(entry) && hasObjectType(entry)) {
      const fields: NativeEntry = entry;
      if (!matchesNullish(fields[key])) {return fields[key];}
    }
  }
  return undefined;
};

const arrayType = (api: Api, { type, values }: ArrayParameter, bind: RecursiveBinding): unknown => {
  if (type?.kind === "tuple") {
    return api.TUPLE(type.items.map((item, index) => bind(item, values[index])));
  }
  if (type?.kind === "map") {
    return api.MAP(bind(type.key, firstMapPart(values, "key")), bind(type.value, firstMapPart(values, "value")));
  }
  return api.LIST(bind(type?.kind === "array" ? type.of : undefined, values.find((item) => !matchesNullish(item))));
};

const objectType = (api: Api, { type, value }: ObjectParameter, bind: RecursiveBinding): unknown => {
  if (type?.kind === "struct") {
    const fields = fieldsOf(value);
    return api.STRUCT(Object.fromEntries(type.fields.map((field) => [field.name, bind(field.type, fields[field.name])])));
  }
  if (type?.kind === "union") {
    const union = memberOf(value);
    return api.UNION(Object.fromEntries(type.members.map((member) => [
      member.name, bind(member.type, union.tag === member.name ? union.value : undefined),
    ])));
  }
  return api.VARCHAR;
};

// Bind nested scalar text as VARCHAR and let DuckDB cast it with its own range checks.
const bindType = function bindType(api: Api, type: EngineType | undefined, value: unknown): unknown {
  if (value instanceof Uint8Array) {return api.BLOB;}
  if (matchesNull(value) || !hasObjectType(value)) {return api.VARCHAR;}
  const bind = (child: EngineType | undefined, entry: unknown): unknown => bindType(api, child, entry);
  return Array.isArray(value) ? arrayType(api, { type, values: value }, bind) : objectType(api, { type, value }, bind);
};

const arrayValue = (api: Api, { type, values }: ArrayParameter, bind: RecursiveBinding): unknown => {
  if (type?.kind === "tuple") {return api.tupleValue(type.items.map((item, index) => bind(item, values[index])));}
  if (type?.kind === "map") {
    return api.mapValue(values.map((entry) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native map binding reads the optional properties of each supplied collection entry.
      const pair = entry as NativeEntry | null | undefined;
      return { key: bind(type.key, pair?.key), value: bind(type.value, pair?.value) };
    }));
  }
  return api.listValue(values.map((item) => bind(type?.kind === "array" ? type.of : undefined, item)));
};

const objectValue = (api: Api, { type, value }: ObjectParameter, bind: RecursiveBinding): unknown => {
  if (type?.kind === "struct") {
    const fields = fieldsOf(value);
    return api.structValue(Object.fromEntries(type.fields.map((field) => [field.name, bind(field.type, fields[field.name])])));
  }
  if (type?.kind === "union") {
    const { tag, value: entry } = memberOf(value);
    return api.unionValue(String(tag), bind(type.members.find((member) => member.name === tag)?.type, entry));
  }
  return JSON.stringify(value);
};

const bindValue = function bindValue(api: Api, type: EngineType | undefined, value: unknown): unknown {
  if (matchesNullish(value)) {return SQL_NULL_VALUE;}
  if (value instanceof Uint8Array) {return api.blobValue(value);}
  if (!hasObjectType(value)) {
    // oxlint-disable-next-line typescript/no-base-to-string -- Nested scalars retain DuckDB's original native String conversion before casting.
    return String(value);
  }
  const bind = (child: EngineType | undefined, entry: unknown): unknown => bindValue(api, child, entry);
  return Array.isArray(value) ? arrayValue(api, { type, values: value }, bind) : objectValue(api, { type, value }, bind);
};

interface Bindings {
  types: unknown[];
  values: unknown[];
}

export const bindingsFrom = (api: Api, values: unknown[], types: (EngineType | undefined)[]): Bindings => ({
  // Build all native type descriptors before building any native values.
  types: values.map((value, index) => needsBinding(value) ? bindType(api, types[index], value) : undefined),
  values: values.map((value, index) => needsBinding(value) ? bindValue(api, types[index], value) : value),
});

type MapType = Extract<EngineType, { kind: "map" }>;
type StructType = Extract<EngineType, { kind: "struct" }>;
type UnionType = Extract<EngineType, { kind: "union" }>;

const encodeMapEntry = (type: MapType, entry: unknown, encode: RecursiveBinding): unknown => {
  if (matchesNull(entry) || !hasObjectType(entry)) {return entry;}
  const pair: NativeEntry = entry;
  return { ...entry, key: encode(type.key, pair.key), value: encode(type.value, pair.value) };
};

const encodeStruct = (type: StructType, value: object, encode: RecursiveBinding): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...value };
  Iterator.from(type.fields).forEach((field) => {result[field.name] = encode(field.type, result[field.name]);});
  return result;
};

interface ParameterContext {
  encode: RecursiveBinding;
  name: string;
}

const encodeUnion = (type: UnionType, value: unknown, { encode, name }: ParameterContext): unknown => {
  const { tag, value: entry } = !matchesNullish(value) && hasObjectType(value) ? memberOf(value) : {};
  const member = type.members.find((candidate) => candidate.name === tag);
  const tags = type.members.map((candidate) => JSON.stringify(candidate.name)).join(", ");
  if (matchesUndefined(member)) {
    throw new ParameterError(`Parameter "${name}" is a UNION, so it takes { tag, value } with the tag one of ${tags}; got ${JSON.stringify(value)}.`);
  }
  if (matchesNullish(entry)) {
    throw new ParameterError(`Parameter "${name}" is a UNION, and @duckdb/node-api cannot bind one whose ${JSON.stringify(tag)} member is null: pass null for the whole parameter, or a value of the member.`);
  }
  return { tag, value: encode(member.type, entry) };
};

const INTEGERS = new Set(["tinyint", "smallint", "integer", "bigint", "hugeint", "utinyint", "usmallint", "uinteger", "ubigint", "uhugeint", "bignum"]);
const TIMES = new Set(["date", "timestamp", "timestamp_s", "timestamp_ms", "timestamp_ns", "timestamptz", "timestamptz_ns"]);

const checkInteger = (value: unknown, name: string): void => {
  if (matchesNumber(value) && !Number.isInteger(value)) {
    throw new ParameterError(`Parameter "${name}" is an integer, and ${value} has a fraction, which DuckDB would round away.`);
  }
  if (matchesString(value) && !/^\s*[+-]?\d+\s*$/u.test(value)) {
    throw new ParameterError(`Parameter "${name}" is an integer, so a string for it holds the digits alone; got ${JSON.stringify(value)}.`);
  }
};

const encodeScalar = (type: string, value: unknown, name: string): unknown => {
  if (INTEGERS.has(type)) {checkInteger(value, name);}
  if (type === "interval" && matchesString(value)) {return duckdbInterval(value);}
  if (matchesNumber(value) || matchesBigInt(value)) {return String(value);}
  if (matchesString(value) && TIMES.has(type)) {return value.replace(/^\+0*(?<year>\d{4,})/u, "$<year>");}
  return value;
};

type ContainerType = Extract<EngineType, { kind: "array" | "map" | "struct" | "tuple" }>;

const encodeContainer = (type: ContainerType, value: unknown, encode: RecursiveBinding): unknown => {
  switch (type.kind) {
    case "array": {return Array.isArray(value) ? value.map((item: unknown) => encode(type.of, item)) : value;}
    case "tuple": {return Array.isArray(value) ? value.map((item: unknown, index) => encode(type.items[index], item)) : value;}
    case "map": {return Array.isArray(value) ? value.map((item: unknown) => encodeMapEntry(type, item, encode)) : value;}
    case "struct": {return !matchesNull(value) && hasObjectType(value) && !Array.isArray(value) ? encodeStruct(type, value, encode) : value;}
    default: {return value;}
  }
};

/**
 * Checks a DuckDB parameter before rounding or binding can change its value.
 * @param {EngineType | undefined} type - The engine's parameter type, when known.
 * @param {unknown} value - The supplied parameter value.
 * @param {string} name - The parameter name used in diagnostics.
 * @returns {unknown} The value in the representation the DuckDB driver accepts.
 */
export const encodeDuckdb = function encodeDuckdb(type: EngineType | undefined, value: unknown, name: string): unknown {
  if (matchesUndefined(type) || matchesNullish(value)) {return value;}
  if (type.kind === "scalar") {return encodeScalar(type.name, value, name);}
  const encode = (child: EngineType | undefined, entry: unknown): unknown => encodeDuckdb(child, entry, name);
  if (type.kind === "union") {return encodeUnion(type, value, { encode, name });}
  return type.kind === "array" || type.kind === "map" || type.kind === "struct" || type.kind === "tuple"
    ? encodeContainer(type, value, encode)
    : value;
};
