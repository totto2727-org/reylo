import { basicFailure, equal, pointer, regex } from "./json-schema-constraints.ts";
import { hasObjectType, isRecord, matchesNull, matchesNumber, matchesUndefined } from "./native-predicates.ts";

// A JSON Schema 2020-12 validator for the run time, which has no dependencies: it checks a value
// Against the schema a statement writes in a `json('…')` member of a column list or, where it is
// Built, a JSON parameter's cast (wiki/typed-json-params.md: JSON
// Schema in its entirety; checks TypeScript cannot say are Reylo's to run). The engine refuses what
// The profile leaves out before a module is written (references, `unevaluatedItems`, a schema in
// `unevaluatedProperties`, the dynamic keywords), so none of those reach this file. A format is
// Asserted, as the decision of 2026-10-19 says; a format this file has no rule for checks nothing.

type Schema = boolean | Readonly<Record<string, unknown>>;

/** Why a value fails a schema: the place in the value, as a JSON Pointer, and what it breaks. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep validation failures assignable to structural Record consumers.
export type Failure = { path: string; message: string };

const EMPTY_FAILURES = 0;

const fail = (out: Failure[], path: string, message: string): false => {
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the field order in serialized validation failures.
  out.push({ path, message });
  return false;
};

/**
 * A fresh copy of a JSON value, such as a schema's `default`, so that filling one in never shares
 * it between calls. A JSON round trip rather than `structuredClone`, which the run time cannot name
 * where a project's tsconfig loads no Node or DOM types (the labs set `"types": []`), and which
 * gives the same copy for a JSON value.
 */
export const cloneJson = function cloneJson<T>(value: T): T {
  return matchesUndefined(value) ? value : JSON.parse(JSON.stringify(value));
};

/**
 * The value with the schema's defaults filled in, as ajv's `useDefaults` fills them (a
 * JSON parameter's default is its schema's `default`): a key `properties`
 * names and the value lacks takes its `default`, and so does an item `prefixItems` names past the
 * array's end. A key that is null keeps its null. Defaults are filled wherever the schema applies
 * to the value but inside `anyOf`, `oneOf`, `not`, `if`, `contains` and `propertyNames`, whose
 * matches are unknown until the checks run. The value given is not changed: a copy comes back.
 */
export const withDefaults = function withDefaults(schema: Schema, value: unknown): unknown {
  if (!isRecord(schema)) {return value;}
  const s = schema;
  let out = value;
  if (isRecord(value)) {
    const o: Record<string, unknown> = { ...value };
    const properties = (s.properties ?? {}) as Record<string, Schema>;
    Object.entries(properties).forEach(([key, sub]) => {
      if (! Object.hasOwn(o, key) && !matchesNull(sub) && hasObjectType(sub) && "default" in sub) {o[key] = cloneJson((sub).default);}
    });
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>).map(([key, sub]) => [regex(key), sub] as const);
    Iterator.from(Object.keys(o)).forEach((key) => {
      let named = false;
      if (Object.hasOwn(properties, key)) {
        named = true;
        o[key] = withDefaults(properties[key]!, o[key]);
      }
      for (const [re, sub] of patterns) {
        if (re.test(key)) {
          named = true;
          o[key] = withDefaults(sub, o[key]);
        }
      }
      if (!named && !matchesUndefined(s.additionalProperties)) {o[key] = withDefaults(s.additionalProperties as Schema, o[key]);}
    });
    if (s.dependentSchemas && hasObjectType(s.dependentSchemas)) {
      Object.entries(s.dependentSchemas as Record<string, Schema>).forEach(([key, sub]) => {if (Object.hasOwn(o, key)) {Object.assign(o, withDefaults(sub, o) as object);}});
    }
    out = o;
  } else if (Array.isArray(value)) {
    const a = [...value];
    const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
    prefix.forEach((sub, index) => {
      if (index >= a.length && !matchesNull(sub) && hasObjectType(sub) && "default" in sub && a.length === index) {a.push(cloneJson((sub).default));}
    });
    for (let i = 0; i < a.length; i++) {a[i] = withDefaults(i < prefix.length ? prefix[i]! : (s.items as Schema) ?? true, a[i]);}
    out = a;
  }
  if (Array.isArray(s.allOf)) {Iterator.from(s.allOf as Schema[]).forEach((sub) => {out = withDefaults(sub, out);});}
  // Only the branch the value takes: `if` decides it as the checks will.
  if (!matchesUndefined(s.if)) {
    const branch = matchesUndefined(validate(s.if as Schema, out)) ? s.then : s.else;
    if (!matchesUndefined(branch)) {out = withDefaults(branch as Schema, out);}
  }
  return out;
};

