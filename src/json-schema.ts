import { hasObjectType, matchesBoolean, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

// A JSON Schema 2020-12 validator for the run time, which has no dependencies: it checks a value
// Against the schema a statement writes in a `json('…')` member of a column list or, where it is
// Built, a JSON parameter's cast (wiki/typed-json-params.md: JSON
// Schema in its entirety; checks TypeScript cannot say are Reylo's to run). The engine refuses what
// The profile leaves out before a module is written (references, `unevaluatedItems`, a schema in
// `unevaluatedProperties`, the dynamic keywords), so none of those reach this file. A format is
// Asserted, as the decision of 2026-10-19 says; a format this file has no rule for checks nothing.

type Schema = boolean | { readonly [key: string]: unknown };
type Object_ = { readonly [key: string]: unknown };

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
  if (matchesNull(schema) || !hasObjectType(schema) || Array.isArray(schema)) {return value;}
  const s = schema as Object_;
  let out = value;
  if (!matchesNull(value) && hasObjectType(value) && !Array.isArray(value)) {
    const o: Record<string, unknown> = { ...(value as Object_) };
    const properties = (s.properties ?? {}) as Record<string, Schema>;
    Object.entries(properties).forEach(([key, sub]) => {
      if (!Object.prototype.hasOwnProperty.call(o, key) && !matchesNull(sub) && hasObjectType(sub) && "default" in sub) {o[key] = cloneJson((sub as Object_).default);}
    });
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>).map(([p, sub]) => [regex(p), sub] as const);
    for (const key of Object.keys(o)) {
      let named = false;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
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
    }
    if (s.dependentSchemas && hasObjectType(s.dependentSchemas)) {
      Object.entries(s.dependentSchemas as Record<string, Schema>).forEach(([key, sub]) => {if (Object.prototype.hasOwnProperty.call(o, key)) {Object.assign(o, withDefaults(sub, o) as object);}});
    }
    out = o;
  } else if (Array.isArray(value)) {
    const a = [...value];
    const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
    prefix.forEach((sub, i) => {
      if (i >= a.length && !matchesNull(sub) && hasObjectType(sub) && "default" in sub && a.length === i) {a.push(cloneJson((sub as Object_).default));}
    });
    for (let i = 0; i < a.length; i++) {a[i] = withDefaults(i < prefix.length ? prefix[i]! : (s.items as Schema) ?? true, a[i]);}
    out = a;
  }
  if (Array.isArray(s.allOf)) {for (const sub of s.allOf as Schema[]) {out = withDefaults(sub, out);}}
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
  if (matchesNull(schema) || !hasObjectType(schema) || Array.isArray(schema)) {return evaluated;}
  const s = schema as Object_;

  if (!matchesUndefined(s.type)) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => is(t, value))) {return fail(out, path, `must be ${types.join(" or ")}, got ${kind(value)}`);}
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
    const length = [...value].length;
    if (matchesNumber(s.maxLength) && length > s.maxLength) {return fail(out, path, `must be at most ${s.maxLength} characters long`);}
    if (matchesNumber(s.minLength) && length < s.minLength) {return fail(out, path, `must be at least ${s.minLength} characters long`);}
    if (matchesString(s.pattern) && !regex(s.pattern).test(value)) {return fail(out, path, `must match the pattern ${s.pattern}`);}
    if (matchesString(s.format) && !format(s.format, value)) {return fail(out, path, `must be a ${s.format}`);}
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
      for (const item of value) {if (check(s.contains as Schema, item, path, [])) {matched++;}}
      const min = matchesNumber(s.minContains) ? s.minContains : 1;
      if (matched < min) {return fail(out, path, min === 1 ? "must contain an item that matches its `contains` schema" : `must contain at least ${min} items that match its \`contains\` schema`);}
      if (matchesNumber(s.maxContains) && matched > s.maxContains) {return fail(out, path, `must contain at most ${s.maxContains} items that match its \`contains\` schema`);}
    }
  }
  if (!matchesNull(value) && hasObjectType(value) && !Array.isArray(value)) {
    const o = value as Object_;
    const keys = Object.keys(o);
    if (matchesNumber(s.maxProperties) && keys.length > s.maxProperties) {return fail(out, path, `must have at most ${s.maxProperties} keys`);}
    if (matchesNumber(s.minProperties) && keys.length < s.minProperties) {return fail(out, path, `must have at least ${s.minProperties} keys`);}
    // A key is the object's own: `toString` and `__proto__` are keys only where the value has them.
    const has = (key: string) => Object.prototype.hasOwnProperty.call(o, key);
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
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
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
    for (const sub of s.anyOf as Schema[]) {
      const e = check(sub, value, path, []);
      if (e) {
        any = true;
        e.forEach((k) => evaluated.add(k));
      }
    }
    if (!any) {return fail(out, path, "must match one of its `anyOf` schemas");}
  }
  if (Array.isArray(s.oneOf)) {
    let matched = 0;
    for (const sub of s.oneOf as Schema[]) {
      const e = check(sub, value, path, []);
      if (e) {
        matched++;
        e.forEach((k) => evaluated.add(k));
      }
    }
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
  if (!matchesNull(value) && hasObjectType(value) && !Array.isArray(value)) {
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
    case "object": { return !matchesNull(v) && hasObjectType(v) && !Array.isArray(v); }
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
  if (typeof a !== typeof b || matchesNull(a) || matchesNull(b) || !hasObjectType(a)) {return false;}
  if (Array.isArray(a) !== Array.isArray(b)) {return false;}
  if (Array.isArray(a)) {return a.length === (b as unknown[]).length && a.every((x, i) => equal(x, (b as unknown[])[i]));}
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal((a as Object_)[k], (b as Object_)[k]));
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
  return key.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

const DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/iu;

const DATE_LENGTH = 10;
const TIME_START = 11;
const FIRST_MONTH = 1;
const FIRST_DAY = 1;
const LONG_MONTH = 31;
const SHORT_MONTH = 30;
const FEBRUARY = 28;
const LEAP_FEBRUARY = 29;
const COMMON_LEAP_INTERVAL = 4;
const YEARS_PER_CENTURY = 100;
const GREGORIAN_CYCLE = 400;
const EVEN_REMAINDER = 0;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
const LAST_MINUTE_OF_DAY = MINUTES_PER_DAY - 1;
const LEAP_SECOND = 60;
const UTC_OFFSET = 0;

const isLeapYear = (year: number): boolean =>
  year % COMMON_LEAP_INTERVAL === EVEN_REMAINDER &&
  (year % YEARS_PER_CENTURY !== EVEN_REMAINDER || year % GREGORIAN_CYCLE === EVEN_REMAINDER);

const daysOfMonths = (year: number): number[] => [
  LONG_MONTH, isLeapYear(year) ? LEAP_FEBRUARY : FEBRUARY, LONG_MONTH, SHORT_MONTH,
  LONG_MONTH, SHORT_MONTH, LONG_MONTH, LONG_MONTH, SHORT_MONTH, LONG_MONTH, SHORT_MONTH, LONG_MONTH,
];

const date = (value: string): boolean => {
  const parts = DATE.exec(value)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const month = Number(parts.month);
  const day = Number(parts.day);
  const lastDay = daysOfMonths(Number(parts.year))[month - FIRST_MONTH];
  return !matchesUndefined(lastDay) && day >= FIRST_DAY && day <= lastDay;
};

const validClock = (hour: number, minute: number): boolean =>
  hour < HOURS_PER_DAY && minute < MINUTES_PER_HOUR;

const utcOffset = ({ sign, offsetHour, offsetMinute }: Record<string, string | undefined>): number => {
  if (matchesUndefined(sign)) {return UTC_OFFSET;}
  const minutes = Number(offsetHour) * MINUTES_PER_HOUR + Number(offsetMinute);
  return sign === "-" ? -minutes : minutes;
};

const time = (value: string): boolean => {
  const parts = TIME.exec(value)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (!validClock(hour, minute) || second > LEAP_SECOND) {return false;}
  if (!matchesUndefined(parts.sign) && !validClock(Number(parts.offsetHour), Number(parts.offsetMinute))) {return false;}
  if (second !== LEAP_SECOND) {return true;}
  // A leap second ends the UTC day even when written with a local offset.
  const localMinute = hour * MINUTES_PER_HOUR + minute;
  const utcMinute = ((localMinute - utcOffset(parts)) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return utcMinute === LAST_MINUTE_OF_DAY;
};

/** The formats this file asserts (RFC 3339, RFC 4122, RFC 5321's address form loosely, RFC 3986's scheme): any other passes. */
function format(name: string, v: string): boolean {
  switch (name) {
    case "date": { return date(v); }
    case "time": { return time(v); }
    case "date-time": {
      const separator = v.search(/[tT ]/u);
      return separator === DATE_LENGTH && date(v.slice(0, separator)) && time(v.slice(TIME_START));
    }
    case "uuid": { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }
    case "email": { return email(v); }
    case "ipv4": { return /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(v); }
    case "ipv6": { return ipv6(v); }
    case "uri": { return uri(v); }
    case "hostname": { return hostname(v); }
    case "regex": {
      try {
        new RegExp(v, "u");
        return true;
      } catch {
        return false;
      }
    }
    default: { return true; }
  }
}

// RFC 5321's mailbox, in ASCII: a dot-string or a quoted string, `@`, and a domain of letter,
// Digit and hyphen labels or an address literal.
const ATOM = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~]+";
const DOT_STRING = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`);
const QUOTED = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function email(v: string): boolean {
  const at = v.lastIndexOf("@");
  if (at < 1) {return false;}
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (!(DOT_STRING.test(local) || QUOTED.test(local))) {return false;}
  if (domain.startsWith("[") && domain.endsWith("]")) {
    const literal = domain.slice(1, -1);
    return /^ipv6:/i.test(literal) ? ipv6(literal.slice(5)) : format("ipv4", literal);
  }
  return domain.length <= 255 && domain.split(".").every((label) => label.length <= 63 && LABEL.test(label));
}

// RFC 3986's URI: a scheme, `:`, an authority after `//` or a path, a query and a fragment, each
// Of the characters its part allows, a `%` always followed by two hexadecimal digits.
const UNRESERVED = "A-Za-z0-9\\-._~";
const SUB_DELIMS = "!$&'()*+,;=";
const PCT = "%[0-9A-Fa-f]{2}";
const PCHAR = `(?:[${UNRESERVED}${SUB_DELIMS}:@]|${PCT})`;
const URI = new RegExp(`^([A-Za-z][A-Za-z0-9+.-]*):(?://([^/?#]*))?((?:/|${PCHAR})*)(?:\\?((?:${PCHAR}|[/?])*))?(?:#((?:${PCHAR}|[/?])*))?$`);
const USERINFO = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}:]|${PCT})*$`);
const REG_NAME = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}]|${PCT})*$`);

