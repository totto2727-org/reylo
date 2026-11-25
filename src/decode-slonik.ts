import { builtin } from "./decode-postgres-catalog.ts";
import { lexPlaceholders } from "./lex.ts";
import { hasFunctionType, isEmptyArray, isEmptyString, matchesNullish, matchesString, matchesUndefined } from "./native-predicates.ts";
import { coerce, DecodeError, textDecoder } from "./values.ts";
import type { Columns, Kind } from "./values.ts";

// ---------------------------------------------------------------------------------------------
// Slonik: its query() runs only the queries its `sql` tag builds, and its type parsers are set on
// The pool's connections, where they turn a numeric into a float, a timestamp into epoch
// Milliseconds and an interval into seconds. A tag made by the app's own `createSqlTag` with
// `typeParsers` (Slonik 49.12.0 and later) overrides them for its queries alone, so Reylo's passes
// Every type that pg or Slonik converts through as the server's text, and decodes the rows itself.
// Each parameter appears once in a statement (upstream engine/core/src/lex.rs), so the statement is the
// Tag's template as it stands: its text between the placeholders, and the values in their order.

interface SlonikTypeParser { name: string; parse: (value: string) => unknown }
interface SlonikQuery { typeParsers?: unknown }
interface SlonikTag { unsafe: (strings: TemplateStringsArray, ...values: unknown[]) => SlonikQuery }
interface SlonikModule { createSqlTag: (configuration: { typeParsers: SlonikTypeParser[] }) => SlonikTag }
interface SlonikConfiguration {
  interceptors?: ({ transformRow?: unknown; transformRowAsync?: unknown } | null | undefined)[];
  typeParsers?: SlonikTypeParser[];
}
interface SlonikProtocol {
  clientConfiguration?: SlonikConfiguration;
  configuration?: SlonikConfiguration;
  query: (query: SlonikQuery) => PromiseLike<{
    fields: SlonikField[];
    rows: Record<string, unknown>[];
  }>;
}
interface SlonikField { dataTypeId: number; name: string }

/**
 * The built-in types pg's parsers (pg-types 4) or Slonik's own convert, each passed through as its
 * text; arrays of them follow. pg leaves every other type, and an array of one, as text or as an
 * array of its elements' text.
 */
const SLONIK_TEXT = [
  "bool", "bytea", "int2", "int4", "int8", "oid", "float4", "float8", "numeric", "money", "date", "timestamp", "timestamptz", "interval",
  "json", "jsonb", "point", "circle", "int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange",
];

/** Kinds whose value must reach Reylo as text: anything else is one a driver already converted, and may have rounded. */
const SLONIK_STRICT = /^(?:decimal|date|timestamp|timestamptz|interval)(?:\[\])*$/u;
const FIRST_PARAMETER_POSITION = 1;
const KIND_START = 0;
const ARRAY_KIND_SUFFIX = "[]";

const START_OF_TEXT = 0;
const ENTRY_SCRIPT_POSITION = 1;
const moduleCache: { module?: SlonikModule } = {};
const slonikTags = new Map<string, SlonikTag>();

type CreateRequire = (from: string) => (id: string) => unknown;
interface NodeProcess {
  argv?: string[];
  cwd: () => string;
  getBuiltinModule?: (id: string) => { createRequire: CreateRequire } | undefined;
}

const requireSlonik = (sources: (string | undefined)[], createRequire: CreateRequire): SlonikModule => {
  const failure: { cause?: unknown } = {};
  // oxlint-disable-next-line rules/no-for-loops -- Stop at the first loadable app package and keep the last require failure if both origins fail.
  for (const from of sources) {
    if (!matchesUndefined(from) && !isEmptyString(from)) {
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- createRequire returns the application's optional Slonik package.
        return createRequire(from)("slonik") as SlonikModule;
      } catch (error) {
        failure.cause = error;
      }
    }
  }
  // oxlint-disable-next-line rules/require-tagged-error, typescript/no-unsafe-type-assertion -- Report the loader's message in the existing native TypeError without importing Effect.
  throw new TypeError(`Reylo runs a query on Slonik with a sql tag from the app's own slonik package, which it could not load (a server that is bundled keeps slonik external, so that it loads from node_modules at run time): ${(failure.cause as Error).message}`);
};

