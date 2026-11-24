// Builds the two scoped packages into dist/ without building an engine binary.
// Dist/reylo holds the runtime and entry points, which discover the SQLite tooling package.
// Dist/sqlite bundles the build-time TypeScript and HCL parser. Its optional dependencies
// Install the upstream native engine for the consumer's platform at the pinned upstream version.
// Repository manifests remain private and point to sources. Published manifests point to JS.
// oxlint-disable-next-line rules/no-node-imports -- The build invokes the native Node launcher for TypeScript.
import { execFileSync } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Verify that Reylo can synchronously load the published tool with Node's require.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- The build performs file operations directly on the package staging directories.
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Package staging uses the host's filesystem paths.
import path from "node:path";
import { build as bundle, transform } from "esbuild";
// oxlint-disable-next-line import/no-relative-parent-imports -- Use the same pinned upstream version as the runtime and generated manifests.
import { ENGINE_VERSION } from "../src/engine-version.ts";

const { join } = path;
const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const js = (sourcePath: string): string => sourcePath.replace(/\.ts$/u, ".js");
const DATABASES = ["sqlite"] as const;

await rm(dist, { force: true, recursive: true });
const reylo = join(dist, "reylo");
// TypeScript's own launcher, run by this Node: node_modules/.bin holds a shell script, which Windows cannot start.
// oxlint-disable-next-line node/no-sync -- Keep the native launcher's inherited stdio and failure status before staging compiler output.
execFileSync(process.execPath, [
  join(root, "node_modules/typescript/bin/tsc"),
  "-p",
  join(root, "tsconfig.build.json"),
], { stdio: "inherit" });
// The comments stay in the sources and in the declarations, where an editor shows them. The
// JavaScript ships without them, since they are about a third of its size.
const emitted = await readdir(reylo, { encoding: "utf8", recursive: true });
await Promise.all(emitted.filter((file) => file.endsWith(".js")).map(async (file) => {
  const outputPath = join(reylo, file);
  const source = await readFile(outputPath, "utf8");
  const { code } = await transform(source, { legalComments: "inline", loader: "js" });
  await writeFile(outputPath, code);
}));
await copyFile(join(root, "README.md"), join(reylo, "README.md"));
await mkdir(join(reylo, "docs"), { recursive: true });
await copyFile(join(root, "docs/effect.md"), join(reylo, "docs/effect.md"));

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
Object.entries(pkg.optionalDependencies).forEach(([name, version]) => {
  if (version !== ENGINE_VERSION) {throw new Error(`package.json: the upstream engine ${name} is ${version}, expected ${ENGINE_VERSION}`);}
});
const { private: _private, scripts: _scripts, devDependencies: _dev, imports: _developmentImports, bin, exports, typescript, ...rest } = pkg;
// SQLite tooling is a peer at reylo's own fork version (src/engine-package.ts).
Iterator.from(DATABASES).forEach((db) => {
  const name = `@totto2727/reylo-${db}`;
  if (rest.peerDependencies?.[name] !== pkg.version) {throw new Error(`package.json: the peer ${name} is ${rest.peerDependencies?.[name]}, and reylo is ${pkg.version}; they move together`);}
  if (!rest.peerDependenciesMeta?.[name]?.optional) {throw new Error(`package.json: the peer ${name} must be optional, since a project installs only its databases' engines`);}
});
const built = {
  ...rest,
  // A bin path without its "./", as npm writes it: npm rewrites `./src/cli.js` to `src/cli.js` at
  // Publish and warns that the script "was invalid and removed", which it was not (0.0.1's stage).
  bin: Object.fromEntries(Object.entries(bin as Record<string, string>).map(([name, path]) => [name, js(path).replace(/^\.\//u, "")])),
  exports: Object.fromEntries(Object.entries(exports as Record<string, string>).map(([key, path]) => [key, { types: path.replace(/\.ts$/u, ".d.ts"), default: js(path) }])),
  typescript: { ...typescript, contentMapper: { ...typescript.contentMapper, exec: (typescript.contentMapper.exec as string[]).map(js) } },
};
await writeFile(join(reylo, "package.json"), `${JSON.stringify(built, null, 2)  }\n`);

// Nothing TypeScript ships but declarations, and no engine ships inside reylo.
const files = await readdir(reylo, { encoding: "utf8", recursive: true });
const source = files.filter((currentFile) => /\.(?:c|m)?ts$/u.test(currentFile) && !/\.d\.(?:c|m)?ts$/u.test(currentFile));
if (source.length) {throw new Error(`dist/reylo holds TypeScript sources: ${source.join(", ")}`);}
const wasm = files.filter((currentFile) => currentFile.endsWith(".wasm"));
if (wasm.length) {throw new Error(`dist/reylo holds an engine: ${wasm.join(", ")}`);}
// Nor any of the build-time half, which a run-time module would drag in by importing it.
const tooling = files.filter((currentFile) => /^src\/(?:tooling|analyze|engine|engine-core|engine-worker|component|loader|commands|mapper-server|play)\.js$/u.test(currentFile));
if (tooling.length) {throw new Error(`dist/reylo holds the engine packages' build steps: ${tooling.join(", ")}`);}
console.log(`dist/reylo: ${files.length} files, package ${built.name}@${built.version}`);

// Each engine package's JavaScript is bundled into a few files with everything it reads, which also
// Leaves out the comments.
const bundled = { bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "inline", logLevel: "warning", metafile: true } as const;

const packageSize = async (packagePath: string): Promise<number> => {
  const info = await stat(packagePath);
  if (info.isDirectory()) {
    const items = await readdir(packagePath);
    const sizes = await Promise.all(items.map((item) => packageSize(join(packagePath, item))));
    // oxlint-disable-next-line unicorn/no-array-reduce -- Report the total bytes across this package directory.
    return sizes.reduce((total, bytes) => total + bytes, 0);
  }
  return info.size;
};

await Promise.all(DATABASES.map(async (db) => {
  const from = join(root, "packages", db);
  const to = join(dist, db);
  await mkdir(to);
  const { private: _enginePrivate, exports: entries, devDependencies: _engineDev, ...engine } = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
  if (engine.version !== pkg.version) {throw new Error(`packages/${db}/package.json is ${engine.version}, and reylo is ${pkg.version}; they move together`);}
  const exported = Object.fromEntries(Object.entries(entries as Record<string, string>).map(([key, path]) => [key, js(path)]));
  // The tooling bundle includes the MPL-covered native HCL parser port alongside MIT code.
  await writeFile(join(to, "package.json"), `${JSON.stringify({ ...engine, license: "MIT AND MPL-2.0", files: [...engine.files, "licenses"], exports: exported }, null, 2)  }\n`);
  await cp(join(root, "licenses"), join(to, "licenses"), { recursive: true });
  if (JSON.stringify(engine.optionalDependencies) !== JSON.stringify(pkg.optionalDependencies)) {throw new Error(`packages/${db}: upstream native engine versions must match the root manifest`);}
  await copyFile(join(from, "README.md"), join(to, "README.md"));
  const half = await bundle({ ...bundled, entryPoints: [join(root, "src/tooling.ts")], outfile: join(to, "tooling.js") });
  // Reylo's entry points load it with a `require` (src/engine-package.ts), which refuses an ES
  // Module with a top-level await.
  if (typeof (createRequire(import.meta.url)(join(to, "tooling.js")) as { default?: { sqlModule?: unknown } }).default?.sqlModule !== "function") {throw new Error(`dist/${db}/tooling.js does not load with a require`);}
  // The engine connects to its database itself, or DuckDB's through the app's own driver: no
  // Driver, and nothing native, is bundled.
  const native = Object.keys(half.metafile.inputs).filter((input) => /node_modules\/(?:postgres|mysql2|@duckdb|@bytecodealliance\/jco-node-fs)\//u.test(input));
  if (native.length) {throw new Error(`dist/${db}/tooling.js bundles a driver or a native addon: ${native.join(", ")}`);}
  // A child process src/sqlite-drivers.ts starts beside the module that starts it.
  await bundle({ ...bundled, entryPoints: [join(root, "src/d1-proxy.ts")], outfile: join(to, "d1-proxy.js") });
  const shipped = await readdir(to);
  const missing = (engine.files as string[]).filter((file) => !shipped.includes(file));
  if (missing.length) {throw new Error(`dist/${db} is missing what its package.json lists: ${missing.join(", ")}`);}
  const sizes = await Promise.all(shipped
    .filter((file) => file !== "package.json" && file !== "README.md")
    .map(async (file) => `${file} ${await packageSize(join(to, file))} bytes`));
  console.log(`dist/${db}: package ${engine.name}@${engine.version}, ${sizes.join(", ")}`);
}));
