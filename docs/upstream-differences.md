# Upstream differences

This page records the retained source differences in this fork.
The upstream base is [`colinhacks/reylo@73562e513ef50d54df51daefa5243fa8427df7af`](https://github.com/colinhacks/reylo/commit/73562e513ef50d54df51daefa5243fa8427df7af).

## Fork package namespace

The fork publishes only `@totto2727/reylo` and its exact-version SQLite engine `@totto2727/reylo-sqlite`.
The manifests, generated Content Mapper declarations, runtime module imports, adapter paths, engine discovery, and consumer examples use these names so the fork does not depend on or publish upstream-owned npm packages.
The `reylo` CLI name and `.reylo.yaml` configuration remain unchanged.
Install the runtime and SQLite engine at the same version.

## SQLite-only distribution scope

The maintained consumer surface is runtime execution with SQLite drivers and analysis from SQLite files or static Atlas HCL.
Postgres, MySQL, and DuckDB npm packages and their consumer projects are absent from the distribution.
The root dependency set and publication workflow contain only the runtime and SQLite engine.
Examples retain small SQLite consumers and a local HCL analysis example instead of framework deployments.
The test fixtures retain only SQLite driver dependencies and the Jest/Vitest integration lab.
Shared multi-dialect TypeScript branches, decoder code, and the upstream Rust workspace remain where removal would increase future merge conflicts.
These retained branches do not constitute supported npm engines or require external database servers for maintained checks.
The SQLite component, inference rules, and runtime query execution API remain upstream behavior.
The HCL adapter and package/distribution scope are source customizations, not deployment-only configuration.

## Local Atlas HCL schema analysis

The fork accepts a local `hcl:./schema.hcl` SQLite analysis source.
The fork parses HCL directly in JavaScript and supplies DDL catalog rows directly to the existing SQLite analysis engine without opening a host or application database.
The HCL path performs no host SQL execution.
The engine's existing embedded SQLite parser and internal schema replay remain unchanged.
The retained source changes are in project source resolution and analysis, the private native-syntax parser, and the static Atlas SQLite adapter in `src/hcl-sqlite.ts`.
No Atlas executable, Go runtime, subprocess, remote service, or migration execution is required for HCL analysis.
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
CI retains the upstream Node test runner, the Linux and Windows matrix, and Atlas for the optional HCL parity regression instead of the template's Vite+ checks.
The minimal `flake.nix` supplies only the empty Linux shell required by the shared publisher, using the library template's locked Nixpkgs input.
It installs no JavaScript runtime, package manager, or build tool through Nix.
The package manifests declare public npm publication without changing source-package privacy.
The fork's publication entry point is `publish.yml`, restricted to the two maintained packages.
Publication requires the npm scope owner's trusted-publisher configuration and separate npm approval of staged versions.
See [the publishing guide](publishing.md) for setup and package boundaries.

When syncing upstream, update the exact base hash above and maintain this record with the retained source changes.
