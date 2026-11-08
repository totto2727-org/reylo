// Builds the two scoped packages into dist/ without building an engine binary.
// dist/reylo holds the runtime and entry points, which discover the SQLite tooling package.
// dist/sqlite bundles the build-time TypeScript and HCL parser. Its optional dependencies
// install the upstream native engine for the consumer's platform at the pinned upstream version.
// Repository manifests remain private and point to sources. Published manifests point to JS.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build as bundle, transformSync } from "esbuild";
import { ENGINE_VERSION } from "../src/engine-version.ts";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const js = (path: string) => path.replace(/\.ts$/, ".js");
const DATABASES = ["sqlite"] as const;

rmSync(dist, { recursive: true, force: true });
const reylo = join(dist, "reylo");
// TypeScript's own launcher, run by this Node: node_modules/.bin holds a shell script, which Windows cannot start.
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
// The comments stay in the sources and in the declarations, where an editor shows them. The
// JavaScript ships without them, since they are about a third of its size.
for (const file of readdirSync(reylo, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js"))) {
  const path = join(reylo, file);
  writeFileSync(path, transformSync(readFileSync(path, "utf8"), { loader: "js", legalComments: "inline" }).code);
}
copyFileSync(join(root, "README.md"), join(reylo, "README.md"));
mkdirSync(join(reylo, "docs"), { recursive: true });
copyFileSync(join(root, "docs/effect.md"), join(reylo, "docs/effect.md"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The retained Cargo workspace describes the upstream binary, not fork-only npm patches.
const cargoVersion = readFileSync(join(root, "Cargo.toml"), "utf8").match(/^\[workspace\.package\]\s*\nversion = "([^"]+)"/m)?.[1];
if (cargoVersion !== ENGINE_VERSION) throw new Error(`Cargo.toml: the workspace's version is ${cargoVersion}, and the upstream engine is ${ENGINE_VERSION}; they move together`);
for (const [name, version] of Object.entries(pkg.optionalDependencies)) {
  if (version !== ENGINE_VERSION) throw new Error(`package.json: the upstream engine ${name} is ${version}, expected ${ENGINE_VERSION}`);
}
const { private: _private, scripts: _scripts, devDependencies: _dev, bin, exports, typescript, ...rest } = pkg;
// SQLite tooling is a peer at reylo's own fork version (src/engine-package.ts).
for (const db of DATABASES) {
  const name = `@totto2727/reylo-${db}`;
  if (rest.peerDependencies?.[name] !== pkg.version) throw new Error(`package.json: the peer ${name} is ${rest.peerDependencies?.[name]}, and reylo is ${pkg.version}; they move together`);
  if (!rest.peerDependenciesMeta?.[name]?.optional) throw new Error(`package.json: the peer ${name} must be optional, since a project installs only its databases' engines`);
}
const built = {
  ...rest,
  // A bin path without its "./", as npm writes it: npm rewrites `./src/cli.js` to `src/cli.js` at
  // publish and warns that the script "was invalid and removed", which it was not (0.0.1's stage).
  bin: Object.fromEntries(Object.entries(bin as Record<string, string>).map(([name, path]) => [name, js(path).replace(/^\.\//, "")])),
  exports: Object.fromEntries(Object.entries(exports as Record<string, string>).map(([key, path]) => [key, { types: path.replace(/\.ts$/, ".d.ts"), default: js(path) }])),
  typescript: { ...typescript, contentMapper: { ...typescript.contentMapper, exec: (typescript.contentMapper.exec as string[]).map(js) } },
};
writeFileSync(join(reylo, "package.json"), JSON.stringify(built, null, 2) + "\n");

// Nothing TypeScript ships but declarations, and no engine ships inside reylo.
const files = readdirSync(reylo, { recursive: true, encoding: "utf8" });
const source = files.filter((f) => /\.(c|m)?ts$/.test(f) && !/\.d\.(c|m)?ts$/.test(f));
if (source.length) throw new Error(`dist/reylo holds TypeScript sources: ${source.join(", ")}`);
const wasm = files.filter((f) => f.endsWith(".wasm"));
if (wasm.length) throw new Error(`dist/reylo holds an engine: ${wasm.join(", ")}`);
// Nor any of the build-time half, which a run-time module would drag in by importing it.
const tooling = files.filter((f) => /^src\/(tooling|analyze|engine|engine-core|engine-worker|component|loader|commands|mapper-server|play)\.js$/.test(f));
if (tooling.length) throw new Error(`dist/reylo holds the engine packages' build steps: ${tooling.join(", ")}`);
console.log(`dist/reylo: ${files.length} files, package ${built.name}@${built.version}`);

// Each engine package's JavaScript is bundled into a few files with everything it reads, which also
// leaves out the comments.
const bundled = { bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "inline", logLevel: "warning", metafile: true } as const;

for (const db of DATABASES) {
  const from = join(root, "packages", db);
  const to = join(dist, db);
  mkdirSync(to);
  const { private: _p, exports: entries, devDependencies: _dev, ...engine } = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
  if (engine.version !== pkg.version) throw new Error(`packages/${db}/package.json is ${engine.version}, and reylo is ${pkg.version}; they move together`);
  const exported = Object.fromEntries(Object.entries(entries as Record<string, string>).map(([key, path]) => [key, js(path)]));
  // The tooling bundle includes the MPL-covered native HCL parser port alongside MIT code.
  writeFileSync(join(to, "package.json"), JSON.stringify({ ...engine, license: "MIT AND MPL-2.0", files: [...engine.files, "licenses"], exports: exported }, null, 2) + "\n");
  cpSync(join(root, "licenses"), join(to, "licenses"), { recursive: true });
  if (JSON.stringify(engine.optionalDependencies) !== JSON.stringify(pkg.optionalDependencies)) throw new Error(`packages/${db}: upstream native engine versions must match the root manifest`);
  copyFileSync(join(from, "README.md"), join(to, "README.md"));
  const half = await bundle({ ...bundled, entryPoints: [join(root, "src/tooling.ts")], outfile: join(to, "tooling.js") });
  // reylo's entry points load it with a `require` (src/engine-package.ts), which refuses an ES
  // module with a top-level await.
  if (typeof (createRequire(import.meta.url)(join(to, "tooling.js")) as { default?: { sqlModule?: unknown } }).default?.sqlModule !== "function") throw new Error(`dist/${db}/tooling.js does not load with a require`);
  // The engine connects to its database itself, or DuckDB's through the app's own driver: no
  // driver, and nothing native, is bundled.
  const native = Object.keys(half.metafile.inputs).filter((input) => /node_modules\/(postgres|mysql2|@duckdb|@bytecodealliance\/jco-node-fs)\//.test(input));
  if (native.length) throw new Error(`dist/${db}/tooling.js bundles a driver or a native addon: ${native.join(", ")}`);
  // A child process src/sqlite-drivers.ts starts beside the module that starts it.
  await bundle({ ...bundled, entryPoints: [join(root, "src/d1-proxy.ts")], outfile: join(to, "d1-proxy.js") });
  const shipped = readdirSync(to);
  const missing = (engine.files as string[]).filter((f) => !shipped.includes(f));
  if (missing.length) throw new Error(`dist/${db} is missing what its package.json lists: ${missing.join(", ")}`);
  const size = (path: string): number => (statSync(path).isDirectory() ? readdirSync(path).reduce((n, f) => n + size(join(path, f)), 0) : statSync(path).size);
  const sizes = shipped.filter((f) => f !== "package.json" && f !== "README.md").map((f) => `${f} ${size(join(to, f))} bytes`);
  console.log(`dist/${db}: package ${engine.name}@${engine.version}, ${sizes.join(", ")}`);
}
