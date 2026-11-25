import { entriesOf, memberOf, patternsOf, pointer } from "./json-schema-constraints.ts";
import type { Pattern } from "./json-schema-constraints.ts";
import { hasObjectType, matchesNull, matchesNumber, matchesUndefined } from "./native-predicates.ts";

type Keywords = Readonly<Record<string, unknown>>;

interface ObjectCheck {
  check: (schema: unknown, value: unknown, path: string) => Set<string> | false;
  evaluated: Set<string>;
  fail: (path: string, message: string) => false;
  path: string;
  probe: (schema: unknown, value: unknown, path: string) => boolean;
  replace: (path: string, message: string) => false;
}

const countFailure = (schema: Keywords, keys: string[]): string | undefined => {
  if (matchesNumber(schema.maxProperties) && keys.length > schema.maxProperties) {return `must have at most ${schema.maxProperties} keys`;}
  if (matchesNumber(schema.minProperties) && keys.length < schema.minProperties) {return `must have at least ${schema.minProperties} keys`;}
  return undefined;
};

const missingKey = (keys: Iterable<unknown>, value: Record<string, unknown>): string | undefined => {
  // oxlint-disable-next-line rules/no-for-loops -- Report the first missing requirement and do not read later keys for a failed object.
  for (const key of keys) {
    const name = String(key);
    if (!Object.hasOwn(value, name)) {return name;}
  }
  return undefined;
};

const requiredFailure = (schema: Keywords, value: Record<string, unknown>): string | undefined => {
  if (!Array.isArray(schema.required)) {return undefined;}
  const missing = missingKey(schema.required, value);
  return matchesUndefined(missing) ? undefined : `must have the key "${missing}"`;
};

const dependencyFailure = (dependencies: unknown, value: Record<string, unknown>): string | undefined => {
  if (matchesNull(dependencies) || !hasObjectType(dependencies)) {return undefined;}
  // oxlint-disable-next-line rules/no-for-loops -- Report the first missing dependent key in the supplied dependency order.
  for (const [owner, needs] of entriesOf(dependencies)) {
    if (Object.hasOwn(value, owner)) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The engine emits a list of names for each dependentRequired keyword entry.
      const missing = missingKey(needs as Iterable<unknown>, value);
      if (!matchesUndefined(missing)) {return `must have the key "${missing}" beside "${owner}"`;}
    }
  }
  return undefined;
};

interface Member {
  key: string;
  path: string;
  value: Record<string, unknown>;
}

interface PropertyKeywords {
  patterns: Pattern[];
  properties: object;
  schema: Keywords;
}

const checkPatterns = ({ key, path, value }: Member, patterns: Pattern[], context: ObjectCheck): { matched: boolean } | false => {
  const matches = { matched: false };
  // oxlint-disable-next-line rules/no-for-loops -- Match every applicable pattern in keyword order until one reports an error.
  for (const [pattern, subschema] of patterns) {
    if (pattern.test(key)) {
      matches.matched = true;
      if (context.check(subschema, value[key], path) === false) {return false;}
    }
  }
  return matches;
};

const checkAvailable = (member: Member, { patterns, properties }: PropertyKeywords, context: ObjectCheck): { matched: boolean } | false => {
  const { key, path, value } = member;
  const named = Object.hasOwn(properties, key);
  if (named && context.check(memberOf(properties, key), value[key], path) === false) {return false;}
  const result = checkPatterns(member, patterns, context);
  if (result === false) {return false;}
  return { matched: named || result.matched };
};

const checkAdditional = ({ key, path, value }: Member, schema: Keywords, context: ObjectCheck): boolean => {
  if (matchesUndefined(schema.additionalProperties)) {return true;}
  if (context.check(schema.additionalProperties, value[key], path) === false) {
    if (schema.additionalProperties === false) {return context.replace(path, "is a key the schema does not allow");}
    return false;
  }
  context.evaluated.add(key);
  return true;
};

const checkMember = (member: Member, keywords: PropertyKeywords, context: ObjectCheck): boolean => {
  const { key, path } = member;
  const matching = checkAvailable(member, keywords, context);
  if (matching === false) {return false;}
  if (matching.matched) {context.evaluated.add(key);}
  else if (!checkAdditional(member, keywords.schema, context)) {return false;}
  if (!matchesUndefined(keywords.schema.propertyNames) && !context.probe(keywords.schema.propertyNames, key, path)) {
    return context.fail(path, "is a key whose name the schema does not allow");
  }
  return true;
};

const checkProperties = ({ keys, schema, value }: { keys: string[]; schema: Keywords; value: Record<string, unknown> }, context: ObjectCheck): boolean => {
  const properties = schema.properties ?? {};
  const patterns = patternsOf(schema.patternProperties);
  const keywords = { patterns, properties, schema };
  // oxlint-disable-next-line rules/no-for-loops -- Walk members in original object key order and stop on the first error.
  for (const key of keys) {
    const path = `${context.path}/${pointer(key)}`;
    if (!checkMember({ key, path, value }, keywords, context)) {return false;}
  }
  return true;
};

const checkDependents = (dependencies: unknown, value: Record<string, unknown>, context: ObjectCheck): boolean => {
  if (matchesNull(dependencies) || !hasObjectType(dependencies)) {return true;}
  // oxlint-disable-next-line rules/no-for-loops -- Apply dependent schemas in insertion order and preserve the first failure.
  for (const [key, subschema] of entriesOf(dependencies)) {
    if (Object.hasOwn(value, key)) {
      const result = context.check(subschema, value, context.path);
      if (result === false) {return false;}
      result.forEach((evaluatedKey) => {context.evaluated.add(evaluatedKey);});
    }
  }
  return true;
};

export const checkObject = (schema: Keywords, value: Record<string, unknown>, context: ObjectCheck): boolean => {
  const keys = Object.keys(value);
  const missing = countFailure(schema, keys) ?? requiredFailure(schema, value) ?? dependencyFailure(schema.dependentRequired, value);
  if (!matchesUndefined(missing)) {return context.fail(context.path, missing);}
  if (!checkProperties({ keys, schema, value }, context)) {return false;}
  return checkDependents(schema.dependentSchemas, value, context);
};
