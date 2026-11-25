import { equal } from "./json-schema-constraints.ts";
import { matchesNumber, matchesUndefined } from "./native-predicates.ts";

type Keywords = Readonly<Record<string, unknown>>;

interface ArrayCheck {
  check: (schema: unknown, value: unknown, path: string) => boolean;
  fail: (message: string) => false;
  path: string;
  probe: (schema: unknown, value: unknown) => boolean;
}

const ZERO = 0;
const SINGLE = 1;
const INDEX_STEP = 1;

interface Duplicate {
  first: number;
  second: number;
}

const duplicate = (value: unknown[]): Duplicate | undefined => {
  // oxlint-disable-next-line rules/no-for-loops -- Report the earliest equal pair in index order, including sparse array positions.
  for (const first of value.keys()) {
    // oxlint-disable-next-line rules/no-let -- Scan later indices in place without copying the array for each comparison.
    let second = first + INDEX_STEP;
    while (second < value.length) {
      if (equal(value[first], value[second])) {return { first, second };}
      second += INDEX_STEP;
    }
  }
  return undefined;
};

const sizeFailure = (schema: Keywords, value: unknown[]): string | undefined => {
  if (matchesNumber(schema.maxItems) && value.length > schema.maxItems) {return `must have at most ${schema.maxItems} items`;}
  if (matchesNumber(schema.minItems) && value.length < schema.minItems) {return `must have at least ${schema.minItems} items`;}
  if (schema.uniqueItems === true) {
    const pair = duplicate(value);
    if (!matchesUndefined(pair)) {return `must have no two equal items (${pair.first} and ${pair.second})`;}
  }
  return undefined;
};

const checkPrefix = (prefix: unknown[], value: unknown[], { check, path }: ArrayCheck): boolean => {
  // oxlint-disable-next-line rules/no-for-loops -- Check prefix positions in order and stop at the first diagnostic.
  for (const index of value.keys()) {
    if (index >= prefix.length) {return true;}
    if (!check(prefix[index], value[index], `${path}/${index}`)) {return false;}
  }
  return true;
};

const checkItems = ({ schema, start, value }: { schema: Keywords; start: number; value: unknown[] }, { check, path }: ArrayCheck): boolean => {
  if (matchesUndefined(schema.items)) {return true;}
  // oxlint-disable-next-line rules/no-let -- Visit suffix positions without copying input or dropping sparse positions.
  let index = start;
  while (index < value.length) {
    if (!check(schema.items, value[index], `${path}/${index}`)) {return false;}
    index += INDEX_STEP;
  }
  return true;
};

const containsFailure = (schema: Keywords, value: unknown[], { probe }: ArrayCheck): string | undefined => {
  const match = { count: ZERO };
  Iterator.from(value).forEach((item) => {
    if (probe(schema.contains, item)) {match.count += SINGLE;}
  });
  const minimum = matchesNumber(schema.minContains) ? schema.minContains : SINGLE;
  if (match.count < minimum) {
    return minimum === SINGLE
      ? "must contain an item that matches its `contains` schema"
      : `must contain at least ${minimum} items that match its \`contains\` schema`;
  }
  if (matchesNumber(schema.maxContains) && match.count > schema.maxContains) {
    return `must contain at most ${schema.maxContains} items that match its \`contains\` schema`;
  }
  return undefined;
};

export const checkArray = (schema: Keywords, value: unknown[], context: ArrayCheck): boolean => {
  const size = sizeFailure(schema, value);
  if (!matchesUndefined(size)) {return context.fail(size);}
  const prefix: unknown[] = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  if (!checkPrefix(prefix, value, context) || !checkItems({ schema, start: prefix.length, value }, context)) {return false;}
  const contains = matchesUndefined(schema.contains) ? undefined : containsFailure(schema, value, context);
  return matchesUndefined(contains) || context.fail(contains);
};