/** The first failure of `value` against `schema`, or `undefined` when it passes. */
export function validate(schema: Schema, value: unknown): Failure | undefined {
  const failures: Failure[] = [];
  check(schema, value, "", failures);
  return failures[0];
}

/** What a passing check evaluated of an object's keys, for `unevaluatedProperties`. */
type Evaluated = Set<string>;

/** Checks `value`; on failure records why and returns `false`, on success the keys it evaluated. */
function check(schema: Schema, value: unknown, path: string, out: Failure[]): Evaluated | false {
  const evaluated: Evaluated = new Set();
  if (schema === true) {return evaluated;}
  if (schema === false) {return fail(out, path, "no value is allowed here");}
  if (!isRecord(schema)) {return evaluated;}
  const s = schema;

  const message = basicFailure(s, value);
  if (!matchesUndefined(message)) {return fail(out, path, message);}
  if (Array.isArray(value)) {
    if (matchesNumber(s.maxItems) && value.length > s.maxItems) {return fail(out, path, `must have at most ${s.maxItems} items`);}
    if (matchesNumber(s.minItems) && value.length < s.minItems) {return fail(out, path, `must have at least ${s.minItems} items`);}
    if (s.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {for (let j = i + 1; j < value.length; j++) {if (equal(value[i], value[j])) {return fail(out, path, `must have no two equal items (${i} and ${j})`);}}}
    }
    const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
    for (let i = 0; i < Math.min(prefix.length, value.length); i++) {if (check(prefix[i]!, value[i], `${path}/${i}`, out) === false) {return false;}}
    if (!matchesUndefined(s.items)) {for (let i = prefix.length; i < value.length; i++) {if (check(s.items as Schema, value[i], `${path}/${i}`, out) === false) {return false;}}}
    if (!matchesUndefined(s.contains)) {
      let matched = 0;
      Iterator.from(value).forEach((item) => {if (check(s.contains as Schema, item, path, []) !== false) {matched++;}});
      const min = matchesNumber(s.minContains) ? s.minContains : 1;
      if (matched < min) {return fail(out, path, min === 1 ? "must contain an item that matches its `contains` schema" : `must contain at least ${min} items that match its \`contains\` schema`);}
      if (matchesNumber(s.maxContains) && matched > s.maxContains) {return fail(out, path, `must contain at most ${s.maxContains} items that match its \`contains\` schema`);}
    }
  }
  if (isRecord(value)) {
    const o = value;
    const keys = Object.keys(o);
    if (matchesNumber(s.maxProperties) && keys.length > s.maxProperties) {return fail(out, path, `must have at most ${s.maxProperties} keys`);}
    if (matchesNumber(s.minProperties) && keys.length < s.minProperties) {return fail(out, path, `must have at least ${s.minProperties} keys`);}
    // A key is the object's own: `toString` and `__proto__` are keys only where the value has them.
    const has = (key: string): boolean => Object.hasOwn(o, key);
    if (Array.isArray(s.required)) {for (const key of s.required as string[]) {if (!has(key)) {return fail(out, path, `must have the key "${key}"`);}}}
    if (s.dependentRequired && hasObjectType(s.dependentRequired)) {
      for (const [key, needs] of Object.entries(s.dependentRequired as Record<string, string[]>)) {
        if (has(key)) {for (const need of needs) {if (!has(need)) {return fail(out, path, `must have the key "${need}" beside "${key}"`);}}}
      }
    }
    const properties = (s.properties ?? {}) as Record<string, Schema>;
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>).map(([key, sub]) => [regex(key), sub] as const);
    for (const key of keys) {
      const at = `${path}/${pointer(key)}`;
      let named = false;
      if (Object.hasOwn(properties, key)) {
        named = true;
        if (check(properties[key]!, o[key], at, out) === false) {return false;}
      }
      for (const [re, sub] of patterns) {
        if (re.test(key)) {
          named = true;
          if (check(sub, o[key], at, out) === false) {return false;}
        }
      }
      if (named) {evaluated.add(key);}
      else if (!matchesUndefined(s.additionalProperties)) {
        if (check(s.additionalProperties as Schema, o[key], at, out) === false) {
          if (s.additionalProperties !== false) {return false;}
          out.length = EMPTY_FAILURES;
          return fail(out, at, "is a key the schema does not allow");
        }
        evaluated.add(key);
      }
      if (!matchesUndefined(s.propertyNames) && check(s.propertyNames as Schema, key, at, []) === false) {return fail(out, at, `is a key whose name the schema does not allow`);}
    }
    if (s.dependentSchemas && hasObjectType(s.dependentSchemas)) {
      for (const [key, sub] of Object.entries(s.dependentSchemas as Record<string, Schema>)) {
        if (!has(key)) {continue;}
        const result = check(sub, value, path, out);
        if (result === false) {return false;}
        result.forEach((k) => evaluated.add(k));
      }
    }
  }

  // The applicators: a subschema's evaluated keys count only where it passed.
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf as Schema[]) {
      const result = check(sub, value, path, out);
      if (result === false) {return false;}
      result.forEach((k) => evaluated.add(k));
    }
  }
  if (Array.isArray(s.anyOf)) {
    let any = false;
    Iterator.from(s.anyOf as Schema[]).forEach((sub) => {
      const result = check(sub, value, path, []);
      if (result !== false) {
        any = true;
        result.forEach((k) => evaluated.add(k));
      }
    });
    if (!any) {return fail(out, path, "must match one of its `anyOf` schemas");}
  }
  if (Array.isArray(s.oneOf)) {
    let matched = 0;
    Iterator.from(s.oneOf as Schema[]).forEach((sub) => {
      const result = check(sub, value, path, []);
      if (result !== false) {
        matched++;
        result.forEach((k) => evaluated.add(k));
      }
    });
    if (matched !== 1) {return fail(out, path, matched === 0 ? "must match one of its `oneOf` schemas" : "must match only one of its `oneOf` schemas, and matches more");}
  }
  if (!matchesUndefined(s.not) && check(s.not as Schema, value, path, []) !== false) {return fail(out, path, "must not match its `not` schema");}
  if (!matchesUndefined(s.if)) {
    const result = check(s.if as Schema, value, path, []);
    const branch = result === false ? s.else : s.then;
    if (result !== false) {result.forEach((k) => evaluated.add(k));}
    if (!matchesUndefined(branch)) {
      const currentResult = check(branch as Schema, value, path, out);
      if (currentResult === false) {return false;}
      currentResult.forEach((k) => evaluated.add(k));
    }
  }
  if (isRecord(value)) {
    if (s.unevaluatedProperties === false) {
      for (const key of Object.keys(value)) {if (!evaluated.has(key)) {return fail(out, `${path}/${pointer(key)}`, "is a key the schema does not allow");}}
    }
    // `true` evaluates every key left, for an enclosing `unevaluatedProperties: false`.
    if (s.unevaluatedProperties === true) {Object.keys(value).forEach((key) => {evaluated.add(key);});}
  }
  return evaluated;
}
