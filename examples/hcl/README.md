# Local HCL analysis

This example types a SQLite query from a static Atlas HCL schema, without Atlas or a host database during analysis.
Execution uses an independent in-memory database through Node's built-in `node:sqlite`.
Use Node 24 or later and nub 0.9.6.

## Run

```sh
nub run build                 # from the repository root
cd examples/hcl
nub install
nub run typecheck
nub run start
```

The script checks a matching row and a missing row, then prints the matching user.
The HCL file does not create tables in the application database.
The application creates its runtime schema explicitly in `main.ts`.

## Configuration

The project file selects `direct_url: hcl:./schema.hcl` for the content mapper and loader.
The runtime preload is `@totto2727/reylo/register`.
The package links point at `dist/reylo` and `dist/sqlite`, so rebuild the root after changing Reylo's source.
In another project, replace the links with matching published versions of `@totto2727/reylo` and `@totto2727/reylo-sqlite`.
See the [root setup](../../README.md#setup) for installation.
