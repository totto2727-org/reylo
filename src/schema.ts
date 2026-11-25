// The JSON Schema of a query's input and output: `query.inputSchema`, `query.outputSchema`, and
// Standard Schema's `jsonSchema` converter. A build step writes both into the module. The
// Spellings are the upstream engine's (engine/core/src/schema.rs); what differs
// Is where a value stands. The output is the result as JSON writes it (`AsJson<T>` in src/index.ts)
// Of the value `run` returns, which is each type's one representation (src/values.ts, the same
// Table the run time decodes with): a 64-bit integer, a BigInt, as the JSON integer it is (what a
// Serializer that writes a BigInt exactly writes, `JSON.rawJSON(String(v))`; JSON.stringify itself
// Refuses a BigInt), a decimal its text, a timestamptz its ISO text in UTC, a date and a timestamp
// The wall-clock text the server wrote. The input is the parameters the caller passes.
import type { EngineType, JsonSchema } from "./engine-type.ts";
import { hasObjectType, matchesNull, matchesString, matchesUndefined } from "./native-predicates.ts";
import { arraySchema, scalarSchema, withDescription } from "./schema-representation.ts";
import type { Schema } from "./schema-representation.ts";
import type { Dialect } from "./values.ts";

interface Analysis {
  params: Readonly<{ name: string; type: EngineType; nullable: boolean; schema?: JsonSchema }[]>;
  columns: Readonly<{ name: string; type: EngineType; nullable: boolean }[]>;
  cardinality: "one" | "maybeOne" | "many" | "none";
}

/**
 * The schema admitting null as well: a bare `type` gets `"null"` beside it, anything else an `anyOf` with null.
 * @param {Schema | JsonSchema} schema - The schema before adding null.
 * @returns {Schema | JsonSchema} The schema that also admits null.
 */
const nullable = function (schema: Schema | JsonSchema): Schema | JsonSchema {
  if (schema === true) {return schema;}
  if (hasObjectType(schema)) {
    const [first, second] = Object.keys(schema);
    if (matchesUndefined(first)) {return schema;}
    if (matchesUndefined(second) && matchesString(schema.type)) {return { type: [schema.type, "null"] };}
  }
  return { anyOf: [schema, { type: "null" }] };
};

const MISSING_KEY = -1;
const SINGLE_KEY = 1;

/**
 * An object of `fields`, each spelled by `fieldSchema`. A later field replaces an earlier field with the same name.
 * @param {Readonly<Field[]>} fields - The fields in statement order.
 * @param {(field: Field) => Schema | JsonSchema} fieldSchema - The schema of a field.
 * @param {Object} options - The presence of optional keys and the admission of other keys.
 * @param {boolean} [options.closed] - Whether to reject other keys.
 * @param {(field: Field) => boolean} [options.optional] - Whether the field may be absent.
 * @returns {Schema} The schema of the object.
 */
const object = function <Field extends { name: string }>(
  fields: Readonly<Field[]>,
  fieldSchema: (field: Field) => Schema | JsonSchema,
  { closed = false, optional = () => false }: { closed?: boolean; optional?: (field: Field) => boolean } = {},
): Schema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  // A later field of a name replaces an earlier one, as a row object and `JSON.parse` keep the last.
  fields.forEach((field) => {
    properties[field.name] = fieldSchema(field);
    const previous = required.indexOf(field.name);
    if (previous !== MISSING_KEY) {required.splice(previous, SINGLE_KEY);}
    if (!optional(field)) {required.push(field.name);}
  });
  // oxlint-disable-next-line eslint/sort-keys -- Keep the field order of the emitted object schema.
  return { type: "object", properties, required, ...(closed ? { additionalProperties: false } : {}) };
};

const withNull = (schema: Schema | JsonSchema, acceptsNull: boolean): Schema | JsonSchema =>
  acceptsNull ? nullable(schema) : schema;

type SchemaPosition = [input?: boolean, inJson?: boolean, inRow?: boolean];

interface ValuePosition {
  inJson: boolean;
  inRow: boolean;
  input: boolean;
}

type StructuredType = Extract<EngineType, { kind: "composite" | "map" | "object" | "rows" | "struct" | "tuple" | "union" }>;

type RenderNested = (valueType: EngineType, ...position: SchemaPosition) => Schema | JsonSchema;

const sequenceSchema = (valueType: Extract<EngineType, { kind: "array" | "list" }>, { inJson, inRow, input }: ValuePosition, render: RenderNested): Schema => {
  if (valueType.kind === "list") {
    return arraySchema(withNull(render(valueType.of, input, true), valueType.nullable_items));
  }
  // A result's elements may be null unless the statement shows they are not; a parameter's
  // Are strict, but a structured parameter's member keeps them (src/render.ts).
  const items = render(valueType.of, input, inJson, inRow);
  const acceptsNull = input ? inRow || (valueType.nullable_items ?? false) : valueType.nullable_items !== false;
  return arraySchema(withNull(items, acceptsNull));
};

