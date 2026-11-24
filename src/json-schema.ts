import { matchesJsonFormat } from "./json-formats.ts";
import { hasObjectType, isRecord, matchesBoolean, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

// A JSON Schema 2020-12 validator for the run time, which has no dependencies: it checks a value
// Against the schema a statement writes in a `json('…')` member of a column list or, where it is
// Built, a JSON parameter's cast (wiki/typed-json-params.md: JSON
// Schema in its entirety; checks TypeScript cannot say are Reylo's to run). The engine refuses what
// The profile leaves out before a module is written (references, `unevaluatedItems`, a schema in
// `unevaluatedProperties`, the dynamic keywords), so none of those reach this file. A format is
// Asserted, as the decision of 2026-10-19 says; a format this file has no rule for checks nothing.

type Schema = boolean | Readonly<Record<string, unknown>>;
type Object_ = Readonly<Record<string, unknown>>;

/** Why a value fails a schema: the place in the value, as a JSON Pointer, and what it breaks. */
export type Failure = { path: string; message: string };

/**
 * A fresh copy of a JSON value, such as a schema's `default`, so that filling one in never shares
 * it between calls. A JSON round trip rather than `structuredClone`, which the run time cannot name
 * where a project's tsconfig loads no Node or DOM types (the labs set `"types": []`), and which
 * gives the same copy for a JSON value.
 */
export function cloneJson<T>(value: T): T {
  return matchesUndefined(value) ? value : JSON.parse(JSON.stringify(value));
}

/**
 * The value with the schema's defaults filled in, as ajv's `useDefaults` fills them (a
 * JSON parameter's default is its schema's `default`): a key `properties`
 * names and the value lacks takes its `default`, and so does an item `prefixItems` names past the
 * array's end. A key that is null keeps its null. Defaults are filled wherever the schema applies
 * to the value but inside `anyOf`, `oneOf`, `not`, `if`, `contains` and `propertyNames`, whose
 * matches are unknown until the checks run. The value given is not changed: a copy comes back.
 */
export function withDefaults(schema: Schema, value: unknown): unknown {
  if (!isRecord(schema)) {return value;}
  const s = schema;
  let out = value;
  if (isRecord(value)) {
    const o: Record<string, unknown> = { ...value };
    const properties = (s.properties ?? {}) as Record<string, Schema>;
    Object.entries(properties).forEach(([key, sub]) => {
      if (! Object.hasOwn(o, key) && !matchesNull(sub) && hasObjectType(sub) && "default" in sub) {o[key] = cloneJson((sub).default);}
    });
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>).map(([p, sub]) => [regex(p), sub] as const);
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
}

/** The first failure of `value` against `schema`, or `undefined` when it passes. */
export function validate(schema: Schema, value: unknown): Failure | undefined {
  const failures: Failure[] = [];
  check(schema, value, "", failures);
  return failures[0];
}

/** What a passing check evaluated of an object's keys, for `unevaluatedProperties`. */
type Evaluated = Set<string>;

/** Checks `value`; on failure pushes why and returns `undefined`, on success the keys it evaluated. */
function check(schema: Schema, value: unknown, path: string, out: Failure[]): Evaluated | undefined {
  const evaluated: Evaluated = new Set();
  if (schema === true) {return evaluated;}
  if (schema === false) {return fail(out, path, "no value is allowed here");}
  if (!isRecord(schema)) {return evaluated;}
  const s = schema;

  if (!matchesUndefined(s.type)) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((currentType) => is(currentType, value))) {return fail(out, path, `must be ${types.join(" or ")}, got ${kind(value)}`);}
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, value))) {return fail(out, path, `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);}
  if ("const" in s && !equal(s.const, value)) {return fail(out, path, `must be ${JSON.stringify(s.const)}`);}

  if (matchesNumber(value)) {
    if (matchesNumber(s.multipleOf) && !multiple(value, s.multipleOf)) {return fail(out, path, `must be a multiple of ${s.multipleOf}`);}
    if (matchesNumber(s.maximum) && value > s.maximum) {return fail(out, path, `must be at most ${s.maximum}`);}
    if (matchesNumber(s.exclusiveMaximum) && value >= s.exclusiveMaximum) {return fail(out, path, `must be less than ${s.exclusiveMaximum}`);}
    if (matchesNumber(s.minimum) && value < s.minimum) {return fail(out, path, `must be at least ${s.minimum}`);}
    if (matchesNumber(s.exclusiveMinimum) && value <= s.exclusiveMinimum) {return fail(out, path, `must be more than ${s.exclusiveMinimum}`);}
  }
  if (matchesString(value)) {
    // A length counts code points, as JSON Schema says.
    const {length} = [...value];
    if (matchesNumber(s.maxLength) && length > s.maxLength) {return fail(out, path, `must be at most ${s.maxLength} characters long`);}
    if (matchesNumber(s.minLength) && length < s.minLength) {return fail(out, path, `must be at least ${s.minLength} characters long`);}
    if (matchesString(s.pattern) && !regex(s.pattern).test(value)) {return fail(out, path, `must match the pattern ${s.pattern}`);}
    if (matchesString(s.format) && !matchesJsonFormat(s.format, value)) {return fail(out, path, `must be a ${s.format}`);}
  }
  if (Array.isArray(value)) {
    if (matchesNumber(s.maxItems) && value.length > s.maxItems) {return fail(out, path, `must have at most ${s.maxItems} items`);}
    if (matchesNumber(s.minItems) && value.length < s.minItems) {return fail(out, path, `must have at least ${s.minItems} items`);}
    if (s.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {for (let j = i + 1; j < value.length; j++) {if (equal(value[i], value[j])) {return fail(out, path, `must have no two equal items (${i} and ${j})`);}}}
    }
    const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
    for (let i = 0; i < Math.min(prefix.length, value.length); i++) {if (!check(prefix[i]!, value[i], `${path}/${i}`, out)) {return undefined;}}
    if (!matchesUndefined(s.items)) {for (let i = prefix.length; i < value.length; i++) {if (!check(s.items as Schema, value[i], `${path}/${i}`, out)) {return undefined;}}}
    if (!matchesUndefined(s.contains)) {
      let matched = 0;
      Iterator.from(value).forEach((item) => {if (check(s.contains as Schema, item, path, [])) {matched++;}});
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
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>).map(([p, sub]) => [regex(p), sub] as const);
    for (const key of keys) {
      const at = `${path}/${pointer(key)}`;
      let named = false;
      if (Object.hasOwn(properties, key)) {
        named = true;
        if (!check(properties[key]!, o[key], at, out)) {return undefined;}
      }
      for (const [re, sub] of patterns) {
        if (re.test(key)) {
          named = true;
          if (!check(sub, o[key], at, out)) {return undefined;}
        }
      }
      if (named) {evaluated.add(key);}
      else if (!matchesUndefined(s.additionalProperties)) {
        if (!check(s.additionalProperties as Schema, o[key], at, out)) {return s.additionalProperties === false ? fail(out, at, `is a key the schema does not allow`, true) : undefined;}
        evaluated.add(key);
      }
      if (!matchesUndefined(s.propertyNames) && !check(s.propertyNames as Schema, key, at, [])) {return fail(out, at, `is a key whose name the schema does not allow`);}
    }
    if (s.dependentSchemas && hasObjectType(s.dependentSchemas)) {
      for (const [key, sub] of Object.entries(s.dependentSchemas as Record<string, Schema>)) {
        if (!has(key)) {continue;}
        const e = check(sub, value, path, out);
        if (!e) {return undefined;}
        e.forEach((k) => evaluated.add(k));
      }
    }
  }

  // The applicators: a subschema's evaluated keys count only where it passed.
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf as Schema[]) {
      const e = check(sub, value, path, out);
      if (!e) {return undefined;}
      e.forEach((k) => evaluated.add(k));
    }
  }
  if (Array.isArray(s.anyOf)) {
    let any = false;
    Iterator.from(s.anyOf as Schema[]).forEach((sub) => {
      const e = check(sub, value, path, []);
      if (e) {
        any = true;
        e.forEach((k) => evaluated.add(k));
      }
    });
    if (!any) {return fail(out, path, "must match one of its `anyOf` schemas");}
  }
  if (Array.isArray(s.oneOf)) {
    let matched = 0;
    Iterator.from(s.oneOf as Schema[]).forEach((sub) => {
      const e = check(sub, value, path, []);
      if (e) {
        matched++;
        e.forEach((k) => evaluated.add(k));
      }
    });
    if (matched !== 1) {return fail(out, path, matched === 0 ? "must match one of its `oneOf` schemas" : "must match only one of its `oneOf` schemas, and matches more");}
  }
  if (!matchesUndefined(s.not) && check(s.not as Schema, value, path, [])) {return fail(out, path, "must not match its `not` schema");}
  if (!matchesUndefined(s.if)) {
    const e = check(s.if as Schema, value, path, []);
    const branch = e ? s.then : s.else;
    if (e) {e.forEach((k) => evaluated.add(k));}
    if (!matchesUndefined(branch)) {
      const b = check(branch as Schema, value, path, out);
      if (!b) {return undefined;}
      b.forEach((k) => evaluated.add(k));
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

function fail(out: Failure[], path: string, message: string, replace = false): undefined {
  if (replace) {out.length = 0;}
  out.push({ path, message });
  return undefined;
}

function is(type: string, v: unknown): boolean {
  switch (type) {
    case "null": { return matchesNull(v); }
    case "boolean": { return matchesBoolean(v); }
    case "number": { return matchesNumber(v) && Number.isFinite(v); }
    case "integer": { return matchesNumber(v) && Number.isInteger(v); }
    case "string": { return matchesString(v); }
    case "array": { return Array.isArray(v); }
    case "object": { return isRecord(v); }
    default: { return false; }
  }
}

function kind(v: unknown): string {
  if (matchesNull(v)) {return "null";}
  if (Array.isArray(v)) {return "an array";}
  if (matchesNumber(v)) {return Number.isInteger(v) ? "an integer" : "a number";}
  if (hasObjectType(v)) {return "an object";}
  return `a ${typeof v}`;
}

/** JSON equality: numbers by value (1 and 1.0 alike), objects by their keys whatever the order. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) {return true;}
  if (matchesNull(a) || matchesNull(b) || !hasObjectType(a) || !hasObjectType(b)) {return false;}
  if (Array.isArray(a) !== Array.isArray(b)) {return false;}
  if (Array.isArray(a)) {return a.length === (b as unknown[]).length && a.every((x, index) => equal(x, (b as unknown[])[index]));}
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal((a as Object_)[k], (b as Object_)[k]));
}

function multiple(value: number, of: number): boolean {
  const q = value / of;
  // Within a rounding error of a whole number, as a decimal multiple like 0.01 needs; past the
  // Largest double, the remainder says it (1e308 is a multiple of 0.5).
  if (Number.isFinite(q)) {return Math.abs(q - Math.round(q)) < 1e-9;}
  return value % of === 0;
}

const regexes = new Map<string, RegExp>();
/** A pattern as ECMA-262 reads it, with Unicode on, as JSON Schema says. */
function regex(pattern: string): RegExp {
  let re = regexes.get(pattern);
  if (!re) {regexes.set(pattern, (re = new RegExp(pattern, "u")));}
  return re;
}

/** A key as one JSON Pointer segment. */
function pointer(key: string): string {
  return key.replaceAll('~', "~0").replaceAll('/', "~1");
}
