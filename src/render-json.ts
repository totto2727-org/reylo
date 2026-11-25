import { isEmptyArray, isRecord, matchesBoolean, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { grouped, ident, JSON_TYPE, objectFields } from "./render-text.ts";

const NO_REQUIRED_ITEMS = 0;
const NEVER = "never";

const union = (types: string[]): string => {
  const unique = [...new Set(types)];
  if (unique.includes(JSON_TYPE)) {return JSON_TYPE;}
  const real = unique.filter((type) => type !== NEVER);
  return isEmptyArray(real) ? NEVER : real.join(" | ");
};

const literalType = (value: unknown): string => {
  if (matchesNull(value) || matchesNumber(value) || matchesBoolean(value)) {return String(value);}
  if (matchesString(value)) {return JSON.stringify(value);}
  if (Array.isArray(value)) {return `[${value.map((item: unknown) => literalType(item)).join(", ")}]`;}
  if (isRecord(value)) {return objectFields(Object.entries(value).map(([key, item]) => `${ident(key)}: ${literalType(item)}`));}
  return "unknown";
};

type Schema = Record<string, unknown>;
type RenderSubschema = (schema: unknown) => string;

const arrayType = (schema: Schema, render: RenderSubschema): string => {
  const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems.map((item: unknown) => render(item)) : [];
  const rest = matchesUndefined(schema.items) ? JSON_TYPE : render(schema.items);
  if (isEmptyArray(prefix)) {return rest === NEVER ? "[]" : `${grouped(rest)}[]`;}
  const min = matchesNumber(schema.minItems) ? schema.minItems : NO_REQUIRED_ITEMS;
  const items = prefix.map((item, index) => index < min ? item : `${grouped(item)}?`);
  if (rest !== NEVER) {items.push(`...${grouped(rest)}[]`);}
  return `[${items.join(", ")}]`;
};

const remainingType = (schema: Schema, hasNamedKeys: boolean, input: boolean): unknown => {
  const { additionalProperties } = schema;
  if (matchesUndefined(additionalProperties) || additionalProperties === false) {return false;}
  if (input && additionalProperties === true && hasNamedKeys) {return false;}
  return additionalProperties;
};

const objectType = (schema: Schema, render: RenderSubschema, input: boolean): string => {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  const fields = Object.entries(properties).map(([key, value]) => `${ident(key)}${required.includes(key) ? "" : "?"}: ${render(value)}`);
  const hasNamedKeys = !isEmptyArray(fields);
  const rest = render(remainingType(schema, hasNamedKeys, input));
  if (rest !== NEVER) {fields.push(`[key: string]: ${hasNamedKeys ? `${JSON_TYPE} | undefined` : rest}`);}
  if (isEmptyArray(fields) && matchesUndefined(schema.additionalProperties)) {return `Record<string, ${JSON_TYPE}>`;}
  return objectFields(fields);
};

const primitiveType = new Map([
  ["boolean", "boolean"], ["integer", "number"], ["null", "null"], ["number", "number"], ["string", "string"],
]);

const kindType = (kind: string, schema: Schema, context: { input: boolean; render: RenderSubschema }): string => {
  if (kind === "array") {return arrayType(schema, context.render);}
  if (kind === "object") {return objectType(schema, context.render, context.input);}
  return primitiveType.get(kind) ?? JSON_TYPE;
};

const schemaKinds = (value: unknown): string[] => {
  if (matchesString(value)) {return [value];}
  if (Array.isArray(value)) {return value.filter((kind: unknown) => matchesString(kind));}
  return [];
};

const alternatives = (schema: Schema, render: RenderSubschema): string | undefined => {
  if (Array.isArray(schema.anyOf)) {return union(schema.anyOf.map((item: unknown) => render(item)));}
  if (Array.isArray(schema.enum)) {return union(schema.enum.map((item: unknown) => literalType(item)));}
  return matchesUndefined(schema.not) ? undefined : NEVER;
};

/**
 * Render the JSON Schema carried by the engine's analysis.
 * @param {unknown} schema - The engine's canonical JSON Schema.
 * @param {boolean} [input] - Accept only named keys for an input object with named properties.
 * @returns {string} The generated JSON value type.
 */
export const schemaType = function schemaType(schema: unknown, input = false): string {
  if (schema === false) {return NEVER;}
  if (!isRecord(schema)) {return JSON_TYPE;}
  const render = (value: unknown): string => schemaType(value, input);
  const included = alternatives(schema, render);
  if (!matchesUndefined(included)) {return included;}
  const kinds = schemaKinds(schema.type);
  return isEmptyArray(kinds) ? JSON_TYPE : union(kinds.map((kind) => kindType(kind, schema, { input, render })));
};
