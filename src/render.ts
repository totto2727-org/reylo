// Render the engine's SQL type model using the same scalar representations as the native runtime.
import type { EngineType } from "./engine-core.ts";
import { isEmptyArray, matchesUndefined } from "./native-predicates.ts";
import { schemaType } from "./render-json.ts";
import { jsonScalar } from "./render-json-scalars.ts";
import { ident, JSON_TYPE, lastOfEachName, objectFields, orNull } from "./render-text.ts";
import { kindType as typeOfKind, scalarKind } from "./values.ts";
import type { Dialect } from "./values.ts";

export { schemaType } from "./render-json.ts";
export { ident, JSON_TYPE, lastOfEachName, orNull } from "./render-text.ts";

type Field = Extract<EngineType, { kind: "object" }>["fields"][number];
type ArrayType = Extract<EngineType, { kind: "array" }>;
type RowType = Extract<EngineType, { kind: "rows" }>;
type DuckdbAggregate = Extract<EngineType, { kind: "struct" | "map" | "tuple" | "union" }>;
type OrdinaryResult = Exclude<EngineType, DuckdbAggregate | RowType | { kind: "unknown" }>;

const DRIVER_MODE = false;
const JSON_MODE = true;
const STANDARD_DIALECT = "postgres";
const NESTED_PARAM = true;
const INTEGER_INPUT = "number | bigint | string";
// Date and timestamp inputs use the value's text to keep driver timezone settings out of binding.
const temporal = new Set(["date", "timestamp", "timestamptz"]);
const duckdbTextInputs = new Set([...temporal, "decimal", "interval"]);
// SQLite writes a Boolean column with NUMERIC affinity as 1 or 0.
const sqliteScalarInput = new Map([
  ["bool", "boolean | number"], ["int8", "number | bigint"], ["integer", "number"], ["numeric", "number | string | boolean"],
]);

const arrayOf = (text: string): string => /[|&]/u.test(text) ? `(${text})[]` : `${text}[]`;
const isRecordValue = (type: EngineType): boolean =>
  type.kind === "composite" || (type.kind === "scalar" && type.name === "record");

const enumLabels = (labels: string[]): string =>
  isEmptyArray(labels) ? "string" : labels.map((label) => JSON.stringify(label)).join(" | ");

const nonSqliteInput = (name: string): string | undefined => {
  if (name === "int8") {return INTEGER_INPUT;}
  if (name.split("|").every((part) => temporal.has(part)) || name === "numeric") {return "string";}
  return undefined;
};

const scalarInput = (name: string, dialect: Dialect): string | undefined => {
  if (dialect === "duckdb") {
    const kind = scalarKind(name, dialect);
    if (kind === "int8") {return INTEGER_INPUT;}
    if (duckdbTextInputs.has(kind)) {return "string";}
  }
  const specific = dialect === "sqlite" ? sqliteScalarInput.get(name) : nonSqliteInput(name);
  if (!matchesUndefined(specific)) {return specific;}
  return name === "bytea" || name === "blob" ? "Uint8Array" : undefined;
};

/**
 * Render a caller-specified JSON schema in the position where the caller supplies that value.
 * @param {EngineType} type - The analyzed parameter or structured field type.
 * @param {unknown} declared - The schema supplied in the statement, if any.
 * @returns {string | undefined} The caller's JSON type when the statement declares one.
 */
export const declaredType = function declaredType(type: EngineType, declared: unknown): string | undefined {
  return !matchesUndefined(declared) && type.kind === "json" && !matchesUndefined(type.schema) ? schemaType(type.schema, true) : undefined;
};

class Renderer {
  #dialect: Dialect;

