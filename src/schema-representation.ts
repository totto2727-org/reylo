import type { JsonSchema } from "./engine-type.ts";
import { scalarKind, scalarKindParts } from "./values.ts";
import type { Dialect, ScalarKind } from "./values.ts";

export type Schema = Record<string, unknown>;
const SINGLE_KIND = 1;

/** A PostGIS geometry inside a document, which its cast to JSON writes as GeoJSON. */
// oxlint-disable-next-line eslint/sort-keys -- Preserve the field order in the serialized GeoJSON schema.
const GEOJSON: Schema = { type: "object", properties: { type: { type: "string" } }, required: ["type"], description: "a GeoJSON geometry" };

const withFormat = (type: string | string[], format: string): Schema => (
  // oxlint-disable-next-line eslint/sort-keys -- Keep the type before its format in serialized query schemas.
  { type, format }
);

export const withDescription = (type: string, description: string): Schema => (
  // oxlint-disable-next-line eslint/sort-keys -- Keep the type before its description in serialized query schemas.
  { type, description }
);

export const arraySchema = (items: Schema | JsonSchema): Schema => (
  // oxlint-disable-next-line eslint/sort-keys -- Keep the array type before its items in serialized query schemas.
  { type: "array", items }
);

const binarySchema = (): Schema => (
  // oxlint-disable-next-line eslint/sort-keys -- Keep the binary type, format, and encoding in the published order.
  { type: "string", format: "byte", contentEncoding: "base64" }
);

const hstoreSchema = (): Schema => (
  // oxlint-disable-next-line eslint/sort-keys -- Keep the object type before the property schema in serialized query schemas.
  { type: "object", additionalProperties: { type: ["string", "null"] } }
);

const documentNumberSchema = (format: string, dialect: Dialect): Schema => {
  const finite = withFormat("number", format);
  return dialect === "postgres" ? { anyOf: [finite, { enum: ["NaN", "Infinity", "-Infinity"] }] } : finite;
};

const KIND_SCHEMAS: Record<ScalarKind, (name: string, dialect: Dialect) => Schema> = {
  bool: () => ({ type: "boolean" }),
  bytes: binarySchema,
  date: () => withFormat("string", "date"),
  decimal: () => withFormat("string", "decimal"),
  float: (name, dialect) => withFormat("number", name === "float4" || (dialect === "duckdb" && name === "float") ? "float" : "double"),
  hstore: hstoreSchema,
  // A SQLite INTEGER is 64 bits wide, and so is an oid's range past int4's.
  int: (name, dialect) => withFormat("integer", name === "oid" || dialect === "sqlite" || name === "uinteger" ? "int64" : "int32"),
  // A BigInt, as the JSON integer it is.
  int8: () => withFormat("integer", "int64"),
  // RFC 3339's duration, which JSON Schema's `duration` format names, has no sign and no fraction.
  interval: () => withDescription("string", "an ISO 8601 duration with its sign in front (P1Y2M3DT4H5M6.789S, -P1D); one whose parts differ in sign signs each part (P1M-1D)"),
  json: () => ({}),
  text: () => ({ type: "string" }),
  // A date and a time with no zone, which RFC 3339's date-time does not admit.
  timestamp: () => withDescription("string", "a date and time without a time zone, as the database wrote it (2026-10-20T10:00:00.123456)"),
  timestamptz: () => withFormat("string", "date-time"),
  unknown: () => ({}),
  vector: () => arraySchema(withFormat("number", "float")),
};

/**
 * The JSON form of a value of `kind` as `run` returns it, once JSON: each kind's one representation (src/values.ts).
 * @param {ScalarKind} kind - The scalar representation.
 * @param {string} name - The database type name.
 * @param {Dialect} dialect - The database dialect.
 * @returns {Schema} The JSON representation of the scalar.
 */
const kindSchema = (kind: ScalarKind, name: string, dialect: Dialect): Schema => KIND_SCHEMAS[kind](name, dialect);

const sqliteInputSchema = (name: string): Schema => {
  switch (name) {
    case "integer": case "int8": {return withFormat("integer", "int64");}
    case "real": {return withFormat("number", "double");}
    case "text": {return { type: "string" };}
    case "blob": {return binarySchema();}
    case "numeric": {return { type: ["number", "string"] };}
    case "bool": {return { type: "boolean" };}
    default: {return {};}
  }
};

