import { isEmptyString, matchesUndefined } from "./native-predicates.ts";
import { scalarKind, textDecoder } from "./values.ts";
import type { Columns, Decoder, Kind, ScalarKind } from "./values.ts";

export interface Field {
  name: string;
  oid: number;
}

/** Below it the built-in types, whose oids every database shares (FirstGenbkiObjectId). */
export const FIRST_USER_OID = 10_000;

// oxlint-disable-next-line eslint/sort-keys -- List the fixed catalog identifiers in ascending numeric order.
const SCALAR_OIDS: Readonly<Record<number, ScalarKind>> = {
  16: "bool", 17: "bytes", 20: "int8", 21: "int", 23: "int", 26: "int", 114: "json",
  700: "float", 701: "float", 1082: "date", 1114: "timestamp", 1184: "timestamptz", 1186: "interval",
  1700: "decimal", 3802: "json",
};

// Every built-in array type and its element, as Postgres 18's pg_type lists them (none was ever
// Renumbered): `_record` is left out, since an array of row values is its text.
/* oxlint-disable eslint/no-magic-numbers -- Array OID and element OID pairs are fixed PostgreSQL catalog data. */
const ARRAY_OIDS = new Map<number, number>([
  [143, 142], [199, 114], [271, 5069], [629, 628], [651, 650], [719, 718], [775, 774], [791, 790], [1000, 16], [1001, 17],
  [1002, 18], [1003, 19], [1005, 21], [1006, 22], [1007, 23], [1008, 24], [1009, 25], [1010, 27], [1011, 28], [1012, 29],
  [1013, 30], [1014, 1042], [1015, 1043], [1016, 20], [1017, 600], [1018, 601], [1019, 602], [1020, 603], [1021, 700],
  [1022, 701], [1027, 604], [1028, 26], [1034, 1033], [1040, 829], [1041, 869], [1115, 1114], [1182, 1082], [1183, 1083],
  [1185, 1184], [1187, 1186], [1231, 1700], [1263, 2275], [1270, 1266], [1561, 1560], [1563, 1562], [2201, 1790],
  [2207, 2202], [2208, 2203], [2209, 2204], [2210, 2205], [2211, 2206], [2949, 2970], [2951, 2950], [3221, 3220],
  [3643, 3614], [3644, 3642], [3645, 3615], [3735, 3734], [3770, 3769], [3807, 3802], [3905, 3904], [3907, 3906],
  [3909, 3908], [3911, 3910], [3913, 3912], [3927, 3926], [4073, 4072], [4090, 4089], [4097, 4096], [4192, 4191],
  [5039, 5038], [6150, 4451], [6151, 4532], [6152, 4533], [6153, 4534], [6155, 4535], [6157, 4536],
]);
/* oxlint-enable eslint/no-magic-numbers */
const BOX_ARRAY = 1020;
const DEFAULT_ARRAY_DELIMITER = ",";
const BOX_ARRAY_DELIMITER = ";";

interface Decoding {
  delim: string;
  kind: Kind;
}

const decoding = (kind: Kind, delim = DEFAULT_ARRAY_DELIMITER): Decoding => ({ delim, kind });
const DEFAULT_DECODING = decoding("text");

/**
 * Look up the data format for a built-in PostgreSQL type.
 * @param {number} oid - The type's catalog identifier.
 * @returns {Decoding | undefined} The kind and delimiter of a built-in type, if known.
 */
export const builtin = function (oid: number): Decoding | undefined {
  const scalar = SCALAR_OIDS[oid];
  if (scalar) {return decoding(scalar);}
  const element = ARRAY_OIDS.get(oid);
  if (!matchesUndefined(element)) {
    return decoding(
      `${SCALAR_OIDS[element] ?? "text"}[]`,
      oid === BOX_ARRAY ? BOX_ARRAY_DELIMITER : DEFAULT_ARRAY_DELIMITER,
    );
  }
  return oid < FIRST_USER_OID ? DEFAULT_DECODING : undefined;
};

const builtinDecoders = new Map<number, Decoder>();
export const builtinDecoder = function (oid: number): Decoder | undefined {
  const cached = builtinDecoders.get(oid);
  if (cached) {return cached;}
  const format = builtin(oid);
  if (!format) {return undefined;}
  const decoder = textDecoder(format.kind, format.delim);
  builtinDecoders.set(oid, decoder);
  return decoder;
};

// ---------------------------------------------------------------------------------------------
// The types a database created: their kind from the module's columns, or from the catalog.

/** What Reylo learned of one client's types the database created: each oid's kind and delimiter. */
type Learned = Map<number, Decoding>;
const learned = new WeakMap<object, Learned>();
export const learnedOf = (key: object): Learned => {
  const cached = learned.get(key);
  if (cached) {return cached;}
  const entries: Learned = new Map();
  learned.set(key, entries);
  return entries;
};

