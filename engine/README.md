# The engine

The engine is the SQL analysis: parsing, placeholders, types, nullability, nested JSON shapes and cardinality, for Postgres, SQLite and MySQL. Its core never opens a connection: it replays an analysis, names the statements to describe and the catalog queries to run, and its host answers them. It is a core crate every database shares and one crate per database, and no database crate depends on another; around them, a facade for Rust hosts, the program that connects each database's engine to its database, and the component that program is built to:

| Crate | Directory | Holds |
| --- | --- | --- |
| `reylo-engine-core` | `core/` | The request protocol (`api`) and its host (`host`), the `Database` trait each database implements (`database`), the placeholder lexer (`lex`), the project file (`config`), the type model (`types`) and its JSON Schema (`schema`, `schema_type`), structured parameters (`structured`), the freshness facts (`fresh`), the shape vocabulary (`shape`), the engine's stack (`stack`), the replay loop (`replay`) and the fingerprint (`fingerprint`) |
| `reylo-engine-postgres` | `postgres/` | libpg_query (the patched `pg_query` crate, `vendor/`), its parse tree read straight from the C nodes into `pg_query`'s structs and built back for its deparser (`raw`, by converters `build.rs` generates from libpg_query's own definitions, and `csrc/deparse.c`), the type registry (`pgtypes`), the analysis (`postgres`, `analyze`, `infer`, `cardinality`, `jsonshape`, `levels`, `returning`) and the server-side handshake (`extension`) |
| `reylo-engine-sqlite` | `sqlite/` | SQLite's amalgamation patched with the engine's hooks (`csrc/`, compiled by `build.rs`), its resolved tree (`sqlite_tree`) and the analysis over it (`sqlite`) |
| `reylo-engine-mysql` | `mysql/` | Its own copy of `sqlparser` 0.63, cut to the statements it reads (`vendor/sqlparser`, whose README lists the changes), and the analysis over the server's prepare metadata (`mysql`, `mysql_shape`, `mysql_params`) |
| `reylo-engine-build` | `build-support/` | The source hash each crate's build script writes, which its fingerprint is made of |
| `reylo-engine` | `facade/` | For a Rust host: each database's engine behind a feature (`postgres`, `sqlite`, `mysql`), the replay loop of core's `replay`, and, behind a client feature (`tokio-postgres`, `rusqlite`, `mysql_async`), the answers to the engine's needs over that client and an `analyze` that runs a statement's whole replay on it |
| `reylo-engine-native` | `native/` | The engine as a program: requests and answers as JSON lines, the pure ones (`ping`, `lex`, `config`, `analyze`) answered by core, and the connection's (`open`, `run`, `query`, `describe`, `forget`, `close`) over the facade's clients, with TLS as libpq reads `sslmode` (`tls`). One module per database, each behind its feature |
| `reylo-engine-wasip2` | `wasip2/` | The program built to a `wasm32-wasip2` component, one per database, exporting `call` (the pure requests) and `serve` (the connection's). A Cargo workspace of its own, since it builds tokio-postgres with a patch (`tokio-postgres-0.7.18.patch`) and tokio with `--cfg tokio_unstable` for WASI's sockets |

The fork's `.sql` loader runs the published upstream `@reylosql/engine-*` native executable selected by [src/native.ts](../src/native.ts), with JSON-line requests managed by [src/engine.ts](../src/engine.ts).
The Rust tree is retained as reference source and for development tests, not as the source of a fork-published binary.
See [the maintained divergence record](../docs/upstream-differences.md) for the exact upstream revision and supported SQLite/HCL scope.

## Building

- `engine/build.sh --prepare` prepares the patched `pg_query` copy (`postgres/.patched/`), the SQLite amalgamation (`sqlite/.sqlite/`) and the patched tokio-postgres (`wasip2/.patched/`). Every cargo command in the workspace needs it first.
- `cargo test -p reylo-engine-core -p reylo-engine-postgres -p reylo-engine-sqlite -p reylo-engine-mysql -p reylo-engine -p reylo-engine-native -p reylo-oracle` runs the engine's native tests (the oracle's dependency gives `reylo-engine` its three client features).
- `engine/build.sh` builds every database's component into `packages/<database>/engine/` (`engine/build.sh postgres` builds one). It needs wasi-sdk 34, a toolchain with the `wasm32-wasip2` target (rustup's has it; Homebrew's `rustc` does not) and a local `@bytecodealliance/jco@1.39.0` installation, which is not part of this fork's normal dependencies.

Normal installation and packaging use the exact-version published native optional dependency and require no Rust or WASI toolchain.
The commands above describe the retained source-development tooling only.
Do not run the component build as part of the fork's package release or commit generated WASM artifacts.
