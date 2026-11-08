# SQLite and HCL examples

These minimal projects use only `@totto2727/reylo` and `@totto2727/reylo-sqlite`.

| Example | Analysis source | Execution |
| --- | --- | --- |
| [hcl](hcl/README.md) | Local static Atlas HCL | Node's built-in `node:sqlite`, in memory |
| [nub](nub/README.md) | Local SQLite file | `node:sqlite` with nub's preload |
| [bun](bun/README.md) | Local SQLite file | `bun:sqlite`, tests and a bundle |

## Run in this repository

Build the two distributions before installing an example:

```sh
nub run build
cd examples/hcl
nub install
nub run typecheck
nub run start
```

Each example links `dist/reylo` and `dist/sqlite` through `link:` dependencies.
Rebuild at the root after changing Reylo's source.
Follow each example's README for its runtime-specific setup and checks.

## Use in another project

Replace local links with matching published versions of the runtime and SQLite engine.
See the [root setup](../README.md#setup) for the content mapper configuration.
The HCL example needs no database or Atlas executable for analysis, but the application still owns its runtime schema and migrations.
