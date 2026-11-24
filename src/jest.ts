// The Jest transformer: `transform: { "\\.sql$": "reylo/jest" }`. Jest loads test code through its
// Own runtime (jest-runtime reads the file and compiles it in a vm context), never through Node's
// Loader, so the hooks `reylo/register` installs never see a `.sql` file there, and Jest's sandbox
// Makes `module.registerHooks` throw. A transform is the one place Jest takes a file's source.
// Jest calls `process` synchronously, also for ES modules when it is defined, so it asks
// `src/bridge.ts`, which blocks on a worker while the analysis waits on the database. The module
// Is ESM when Jest loads the file as one (`--experimental-vm-modules` with `extensionsToTreatAsEsm:
// [".sql"]`), else CommonJS.
import { createHash } from "node:crypto";
import { sqlModuleSync } from "./bridge.ts";

type Options = { supportsStaticESM: boolean; configString: string };

// The module the cache key was computed from, for the `process` call that follows it.
const built = new Map<string, string>();

// Jest keeps a transform's output across runs, keyed by the source unless the transformer says
// Otherwise; a migration changes the module (its row count, its rewritten statement) and not the
// Source, so the key is the module itself.
const getCacheKey = function (_source: string, path: string, options: Options): string {
  const code = sqlModuleSync(path);
  built.set(path, code);
  return createHash("sha256").update(code).update(String(options.supportsStaticESM)).update(options.configString).digest("hex");
};

const transform = function (_source: string, path: string, options: Options): { code: string } {
  const code = built.get(path) ?? sqlModuleSync(path);
  built.delete(path);
  return { code: options.supportsStaticESM ? code : commonJs(path, code) };
};

// The loader's module has one import, two named exports and a default (`src/loader.ts`); each is
// One line, since the values are JSON.
function commonJs(path: string, code: string): string {
  const out = code
    .replace(/^import \{ (defineQuery(?:, checks)?) \} from "@totto2727\/reylo";$/m, (_, names: string) => `const { ${names} } = require("@totto2727/reylo");`)
    .replace(/^export const (\w+) = /gmu, "const $1 = exports.$1 = ")
    .replace(/^export default /mu, "exports.default = ");
  if (/^(import|export) /mu.test(out)) {throw new Error(`${path}: reylo's module has a shape reylo/jest cannot make CommonJS.`);}
  return `Object.defineProperty(exports, "__esModule", { value: true });\n${out}`;
}

export default { getCacheKey, process: transform };
