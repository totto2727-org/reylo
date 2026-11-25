import { isEmptyString, matchesNull, matchesUndefined } from "./native-predicates.ts";

// Constructors for values and types from the same node-api copy as the connection.
export interface Api {
  DuckDBConnection: unknown;
  listValue: (items: unknown[]) => unknown;
  structValue: (entries: Record<string, unknown>) => unknown;
  mapValue: (entries: { key: unknown; value: unknown }[]) => unknown;
  unionValue: (tag: string, value: unknown) => unknown;
  blobValue: (bytes: Uint8Array) => unknown;
  LIST: (of: unknown) => unknown;
  STRUCT: (fields: Record<string, unknown>) => unknown;
  MAP: (key: unknown, value: unknown) => unknown;
  UNION: (members: Record<string, unknown>) => unknown;
  TUPLE: (items: unknown[]) => unknown;
  tupleValue: (items: unknown[]) => unknown;
  BOOLEAN: unknown;
  HUGEINT: unknown;
  DOUBLE: unknown;
  VARCHAR: unknown;
  BLOB: unknown;
}

type ModuleCache = Record<string, { exports?: unknown } | undefined>;
interface NodeRequire {
  (id: string): unknown;
  cache?: ModuleCache;
}
interface NodeProcess {
  argv?: string[];
  cwd: () => string;
  getBuiltinModule?: (id: string) => { createRequire: (from: string) => NodeRequire } | undefined;
}

const NODE_API = "@duckdb/node-api";
const NODE_API_ENTRY = /[\\/]@duckdb[\\/]node-api[\\/]lib[\\/]index\.js$/u;
const ROOT_OBJECT = Object.prototype;
const ENTRY_SCRIPT = 1;
const SINGLE_COPY = 1;
const apis = new WeakMap<object, Promise<Api>>();

const classesOf = (connection: object): unknown[] => {
  const classes: unknown[] = [];
  const chain = { cursor: Reflect.getPrototypeOf(connection) };
  while (!matchesNull(chain.cursor) && chain.cursor !== ROOT_OBJECT) {
    classes.push(chain.cursor.constructor);
    chain.cursor = Reflect.getPrototypeOf(chain.cursor);
  }
  return classes;
};

const readCache = (proc: NodeProcess | undefined): ModuleCache | undefined => {
  try {
    return proc?.getBuiltinModule?.("node:module")?.createRequire(`${proc.cwd()}/`).cache;
  } catch {
    return undefined;
  }
};

const nodeExports = (exported: unknown): Api | undefined =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the native package entry or its resolved CommonJS exports reach this adapter.
  exported as Api | undefined;

interface CacheResult {
  exact: Api | undefined;
  loaded: Api[];
}

const scanCache = (cache: ModuleCache | undefined, classes: Readonly<unknown[]>): CacheResult => {
  const loaded: Api[] = [];
  // oxlint-disable-next-line rules/no-for-loops -- Stop as soon as a cached entry supplied the connection's class.
  for (const [file, entry] of Object.entries(cache ?? {})) {
    const library = NODE_API_ENTRY.test(file) ? nodeExports(entry?.exports) : undefined;
    if (!matchesUndefined(library?.DuckDBConnection)) {
      if (classes.includes(library.DuckDBConnection)) {return { exact: library, loaded };}
      loaded.push(library);
    }
  }
  return { exact: undefined, loaded };
};

interface Resolution {
  failure: unknown;
  library: Api | undefined;
}

const resolvePackage = (proc: NodeProcess | undefined): Resolution => {
  const createRequire = proc?.getBuiltinModule?.("node:module")?.createRequire;
  const from = [proc?.argv?.[ENTRY_SCRIPT], proc && `${proc.cwd()}/`];
  const result: Resolution = { failure: undefined, library: undefined };
  // oxlint-disable-next-line rules/no-for-loops -- Match Node's resolution fallback order and stop at the first successful require.
  for (const origin of from) {
    if (!matchesUndefined(origin) && !isEmptyString(origin) && createRequire) {
      try {
        return { failure: result.failure, library: nodeExports(createRequire(origin)(NODE_API)) };
      } catch (error) {
        result.failure ??= error;
      }
    }
  }
  return result;
};

const constructorName = (value: unknown): unknown =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Read the prototype constructor's existing native name when it has one.
  (value as { name?: unknown } | null | undefined)?.name;

const unavailable = (cause: unknown): TypeError => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native require failures can also carry a message on a non-Error value.
  const failure = (cause as { message?: string } | null | undefined)?.message;
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the runtime's native TypeError contract without loading Effect.
  return new TypeError(`A list, a struct, a map or binary data is bound with @duckdb/node-api's own values, and the copy the connection came from cannot be found, nor one installed in the project: ${failure ?? "this runtime has no process.getBuiltinModule"}`);
};

const ambiguous = (other: boolean): TypeError => {
  const why = other ? "the copy the app's install resolves is another" : "the app has loaded several, and the connection is none of their DuckDBConnection";
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the runtime's native TypeError contract without loading Effect.
  return new TypeError(`A list, a struct, a map or binary data is bound with @duckdb/node-api's own values, which must come from the copy of the package the connection came from, and ${why}: install a single @duckdb/node-api.`);
};

const uncachedLibrary = (proc: NodeProcess | undefined, classes: Readonly<unknown[]>, loaded: number): Api => {
  const { failure, library } = resolvePackage(proc);
  if (matchesUndefined(library)) {throw unavailable(failure);}
  const other = classes.some((kind) => kind !== library.DuckDBConnection && constructorName(kind) === "DuckDBConnection");
  if (loaded > SINGLE_COPY || other) {throw ambiguous(other);}
  return library;
};

const loadedLibrary = ({ exact, loaded }: CacheResult): Api | undefined => {
  if (!matchesUndefined(exact)) {return exact;}
  const [first] = loaded;
  return loaded.length === SINGLE_COPY ? first : undefined;
};

// oxlint-disable-next-line typescript/require-await -- Run native module discovery immediately and keep resolution failures on the shared Promise.
const loadNodeApi = async function (connection: object): Promise<Api> {
  const classes = classesOf(connection);
  const proc = (globalThis as { process?: NodeProcess }).process;
  const cache = scanCache(readCache(proc), classes);
  return loadedLibrary(cache) ?? uncachedLibrary(proc, classes, cache.loaded.length);
};

// A connection's native class determines its copy. A plain wrapper is its own cache key.
// oxlint-disable-next-line typescript/promise-function-async -- Returning the cached Promise directly preserves its identity across concurrent native calls.
export const nodeApiOf = (connection: object): Promise<Api> => {
  const inherited = Reflect.getPrototypeOf(connection);
  const key = matchesNull(inherited) || inherited === ROOT_OBJECT ? connection : inherited;
  const existing = apis.get(key);
  if (!matchesUndefined(existing)) {return existing;}
  const pending = loadNodeApi(connection);
  apis.set(key, pending);
  // oxlint-disable-next-line promise/prefer-await-to-then -- Evict a failure without wrapping the Promise shared by concurrent calls.
  pending.catch(() => apis.delete(key));
  return pending;
};
