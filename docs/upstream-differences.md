# Upstream differences

This page records the retained source differences in this fork.
The upstream base is [`colinhacks/reylo@73562e513ef50d54df51daefa5243fa8427df7af`](https://github.com/colinhacks/reylo/commit/73562e513ef50d54df51daefa5243fa8427df7af).

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

Package builds retain the upstream `scripts/build.ts` behavior: `nub run build` replaces `dist/`, builds all four engine packages, and includes the playground in `dist/reylo`.
Use upstream's nub 0.9.6 on Node 24 and run `nub install --frozen-lockfile` at the repository root and in `site/` before building.
Local SQLite consumers link `dist/reylo` and `dist/sqlite` from that complete build.
The retained packaging change copies `licenses/` into each engine distribution and declares its combined MIT and MPL-2.0 contents because each tooling bundle includes the native HCL parser port.

Raw TypeScript source links can load natively after Node resolves symlinks outside `node_modules`, but they also expose implementation files to the consuming application's compiler options.
Built links expose the official JavaScript and declarations instead, preserving application type checks without rewriting upstream implementation or weakening compiler settings.
No package publishing, duplicate compiler, custom execution driver or toolchain migration is required.

When syncing upstream, update the exact base hash above and maintain this record with the retained source changes.