/**
 * Loads the app's own Slonik package from the entry script or working directory.
 * The runtime lookup lets apps without Slonik bundle Reylo without resolving that package.
 * @returns {SlonikModule} The first package required by this driver.
 */
const loadSlonik = function (): SlonikModule {
  if (moduleCache.module) {return moduleCache.module;}
  const proc = (globalThis as { process?: NodeProcess }).process;
  const createRequire = proc?.getBuiltinModule?.("node:module")?.createRequire;
  if (!proc || !createRequire) {
    // oxlint-disable-next-line rules/require-tagged-error -- Unsupported host runtimes retain a native TypeError without importing Effect.
    throw new TypeError("Reylo runs a query on Slonik with a sql tag from the app's own slonik package, which it loads through Node's process.getBuiltinModule, and this runtime has none.");
  }
  const module = requireSlonik([proc.argv?.[ENTRY_SCRIPT_POSITION], `${proc.cwd()}/`], createRequire);
  moduleCache.module = module;
  return module;
};

const slonikTag = function (client: SlonikProtocol): SlonikTag {
  const { createSqlTag } = loadSlonik();
  // Slonik pools store parsers in configuration. Connections, transactions, and savepoints
  // Use clientConfiguration.
  const own = (client.configuration ?? client.clientConfiguration)?.typeParsers?.map((parser) => parser.name) ?? [];
  const names = [...new Set([...SLONIK_TEXT, ...own])];
  const key = names.join(",");
  const cached = slonikTags.get(key);
  if (!matchesUndefined(cached)) {return cached;}
  const tag = createSqlTag({ typeParsers: names.map((name) => ({ name, parse: (value: string) => value })) });
  slonikTags.set(key, tag);
  return tag;
};

/**
 * Forms the cooked and raw template literals expected by Slonik's SQL tag.
 * @param {string} text - A statement whose positional parameters each appear once.
 * @param {Readonly<unknown[]>} values - Bound parameter values.
 * @returns {[TemplateStringsArray, unknown[]]} Frozen strings and values in placeholder order.
 */
const slonikTemplate = function (text: string, values: Readonly<unknown[]>): [TemplateStringsArray, unknown[]] {
  const { params, placeholders } = lexPlaceholders(text, "postgres");
  if (placeholders.length > params.length) {
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native TypeError for unsupported bind forms without importing Effect.
    throw new TypeError("Reylo cannot run this statement on Slonik: it uses a parameter more than once, and Slonik's sql tag binds each use on its own, so the server would type each one separately. Use each parameter once, and select it in a with to read it twice.");
  }
  const strings = placeholders.map((placeholder, index) =>
    text.slice(placeholders[index - FIRST_PARAMETER_POSITION]?.end ?? START_OF_TEXT, placeholder.start));
  strings.push(text.slice(placeholders.at(-FIRST_PARAMETER_POSITION)?.end ?? START_OF_TEXT));
  const template: TemplateStringsArray = Object.freeze(Object.assign(strings, { raw: Object.freeze([...strings]) }));
  return [template, placeholders.map((placeholder) => values[Number(placeholder.name) - FIRST_PARAMETER_POSITION])];
};

const refuseSlonikRows = (): TypeError =>
  // oxlint-disable-next-line rules/require-tagged-error -- Retain the existing native TypeError before starting a write, with no Effect dependency.
  new TypeError("Reylo cannot run on this Slonik client: one of its interceptors rewrites every row (transformRow or transformRowAsync, such as slonik-interceptor-field-name-transformation), Reylo's too, so they would not have the columns the query declares. Run Reylo's queries on a pool made without that interceptor.");

