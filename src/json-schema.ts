import { checkApplicators } from "./json-schema-applicators.ts";
import type { Outcome } from "./json-schema-applicators.ts";
import { checkArray } from "./json-schema-arrays.ts";
import { basicFailure, pointer } from "./json-schema-constraints.ts";
import { fillDefaults } from "./json-schema-defaults.ts";
import { checkObject } from "./json-schema-objects.ts";
import { isRecord, matchesUndefined } from "./native-predicates.ts";

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

type Keywords = Readonly<Record<string, unknown>>;
const ROOT = "";

interface Location {
  evaluated: Set<string>;
  path: string;
}

class Validator {
  #failure?: Failure;

  public first(schema: unknown, value: unknown): Failure | undefined {
    this.#check(schema, value, ROOT);
    return this.#failure;
  }

  #reject(path: string, message: string, replace = false): false {
    if (replace || matchesUndefined(this.#failure)) {
      // oxlint-disable-next-line eslint/sort-keys -- Preserve the field order in serialized validation failures.
      this.#failure = { path, message };
    }
    return false;
  }

  static #probe(schema: unknown, value: unknown, path: string): Outcome {
    return new Validator().#check(schema, value, path);
  }

  #check(schema: unknown, value: unknown, path: string): Outcome {
    if (schema === false) {return this.#reject(path, "no value is allowed here");}
    const evaluated = new Set<string>();
    if (!isRecord(schema)) {return evaluated;}
    return this.#keywords(schema, value, { evaluated, path }) ? evaluated : false;
  }

  #array(schema: Keywords, value: unknown[], path: string): boolean {
    return checkArray(schema, value, {
      check: (subschema, item, position) => this.#check(subschema, item, position) !== false,
      fail: (reason) => this.#reject(path, reason),
      path,
      probe: (subschema, item) => Validator.#probe(subschema, item, path) !== false,
    });
  }

  #object(schema: Keywords, value: Record<string, unknown>, { evaluated, path }: Location): boolean {
    return checkObject(schema, value, {
      check: (subschema, candidate, position) => this.#check(subschema, candidate, position),
      evaluated,
      fail: (position, reason) => this.#reject(position, reason),
      path,
      probe: (subschema, candidate, position) => Validator.#probe(subschema, candidate, position) !== false,
      replace: (position, reason) => this.#reject(position, reason, true),
    });
  }

  #applicators(schema: Keywords, value: unknown, { evaluated, path }: Location): boolean {
    return checkApplicators(schema, {
      check: (subschema) => this.#check(subschema, value, path),
      evaluated,
      fail: (reason) => this.#reject(path, reason),
      probe: (subschema) => Validator.#probe(subschema, value, path),
    });
  }

  #remaining(schema: Keywords, value: unknown, { evaluated, path }: Location): boolean {
    if (!isRecord(value)) {return true;}
    if (schema.unevaluatedProperties === false) {
      const missing = Object.keys(value).find((key) => !evaluated.has(key));
      if (!matchesUndefined(missing)) {return this.#reject(`${path}/${pointer(missing)}`, "is a key the schema does not allow");}
    }
    if (schema.unevaluatedProperties === true) {
      Object.keys(value).forEach((key) => {evaluated.add(key);});
    }
    return true;
  }

  #keywords(schema: Keywords, value: unknown, location: Location): boolean {
    const reason = basicFailure(schema, value);
    if (!matchesUndefined(reason)) {return this.#reject(location.path, reason);}
    if (Array.isArray(value) && !this.#array(schema, value, location.path)) {return false;}
    if (isRecord(value) && !this.#object(schema, value, location)) {return false;}
    return this.#applicators(schema, value, location) && this.#remaining(schema, value, location);
  }
}

const firstFailure = (schema: unknown, value: unknown): Failure | undefined => new Validator().first(schema, value);

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
