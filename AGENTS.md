# Working on Reylo

This guide is for contributors and coding agents maintaining the SQLite and HCL fork.
Read `AGENTS.local.md` when present, which takes precedence over this guide.
Consumer setup belongs in [README.md](README.md).

## Maintained scope

Build and publish only `@totto2727/reylo` and `@totto2727/reylo-sqlite`.
Do not restore Postgres, MySQL, or DuckDB npm packages, external-server requirements, or framework example projects.
Shared TypeScript dialect branches and the upstream Rust workspace remain when keeping them reduces upstream merge conflicts.
Their presence does not extend this fork's supported package matrix.
Preserve the SQLite inference engine and runtime API unless a change requires otherwise.
Record fork-specific behavior and operational impact in [docs/upstream-differences.md](docs/upstream-differences.md), including the exact upstream base hash whenever upstream is synced.

| Effect contract | Enforcement |
| --- | --- |
| Single-query Effects use a Layer-provided executor; native batches stay with the application. | `QueryExecutor` exposes only `dialect` and `execute`; `tests/effect.test.ts` exercises real SQLite through independent Layers. |
| Effect integration remains optional for ordinary runtime users. | `tests/effect-optional.test.ts` executes SQLite with Effect imports forbidden. |
| Query errors require their original cause in both constructor and instance types. | Constructor and structural type assertions in `tests/effect.test.ts`, checked by `nub run typecheck`. |
| Effect query errors use `Data.TaggedError`, not manually tagged native errors. | Direct yielding and `Effect.catchTag` recovery tests in `tests/effect.test.ts`. |

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/` | Runtime, content mapper, loaders, SQLite/HCL analysis, CLI, and shared upstream dialect code |
| `src/hclsyntax/` | Private native HCL parser port with MPL-2.0 notices |
| `packages/sqlite/` | SQLite/HCL tooling entry and upstream native optional dependencies |
| `engine/` | Upstream Rust workspace, shared core and database implementations |
| `spec/type-descriptor.ts` | Settled, living upstream descriptor contract. Agree format changes with a maintainer before editing |
| `oracle/` | Rust soundness oracle and upstream regression cases |
| `tests/` | Loader, runtime, SQLite and HCL regression tests |
| `examples/` | Minimal SQLite and HCL consumers linked to built distributions |
| `lab/drivers/` | SQLite integration driver dependencies used by root tests |
| `lab/jest/` | SQLite Jest/Vitest integration fixture used by root tests |
| `scripts/build.ts` | Distribution build into `dist/reylo` and `dist/sqlite` |
| `skills/using-reylo/` | Consumer skill, updated with user-visible behavior |

## JavaScript checks

Prefer nub 0.9.6 on Node 24 or later.
For local development, obtain Nub through the default shell with `nix develop`.
Keep the `ci` shell empty because CI already installs Nub through its setup action, and select that shell in the shared publisher.
Keep lockfiles current without bypassing the release-age policy.
From the repository root:

```sh
nub install
nub run typecheck
nub run test
nub run build
```

Run tests through Nub: on Node 24, direct `node --test` does not provide the Temporal API required by the retained shared value tests.

The root tests use `lab/drivers` for third-party SQLite clients and `lab/jest` for Jest/Vitest.
Install those fixtures when running the complete integration suite:

```sh
(cd lab/drivers && nub install)
(cd lab/jest && nub install)
mkdir -p lab/jest/node_modules/@totto2727
ln -sfn ../../../.. lab/jest/node_modules/@totto2727/reylo
ln -sfn ../../../../packages/sqlite lab/jest/node_modules/@totto2727/reylo-sqlite
```

Nub installs remove fixture package links, so recreate them after installation.
No Postgres or MySQL server is required for maintained SQLite/HCL checks.
Inspect skipped integration tests and state missing prerequisites rather than treating skips as verification.
The optional Atlas parity test requires Atlas on `PATH`, but production HCL analysis does not.

Examples use `link:` dependencies on `dist/reylo` and `dist/sqlite`.
Build at the root before installing an example, and rebuild after changing `src/`.
Do not replace those links with `file:` dependencies, which can leave stale installed builds under nub 0.9.6.
Follow each example's README for its checks.

## Engine changes

Analysis uses the published upstream `@reylosql/engine-*` packages at exactly `0.7.0`.
Normal install, build, and tests need no Rust compiler, WASI SDK, jco, or local engine build.
Keep optional dependencies enabled and verify `nativeBinary()` resolves an upstream installed package when checking this path.
`REYLO_ENGINE_PATH` is an explicit override, not the default acceptance path.
The host checks the engine's reported version, and this fork still rejects non-SQLite analysis.
Read [engine/README.md](engine/README.md) before changing reference Rust sources.
Those sources do not change the installed upstream binary.
Any inference change must be delivered through a compatible upstream engine release before it affects users.
Use the retained Rust workspace and SQLite oracle only for source-level investigation, not as a substitute for tests against the published engine.
Do not rebuild or publish platform packages from this fork.

## Version policy

Follow the upstream published release version by default, without independent fork version bumps.
Keep the root package, SQLite/HCL tooling package, and exact tooling peer dependency equal.
Keep `src/engine-version.ts`, the retained Cargo workspace, and upstream native optional dependencies at the compatible published native release.
The approved fork-only patch release is `0.7.1`, using the unchanged upstream native release `0.7.0`.
When syncing upstream, update these versions together with the lockfile and exact comparison revision in `docs/upstream-differences.md`.
Use a published release with available native packages, not an unreleased `main` version.
Do not overwrite an existing npm version or add a fork suffix automatically.
If a fork-only fix needs publication before the next upstream release, obtain approval for a version-policy exception first.

## Documentation and changes

Update the consumer skill and relevant examples with user-visible changes.
Keep Markdown paragraphs and list items on one line without hard wrapping.
State rules and reasons without attributing them to people.
Use Conventional Commits with lowercase imperative subjects, at most 72 characters.
Commit finished, verified steps and keep unrelated changes separate.
Do not commit temporary reports, local notes, or generated test databases.
Read [docs/publishing.md](docs/publishing.md) when changing release packaging or trusted publishing.
Keep CI and publication settings aligned with the library template unless this fork requires a difference.
Keep publication on pushes to `main`, not tag or release triggers.
Retain the upstream Nub build and the two distribution directories rather than migrating the toolchain to match the template.
Record required differences and their operational impact in [upstream differences](docs/upstream-differences.md).
