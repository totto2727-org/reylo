# Publish fork packages

Maintainers publish built distributions with the same shared actions as `template/vite-plus-lib/.github/workflows/publish.yml.disabled`.

## Packages

| Distribution | Package | Fork changes |
| --- | --- | --- |
| `dist/reylo` | `@totto2727/reylo` | HCL source integration and scoped module references |
| `dist/sqlite` | `@totto2727/reylo-sqlite` | Static Atlas HCL analysis and scoped references |
| `dist/postgres` | `@totto2727/reylo-postgres` | Scoped references and the shared tooling bundle |
| `dist/mysql` | `@totto2727/reylo-mysql` | Scoped references and the shared tooling bundle |
| `dist/duckdb` | `@totto2727/reylo-duckdb` | Scoped references and the shared tooling bundle |

An SQLite consumer installs the runtime and SQLite engine at the same version.
The workflow retains all four upstream engines without changing their inference rules.

## Setup

- Configure npm trusted publishing for each package: repository `totto2727-org/reylo`, workflow `publish.yml`, without a GitHub environment.
- Keep the repository public for provenance.
- Complete any initial package ownership setup as the npm scope owner.
- Use stage-only publishing permissions and approve staged versions on npm.

## Release

1. Pass CI and set the same version in the root and all four engine manifests.
2. Push the corresponding `v*` tag, as in the library template.
3. Inspect the staged versions on npm and approve the engines before the runtime.

The workflow uses shared `setup-nix`, `setup-typescript`, and `publish-npm` actions.
Nub still builds the upstream distributions, including the playground, after installing `site/` dependencies.
The empty Nix shell satisfies the shared publisher's `nix print-dev-env` contract and manages no JavaScript runtime or package manager.
The lockfile uses the library template's pinned Nixpkgs input.

Each engine is staged before the runtime through `publish-npm` with its own distribution directory.
A partial failure can leave some versions staged, so inspect npm before retrying.
The upstream `release.yml` remains unchanged and is not the fork's publication entry point.
No workflow run or package publication is performed as part of this configuration change.
