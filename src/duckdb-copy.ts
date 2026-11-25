// oxlint-disable-next-line rules/no-node-imports -- Snapshot locally owned DuckDB files through the host filesystem.
import { constants, copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Place each private database copy in the host's temp directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- Keep the database basename and its WAL paired using native paths.
import path from "node:path";
import { matchesUndefined } from "./native-predicates.ts";

interface Copy { dir: string; file: string; key: string }
const copies = new Map<string, Copy>();
const cleanup = { registered: false };

const remove = (directory: string): void => {
  // oxlint-disable-next-line node/no-sync -- The process exit hook must remove owned snapshots before returning.
  rmSync(directory, { force: true, recursive: true });
};

const stamp = (filename: string): string =>
  // oxlint-disable-next-line node/no-sync -- Read the database and WAL stamps before copying files that may be written concurrently.
  existsSync(filename) ? `${statSync(filename).size}:${statSync(filename).mtimeMs}` : "-";

const registerCleanup = (): void => {
  if (cleanup.registered) {return;}
  cleanup.registered = true;
  process.once("exit", () => {
    Iterator.from(copies.values()).forEach(({ dir }) => {remove(dir);});
  });
};

const makeCopy = (filename: string, wal: string, key: string): string => {
  // oxlint-disable-next-line node/no-sync -- Create a fresh private snapshot before handing its path to the native driver.
  const dir = mkdtempSync(path.join(tmpdir(), "reylo-duckdb-"));
  const file = path.join(dir, path.basename(filename));
  // oxlint-disable-next-line node/no-sync -- The driver opens only after the copy or filesystem clone is complete.
  copyFileSync(filename, file, constants.COPYFILE_FICLONE);
  // oxlint-disable-next-line node/no-sync -- Include an existing WAL before opening this database copy.
  if (existsSync(wal)) {copyFileSync(wal, `${file}.wal`, constants.COPYFILE_FICLONE);}
  copies.set(filename, { dir, file, key });
  registerCleanup();
  return file;
};

/**
 * Return a local snapshot of the database and its write-ahead log.
 * @param {string} filename - The live DuckDB file.
 * @param {boolean} [fresh] - Copy again even when the file stamps match.
 * @returns {string} The temporary database path.
 */
export const copyOf = function copyOf(filename: string, fresh = false): string {
  const wal = `${filename}.wal`;
  const key = `${stamp(filename)}/${stamp(wal)}`;
  const previous = copies.get(filename);
  if (previous?.key === key && !fresh) {return previous.file;}
  if (!matchesUndefined(previous)) {remove(previous.dir);}
  return makeCopy(filename, wal, key);
};