  public constructor(dialect: Dialect) {this.#dialect = dialect;}

  public result(type: EngineType, inJson: boolean): string {
    if (type.kind === "rows") {return this.#rowsParam(type);}
    if (type.kind === "unknown") {return inJson ? JSON_TYPE : "unknown";}
    if (type.kind === "struct" || type.kind === "map" || type.kind === "tuple" || type.kind === "union") {
      return this.#duckdbResult(type);
    }
    return this.#ordinaryResult(type, inJson);
  }

  #ordinaryResult(type: OrdinaryResult, inJson: boolean): string {
    if (type.kind === "scalar") {return this.#scalarResult(type.name, inJson);}
    if (type.kind === "enum") {return enumLabels(type.labels);}
    if (type.kind === "array") {return this.#arrayResult(type, inJson);}
    return this.#documentResult(type, inJson);
  }

  #scalarResult(name: string, inJson: boolean): string {
    return inJson ? jsonScalar(name, this.#dialect) : typeOfKind(scalarKind(name, this.#dialect));
  }

  #arrayResult(type: ArrayType, inJson: boolean): string {
    // A driver returns a Postgres row array as text. In documents it returns JSON.
    if (!inJson && isRecordValue(type.of)) {return "string";}
    const item = this.result(type.of, inJson);
    // Array elements can be null unless the analysis proves that the statement excludes nulls.
    return arrayOf(type.nullable_items === false ? item : orNull(item));
  }

  #documentResult(type: Exclude<OrdinaryResult, { kind: "scalar" | "enum" | "array" }>, inJson: boolean): string {
    if (type.kind === "json") {return matchesUndefined(type.schema) ? JSON_TYPE : schemaType(type.schema);}
    if (type.kind === "object") {return this.#jsonFields(type.fields);}
    if (type.kind === "composite") {return inJson ? this.#jsonFields(type.fields) : "string";}
    const item = this.result(type.of, JSON_MODE);
    return arrayOf(type.nullable_items ? orNull(item) : item);
  }

  #jsonFields(fields: Field[]): string {
    return objectFields(lastOfEachName(fields).map((field) => {
      const name = ident(field.name);
      const { nullable } = field;
      const type = this.result(field.type, JSON_MODE);
      return `${name}: ${nullable ? orNull(type) : type}`;
    }));
  }

  #driverFields(fields: Field[]): string {
    return objectFields(lastOfEachName(fields).map((field) => `${ident(field.name)}: ${orNull(this.result(field.type, DRIVER_MODE))}`));
  }

  #duckdbResult(type: DuckdbAggregate): string {
    if (type.kind === "struct") {return this.#driverFields(type.fields);}
    if (type.kind === "map") {return `{ key: ${this.result(type.key, DRIVER_MODE)}; value: ${orNull(this.result(type.value, DRIVER_MODE))} }[]`;}
    if (type.kind === "tuple") {return `[${type.items.map((item) => orNull(this.result(item, DRIVER_MODE))).join(", ")}]`;}
    if (isEmptyArray(type.members)) {return "never";}
    return type.members.map((member) => `{ tag: ${JSON.stringify(member.name)}; value: ${orNull(this.result(member.type, DRIVER_MODE))} }`).join(" | ");
  }

  public param(type: EngineType, inRow: boolean): string {
    if (type.kind === "scalar") {return scalarInput(type.name, this.#dialect) ?? this.result(type, DRIVER_MODE);}
    if (type.kind === "rows") {return this.#rowsParam(type);}
    if (type.kind === "array") {return this.#arrayParam(type, inRow);}
    return this.#compoundParam(type);
  }

  #compoundParam(type: Exclude<EngineType, { kind: "scalar" | "rows" | "array" }>): string {
    if (this.#dialect !== "duckdb") {return this.result(type, DRIVER_MODE);}
    if (type.kind === "struct") {return objectFields(type.fields.map((field) => `${ident(field.name)}: ${orNull(this.param(field.type, NESTED_PARAM))}`));}
    if (type.kind === "map") {return `readonly { key: ${this.param(type.key, NESTED_PARAM)}; value: ${orNull(this.param(type.value, NESTED_PARAM))} }[]`;}
    if (type.kind === "tuple") {return `readonly [${type.items.map((item) => orNull(this.param(item, NESTED_PARAM))).join(", ")}]`;}
    return this.result(type, DRIVER_MODE);
  }

  #rowsParam(type: RowType): string {
    const fields = type.fields.map((field) => {
      const value = declaredType(field.type, field.schema) ?? this.param(field.type, NESTED_PARAM);
      const optional = field.optional ? "?" : "";
      return `${ident(field.name)}${optional}: ${field.nullable ? orNull(value) : value}`;
    });
    const row = objectFields(fields);
    return type.one ? row : `readonly ${row}[]`;
  }

  #arrayParam(type: ArrayType, inRow: boolean): string {
    if (isRecordValue(type.of)) {return "string | string[]";}
    const inner = this.param(type.of, inRow);
    // A nested record can pass null array elements back to the database.
    return arrayOf(inRow ? orNull(inner) : inner);
  }
}

/**
 * Render the value the native driver returns for an analyzed SQL type.
 * @param {EngineType} type - The analyzed result type.
 * @param {boolean} [inJson] - Whether the database serializes this value inside a JSON document.
 * @param {Dialect} [dialect] - The database dialect.
 * @returns {string} The result's TypeScript representation.
 */
export const renderType = function renderType(type: EngineType, inJson = DRIVER_MODE, dialect: Dialect = STANDARD_DIALECT): string {
  return new Renderer(dialect).result(type, inJson);
};

/**
 * Render what the runtime accepts for a SQL parameter, including each supported round-trip value.
 * @param {EngineType} type - The analyzed parameter type.
 * @param {Dialect} [dialect] - The database dialect.
 * @param {boolean} [inRow] - Whether to retain null elements inside structured input fields.
 * @returns {string} The parameter's TypeScript representation.
 */
export const renderParamType = function renderParamType(type: EngineType, dialect: Dialect = STANDARD_DIALECT, inRow = false): string {
  return new Renderer(dialect).param(type, inRow);
};