const assertNoRowInterceptor = (driver: SlonikProtocol): void => {
  const interceptors = (driver.configuration ?? driver.clientConfiguration)?.interceptors;
  // Refuse before a query runs. A write that commits and then reports an error invites a retry.
  if (interceptors?.some((interceptor) => hasFunctionType(interceptor?.transformRow) || hasFunctionType(interceptor?.transformRowAsync)) ?? false) {
    throw refuseSlonikRows();
  }
};

// oxlint-disable-next-line unicorn/no-null -- Absent cells are SQL NULL in the public query rows.
const SQL_NULL = null;

type DecodingColumn = Readonly<[name: string, kind: Kind, delimiter: string | undefined]>;

const slonikValue = function slonikValue([name, kind, delim]: DecodingColumn, value: unknown): unknown {
  if (matchesNullish(value)) {return SQL_NULL;}
  if (matchesString(value)) {return textDecoder(kind, delim)(value);}
  // Slonik can return an array of the element parser's values, including nested arrays.
  if (Array.isArray(value) && kind.endsWith(ARRAY_KIND_SUFFIX)) {
    const elementKind = kind.slice(KIND_START, -ARRAY_KIND_SUFFIX.length);
    return value.map((element) => slonikValue([name, Array.isArray(element) ? kind : elementKind, delim], element));
  }
  if (SLONIK_STRICT.test(kind)) {
    throw new DecodeError(`Column "${name}" reached Reylo already converted by Slonik's driver (${value instanceof Date ? "a Date" : typeof value}), which ignored the query's type parsers, as a custom driverFactory may: Reylo refuses it rather than return a value that may have been rounded.`);
  }
  return coerce(kind, value, name, delim);
};

const slonikRows = (rows: Record<string, unknown>[], fields: SlonikField[], columns: Columns | undefined): unknown[] => {
  if (isEmptyArray(rows)) {return rows;}
  const work = columns ?? fields.map((field) => {
    const format = builtin(field.dataTypeId);
    return format ? ([field.name, format.kind, format.delim] as const) : ([field.name, "text"] as const);
  });
  Iterator.from(rows).forEach((row) => {
    Iterator.from(work).forEach(([name, kind, delim]) => {
      row[name] = slonikValue([name, kind, delim], row[name]);
    });
  });
  return rows;
};

/**
 * Runs a statement through the app's Slonik tag and decodes the named result rows.
 * @param {Record<string, unknown>} client - The app's Slonik pool, connection, or transaction.
 * @param {string} text - The query text.
 * @param {Readonly<unknown[]>} values - The positional parameters.
 * @param {Columns | undefined} columns - The compiled columns, when available.
 * @returns {Promise<unknown[]>} Named result rows in the compiled representation.
 */
// oxlint-disable-next-line eslint/max-params -- Keep the decoder call contract used by execute and keep columns optional.
export const slonik = async function slonik(client: Record<string, unknown>, text: string, values: Readonly<unknown[]>, columns: Columns | undefined): Promise<unknown[]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The caller has selected the Slonik driver using its connection methods.
  const driver = client as Record<string, unknown> & SlonikProtocol;
  assertNoRowInterceptor(driver);
  const tag = slonikTag(driver);
  const [template, ordered] = slonikTemplate(text, values);
  const query = tag.unsafe(template, ...ordered);
  if (matchesUndefined(query.typeParsers)) {
    // oxlint-disable-next-line rules/require-tagged-error -- An older Slonik driver reports the existing native TypeError without importing Effect.
    throw new TypeError("Reylo cannot run on this Slonik: its sql tag takes no type parsers per query (createSqlTag's typeParsers option), so its pool's parsers would turn numeric, timestamp and interval values into lossy numbers. Upgrade slonik to 49.12.0 or later.");
  }
  const result = await driver.query(query);
  return slonikRows(result.rows, result.fields, columns);
};
