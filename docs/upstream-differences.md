# Upstream differences

This page records the retained source differences in this fork.
The upstream base is the latest public release tag, [`colinhacks/reylo@7a3928a8ff4dfb387b34ed584ab1319aa72f3f3b` (`v0.7.0`)](https://github.com/colinhacks/reylo/commit/7a3928a8ff4dfb387b34ed584ab1319aa72f3f3b).
The fork merges this release rather than the later, unreleased `main` history.

## Fork package namespace

The fork publishes only `@totto2727/reylo` and its exact-version SQLite engine `@totto2727/reylo-sqlite`.
The manifests, generated Content Mapper declarations, runtime module imports, adapter paths, tooling discovery, and consumer examples use these names.
The fork depends on upstream-owned native engine packages but does not republish them.
The `reylo` CLI name and `.reylo.yaml` configuration remain unchanged.
Install the two fork packages, runtime and SQLite/HCL tooling, at the same version.
Both fork packages follow the upstream published release version by default, without independent fork patch bumps or suffixes.
The tooling peer stays at the fork package version.
Already-published npm versions remain immutable; a fork-only release outside this policy requires explicit approval.
The approved fork-only patch is `0.7.1` for both scoped packages and their exact tooling peer.
The native optional dependencies and retained Cargo workspace stay at upstream `0.7.0`.

## SQLite-only distribution scope

The maintained consumer surface is runtime execution with SQLite drivers and analysis from SQLite files or static Atlas HCL.
Postgres, MySQL, and DuckDB npm packages and their consumer projects are absent from the distribution.
The publication workflow stages only the runtime and SQLite/HCL tooling.
Their optional dependencies refer to upstream native platform engines, not database-specific npm engines.
Examples retain small SQLite consumers and a local HCL analysis example instead of framework deployments.
The test fixtures retain only SQLite driver dependencies and the Jest/Vitest integration lab.
Shared multi-dialect TypeScript branches, decoder code, and the upstream Rust workspace remain where removal would increase future merge conflicts.
These retained branches do not constitute supported npm engines or require external database servers for maintained checks.
The SQLite inference rules and runtime query execution API remain upstream behavior.
The HCL adapter and package/distribution scope are source customizations, not deployment-only configuration.

## Effect execution boundary

The optional `@totto2727/reylo/effect` subpath provides typed single-query Effects with a Layer-injected `QueryExecutor`.
`makeQueryRunner` captures that executor during service construction and returns a generic run function with no executor environment requirement per operation, independent of later context changes.
The existing context-dependent `run` delegates to the same preparation, execution, and decoding implementation.
Its execution contract has no dependency on a concrete SQL client or infrastructure framework.
Parameter encoding, SQLite object-row normalization, and cardinality reuse the existing query runtime.
Preparation, execution, and decoding failures use Effect's `Data.TaggedError` with a required original cause, supporting direct yielding and tag-based recovery without hand-written error tags.
Client acquisition, native batching, and transaction semantics remain application responsibilities.
Effect is an optional peer and is imported only from the opt-in subpath, so existing runtime consumers do not load it.
The affected areas are the runtime query metadata, the new Effect entry point, package exports, and regression tests.
There are no schema-analysis or upstream native-engine changes.

## Upstream native engine reuse

The fork uses upstream v0.7.0's native host and platform resolver in `src/engine.ts` and `src/native.ts`.
Both manifests pin all eight `@reylosql/engine-*` optional dependencies to `0.7.0`, and the package manager selects the host platform.
The fork does not build, publish, or rename these upstream binaries.
The build-time host rejects a binary whose reported version does not exactly match the upstream native release `0.7.0` recorded in `src/engine-version.ts`, independently of the fork npm version.
The package manifests, `src/engine.ts`, `src/engine-version.ts`, and `scripts/build.ts` separate these two version domains so fork-only npm patches do not request an unpublished native release.
Build checks preserve both the exact upstream native version and the exact fork runtime/tooling peer version.
The retained host changes restrict analysis to SQLite, select SQLite for core configuration parsing, and read the bundled tooling package's own version before a parent manifest.
Engine function signatures, asynchronous lexer calls, and the cached engine fingerprint follow upstream without compatibility arguments or an extra synchronous ping.
The runtime and tooling retain their separate scoped package boundary, with the HCL parser bundled into `dist/sqlite/tooling.js`.
Committed SQLite WASM artifacts, the component worker and host, and the WASI shim dependency are removed.
The retained Rust workspace is reference and oracle source, not the engine installed by consumers.
A fork change to Rust inference does not change the upstream binary and requires a separately coordinated compatible engine release before consumers can use it.
The release's JSON value type, ISO 8601 extended-year representation, and [`descriptor specification`](../spec/type-descriptor.ts) remain upstream behavior.
The existing main-push publication workflow and template-derived settings are unchanged.

## Local Atlas HCL schema analysis

The fork accepts a local `hcl:./schema.hcl` SQLite analysis source.
The fork parses HCL directly in JavaScript and supplies DDL catalog rows directly to the existing SQLite analysis engine without opening a host or application database.
The HCL path performs no host SQL execution.
The engine's existing embedded SQLite parser and internal schema replay remain unchanged.
The retained source changes are in project source resolution and analysis, the private native-syntax parser, and the static Atlas SQLite adapter in `src/hcl-sqlite.ts`.
No Atlas executable, Go runtime, remote service, or migration execution is required for HCL analysis.
HCL parsing runs in TypeScript, and the schema replay runs in the upstream native engine child process.
The HCL file remains an analysis input, not a migration or a runtime connection.
This is a build-time source customization, not a deployment customization or a new SQL execution driver.
The upstream runtime query API, binding, decoding and engine inference rules are unchanged.

### Native HCL source port

The parser is translated from [HashiCorp HCL v2.25.0 at `00057cf06d7b38a3f89e6e54d622eee98322b314`](https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314).
The private `src/hclsyntax/` implementation covers the native scanner, token cursor, configuration and expression parser, templates, parser-reachable AST, ranges, and diagnostics.
It does not add HCL evaluation, JSON syntax, `gohcl`, `hcldec`, or standalone traversal APIs.
No compiler settings are weakened for the translated implementation, Atlas adapter, or application code.
Translated files retain their MPL-2.0 notices, and [`licenses/hashicorp-hcl-MPL-2.0.txt`](../licenses/hashicorp-hcl-MPL-2.0.txt) retains the full upstream license.
The scanner uses standard `Intl.Segmenter` for grapheme columns and maps its UTF-16 boundaries to original UTF-8 byte positions.
It carries no copied textseg Unicode engine or tables.
Grapheme rules follow the host runtime's Unicode version instead of reproducing Unicode 15 exactly; character-column differences that do not change parsing are accepted.
The small adapted malformed-UTF-8 byte-width boundary retains its [MIT and Unicode notices](../licenses/go-textseg-LICENSE.txt).
Engine tooling distributions include these licenses and identify the combined MIT and MPL-2.0 contents.
The original covered source and this fork's translated files remain available at the linked source repositories.
The [conformance test manifest and reproduction instructions](../tests/hclsyntax/README.md) identify every copied test surface, excluded API, and reference fixture.

The Atlas semantic adapter supports static SQLite `main` schemas, tables, columns, defaults, primary and foreign keys, checks, indexes, and table options.
It rejects unknown blocks, attributes, dynamic expressions, and invalid references rather than silently discarding them.
This adapter is not an implementation of arbitrary Atlas HCL evaluation.
The private catalog callback answers only the engine's known DDL and function-list requests and rejects other queries or parameters.
It does not execute SQL on the host and is not a general-purpose SQL interface.
Static inference uses the embedded engine's built-in functions rather than a live target's function allowlist.
SQL syntax and schema replay remain the responsibility of the existing embedded engine.

HCL content hashes replace database fingerprint queries and are checked before cached analysis is reused.
HCL edits immediately discard the catalog answers and analysis cache before another query is analyzed, including callers without a bundler watcher.

## Atlas parity regression

The test in `tests/hcl-parity.test.ts` compares direct HCL inference with the same schema applied by Atlas to a disposable SQLite database.
It compares inferred parameters, result columns, nullability, cardinality, and Content Mapper declarations for primary keys, unique indexes, joins, aggregates, and nullable inputs.
This optional regression requires Atlas on `PATH`; maintained production HCL analysis does not.
Run `node --test tests/hcl-parity.test.ts` with Atlas available on `PATH`.
The reference database exists only under the test's temporary directory and is removed when the test finishes.
Production HCL analysis remains independent of Atlas and host databases.

## Native SQLite and D1 execution

Native batching uses the existing Standard Query interface, `query["~standard"].query.text` and `.encode(input)`, with the driver's own prepared statements.
The fork adds no `.compile()` API, SQL compiler or D1 driver.
A generic consumer preserves inferred input types through the existing `StandardQueryV1.InferArgs<Q>` type, while `.encode()` accepts unknown input and validates it at runtime.
The caller owns execution, transaction boundaries and driver-specific value limits.
Standard Query does not check live-schema freshness, and raw driver results are not decoded or checked for cardinality unless the caller invokes `.decode()` with raw array rows.
Parameter errors retain the existing Standard Query messages, which need not include the source filename.

Regression tests in `tests/standard-query-sqlite.test.ts` cover ordered and repeated parameters, nullable and invalid inputs, boolean and JSON encoding, sqlcommenter, result cardinality and native SQLite commit and rollback behavior.
These tests establish compatibility with native SQLite transactions, not Cloudflare D1 batch behavior.
An application must validate D1 execution with its own native `prepare()`, `bind()` and `batch()` calls.

## Package build and license packaging

Package builds write only `dist/reylo` and `dist/sqlite`.
Use nub 0.9.6 on Node 24 or later and install the repository's dependencies before building.
Local SQLite consumers link those two built distributions.
The packaging copies `licenses/` into the engine distribution and declares its combined MIT and MPL-2.0 contents because the tooling bundle includes the native HCL parser port.

Raw TypeScript source links can load natively after Node resolves symlinks outside `node_modules`, but they also expose implementation files to the consuming application's compiler options.
Built links expose the official JavaScript and declarations instead, preserving application type checks without rewriting upstream implementation or weakening compiler settings.
No duplicate compiler, custom execution driver or toolchain migration is required.

## Fork npm publication

`.github/workflows/publish.yml` runs on pushes to `main`, without a tag or release trigger.
It follows the library template's workflow structure, pinned checkout with credentials disabled, job permissions, Nix shell loading, and shared `setup-nix`, `setup-typescript`, and `publish-npm` action order.
The template reference is [`template-vite-plus-lib@bba7ce226000366b8f20fe4bc26623f98acccc20`](https://github.com/totto2727-org/template-vite-plus-lib/tree/bba7ce226000366b8f20fe4bc26623f98acccc20).
That revision still has a tag filter despite its main-push policy comments; this fork uses the required main-push trigger.
Keep other template settings unchanged unless this fork requires a difference.
Nub builds the two maintained distributions, and the shared publisher stages the SQLite engine before the runtime.
Nub setup, the upstream build command instead of `vp pack`, and the two package directories are required differences because upstream already builds separate runtime and engine distributions.
On Node 24, Nub also supplies the Temporal API used by retained shared value tests; direct `node --test` is not equivalent to `nub run test`.
CI retains the upstream Node test runner, the Linux and Windows matrix, and Atlas for the optional HCL parity regression instead of the template's Vite+ checks.
The `flake.nix` follows the library template's `supportedSystems`, `forEachSystem`, and `default`/`ci` shell structure, using its locked Nixpkgs input.
The default shell obtains Nub from the official [`nubjs/nub` flake at `v0.9.6`](https://github.com/nubjs/nub/tree/v0.9.6), pinned by `flake.lock`, so local contributors need no global Nub installation.
The Nub input retains its own upstream Nixpkgs pin rather than changing its build toolchain to the template's pin.
The `ci` shell is empty because CI already installs Nub through its existing setup action.
The publishing workflow explicitly selects `ci` in setup, build, and publisher steps to avoid building a second copy of Nub.
No separate Node package is installed because Nub manages its runtime.
The package manifests declare public npm publication without changing source-package privacy.
The fork's publication entry point is `publish.yml`, restricted to the two maintained packages.
Publication requires the npm scope owner's trusted-publisher configuration and separate npm approval of staged versions.
See [the publishing guide](publishing.md) for setup and package boundaries.

When syncing upstream, update the exact base hash above and maintain this record with the retained source changes.
