import { bunRows } from "./decode-bun.ts";
import { fieldDecoders } from "./decode-postgres-catalog.ts";
import type { Field, Load } from "./decode-postgres-catalog.ts";
import { hasFunctionType, isEmptyArray, matchesNull, matchesNullish } from "./native-predicates.ts";
import { utf8 } from "./values.ts";
import type { Columns, Decoder } from "./values.ts";

// ---------------------------------------------------------------------------------------------
// Postgres.js: `.raw()`, and the rows built by Reylo.

type RawCell = Uint8Array | null;
type PostgresRaw = unknown[] & { columns?: { name: string; type: number }[] };
type PostgresPending = PromiseLike<unknown[]> & { raw?: () => PromiseLike<PostgresRaw> };
interface PostgresJsClient {
  unsafe: {
    (text: string): { raw: () => PromiseLike<RawCell[][]> };
    (text: string, params: unknown[], options: { prepare: true }): PostgresPending | null | undefined;
  };
}

const validateRawRows = (raw: PostgresRaw, fields: Field[]): void => {
  // A row transform also runs on `.raw()` results and can rewrite every cell or replace a row.
  Iterator.from(raw).forEach((row) => {
    if (!Array.isArray(row) || row.length !== fields.length || !row.every((value) => matchesNull(value) || value instanceof Uint8Array)) {
      // oxlint-disable-next-line rules/require-tagged-error -- Preserve the unsupported driver TypeError without loading the optional Effect runtime.
      throw new TypeError("Reylo cannot read this postgres.js client's rows: its transform.row rewrites every row, Reylo's too, so they would not have the types the query declares. Run Reylo's queries on a postgres() instance without transform.row.");
    }
  });
};

const loadCatalog = (driver: PostgresJsClient): Load => async (sql) => {
  const rows = await driver.unsafe(sql).raw();
  return rows.map((row) => row.map((bytes) => (matchesNull(bytes) ? bytes : utf8(bytes))));
};

// oxlint-disable-next-line unicorn/no-null -- Absent postgres.js result cells use SQL NULL in the public row.
const SQL_NULL = null;

// Index fields in result order, using names from the module when it supplies them.
const decodeRow = (cells: RawCell[], names: string[], decoders: Decoder[]): Record<string, unknown> => {
  const row: Record<string, unknown> = {};
  Iterator.from(names.keys()).forEach((columnIndex) => {
    const bytes = cells[columnIndex];
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Names and decoders were built from the same result fields, in column order.
    row[names[columnIndex]!] = matchesNullish(bytes) ? SQL_NULL : decoders[columnIndex]!(utf8(bytes));
  });
  return row;
};

const buildRows = (rows: RawCell[][], names: string[], decoders: Decoder[]): Record<string, unknown>[] =>
  Array.from({ length: rows.length }, (_row, rowIndex) =>
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Raw result rows were validated and are indexed within the result length.
    decodeRow(rows[rowIndex]!, names, decoders));

const decodeRawResult = async (raw: PostgresRaw, driver: PostgresJsClient, columns: Columns | undefined): Promise<unknown[]> => {
  const fields: Field[] = (raw.columns ?? []).map((field) => ({ name: field.name, oid: field.type }));
  if (isEmptyArray(raw)) {return [];}
  validateRawRows(raw, fields);
  const decoders = await fieldDecoders(fields, columns, { key: driver, load: loadCatalog(driver) });
  // Generated column names bypass the connection's transform.column option.
  const names = columns && columns.length === fields.length ? columns.map(([name]) => name) : fields.map((field) => field.name);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every raw row and cell was validated above, including custom row transforms.
  return buildRows(raw as RawCell[][], names, decoders);
};

/**
 * Runs a prepared postgres.js statement and decodes its raw result.
 * @param {Record<string, unknown>} client - The app's postgres.js client.
 * @param {string} text - The query text.
 * @param {unknown[]} params - The positional parameters.
 * @param {Columns | undefined} columns - The compiled columns, when available.
 * @returns {Promise<unknown[]>} The decoded named rows.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the established decoder signature and independent query parameters.
export const postgresJs = async function postgresJs(client: Record<string, unknown>, text: string, params: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dispatch has selected the postgres.js unsafe query protocol.
  const driver = client as Record<string, unknown> & PostgresJsClient;
  // By default postgres.js prepares no unsafe() calls. An explicit preparation reduces round trips
  // For queries with parameters. A connection's prepare: false option still takes precedence.
  const pending = driver.unsafe(text, params, { prepare: true });
  // Wrappers that do not expose raw() return native values with the declared representations.
  if (!hasFunctionType(pending?.raw)) {return bunRows((await pending) ?? [], columns);}
  return decodeRawResult(await pending.raw(), driver, columns);
};