const sqliteScalar = (name: string, inInputOrDocument: boolean): Schema => {
  // A SQLite INTEGER is a number as a parameter (src/render.ts), and its JSON spelling inside a
  // Document; as `run` returns it, its kind's.
  if (inInputOrDocument) {return sqliteInputSchema(name);}
  const kinds = scalarKindParts(name, "sqlite");
  if (kinds.length > SINGLE_KIND) {
    // A NUMERIC: whichever storage class the row stored, an integer being a number too.
    const types = [...new Set(kinds.map((part) => kindSchema(part, name, "sqlite").type))];
    return { type: types.includes("number") ? types.filter((currentType) => currentType !== "integer") : types };
  }
  const [kind] = kinds;
  return kindSchema(kind, name, "sqlite");
};

// As the database writes a value inside a document. Postgres writes non-finite numbers as text.
const DOCUMENT_SCHEMAS = new Map<string, (dialect: Dialect) => Schema>([
  ["int8", () => withFormat("integer", "int64")],
  ["float4", (dialect) => documentNumberSchema("float", dialect)],
  ["float8", (dialect) => documentNumberSchema("double", dialect)],
  ["numeric", (dialect) => documentNumberSchema("decimal", dialect)],
  ["bytea", () => withFormat("string", "hex")],
  // The runtime converts an interval result column, and keeps the server's spelling in documents.
  ["interval", () => withDescription("string", "pg type interval")],
  ["record", () => ({ type: "object" })],
  ["hstore", hstoreSchema],
  ["geometry", () => GEOJSON],
  // Oids and vectors appear as text when Postgres puts them inside a document.
  ["oid", () => ({ type: "string" })],
  ["vector", () => ({ type: "string" })],
  ["halfvec", () => ({ type: "string" })],
]);

const integerParameter = (): Schema => withFormat(["integer", "string"], "int64");
const decimalParameter = (): Schema => withFormat("string", "decimal");
const timeParameter = (): Schema => withFormat("string", "date-time");

const DUCKDB_PARAMETERS = new Map<string, () => Schema>([
  ["int8", integerParameter],
  ["decimal", decimalParameter],
  ["timestamp", timeParameter],
]);

const SQL_PARAMETERS = new Map<string, () => Schema>([
  ["int8", integerParameter],
  ["numeric", decimalParameter],
  ["timestamp", timeParameter],
]);

interface ScalarPosition {
  inJson: boolean;
  input: boolean;
}

const positionSchema = (name: string, dialect: Dialect, { inJson, input }: ScalarPosition): Schema | undefined => {
  if (inJson) {return DOCUMENT_SCHEMAS.get(name)?.(dialect);}
  if (!input) {return undefined;}
  return dialect === "duckdb" ? DUCKDB_PARAMETERS.get(scalarKind(name, dialect))?.() : SQL_PARAMETERS.get(name)?.();
};

const DIALECT_NAMES = new Map<Dialect, string>([["mysql", "MySQL"], ["duckdb", "DuckDB"]]);

const textScalar = (name: string, dialect: Dialect): Schema => {
  switch (name) {
    case "text": case "varchar": case "bpchar": case "name": case "char": case "citext": {return { type: "string" };}
    case "uuid": {return withFormat("string", "uuid");}
    case "time": {return withFormat("string", "time");}
    case "unknown": {return {};}
    default: {return withDescription("string", `${DIALECT_NAMES.get(dialect) ?? "pg"} type ${name}`);}
  }
};

const resultScalar = (name: string, dialect: Dialect): Schema => {
  const kinds = scalarKindParts(name, dialect);
  if (kinds.length > SINGLE_KIND) {return { anyOf: kinds.map((part) => kindSchema(part, name, dialect)) };}
  const [kind] = kinds;
  return kind === "text" ? textScalar(name, dialect) : kindSchema(kind, name, dialect);
};

/**
 * A base type by its catalog name, standing where `position` says: inside a JSON document, as a parameter the caller passes, or as `run` returns it.
 * @param {string} name - The catalog name of the type.
 * @param {Dialect} dialect - The database dialect.
 * @param {ScalarPosition} position - The value's position in the query or result.
 * @returns {Schema} The schema for the base type in this position.
 */
export const scalarSchema = function scalarSchema(name: string, dialect: Dialect, position: ScalarPosition): Schema {
  if (name.includes("|")) {return { anyOf: name.split("|").map((part) => scalarSchema(part, dialect, position)) };}
  if (dialect === "sqlite") {return sqliteScalar(name, position.inJson || position.input);}
  return positionSchema(name, dialect, position) ?? resultScalar(name, dialect);
};
