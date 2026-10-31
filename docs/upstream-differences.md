# Upstream differences

This page is for contributors and maintainers of this fork.
The upstream base is [`colinhacks/reylo@73562e513ef50d54df51daefa5243fa8427df7af`](https://github.com/colinhacks/reylo/commit/73562e513ef50d54df51daefa5243fa8427df7af).

## SQLite batch bindings

This fork adds `.compile(input)` to SQLite query objects.
The result is `{ sql, parameters }`, with the same typed input, checks and encoding as `.run()`.
The method reuses the upstream `rawStatement` binder and does not introduce another SQL compiler.
Cloudflare D1 can prepare these statements and submit them in one native batch.

The runtime change is limited to `src/index.ts`.
Regression tests are in `tests/compile.test.ts`.
Usage documentation and `skills/using-reylo/SKILL.md` describe the same contract.
No engine artifact, schema inference rule, deployment configuration or upstream connection implementation changes.

The caller owns execution, transaction boundaries and driver-specific value limits.
The method does not contact a database, check live-schema freshness, decode results or apply cardinality.
Other dialects are rejected at both the TypeScript call boundary and runtime.
This is a runtime source difference, not a deployment customization.
The upstream runtime source is therefore not unchanged.

The native SQLite tests establish binding and explicit transaction compatibility.
They do not establish Cloudflare D1 batch behavior, which must be tested by an application on D1.
When syncing upstream, update the base hash above and keep this record with the retained changes.
