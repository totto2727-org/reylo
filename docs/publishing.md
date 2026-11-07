# Publish fork packages

This guide is for maintainers staging the two SQLite/HCL distributions on npm.

| Distribution | Package |
| --- | --- |
| `dist/reylo` | `@totto2727/reylo` |
| `dist/sqlite` | `@totto2727/reylo-sqlite` |

The runtime and SQLite engine must have the same version.
Do not stage Postgres, MySQL, or DuckDB packages from this fork.

## Setup

- Configure npm trusted publishing for both packages: repository `totto2727-org/reylo`, workflow `publish.yml`, without a GitHub environment.
- Keep the repository public for provenance.
- Complete initial package ownership setup as the npm scope owner.
- Use stage-only publishing permissions and approve staged versions on npm.

## Release

1. Pass the SQLite/HCL checks and set the same version in the root and SQLite engine manifests.
2. Build with `nub run build` and inspect `dist/reylo` and `dist/sqlite`.
3. Push the corresponding `v*` tag to start `.github/workflows/publish.yml`.
4. Inspect the staged versions on npm and approve the SQLite engine before the runtime.

The workflow uses shared `setup-nix`, `setup-typescript`, and `publish-npm` actions.
The empty Nix shell satisfies the shared publisher's `nix print-dev-env` contract and manages no JavaScript runtime or package manager.
The lockfile uses the library template's pinned Nixpkgs input.
The SQLite tooling bundle includes the HCL parser's license notices.

The publisher stages each distribution separately, with the SQLite engine first.
A partial failure can leave one version staged, so inspect npm before retrying.
Read [upstream differences](upstream-differences.md) for the package boundary and retained source customizations.