function uri(v: string): boolean {
  const regexMatch = URI.exec(v);
  if (!regexMatch) {return false;}
  const authority = regexMatch[2];
  // Without an authority a path may not start with `//`.
  if (matchesUndefined(authority)) {return !(regexMatch[3] ?? "").startsWith("//");}
  const at = authority.lastIndexOf("@");
  if (at >= 0 && !USERINFO.test(authority.slice(0, at))) {return false;}
  const hostport = authority.slice(at + 1);
  if (hostport.startsWith("[")) {
    const close = hostport.indexOf("]");
    if (close < 0) {return false;}
    const literal = hostport.slice(1, close);
    const ok = /^v[0-9a-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+$/i.test(literal) || ipv6(literal);
    return ok && /^(?::\d*)?$/.test(hostport.slice(close + 1));
  }
  const colon = hostport.lastIndexOf(":");
  const host = colon >= 0 ? hostport.slice(0, colon) : hostport;
  if (colon >= 0 && !/^\d*$/.test(hostport.slice(colon + 1))) {return false;}
  return REG_NAME.test(host);
}

// RFC 1123's host name: labels of letters, digits and hyphens, at most 63 characters each and 253
// In all. A label with `--` in its third and fourth places is an A-label (`xn--`), whose Punycode
// Must decode (RFC 3492) to a U-label that IDNA 2008's contextual rules allow (RFC 5892,
// Appendix A): this checks the ones for MIDDLE DOT, Greek KERAIA, Hebrew GERESH and GERSHAYIM,
// KATAKANA MIDDLE DOT, the two sets of Arabic-Indic digits, the joiners after a virama, a combining
// Mark first, and the code points RFC 5892 lists as DISALLOWED exceptions. A ZERO WIDTH NON-JOINER
// That follows no virama is taken where it joins two letters of a joining script, short of the
// Unicode joining types the rule names.
function hostname(v: string): boolean {
  if (v.length === 0 || v.length > 253) {return false;}
  return v.split(".").every((label) => {
    if (label.length === 0 || label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) {return false;}
    if (label.slice(2, 4) !== "--") {return true;}
    if (label.slice(0, 2).toLowerCase() !== "xn") {return false;}
    const u = punycode(label.slice(4).toLowerCase());
    return !matchesUndefined(u) && uLabel(u);
  });
}

const VIRAMA = new Set([0x09_4D, 0x09_CD, 0x0A_4D, 0x0A_CD, 0x0B_4D, 0x0B_CD, 0x0C_4D, 0x0C_CD, 0x0D_3B, 0x0D_3C, 0x0D_4D, 0x0D_CA, 0x0E_3A, 0x0E_BA, 0x0F_84, 0x10_39, 0x10_3A, 0x17_14, 0x17_15, 0x17_34, 0x17_D2, 0x1A_60, 0x1B_44, 0x1B_AA, 0x1B_AB, 0x1B_F2, 0x1B_F3, 0x2D_7F, 0xA8_06, 0xA8_2C, 0xA8_C4, 0xA9_53, 0xA9_C0, 0xAA_F6, 0xAB_ED, 0x1_0A_3F, 0x1_10_46, 0x1_10_70, 0x1_10_7F, 0x1_10_B9, 0x1_11_33, 0x1_11_34, 0x1_11_C0, 0x1_12_35, 0x1_12_EA, 0x1_13_4D, 0x1_14_42, 0x1_14_C2, 0x1_15_BF, 0x1_16_3F, 0x1_16_B6, 0x1_17_2B, 0x1_18_39, 0x1_19_3D, 0x1_19_3E, 0x1_19_E0, 0x1_1A_34, 0x1_1A_47, 0x1_1A_99, 0x1_1C_3F, 0x1_1D_44, 0x1_1D_45, 0x1_1D_97, 0x1_1F_41, 0x1_1F_42]);
const DISALLOWED = new Set([0x06_40, 0x07_FA, 0x30_2E, 0x30_2F, 0x30_31, 0x30_32, 0x30_33, 0x30_34, 0x30_35, 0x30_3B]);
const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Mandaic}\p{Script=Manichaean}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Sogdian}]/u;

