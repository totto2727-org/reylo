import type { StandardTypedV1 } from "./standard.ts";

// Registered by defineQuery without loading any optional execution integration.
const decoders = new WeakMap<object, (rows: readonly unknown[]) => unknown>();

export function registerObjectDecoder<Input, Output>(query: StandardTypedV1<Input, Output>, decode: (rows: readonly unknown[]) => NoInfer<Output>): void {
  decoders.set(query, decode);
}

export function objectDecoder<Input, Output>(query: StandardTypedV1<Input, Output>): (rows: readonly unknown[]) => Output {
  const decode = decoders.get(query);
  if (!decode) throw new TypeError("Object-row execution requires a query created by Reylo.");
  // The registration belongs to this exact query identity, whose materializer owns Output.
  return (rows) => decode(rows) as Output;
}
