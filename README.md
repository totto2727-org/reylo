# Reylo: SQLite and HCL

This fork of [Reylo](https://github.com/colinhacks/reylo) imports `.sql` files as typed TypeScript queries.
It maintains only the runtime `@totto2727/reylo` and the SQLite/HCL tooling `@totto2727/reylo-sqlite`.
Analysis reads a local SQLite database or a static Atlas HCL schema.
The application supplies its own SQLite driver for execution.

## Setup

Use Node 24 or later and TypeScript 7.1 with content mapper support.
Install the runtime and SQLite engine at the same version:

```sh
nub add @totto2727/reylo
nub add -D @totto2727/reylo-sqlite typescript@7.1.0-beta
```

Configure the content mapper in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "strict": true,
    "noEmit": true
  },
  "contentMappers": [
    {
      "package": "@totto2727/reylo",
      "extensions": [".sql", ".reylo.yaml", ".reylo.yml"]
    }
  ]
}
```

Choose one analysis source in `.reylo.yaml`:

```yaml
# A local database that already contains the schema:
direct_url: file:./app.db
```

```yaml
# Or a local static Atlas SQLite schema:
direct_url: hcl:./schema.hcl
```

HCL analysis needs no Atlas executable, database server, or migration execution.
It supports static SQLite `main` schemas, not arbitrary HCL evaluation.
The schema is an analysis input, not a runtime connection or a migration.
The application must create and maintain its runtime database separately.

## Use typed SQL

```sql
-- get_user.sql
select id, name from users where id = :id
```

```ts
import { DatabaseSync } from "node:sqlite";
import getUser from "./get_user.sql";

const db = new DatabaseSync("app.db");
const user = getUser.runSync(db, { id: 1 });
console.log(user);
db.close();
```

Enable the loader with `node --import @totto2727/reylo/register main.ts`, or use the preload configuration in the [nub example](examples/nub/README.md).
Run the type check with `nubx tsc --noEmit --runExternalCode`.
See the [examples](examples/README.md) for complete SQLite and HCL projects, and the [usage skill](skills/using-reylo/SKILL.md) for configuration and native-driver guidance.

## Version 0.7 compatibility

Unconstrained JSON values use the exported `Json` union rather than `unknown`.
The previous generic `Json<T>` row-to-JSON utility is now named `AsJson<T>`.
Date and timestamp values outside years 0000 through 9999 use ISO 8601 extended years.
The fork keeps the two scoped packages above and reuses upstream `@reylosql/engine-*` native binaries, pinned to `0.7.0`.
The package manager installs the binary for the host platform through optional dependencies.
Do not omit optional dependencies when installing analysis tooling.
Analysis starts the engine as a child process, including when its schema comes from HCL.
The fork no longer ships a WebAssembly component or needs Rust to build its npm distributions.
See the [tooling package](packages/sqlite/README.md) for supported platforms and missing-binary guidance.

## Maintenance

Read [AGENTS.md](AGENTS.md) before changing this repository.
The [upstream differences](docs/upstream-differences.md) record the exact upstream base and retained shared code.
The [publishing guide](docs/publishing.md) describes the two-package release.
Upstream's [documentation](https://reylo.dev) describes a broader product and is not this fork's support matrix.

## License

Reylo retains its [MIT license](LICENSE).
The translated native HCL parser carries [MPL-2.0](licenses/hashicorp-hcl-MPL-2.0.txt), with additional notices in [licenses/](licenses/).
See the [upstream source](https://github.com/colinhacks/reylo) and this fork's [source](https://github.com/totto2727-org/reylo).
