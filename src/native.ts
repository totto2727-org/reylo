// Where the `reylo` executable is: the one native program that is the analysis engine of every
// Database (`reylo engine <database>`, src/engine.ts). npm installs it as one of reylo's optional dependencies, the package of this
// Platform alone (`@reylosql/engine-<os>-<arch>`, each declaring its `os`, `cpu` and `libc`), so it
// Is found from reylo's own install, never the project's: the run time never reaches this file, and
// A bundler or a host's file tracing never pulls the binary into a function.
// oxlint-disable-next-line rules/no-node-imports -- Detect musl through the platform's ldd when Node's report cannot identify libc.
import { execSync } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- The native binary must exist before the synchronous resolver returns it.
import { existsSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the optional engine relative to Reylo's own installation.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Native binary paths follow the host filesystem conventions.
import path from "node:path";

/** The platform packages, by `<platform>-<arch>`, with `-musl` on a musl Linux. */
// oxlint-disable-next-line eslint/sort-keys -- Installation errors list supported platforms in this published order.
export const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@reylosql/engine-darwin-arm64",
  "darwin-x64": "@reylosql/engine-darwin-x64",
  "linux-x64": "@reylosql/engine-linux-x64",
  "linux-x64-musl": "@reylosql/engine-linux-x64-musl",
  "linux-arm64": "@reylosql/engine-linux-arm64",
  "linux-arm64-musl": "@reylosql/engine-linux-arm64-musl",
  "win32-x64": "@reylosql/engine-win32-x64",
  "win32-arm64": "@reylosql/engine-win32-arm64",
};

const reportMusl = (): boolean | undefined => {
  try {
    const rawReport: unknown = process.report.getReport();
    // oxlint-disable-next-line rules/force-predicate -- The native package probe must run independently of other Reylo modules.
    const report: unknown = typeof rawReport === "string" ? JSON.parse(rawReport) : rawReport;
    // oxlint-disable-next-line rules/force-predicate -- Support missing or malformed host reports in the standalone probe.
    if (typeof report !== "object" || report === null || !("header" in report)) {
      return undefined;
    }
    const { header } = report;
    // oxlint-disable-next-line rules/force-predicate -- A host report only identifies libc when the header contains this property.
    if (typeof header === "object" && header !== null && "glibcVersionRuntime" in header) {
      const usesGlibc = Boolean(header.glibcVersionRuntime);
      return !usesGlibc;
    }
  } catch {
    // Older runtimes may not provide a report. The caller tries ldd.
  }
  return undefined;
};

const streamText = (stream: unknown): string => {
  // oxlint-disable-next-line rules/force-predicate -- Decode native stream data without importing other Reylo modules.
  if (typeof stream === "string") {
    return stream;
  }
  return Buffer.isBuffer(stream) ? stream.toString("utf8") : "";
};

const lddErrorOutput = (failure: unknown): string => {
  // oxlint-disable-next-line rules/force-predicate -- execSync exposes stream data on its native error in the standalone probe.
  if (typeof failure !== "object" || failure === null) {
    return "";
  }
  const stdout = "stdout" in failure ? streamText(failure.stdout) : "";
  const stderr = "stderr" in failure ? streamText(failure.stderr) : "";
  return `${stdout}${stderr}`;
};

const lddMusl = (): boolean => {
  try {
    // oxlint-disable-next-line node/no-sync -- Package selection is synchronous and ldd can print libc information on either stream.
    return execSync("ldd --version 2>&1", { encoding: "utf8" }).includes("musl");
  } catch (error) {
    return lddErrorOutput(error).includes("musl");
  }
};

/**
 * Identify the libc that selects the installed Linux engine.
 * @returns {boolean} Whether the host uses musl libc.
 */
export const isMusl = (): boolean => process.platform === "linux" && (reportMusl() ?? lddMusl());

/**
 * Find the package name for the current host.
 * @returns {{key: string, pkg: string | undefined}} The platform key and its optional package.
 */
export const platformPackage = (): { key: string; pkg: string | undefined } => {
  const key = `${process.platform}-${process.arch}${isMusl() ? "-musl" : ""}`;
  return { key, pkg: PLATFORM_PACKAGES[key] };
};

const cache = { binary: "" };

const existingBinary = (candidate: () => string): string | undefined => {
  try {
    const binary = candidate();
    // oxlint-disable-next-line node/no-sync -- Callers require a resolved native path synchronously.
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
};

const availableBinary = (): string => {
  // oxlint-disable-next-line node/no-process-env -- REYLO_ENGINE_PATH is the documented executable override.
  const named = process.env.REYLO_ENGINE_PATH ?? "";
  // oxlint-disable-next-line node/no-sync -- Check the override before returning from the synchronous API.
  if (named && !existsSync(named)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the public native error without loading the optional Effect peer.
    throw new Error(`REYLO_ENGINE_PATH names ${named}, which does not exist: point it at a reylo executable, or unset it to use the one reylo installs`);
  }
  // oxlint-disable-next-line node/no-sync -- A previously resolved executable might have been removed.
  return named || (cache.binary && existsSync(cache.binary) ? cache.binary : "");
};

const installedBinary = (pkg: string): string => {
  const exe = process.platform === "win32" ? "reylo.exe" : "reylo";
  const require = createRequire(import.meta.url);
  const binary = existingBinary(() => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", exe))
    ?? existingBinary(() => require.resolve(`${pkg}/bin/${exe}`))
    ?? "";
  if (binary) {
    cache.binary = binary;
  }
  return binary;
};

/**
 * Resolve the explicitly configured engine or the engine installed with Reylo.
 * @returns {string} The native executable path.
 */
export const nativeBinary = (): string => {
  const named = availableBinary();
  if (named) {
    return named;
  }
  const { key, pkg = "" } = platformPackage();
  const binary = pkg ? installedBinary(pkg) : "";
  if (binary) {
    return binary;
  }
  const why = pkg ? `${pkg} is not installed (an install with --no-optional, or --omit=optional, leaves it out)` : `reylo ships no binary for ${key}`;
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the installation error for callers without Effect.
  throw new Error(`reylo's engine, the reylo executable, is missing: ${why}. Install reylo again with optional dependencies enabled on a supported platform (${Object.keys(PLATFORM_PACKAGES).join(", ")}), or set REYLO_ENGINE_PATH to a compatible reylo executable.`);
};
