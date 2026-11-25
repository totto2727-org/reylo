import { regex } from "./json-schema-constraints.ts";
import { hasFunctionType, hasObjectType, isRecord, matchesNull, matchesUndefined } from "./native-predicates.ts";

type Keywords = Readonly<Record<string, unknown>>;
type Matches = (schema: unknown, value: unknown) => boolean;
type Pattern = [RegExp, unknown];

const entriesOf = (value: unknown): [string, unknown][] => Object.entries(value ?? {});

const property = (source: unknown, key: string): unknown => {
  const boxed: unknown = new Object(source);
  if ((!matchesNull(boxed) && hasObjectType(boxed)) || hasFunctionType(boxed)) {return Reflect.get(boxed, key);}
  return undefined;
};

/**
 * Copies a JSON value, including a schema default that may be reused between calls.
 * @param {T} value The JSON value.
 * @returns {T} The same value or an independent JSON copy.
 */
export const cloneJson = function cloneJson<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone, typescript/no-unsafe-return -- Preserve the generic JSON round trip in projects that load neither DOM nor Node types.
  return matchesUndefined(value) ? value : JSON.parse(JSON.stringify(value));
};

const defaultOf = (schema: unknown): { value: unknown } | undefined => {
  if (!matchesNull(schema) && hasObjectType(schema) && "default" in schema) {return { value: schema.default };}
  return undefined;
};

interface ObjectKeywords {
  patterns: Pattern[];
  properties: object;
  schema: Keywords;
}

class Defaults {
  #matches: Matches;

  public constructor(matches: Matches) {
    this.#matches = matches;
  }

  public fill(schema: unknown, value: unknown): unknown {
    if (!isRecord(schema)) {return value;}
    const shaped = this.#shape(schema, value);
    const applied = this.#allOf(schema.allOf, shaped);
    if (matchesUndefined(schema.if)) {return applied;}
    const branch = this.#matches(schema.if, applied) ? schema.then : schema.else;
    return matchesUndefined(branch) ? applied : this.fill(branch, applied);
  }

  #shape(schema: Keywords, value: unknown): unknown {
    if (isRecord(value)) {return this.#object(schema, value);}
    if (Array.isArray(value)) {return this.#array(schema, value);}
    return value;
  }

  #allOf(branches: unknown, value: unknown): unknown {
    if (!Array.isArray(branches)) {return value;}
    const applied = { value };
    Iterator.from(branches).forEach((subschema) => {applied.value = this.fill(subschema, applied.value);});
    return applied.value;
  }

  #object(schema: Keywords, value: Record<string, unknown>): Record<string, unknown> {
    const result = { ...value };
    const properties = schema.properties ?? {};
    entriesOf(properties).forEach(([key, subschema]) => {
      if (!Object.hasOwn(result, key)) {
        const fallback = defaultOf(subschema);
        if (!matchesUndefined(fallback)) {result[key] = cloneJson(fallback.value);}
      }
    });
    const patterns = entriesOf(schema.patternProperties).map(([key, sub]): Pattern => [regex(key), sub]);
    const keywords = { patterns, properties, schema };
    Object.keys(result).forEach((name) => {this.#member(name, result, keywords);});
    this.#dependencies(schema.dependentSchemas, result);
    return result;
  }

  #member(name: string, result: Record<string, unknown>, { patterns, properties, schema }: ObjectKeywords): void {
    const matched = { named: Object.hasOwn(properties, name) };
    if (matched.named) {result[name] = this.fill(property(properties, name), result[name]);}
    Iterator.from(patterns).forEach(([pattern, subschema]) => {
      if (pattern.test(name)) {
        matched.named = true;
        result[name] = this.fill(subschema, result[name]);
      }
    });
    if (!matched.named && !matchesUndefined(schema.additionalProperties)) {
      result[name] = this.fill(schema.additionalProperties, result[name]);
    }
  }

  #dependencies(dependencies: unknown, result: Record<string, unknown>): void {
    if (matchesNull(dependencies) || !hasObjectType(dependencies)) {return;}
    entriesOf(dependencies).forEach(([key, subschema]) => {
      if (Object.hasOwn(result, key)) {Object.assign(result, this.fill(subschema, result));}
    });
  }

  #array(schema: Keywords, value: unknown[]): unknown[] {
    const result = [...value];
    const prefix: unknown[] = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    prefix.forEach((subschema, index) => {
      if (index === result.length) {
        const fallback = defaultOf(subschema);
        if (!matchesUndefined(fallback)) {result.push(cloneJson(fallback.value));}
      }
    });
    result.forEach((item, index) => {
      const subschema = index < prefix.length ? prefix[index] : schema.items ?? true;
      result[index] = this.fill(subschema, item);
    });
    return result;
  }
}

export const fillDefaults = (schema: unknown, value: unknown, matches: Matches): unknown => new Defaults(matches).fill(schema, value);
