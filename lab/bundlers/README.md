# Bundlers lab

One `main.ts` (and its `main.mjs` twin for the bundlers that take no TypeScript entry) importing `query.sql`, bundled through every adapter Reylo ships, with `@totto2727/reylo` and `postgres` external so each bundle runs against the local Postgres afterwards:

| Adapter | Bundlers proven | Command |
| --- | --- | --- |
| `@totto2727/reylo/vite` | Vite 7, Rollup 4, Rolldown 1 | `vite build`, `rollup -c rollup.config.mjs`, `rolldown -c rolldown.config.mjs` |
| `@totto2727/reylo/esbuild` | esbuild 0.28, `Bun.build`, `Bun.plugin` (preload) | `node esbuild.mjs`, `bun bun-build.ts`, `bun --preload ./bun-preload.ts main.ts` |
| `@totto2727/reylo/webpack` | webpack 5, Rspack 1 (Turbopack takes the same loader as `@totto2727/reylo/turbopack` in `turbopack.rules`, not run here) | `webpack --config webpack.config.mjs`, `rspack build --config rspack.config.mjs` |

Then `node dist/<bundler>/main.js` prints the row. `nub install` first (a `node_modules/@totto2727/reylo` symlink to the repo root is created by hand after it: `mkdir -p node_modules/@totto2727 && ln -sfn ../../../.. node_modules/@totto2727/reylo`, and one to the Postgres engine: `mkdir -p node_modules/@totto2727 && ln -sfn ../../../../packages/postgres node_modules/@totto2727/reylo-postgres`). Each build analyzes `query.sql` against the database `.reylo.yaml` names, `${DATABASE_URL}` from the environment or from a `.env` beside `package.json` (the `lab/basic` tables), or reads it from `.reylo/` when `reylo generate` ran first; with neither the build fails. Each bundle runs against `DATABASE_URL` from the environment, falling back to `postgres://localhost:5432/postgres` (`node --env-file=.env dist/vite/main.js`).
