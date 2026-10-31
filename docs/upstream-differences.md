# Upstream differences

This page records the retained source differences in this fork.
The upstream base is [`colinhacks/reylo@73562e513ef50d54df51daefa5243fa8427df7af`](https://github.com/colinhacks/reylo/commit/73562e513ef50d54df51daefa5243fa8427df7af).

## Local Atlas HCL schema analysis

The fork accepts a local `hcl:./schema.hcl` SQLite analysis source.
The fork parses HCL directly in JavaScript, then supplies the existing SQLite analysis engine with an in-memory schema catalog without opening or creating an application database.
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
The byte scanner also ports `go-textseg/v15` v15.0.0's Unicode 15 grapheme scanner and tables, preserving its [MIT and Unicode notices](../licenses/go-textseg-LICENSE.txt).
This pins the selected Go reference behavior instead of delegating positions to the host JavaScript runtime's Unicode version.
Engine tooling distributions include these licenses and identify the combined MIT and MPL-2.0 contents.
The original covered source and this fork's translated files remain available at the linked source repositories.
The [conformance test manifest and reproduction instructions](../tests/hclsyntax/README.md) identify every copied test surface, excluded API, and reference fixture.

The Atlas semantic adapter supports static SQLite `main` schemas, tables, columns, defaults, primary and foreign keys, checks, indexes, and table options.
It rejects unknown blocks, attributes, dynamic expressions, and invalid references rather than silently discarding them.
This adapter is not an implementation of arbitrary Atlas HCL evaluation.
SQLite's own prepared-statement parser prevents trailing SQL statements in explicit expression fields from being executed.
The resulting analysis catalog is read-only for the trusted bundled inference engine's catalog queries.
Its private query callback is not a general-purpose SQL sandbox and must not be exposed to untrusted callers.

A content fingerprint remains necessary when reusing analysis sessions: watching an HCL file does not replace a session's already-open in-memory catalog.
HCL edits immediately discard that catalog and its analysis answers before another query is analyzed, including callers without a bundler watcher.

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
