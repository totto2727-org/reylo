// oxlint-disable-next-line rules/no-node-imports -- The on-disk analysis cache uses the host filesystem and atomic rename.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Cache entries use the host's filesystem paths.
import path from "node:path";
import type { Analysis } from "./engine.ts";
import { isRecord } from "./native-predicates.ts";
import type { ResolvedProject } from "./project.ts";

export const CACHE_ENTRY_VERSION = 1;

/** What `.reylo/` holds for one statement. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- The exported cache type keeps its existing implicit Record assignability.
export type Entry = {
  version: typeof CACHE_ENTRY_VERSION;
  dialect: ResolvedProject["dialect"];
  schema: string;
  analysis: Analysis;
  /** When it was written, in milliseconds since 1970: a copy of `.reylo/` keeps it where it may not keep the file's time. */
  at: number;
};

interface CacheHit {
  entry: Entry;
  file: string;
}

const cacheDirectory = (root: string): string => path.join(root, ".reylo");

const queryCacheDirectory = (root: string): string => path.join(cacheDirectory(root), "queries");

export const cacheEntryFile = (root: string, statementKey: string, serverKey: string): string =>
  path.join(queryCacheDirectory(root), `${statementKey}-${serverKey}.json`);

export const readCacheEntry = async (file: string): Promise<Entry | undefined> => {
  try {
    const json: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(json) || json.version !== CACHE_ENTRY_VERSION) {
      return undefined;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Version 1 is the private serialized Entry format. Existing entries may omit newer fields such as `at`.
    return json as Entry;
  } catch {
    return undefined;
  }
};

const byRecordedTime = (entry: Entry | undefined): number => entry?.at ?? -Infinity;

const mostRecentEntry = async (directory: string, prefix: string): Promise<CacheHit | undefined> => {
  const names = await readdir(directory).catch((): string[] => []);
  const candidates = names.filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
  // oxlint-disable-next-line eslint/init-declarations, rules/no-let -- Keep only the newest hit in memory during the sequential file scan.
  let newest: CacheHit | undefined;
  // oxlint-disable-next-line rules/no-for-loops -- Read in directory order, keeping the first entry when timestamps tie.
  for (const name of candidates) {
    const file = path.join(directory, name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bound cache I/O to one open file at a time.
    const entry = await readCacheEntry(file);
    if (entry && (!newest || byRecordedTime(entry) > byRecordedTime(newest.entry))) {
      newest = { entry, file };
    }
  }
  return newest;
};

export const readOfflineEntry = async (root: string, statementKey: string, own: string): Promise<CacheHit | undefined> => {
  const entry = await readCacheEntry(own);
  return entry ? { entry, file: own } : mostRecentEntry(queryCacheDirectory(root), `${statementKey}-`);
};

const BASE36_RADIX = 36;
const FRACTION_START = 2;
const CACHE_IGNORE = "# reylo's cache: written by the type check, the build steps and reylo generate; never committed.\n*\n";

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

// Several processes can update a statement. Publish only whole entries via an atomic rename.
const publishEntry = async (root: string, file: string, entry: Entry): Promise<void> => {
  const suffix = Math.random().toString(BASE36_RADIX).slice(FRACTION_START);
  const temporary = `${file}.${process.pid}.${suffix}.tmp`;
  try {
    await mkdir(queryCacheDirectory(root), { recursive: true });
    const ignore = path.join(cacheDirectory(root), ".gitignore");
    if (!await exists(ignore)) {
      await writeFile(ignore, CACHE_IGNORE);
    }
    await writeFile(temporary, `${JSON.stringify(entry)}\n`);
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true });
  }
};

// Keep writes to one statement in submission order within this process.
const pendingWrites = new Map<string, Promise<void>>();

export const writeCacheEntry = async (root: string, file: string, entry: Entry): Promise<void> => {
  const previous = pendingWrites.get(file);
  const write = (async (): Promise<void> => {
    await previous?.catch(() => {
      // The previous caller already receives its own write error.
    });
    await publishEntry(root, file, entry);
  })();
  pendingWrites.set(file, write);
  try {
    await write;
  } finally {
    if (pendingWrites.get(file) === write) {
      pendingWrites.delete(file);
    }
  }
};