function uLabel(label: string): boolean {
  const cps = [...label];
  if (cps.length === 0 || /^\p{M}/u.test(label) || label.slice(2, 4) === "--") {return false;}
  const at = (i: number) => cps[i] ?? "";
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!.codePointAt(0)!;
    if (DISALLOWED.has(c)) {return false;}
    switch (c) {
      case 0x00_B7: { if (at(i - 1) !== "l" || at(i + 1) !== "l") {return false;} break; }
      case 0x03_75: { if (!/\p{Script=Greek}/u.test(at(i + 1))) {return false;} break; }
      case 0x05_F3: case 0x05_F4: { if (!/\p{Script=Hebrew}/u.test(at(i - 1))) {return false;} break; }
      case 0x30_FB: { if (!cps.some((x) => x !== "・" && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(x))) {return false;} break; }
      case 0x20_0D: { if (!VIRAMA.has(at(i - 1).codePointAt(0) ?? -1)) {return false;} break; }
      case 0x20_0C: {
        if (VIRAMA.has(at(i - 1).codePointAt(0) ?? -1)) {break;}
        let before = i - 1;
        while (before >= 0 && /\p{Mn}/u.test(at(before))) {before--;}
        let after = i + 1;
        while (after < cps.length && /\p{Mn}/u.test(at(after))) {after++;}
        if (!(JOINING.test(at(before)) && JOINING.test(at(after)))) {return false;}
        break;
      }
    }
  }
  const arabic = cps.some((x) => /[٠-٩]/.test(x));
  const extended = cps.some((x) => /[۰-۹]/.test(x));
  return !(arabic && extended);
}

