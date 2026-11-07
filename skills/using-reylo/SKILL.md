---
name: using-reylo
description: Set up and use the SQLite/HCL Reylo fork with typed SQL imports, local schema analysis, and native SQLite execution.
---

# Using the SQLite/HCL Reylo fork

Use this skill when adding typed SQL imports to an application that consumes `@totto2727/reylo`.
This fork maintains only the runtime and `@totto2727/reylo-sqlite`.
Do not install Postgres, MySQL, or DuckDB engine packages.
Upstream documentation at <https://reylo.dev> describes a broader product, not this fork's package scope.
In version 0.7, unconstrained JSON values have type `Json`, and the former generic `Json<T>` helper is named `AsJson<T>`.
Date and timestamp years outside 0000 through 9999 use ISO 8601 extended form.
Keep the two scoped packages, not upstream's native platform packages.

## Setup

Use Node 24 or later and TypeScript 7.1 with content mapper support.
Install the runtime and engine at the same version:

```sh
nub add @totto2727/reylo
nub add -D @totto2727/reylo-sqlite typescript@7.1.0-beta
```

Add a `contentMappers` entry to the project's `tsconfig.json`:

```json
{
  "contentMappers": [
    {
      "package": "@totto2727/reylo",
      "extensions": [".sql", ".reylo.yaml", ".reylo.yml"]
    }
  ]
}
```

Run the type check with `tsc --noEmit --runExternalCode`.
For Node execution, load `@totto2727/reylo/register` with `--import` before importing SQL modules.
For nub, set `"preload": ["@totto2727/reylo/register"]` in `nub.jsonc`.
See the repository's [examples](../../examples/README.md) for complete configurations.

## Choose the analysis source

Set `direct_url` in `.reylo.yaml`, or supply `DATABASE_URL` through the environment or `.env`.
A local database source must already contain its schema:

```yaml
direct_url: file:./app.db
```

A local Atlas HCL source needs no host database or Atlas executable:

```yaml
direct_url: hcl:./schema.hcl
```

The HCL adapter accepts static SQLite `main` schemas with tables, columns, defaults, keys, checks, indexes, and supported table options.
It rejects dynamic expressions, unsupported attributes, and invalid references instead of silently ignoring them.
HCL is an analysis input only.
The application owns migrations and runtime connections, and must keep the runtime schema consistent with the HCL source.
Do not pass an `hcl:` URL to a database driver.
HCL content changes invalidate cached analysis.

## Import and execute queries

Write one statement per `.sql` file and use named parameters:

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

Reylo infers parameters, columns, nullability, and cardinality from SQLite's analysis.
Do not write duplicate query types by hand.
Use `.runSync()` with synchronous SQLite drivers and `.run()` with asynchronous drivers.
A primary or unique-key lookup normally returns a row or `null`, and a multi-row query returns an array.
Treat SQLite `check` constraints as constraints, not a promise of TypeScript literal unions.

## Native SQLite and D1 batches

Use the existing Standard Query interface when the native driver must own a transaction or batch:

```ts
const standard = getUser["~standard"].query;
const prepared = db.prepare(standard.text);
const rows = prepared.all(...standard.encode({ id: 1 }));
```

The interface's `.encode()` validates input and returns ordered bound values.
Native execution owns transaction boundaries, rollback, and driver-specific limits.
Raw results are not decoded or checked for cardinality unless the caller passes raw array rows to the interface's `.decode()`.
Standard Query does not check live-schema freshness.
For D1, use its native `.prepare()`, `.bind()`, and `.batch()` methods and validate behavior in the application's own environment.
Do not invent a `.compile()` API, custom SQL compiler, or new execution driver.

## Verify changes

Run the application's type check and its query tests after changing SQL or schema inputs.
Check both successful execution and invalid parameter rejection.
For HCL, verify the application's migration/schema path separately because HCL analysis executes no host migration.
