import type { Columns, Decoder } from "./values.ts";

export interface PgStatement {
  columns: Columns | undefined;
  text: string;
  values: unknown[];
}

interface PgField {
  dataTypeID: number;
  name: string;
}

export interface PgRows<Row> {
  fields?: PgField[] | null;
  rows: Row[];
}

export type PgRow = Record<string, unknown>;
export type CatalogRow = (string | null)[];
export type PgResult<Row> = PgRows<Row> | (Row[] & { fields?: PgField[] | null });
type PgArguments = [request: object] | [text: string, values: unknown[], options?: object];
export type PgClient = Record<string, unknown> & {
  $config?: { options?: { receive?: unknown } };
  options?: { binary?: unknown };
};

export const callPg = <Result>(client: PgClient, method: "query" | "result", args: PgArguments): PromiseLike<Result> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Existing driver detection selects the pg protocol; each call describes the rows selected by its options.
  (client[method] as (...values: PgArguments) => PromiseLike<Result>)(...args);

export const queryPg = <Result>(client: PgClient, ...args: PgArguments): PromiseLike<Result> =>
  callPg<Result>(client, "query", args);

export const rowsOf = <Row>(result: PgResult<Row>): Row[] => Array.isArray(result) ? result : result.rows;

export interface PgTypeTable {
  getTypeParser: (oid: number, format?: string) => Decoder;
}

// Catalog queries keep every cell in the server's text format.
export const asText = { getTypeParser: () => (text: string): string => text };
