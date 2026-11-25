import { queryPg } from "./decode-pg-wire.ts";
import type { CatalogRow, PgClient, PgRow, PgRows, PgStatement } from "./decode-pg-wire.ts";
import { builtin, builtinDecoder, builtinOids, fieldDecoders, FIRST_USER_OID, learnedOf } from "./decode-postgres-catalog.ts";
import type { Field, Load } from "./decode-postgres-catalog.ts";
import { hasFunctionType, isEmptyArray, matchesNullish, matchesString } from "./native-predicates.ts";
import { coerce } from "./values.ts";
import type { Columns, Decoder, Kind } from "./values.ts";

export const isPglite = (client: PgClient): boolean =>
  hasFunctionType(client.query) && hasFunctionType(client.exec) &&
  (hasFunctionType(client.refreshArrayTypes) || (hasFunctionType(client.rollback) && "closed" in client));

// PGlite copies the parser table on every query. Remember only the types each statement uses.
const pgliteOids = new Map<string, Set<number>>();
const PGLITE_STATEMENTS = 2000;
const TEXT_OID = 25;
const keepText = (text: string): string => text;

const catalogOf = (db: PgClient): Load => async (sql) => {
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the options order seen by app-provided query wrappers.
  const result = await queryPg<PgRows<CatalogRow>>(db, sql, [], { rowMode: "array", parsers: { [TEXT_OID]: keepText } });
  return result.rows;
};

type IndexedField = Readonly<[field: Field, index: number]>;

const preparedDecoders = (oids: ReadonlySet<number>): Record<number, Decoder> => {
  const parsers: Record<number, Decoder> = {};
  Iterator.from(oids).forEach((oid) => {parsers[oid] = builtinDecoder(oid) ?? keepText;});
  return parsers;
};

const kindsFor = (db: PgClient, fields: Field[], columns: Columns | undefined): Kind[] =>
  fields.map((field, index) => {
    if (columns && columns.length === fields.length) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- The generated columns and driver fields are positionally matched.
      return columns[index]![1];
    }
    return builtin(field.oid)?.kind ?? learnedOf(db).get(field.oid)?.kind ?? "text";
  });

interface AdditionalFields {
  after: IndexedField[];
  fields: Field[];
  rows: PgRow[];
}

const afterQuery = async (db: PgClient, { after, fields, rows }: AdditionalFields, columns: Columns | undefined): Promise<void> => {
  const decoders = await fieldDecoders(fields, columns, { key: db, load: catalogOf(db) });
  const kinds = kindsFor(db, fields, columns);
  Iterator.from(after).forEach(([field, index]) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Each field index refers to a decoder and kind built from the complete field list.
    const [decode, kind] = [decoders[index]!, kinds[index]!];
    Iterator.from(rows).forEach((row) => {
      const value = row[field.name];
      if (!matchesNullish(value)) {
        row[field.name] = matchesString(value) ? decode(value) : coerce(kind, value, field.name);
      }
    });
  });
};

const rememberOids = (text: string, named: Set<number> | undefined, fields: Field[]): void => {
  if (named && fields.every((field) => named.has(field.oid))) {return;}
  if (pgliteOids.size >= PGLITE_STATEMENTS) {pgliteOids.clear();}
  pgliteOids.set(text, new Set([...(named ?? []), ...fields.map((field) => field.oid)]));
};

/**
 * Runs a query on a PGlite database or transaction with a per-query parser table.
 * @param {PgClient} db - The application's PGlite database or transaction.
 * @param {PgStatement} statement - SQL, bind values, and the compiled columns, when available.
 * @returns {Promise<unknown[]>} Result rows in the declared representation.
 */
export const pglite = async (db: PgClient, { columns, text, values }: PgStatement): Promise<unknown[]> => {
  // The first run names the built-ins and the app's instance parsers. Transactions have none.
  const named = pgliteOids.get(text);
  const oids = named ?? new Set([...builtinOids, ...Object.keys(db.parsers ?? {}).map(Number)]);
  const parsers = preparedDecoders(oids);
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the options order seen by app-provided query wrappers.
  const { rows, fields: columnMetadata } = await queryPg<PgRows<PgRow>>(db, text, values, { rowMode: "object", parsers });
  const fields: Field[] = (columnMetadata ?? []).map(({ name, dataTypeID }) => ({ name, oid: dataTypeID }));
  // A custom type was kept as text. An unnamed type passed through the instance's parser.
  const after = fields.map((field, index) => [field, index] as const)
    .filter(([field]) => field.oid >= FIRST_USER_OID || !oids.has(field.oid));
  if (!isEmptyArray(after)) {await afterQuery(db, { after, fields, rows }, columns);}
  rememberOids(text, named, fields);
  return rows;
};
