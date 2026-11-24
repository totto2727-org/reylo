// oxlint-disable-next-line rules/force-predicate, typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer a native type guard without loading the optional Effect peer.
export const matchesBigInt = (value: unknown) => typeof value === "bigint";

// oxlint-disable-next-line rules/force-predicate, typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer a native type guard without loading the optional Effect peer.
export const matchesBoolean = (value: unknown) => typeof value === "boolean";

// oxlint-disable-next-line rules/force-predicate, typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer a native type guard without loading the optional Effect peer.
export const matchesNumber = (value: unknown) => typeof value === "number";

// oxlint-disable-next-line rules/force-predicate, typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer a native type guard without loading the optional Effect peer.
export const matchesString = (value: unknown) => typeof value === "string";

// oxlint-disable-next-line rules/force-predicate, typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer an exact native sentinel guard without the optional Effect peer.
export const matchesNull = (value: unknown) => value === null;

// oxlint-disable-next-line rules/force-predicate, typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer an exact native sentinel guard without the optional Effect peer.
export const matchesUndefined = (value: unknown) => value === undefined;

// oxlint-disable-next-line typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer the pair of native absent values without loading Effect.
export const matchesNullish = (value: unknown) => matchesNull(value) || matchesUndefined(value);

// oxlint-disable-next-line rules/force-predicate, typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer a native type guard without the optional Effect peer.
export const hasFunctionType = (value: unknown) => typeof value === "function";

// oxlint-disable-next-line rules/force-predicate, typescript/explicit-function-return-type, typescript/explicit-module-boundary-types -- Infer a native type guard without the optional Effect peer.
export const hasObjectType = (value: unknown) => typeof value === "object";

// oxlint-disable-next-line rules/no-type-predicate -- Native object checks narrow an indexable record without loading the optional Effect peer.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !matchesNull(value) && hasObjectType(value) && !Array.isArray(value);

// oxlint-disable-next-line rules/force-string-empty -- Compare primitive text here so native decoders can run without loading Effect.
export const isEmptyString = (value: string): boolean => value === "";

const EMPTY_ARRAY_LENGTH = 0;
export const isEmptyArray = (value: Readonly<unknown[]>): boolean => value.length === EMPTY_ARRAY_LENGTH;
