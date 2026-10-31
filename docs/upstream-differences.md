# Upstream differences

This page records the retained source differences in this fork.
The upstream base is [`colinhacks/reylo@73562e513ef50d54df51daefa5243fa8427df7af`](https://github.com/colinhacks/reylo/commit/73562e513ef50d54df51daefa5243fa8427df7af).

## Local Atlas HCL schema analysis

The fork accepts a local `hcl:./schema.hcl` SQLite analysis source.
Atlas evaluates the HCL, and Reylo analyzes the resulting schema in an in-memory SQLite database without opening or creating an application database.
The retained source changes are in the project source resolution and analysis path, including `src/project.ts`, `src/analyze.ts` and `src/hcl.ts`.
Atlas must be available when analyzing an HCL source.
The HCL file remains an analysis input, not a migration or a runtime connection.
This is a build-time source customization, not a deployment customization or a new SQL execution driver.
The upstream runtime query API, binding, decoding and engine inference rules are unchanged.

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

## Local SQLite package build

The centralized `scripts/build.ts` accepts `--sqlite` for local SQLite consumers.
Run `node scripts/build.ts --sqlite` to build `dist/reylo` and `dist/sqlite`, then link those package directories in the application.
The build uses the existing TypeScript compilation, declaration generation, package manifests, SQLite engine and tooling bundles.
It skips the unrelated database packages and the docs playground, so it does not require the site's installation or `nub`.
The default build without the flag still builds all packages and the playground.
The SQLite-only output is for local consumption, not a complete release artifact, and `reylo play` has no bundled playground page in this mode.
Both modes replace `dist/`, so rebuild with the required mode before consuming its output.

Raw TypeScript source links can load natively after Node resolves symlinks outside `node_modules`, but they also expose implementation files to the consuming application's compiler options.
Built links expose the official JavaScript and declarations instead, preserving application type checks without rewriting upstream implementation or weakening compiler settings.
No package publishing, duplicate compiler, custom execution driver or toolchain migration is required.

When syncing upstream, update the exact base hash above and maintain this record with the retained source changes.
