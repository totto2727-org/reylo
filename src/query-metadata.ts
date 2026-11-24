import type { StandardTypedV1 } from "./standard.ts";

// Registered by defineQuery without loading any optional execution integration.
const decoders = new WeakMap<object, (rows: Readonly<unknown[]>) => unknown>();

export const registerObjectDecoder = <Input, Output>(query: StandardTypedV1<Input, Output>, decode: (rows: Readonly<unknown[]>) => NoInfer<Output>): void => {
  decoders.set(query, decode);
};

export const objectDecoder = <Input, Output>(query: StandardTypedV1<Input, Output>): ((rows: Readonly<unknown[]>) => Output) => {
  const decode = decoders.get(query);
  if (!decode) {
    // oxlint-disable-next-line rules/require-tagged-error -- Reject foreign queries without loading the optional Effect peer.
    throw new TypeError("Object-row execution requires a query created by Reylo.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The WeakMap entry uses the same query identity whose registration constrains Output.
  return (rows) => decode(rows) as Output;
};