/** RFC 3492's decoding of a Punycode string, or `undefined` where it is not one. */
function punycode(input: string): string | undefined {
  const base = 36; const tMin = 1; const tMax = 26; const skew = 38; const damp = 700;
  const delimiter = input.lastIndexOf("-");
  const output = delimiter > 0 ? [...input.slice(0, delimiter)].map((c) => c.codePointAt(0)!) : [];
  if (output.some((c) => c >= 0x80)) {return undefined;}
  let n = 128; let i = 0; let bias = 72;
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
  };
  const digit = (c: string) => (/[a-z]/u.test(c) ? c.charCodeAt(0) - 97 : /[0-9]/u.test(c) ? c.charCodeAt(0) - 22 : -1);
  let pos = delimiter > 0 ? delimiter + 1 : 0;
  if (pos >= input.length && delimiter <= 0) {return undefined;}
  while (pos < input.length) {
    const old = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (pos >= input.length) {return undefined;}
      const d = digit(input[pos++]!);
      if (d < 0) {return undefined;}
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) {break;}
      w *= base - t;
      if (!Number.isSafeInteger(i) || !Number.isSafeInteger(w)) {return undefined;}
    }
    bias = adapt(i - old, output.length + 1, old === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10_FF_FF) {return undefined;}
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function ipv6(v: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(v) || v.includes(":::")) {return false;}
  const halves = v.split("::");
  if (halves.length > 2) {return false;}
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const parts = halves.flatMap(groups);
  const last = parts[parts.length - 1] ?? "";
  const v4 = last.includes(".");
  if (v4 && !format("ipv4", last)) {return false;}
  const words = parts.length + (v4 ? 1 : 0);
  if (parts.slice(0, v4 ? -1 : undefined).some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) {return false;}
  return halves.length === 2 ? words < 8 : words === 8;
}
