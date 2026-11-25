import { checkArray } from "./json-schema-arrays.ts";
import { basicFailure, pointer, regex } from "./json-schema-constraints.ts";
import { fillDefaults } from "./json-schema-defaults.ts";

import { hasObjectType, isRecord, matchesNumber, matchesUndefined } from "./native-predicates.ts";

export { cloneJson } from "./json-schema-defaults.ts";

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

/** What a passing check evaluated of an object's keys, for `unevaluatedProperties`. */
type Evaluated = Set<string>;

/** Checks `value`; on failure records why and returns `false`, on success the keys it evaluated. */
function check(schema: unknown, value: unknown, path: string, out: Failure[]): Evaluated | false {
  const evaluated: Evaluated = new Set();
  if (schema === true) {return evaluated;}
  if (schema === false) {return fail(out, path, "no value is allowed here");}
  if (!isRecord(schema)) {return evaluated;}
  const s = schema;

  const message = basicFailure(s, value);
  if (!matchesUndefined(message)) {return fail(out, path, message);}
  if (Array.isArray(value) && !checkArray(s, value, {
    check: (subschema, item, position) => check(subschema, item, position, out) !== false,
    fail: (reason) => fail(out, path, reason),
    path,
    probe: (subschema, item) => check(subschema, item, path, []) !== false,
  })) {return false;}
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


const firstFailure = (schema: unknown, value: unknown): Failure | undefined => {
  const failures: Failure[] = [];
  check(schema, value, "", failures);
  return failures[0];
};

/**
 * Checks the value and reports its first failure.
 * @param {Schema} schema The emitted JSON Schema.
 * @param {unknown} value The value supplied by the caller.
 * @returns {Failure | undefined} The first failure or undefined when the value passes.
 */
export const validate = function validate(schema: Schema, value: unknown): Failure | undefined {
  return firstFailure(schema, value);
};

/**
 * Returns a copy with the selected schema defaults applied. Explicit nulls keep their value.
 * Applies defaults from matching object members, positional array members, allOf and the chosen
 * conditional branch. Other alternatives validate the value without supplying defaults.
 * @param {Schema} schema The emitted JSON Schema.
 * @param {unknown} value The supplied JSON value.
 * @returns {unknown} The value with applicable defaults filled in.
 */
export const withDefaults = function withDefaults(schema: Schema, value: unknown): unknown {
  return fillDefaults(schema, value, (condition, candidate) => matchesUndefined(firstFailure(condition, candidate)));
};
