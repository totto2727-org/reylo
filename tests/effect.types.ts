import { Effect, Layer } from "effect";
import { defineQuery } from "@totto2727/reylo";
import { makeQueryRunner, prepare, QueryDecodeError, QueryExecutionError, QueryExecutor, QueryPreparationError, run } from "@totto2727/reylo/effect";
import type { BoundQuery } from "@totto2727/reylo/effect";
import { lookup } from "./effect-query-fixture.ts";
import type { LookupInput, LookupRow } from "./effect-query-fixture.ts";
import { NO_ROW } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";

type CapturedRunner = Effect.Success<typeof makeQueryRunner>;
type QueryFailure = QueryPreparationError | QueryExecutionError | QueryDecodeError;
interface NumberRow { n: number }

const INPUT = { active: true, id: 7 };

const many = defineQuery<EmptyParameters, NumberRow, "many", "sqlite">({
  cardinality: "many", columns: [["n", "int"]], dialect: "sqlite", params: [], sql: "select 1 as n",
});
const maybe = defineQuery<EmptyParameters, NumberRow, "maybeOne", "sqlite">({
  cardinality: "maybeOne", columns: [["n", "int"]], dialect: "sqlite", params: [], sql: "select 1 as n",
});
const none = defineQuery<EmptyParameters, never, "none", "sqlite">({
  cardinality: "none", columns: [], dialect: "sqlite", params: [], sql: "delete from t",
});

// TypeScript checks these contract functions. The test runner never calls them.
export const factoryTypes = (): void => {
  // @ts-expect-error The runner factory requires an executor during construction.
  makeQueryRunner satisfies Effect.Effect<CapturedRunner>;
  const layer = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([]) });
  Effect.provide(makeQueryRunner, layer) satisfies Effect.Effect<CapturedRunner>;
};

export const capturedTypes = (captured: CapturedRunner): void => {
  captured(lookup, INPUT) satisfies Effect.Effect<LookupRow, QueryFailure>;
  captured(many) satisfies Effect.Effect<NumberRow[], unknown>;
  captured(maybe) satisfies Effect.Effect<NumberRow | null, unknown>;
  captured(none) satisfies Effect.Effect<void, unknown>;
  // @ts-expect-error A captured many-row result is an array.
  captured(many) satisfies Effect.Effect<NumberRow, unknown>;
  // @ts-expect-error A captured optional-row result may be null.
  captured(maybe) satisfies Effect.Effect<NumberRow, unknown>;
  // @ts-expect-error A captured runner still requires the input object.
  captured(lookup);
  // @ts-expect-error A captured runner preserves the declared input types.
  captured(lookup, { active: true, id: "7" });
};

export const directTypes = (): void => {
  const one = run(lookup, INPUT);
  one satisfies Effect.Effect<LookupRow, QueryFailure, QueryExecutor>;
  // @ts-expect-error The query cannot run without providing an executor.
  one satisfies Effect.Effect<LookupRow, QueryFailure>;
  run(many) satisfies Effect.Effect<NumberRow[], unknown, QueryExecutor>;
  run(maybe) satisfies Effect.Effect<NumberRow | null, unknown, QueryExecutor>;
  run(none) satisfies Effect.Effect<void, unknown, QueryExecutor>;
  // @ts-expect-error A many-row result is an array.
  run(many) satisfies Effect.Effect<NumberRow, unknown, QueryExecutor>;
  // @ts-expect-error An optional-row result may be null.
  run(maybe) satisfies Effect.Effect<NumberRow, unknown, QueryExecutor>;
  // @ts-expect-error The required input object cannot be omitted.
  run(lookup);
  // @ts-expect-error A caller cannot widen the inferred query input.
  run(lookup, { active: true, id: "7" });
};

export const preparationTypes = (): void => {
  prepare(lookup, INPUT) satisfies Effect.Effect<BoundQuery<LookupRow>, QueryPreparationError>;
  // Verify the API's input independently of the effect's output type.
  INPUT satisfies LookupInput;
  // @ts-expect-error Preparation requires the complete input object.
  prepare(lookup, { id: 7 });
};

export const requiredErrorCauses = (): Readonly<{ cause: unknown }>[] => [
  // @ts-expect-error Preparation errors require their original cause.
  new QueryPreparationError({}),
  // @ts-expect-error Execution errors require their original cause.
  new QueryExecutionError({}),
  // @ts-expect-error Decoding errors require their original cause.
  new QueryDecodeError({}),
  new QueryPreparationError({ cause: NO_ROW }),
  new QueryExecutionError({ cause: NO_ROW }),
  new QueryDecodeError({ cause: NO_ROW }),
];