/** Rows as arrays of text, from a query that reads the catalog. */
export type Load = (sql: string) => Promise<(string | null)[][]>;

interface Catalog {
  key: object;
  load: Load;
}

// Every type among `oids`, and every array type's element, with its base type through any number
// Of domains and that base type's name (an array of row values, or of a type whose own output is
// An array, stays text). An oid goes out as int8, since one above 2^31 would wrap as int4.
const catalogSql = (oids: number[]): string => {
  const list = `'{${oids.map((oid) => Math.trunc(oid)).join(",")}}'::pg_catalog.oid[]`;
  return `with recursive d(oid, base) as (
  select oid, typbasetype from pg_catalog.pg_type where typtype = 'd'
  union all
  select d.oid, t.typbasetype from d join pg_catalog.pg_type t on t.oid = d.base where t.typtype = 'd'
)
select e.typarray::int8::text, b.oid::int8::text, (b.typtype = 'c' or b.typcategory = 'A')::text, e.typdelim::text, e.oid::int8::text, b.typname::text
from pg_catalog.pg_type e
join pg_catalog.pg_type b on b.oid = coalesce((select d.base from d join pg_catalog.pg_type t on t.oid = d.base where d.oid = e.oid and t.typtype <> 'd'), e.oid)
where e.typarray = any(${list}) or (e.oid = any(${list}) and e.typcategory <> 'A')`;
};

/**
 * Reads the kinds of the oids the client has not met yet: a type the database created by its
 * name, as the engine names it (pgvector's `vector` is its numbers, an enum its text), and an array
 * of one its element's kind.
 * @param {Catalog} catalog - The client identity and query used to load its type catalog.
 * @param {Iterable<number>} oids - The types used by the statement.
 * @returns {Promise<void>} Resolves after the client's type cache is updated.
 */
export const learn = async function ({ key, load }: Catalog, oids: Iterable<number>): Promise<void> {
  const known = learnedOf(key);
  const missing = new Set([...oids].filter((oid) => !known.has(oid)));
  if (!missing.size) {return;}
  const rows = await load(catalogSql([...missing]));
  // An array oid takes its element's kind, never the text its own row as a type would give it.
  const arrays = new Set<number>();
  Iterator.from(rows).forEach(([array, base, isText, delim, oid, name]) => {
    const typeName = name ?? "";
    const element = isText === "true"
      ? undefined
      : builtin(Number(base))?.kind ?? (isEmptyString(typeName) ? "text" : scalarKind(typeName, "postgres"));
    if (missing.has(Number(array))) {
      arrays.add(Number(array));
      known.set(
        Number(array),
        matchesUndefined(element) || element.endsWith("[]")
          ? DEFAULT_DECODING
          : decoding(`${element}[]`, delim ?? DEFAULT_ARRAY_DELIMITER),
      );
    }
    if (missing.has(Number(oid)) && !arrays.has(Number(oid))) {
      known.set(Number(oid), decoding(element ?? "text"));
    }
  });
  missing.forEach((oid) => {if (!known.has(oid)) {known.set(oid, DEFAULT_DECODING);}});
};

/**
 * The decoder of each field a result named: a built-in type's by its oid, a created type's by the
 * module's column (when the module's columns match the result's) or by what the catalog said.
 * @param {Field[]} fields - The driver's result fields in order.
 * @param {Columns | undefined} columns - The generated module's columns when available.
 * @param {Catalog} catalog - The client identity and catalog loader.
 * @returns {Promise<Decoder[]>} The decoders for the result fields.
 */
export const fieldDecoders = async function (fields: Field[], columns: Columns | undefined, catalog: Catalog): Promise<Decoder[]> {
  const byColumn = columns && columns.length === fields.length ? columns : undefined;
  const created = fields.filter((field) => field.oid >= FIRST_USER_OID);
  const known = learnedOf(catalog.key);
  if (byColumn) {
    created.forEach((field) => {
      if (known.has(field.oid)) {return;}
      // oxlint-disable-next-line typescript/no-non-null-assertion -- The matched module columns contain a tuple for each field.
      const column = byColumn[fields.indexOf(field)]!;
      known.set(field.oid, decoding(column[1], column[2]));
    });
  }
  else if (created.length) {await learn(catalog, created.map((field) => field.oid));}
  return fields.map((field) => {
    const decoder = builtinDecoder(field.oid);
    if (decoder) {return decoder;}
    const format = known.get(field.oid) ?? DEFAULT_DECODING;
    return textDecoder(format.kind, format.delim);
  });
};

/** All built-in identifiers with an explicit decoder. */
export const builtinOids = [...Object.keys(SCALAR_OIDS).map(Number), ...ARRAY_OIDS.keys()];