const structuredParameterSchema = (valueType: Extract<StructuredType, { kind: "rows" }>, render: RenderNested): Schema => {
  // A JSON member's schema as written, with its defaults and formats.
  const row = object(valueType.fields, (field) => withNull(field.schema ?? render(field.type, true, false, true), field.nullable), {
    closed: true,
    optional: (field) => field.optional,
  });
  return valueType.one ? row : arraySchema(row);
};

// oxlint-disable-next-line typescript/consistent-return -- All supported structured kinds return schemas. Unknown native kinds keep the existing undefined fallback.
const structuredSchema = (valueType: StructuredType, { inJson, input }: Pick<ValuePosition, "inJson" | "input">, render: RenderNested): Schema => {
  // oxlint-disable-next-line eslint/default-case -- TypeScript checks the supported kinds. Missing native cases deliberately keep the existing undefined fallback.
  switch (valueType.kind) {
    case "composite":
    case "object": {
      if (valueType.kind === "composite" && !inJson) {return withDescription("string", `the row value of ${valueType.name} as Postgres prints it`);}
      return object(valueType.fields, (field) => withNull(render(field.type, input, true), field.nullable));
    }
    case "rows": {return structuredParameterSchema(valueType, render);}
    // A DuckDB struct's fields, map's entries and union's value stand as a row's values do, each may be null.
    case "struct": {return object(valueType.fields, (field) => nullable(render(field.type, input)));}
    case "map": {
      const entries = [
        { name: "key", schema: render(valueType.key, input) },
        { name: "value", schema: nullable(render(valueType.value, input)) },
      ];
      return arraySchema(object(entries, (entry) => entry.schema));
    }
    case "tuple": {
      // oxlint-disable-next-line eslint/sort-keys -- Keep the field order of the emitted tuple schema.
      return { type: "array", prefixItems: valueType.items.map((item) => nullable(render(item, input))), items: false, minItems: valueType.items.length };
    }
    case "union": {
      return { anyOf: valueType.members.map((member) => object([
        { name: "tag", schema: { const: member.name } },
        { name: "value", schema: nullable(render(member.type, input)) },
      ], (field) => field.schema)) };
    }
  }
};

const forDialect = (dialect: Dialect): RenderNested => {
  const render: RenderNested = (valueType, ...position) => {
    const [input = false, inJson = false, inRow = false] = position;
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- The default passes the remaining typed structures to their own exhaustive dispatch.
    switch (valueType.kind) {
      case "scalar": {return scalarSchema(valueType.name, dialect, { inJson, input });}
      case "enum": {
        // oxlint-disable-next-line eslint/sort-keys -- Keep the type before the enum labels in the emitted schema.
        return { type: "string", enum: valueType.labels };
      }
      case "array": case "list": {return sequenceSchema(valueType, { inJson, inRow, input }, render);}
      case "json": {return valueType.schema ?? {};}
      case "unknown": {return {};}
      default: {return structuredSchema(valueType, { inJson, input }, render);}
    }
  };
  return render;
};

/**
 * The JSON Schema of a value of `valueType`, as a result column (`input` false) or a parameter the caller passes (`input` true), or a structured parameter's member (`inRow`).
 * @param {EngineType} valueType - The value's database type.
 * @param {Dialect} dialect - The database dialect.
 * @param {SchemaPosition} position - Whether the value is a parameter, occurs inside JSON, or belongs to a structured parameter.
 * @returns {Schema | JsonSchema} The schema for the value in this position.
 */
export const typeSchema = function typeSchema(valueType: EngineType, dialect: Dialect, ...position: SchemaPosition): Schema | JsonSchema {
  return forDialect(dialect)(valueType, ...position);
};

const outputSchema = (row: Schema, cardinality: Analysis["cardinality"]): Schema => {
  if (cardinality === "many") {return arraySchema(row);}
  if (cardinality === "one") {return row;}
  if (cardinality === "maybeOne") {return { anyOf: [row, { type: "null" }] };}
  return { type: "null" };
};

/**
 * The query's input and output schemas: the parameters as an object, and the result as `run` returns it once JSON.
 * @param {Analysis} analysis - The analyzed parameters and return columns.
 * @param {Dialect} dialect - The database dialect.
 * @returns {{ input: Schema, output: Schema }} The input and output JSON schemas.
 */
export const querySchemas = function querySchemas(analysis: Analysis, dialect: Dialect): { input: Schema; output: Schema } {
  const render = forDialect(dialect);
  // A typed JSON parameter's schema as written, with its defaults; one with a `default` at its root may be left out, as may one that takes null.
  const input = object(analysis.params, (parameter) => {
    const schema = parameter.schema ?? render(parameter.type, true);
    return withNull(schema, parameter.nullable);
  }, {
    closed: true,
    optional: (parameter) => {
      const { schema } = parameter;
      return parameter.nullable || (!matchesNull(schema) && hasObjectType(schema) && !matchesUndefined(schema) && "default" in schema);
    },
  });
  const row = object(analysis.columns, (column) => withNull(render(column.type), column.nullable));
  const output = outputSchema(row, analysis.cardinality);
  return { input: { $schema: "https://json-schema.org/draft/2020-12/schema", ...input }, output: { $schema: "https://json-schema.org/draft/2020-12/schema", ...output } };
};
