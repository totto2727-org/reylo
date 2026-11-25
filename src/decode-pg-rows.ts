import { rowsOf } from "./decode-pg-wire.ts";
import type { PgResult, PgRow, PgTypeTable } from "./decode-pg-wire.ts";
import { builtinDecoder, fieldDecoders, learn, learnedOf } from "./decode-postgres-catalog.ts";
import type { Catalog } from "./decode-postgres-catalog.ts";
import { matchesUndefined } from "./native-predicates.ts";
import { textDecoder } from "./values.ts";
import type { Columns, Decoder } from "./values.ts";

// A newly seen database type temporarily keeps its OID and the server's text.
class Pending {
  // oxlint-disable-next-line rules/no-readonly -- Preserve the OID marker in the driver's own rows until catalog decoding completes.
  public readonly oid: number;
  // oxlint-disable-next-line rules/no-readonly -- Preserve the original wire value without adding an Effect runtime dependency.
  public readonly text: string;
  public constructor(oid: number, text: string) {
    this.oid = oid;
    this.text = text;
  }
}

const BINARY = Symbol("binary");

interface Observation {
  binary: boolean;
  pending: boolean;
}

const binaryDecoder = (observed: Observation): Decoder => {
  observed.binary = true;
  return () => BINARY;
};

const typeTable = (key: object, observed: Observation): PgTypeTable => {
  const known = learnedOf(key);
  return {
    getTypeParser(oid: number, format?: string): Decoder {
      if (!matchesUndefined(format) && format !== "text") {return binaryDecoder(observed);}
      const decoder = builtinDecoder(oid);
      if (decoder) {return decoder;}
      const learnedType = known.get(oid);
      if (learnedType) {return textDecoder(learnedType.kind, learnedType.delim);}
      observed.pending = true;
      return (text) => new Pending(oid, text);
    },
  };
};

export const refuseBinary = (): TypeError =>
  // oxlint-disable-next-line rules/require-tagged-error -- Unsupported pg modes keep the existing native TypeError without importing Effect.
  new TypeError("Reylo cannot read this pg client's results: it was set up with binary: true (or pg.defaults.binary), which pg 8 reads wrong (an int8 comes back as another number). Reylo decodes every value from the server's text; leave binary off.");

const pendingOids = (rows: PgRow[]): Set<number> => {
  const oids = new Set<number>();
  Iterator.from(rows).forEach((row) => {
    Object.values(row).forEach((value) => {
      if (value instanceof Pending) {oids.add(value.oid);}
    });
  });
  return oids;
};

const decodePending = (row: PgRow, decoders: ReadonlyMap<number, Decoder>): void => {
  // oxlint-disable-next-line eslint/guard-for-in, rules/no-for-loops -- Retain enumerable row properties supplied through pg wrapper prototypes.
  for (const name in row) {
    const value = row[name];
    if (value instanceof Pending) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Pending values in these rows share the OIDs collected before decoding.
      row[name] = decoders.get(value.oid)!(value.text);
    }
  }
};

interface PendingResult {
  result: PgResult<PgRow>;
  rows: PgRow[];
}

const resolvePending = async ({ result, rows }: PendingResult, catalog: Catalog, columns: Columns | undefined): Promise<void> => {
  // An object result exposes its field metadata. A pg-promise task can also return a bare array.
  if (result.fields && !Array.isArray(result)) {
    await fieldDecoders(result.fields.map((field) => ({ name: field.name, oid: field.dataTypeID })), columns, catalog);
  }
  const oids = pendingOids(rows);
  await learn(catalog, oids);
  const known = learnedOf(catalog.key);
  const decoders = new Map(Iterator.from(oids).map((oid) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Learning populates every requested OID, including a fallback for unknown types.
    const format = known.get(oid)!;
    return [oid, textDecoder(format.kind, format.delim)];
  }));
  Iterator.from(rows).forEach((row) => {decodePending(row, decoders);});
};

type PgRun = (types: PgTypeTable) => PromiseLike<PgResult<PgRow>>;

/**
 * Supplies the query's decoders and resolves newly seen PostgreSQL types from generated columns or the catalog.
 * @param {Catalog} catalog - The client identity and type catalog loader.
 * @param {PgRun} run - The driver query with Reylo's per-query parser table.
 * @param {Columns | undefined} columns - The compiled columns, when available.
 * @returns {Promise<PgRow[]>} The normalized result rows.
 */
export const pgFamily = async (catalog: Catalog, run: PgRun, columns: Columns | undefined): Promise<PgRow[]> => {
  const observed = { binary: false, pending: false };
  const result = await run(typeTable(catalog.key, observed));
  const rows = rowsOf(result);
  if (observed.binary) {throw refuseBinary();}
  if (observed.pending) {await resolvePending({ result, rows }, catalog, columns);}
  return rows;
};
