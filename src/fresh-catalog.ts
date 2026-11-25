import type { Fresh } from "./fresh.ts";
import { asciiLower, sqliteDefault } from "./fresh-sqlite-default.ts";
import { isEmptyString, isRecord, matchesNullish, matchesUndefined } from "./native-predicates.ts";

const TABLE = 0;
const COLUMN = 1;
const TYPE = 2;
const NOT_NULL = 3;
const HAS_DEFAULT = 4;
const DEFAULT_SQL = 5;
const WITH_DEFAULT_SQL = 6;
const WITHOUT_DEFAULT_SQL = 5;
const FIRST_ROW = 0;
const COLUMNS = ["fresh_table", "fresh_column", "fresh_type", "fresh_not_null", "fresh_default", "fresh_expr"] as const;

type CatalogRow = Readonly<string[]>;
type Dialect = "postgres" | "mysql" | "sqlite" | "duckdb";
type Normalize = (text: string) => string;

const yes = (value: string | undefined): boolean => value === "true" || value === "1";

const field = (row: CatalogRow, offset: number): string =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Catalog facts use a fixed wire layout. A bad field keeps the original comparison and failure behavior.
  row[offset]!;

const columnKey = (row: CatalogRow): string => `${row[TABLE]}\u0000${row[COLUMN]}`;

const qualifiedColumn = (row: CatalogRow): string => {
  const relation = field(row, TABLE).replaceAll(/^"|"$/gu, "").replaceAll('"."', ".");
  return `${relation}.${row[COLUMN]}`;
};

const describe = (row: CatalogRow): string =>
  `${row[TYPE]}${yes(row[NOT_NULL]) ? " not null" : ""}${yes(row[HAS_DEFAULT]) ? " with a default" : ""}`;

const rawFields = (row: unknown, columns: Readonly<string[]>): unknown[] | undefined => {
  if (Array.isArray(row)) {return row.length === columns.length ? row : undefined;}
  if (isRecord(row) && Object.keys(row).length === columns.length && columns.every((column) => column in row)) {
    return columns.map((column) => row[column]);
  }
  return undefined;
};

const currentCatalog = (fresh: Fresh, rows: Readonly<unknown[]>): Map<string, CatalogRow> | undefined => {
  const now = new Map<string, CatalogRow>();
  const width = fresh.rows[FIRST_ROW]?.length === WITH_DEFAULT_SQL ? WITH_DEFAULT_SQL : WITHOUT_DEFAULT_SQL;
  const columns = COLUMNS.slice(TABLE, width);
  const valid = Iterator.from(rows).every((row) => {
    const raw = rawFields(row, columns);
    if (matchesUndefined(raw)) {return false;}
    // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the catalog wire coercion, including driver values that implement native string conversion.
    const values = raw.map((value) => matchesNullish(value) ? "" : String(value));
    now.set(columnKey(values), values);
    return true;
  });
  return valid ? now : undefined;
};

const sameText = (current: string, previous: string, normalize?: Normalize): boolean =>
  current === previous || (!matchesUndefined(normalize) && normalize(current) === normalize(previous));

const sameShape = (current: CatalogRow, previous: CatalogRow, dialect: Dialect | undefined): boolean =>
  sameText(field(current, TYPE), field(previous, TYPE), dialect === "sqlite" ? asciiLower : undefined) &&
  yes(current[NOT_NULL]) === yes(previous[NOT_NULL]) && yes(current[HAS_DEFAULT]) === yes(previous[HAS_DEFAULT]);

const describeDefault = (value: string | undefined, absent: string): string =>
  matchesUndefined(value) || isEmptyString(value) ? absent : `the default ${value}`;

const defaultDifference = (current: CatalogRow, previous: CatalogRow, dialect: Dialect | undefined): string | undefined => {
  const normalizer = dialect === "sqlite" ? sqliteDefault : undefined;
  const before = field(previous, DEFAULT_SQL);
  const after = field(current, DEFAULT_SQL);
  if (sameText(after, before, normalizer)) {return undefined;}
  return `${qualifiedColumn(previous)} had ${describeDefault(before, "no default")}, which the insert writes for a row that leaves its key out, and now has ${describeDefault(after, "none")}`;
};

const changedColumn = (
  previous: CatalogRow, current: CatalogRow | undefined,
  { comparesDefault, dialect }: { comparesDefault: boolean; dialect: Dialect | undefined },
): string | undefined => {
  if (matchesUndefined(current)) {return `${qualifiedColumn(previous)} was ${describe(previous)} and no longer exists`;}
  if (!sameShape(current, previous, dialect)) {return `${qualifiedColumn(previous)} was ${describe(previous)} and is now ${describe(current)}`;}
  return comparesDefault ? defaultDifference(current, previous, dialect) : undefined;
};

const oldColumnDifferences = (fresh: Fresh, catalog: Map<string, CatalogRow>, dialect: Dialect | undefined): {
  differences: string[]; seen: Set<string>;
} => {
  const seen = new Set<string>();
  const copied = new Set((fresh.defaults ?? []).map((column) => columnKey(column)));
  const differences: string[] = [];
  Iterator.from(fresh.rows).forEach((previous) => {
    const key = columnKey(previous);
    seen.add(key);
    const change = changedColumn(previous, catalog.get(key), { comparesDefault: copied.has(key), dialect });
    if (!matchesUndefined(change)) {differences.push(change);}
  });
  return { differences, seen };
};

/**
 * Compare the build's catalog facts with the caller's database.
 * @param {Fresh} fresh - Catalog facts carried by the built query.
 * @param {Readonly<unknown[]>} rows - Current database rows in array or record form.
 * @param {Dialect} dialect - SQLite type and default text may have an equivalent spelling.
 * @returns {string[] | undefined} Differences in source order, or undefined for a malformed response.
 */
export const differences = function differences(fresh: Fresh, rows: Readonly<unknown[]>, dialect?: Dialect): string[] | undefined {
  const catalog = currentCatalog(fresh, rows);
  if (matchesUndefined(catalog)) {return undefined;}
  const { differences: changes, seen } = oldColumnDifferences(fresh, catalog, dialect);
  // A column absent at build time may become required for an insert.
  Iterator.from(catalog).forEach(([key, row]) => {
    if (!seen.has(key) && fresh.inserts.includes(field(row, TABLE)) && yes(row[NOT_NULL]) && !yes(row[HAS_DEFAULT])) {
      changes.push(`${qualifiedColumn(row)} is now ${describe(row)}, which the insert does not write`);
    }
  });
  return changes;
};
