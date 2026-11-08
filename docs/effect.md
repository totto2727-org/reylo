# Effect query execution

The optional `@totto2727/reylo/effect` entry point executes typed SQLite queries through a Layer-provided client.
The core runtime does not import Effect.
Install Effect 4 only when using this entry point.

```ts
import * as QueryEffect from "@totto2727/reylo/effect";
import { Effect } from "effect";
import getUser from "./get_user.sql";
import { ProjectQueryLayer } from "./database.ts";

const makeUserService = Effect.gen(function*() {
  const run = yield* QueryEffect.makeQueryRunner;
  return { getUser: (id: number) => run(getUser, { id }) };
});
const service = makeUserService.pipe(Effect.provide(ProjectQueryLayer));
const program = Effect.flatMap(service, (users) => users.getUser(1));
```

`makeQueryRunner` is an Effect that requires `QueryExecutor` and captures it once during service construction.
It returns a generic typed run function whose query Effects require no `QueryExecutor`, even when evaluated with an absent or conflicting executor context.
Provide the application's dependencies to the service Layer or construction Effect, not to each operation.
Keep the executor's resources alive for the service's lifetime; capture does not extend a scoped client's lifetime.
The existing `QueryEffect.run` remains available for programs that intentionally obtain `QueryExecutor` from the current context on each evaluation.
Both run functions share the same execution and decoding implementation and retain the query's inferred parameters and cardinality.
It validates and orders bound values before execution, decodes returned values with Reylo's SQLite decoder, and rejects a result with the wrong cardinality.
Encoding and decoding run inside the Effect, not when the program is constructed.
A query with required parameters cannot be called without them.
The existing Promise and synchronous query APIs remain unchanged.

## Client ownership

The application provides `QueryExecutor` through a Layer.
The executor receives a SQL statement and its ordered values and returns the client's object rows as an Effect.
The application adapter uses its existing client's execution API and retains responsibility for connection acquisition, resource disposal, and client-specific services.
Reylo does not create a connection, extract an underlying driver, convert a Promise-based driver to Effect, or depend on a concrete client package.
Client failures retain their original cause.
Fiber interruption remains interruption.

`QueryPreparationError`, `QueryExecutionError`, and `QueryDecodeError` use `Data.TaggedError` and support direct `yield*` and `Effect.catchTag` recovery.
Their required `cause: unknown` retains the original encoder, client, or decoder failure, not an Effect `Cause` container.
Effect represents typed failures, defects, and interruptions in `Cause` when observing an `Exit`; the query errors do not wrap or remap defects and interruptions.

The executor identifies its SQL dialect.
A query for another dialect fails before the client executes it.
The maintained object-row decoding path supports SQLite.
Live-schema freshness is not checked by this entry point, as with Standard Query execution.

## Native batches

Batching and transactions belong to the application and its selected client.
This entry point does not provide a batch executor or emulate a transaction with sequential query calls.
Use `prepare` to obtain a statement and ordered values without executing it, then pass those values to the application's native batch Effect.
Keep all writes that must be atomic in that single native batch.
Single-query result decoding does not apply to a batch that the application executes independently.

## Design choice

The execution contract is independent from a client's statement builder, transaction API, or framework.
An application that already has an Effect-native client adapts that service in a Layer instead of constructing a second client.
Using a framework-wide SQL client contract would also require implementations for connection reservation, transactions, streams, and other capabilities that this query executor does not need.
The smaller executor contract keeps those capabilities with their existing owner.
