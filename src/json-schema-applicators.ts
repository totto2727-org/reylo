import { matchesUndefined } from "./native-predicates.ts";

type Keywords = Readonly<Record<string, unknown>>;
export type Outcome = Set<string> | false;

interface ApplicatorCheck {
  check: (schema: unknown) => Outcome;
  evaluated: Set<string>;
  fail: (message: string) => false;
  probe: (schema: unknown) => Outcome;
}

const NO_MATCH = 0;
const ONE_MATCH = 1;

const recordPassed = (outcome: Outcome, evaluated: Set<string>): boolean => {
  if (outcome === false) {return false;}
  outcome.forEach((key) => {evaluated.add(key);});
  return true;
};

const allOf = (branches: unknown, { check, evaluated }: ApplicatorCheck): boolean =>
  !Array.isArray(branches) || Iterator.from(branches).every((branch) => recordPassed(check(branch), evaluated));

const countPassed = (branches: Iterable<unknown>, { evaluated, probe }: ApplicatorCheck): number => {
  const matched = { count: NO_MATCH };
  Iterator.from(branches).forEach((branch) => {
    if (recordPassed(probe(branch), evaluated)) {matched.count += ONE_MATCH;}
  });
  return matched.count;
};

const anyOf = (branches: unknown, context: ApplicatorCheck): boolean => {
  if (!Array.isArray(branches)) {return true;}
  if (countPassed(branches, context) === NO_MATCH) {return context.fail("must match one of its `anyOf` schemas");}
  return true;
};

const oneOf = (branches: unknown, context: ApplicatorCheck): boolean => {
  if (!Array.isArray(branches)) {return true;}
  const matched = countPassed(branches, context);
  if (matched === NO_MATCH) {return context.fail("must match one of its `oneOf` schemas");}
  if (matched !== ONE_MATCH) {return context.fail("must match only one of its `oneOf` schemas, and matches more");}
  return true;
};

const condition = (schema: Keywords, { check, evaluated, probe }: ApplicatorCheck): boolean => {
  if (matchesUndefined(schema.if)) {return true;}
  const result = probe(schema.if);
  const branch = result === false ? schema.else : schema.then;
  recordPassed(result, evaluated);
  return matchesUndefined(branch) || recordPassed(check(branch), evaluated);
};

export const checkApplicators = (schema: Keywords, context: ApplicatorCheck): boolean => {
  if (!allOf(schema.allOf, context) || !anyOf(schema.anyOf, context) || !oneOf(schema.oneOf, context)) {return false;}
  if (!matchesUndefined(schema.not) && context.probe(schema.not) !== false) {
    return context.fail("must not match its `not` schema");
  }
  return condition(schema, context);
};
