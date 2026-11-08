# Publish fork packages

This guide is for maintainers staging the two SQLite/HCL distributions on npm.

| Distribution | Package |
| --- | --- |
| `dist/reylo` | `@totto2727/reylo` |
| `dist/sqlite` | `@totto2727/reylo-sqlite` |

The fork runtime and SQLite/HCL tooling packages must have the same version.
Do not stage Postgres, MySQL, or DuckDB packages from this fork.
The two distributions refer to published upstream `@reylosql/engine-*` packages at `0.7.0` through optional dependencies.
Do not build, stage, or republish these platform packages from this fork.
Check an installed distribution with optional dependencies enabled before release.

## Version policy

Both fork packages follow the upstream published release version by default.
Do not assign independent fork patch versions or suffixes automatically.
Keep both fork package versions and the exact tooling peer dependency equal.
The approved fork-only patch release is `0.7.1`, using upstream native release `0.7.0` without rebuilding it.
Keep `src/engine-version.ts` and all upstream native optional dependencies equal to that native release.
The host still requires an exact native version match, independently of the fork package version.
Update them together with the lockfile when adopting an upstream release whose native packages are published.
An unreleased upstream `main` commit is not a reason to select a version whose native packages are unavailable.
npm versions are immutable, so do not try to overwrite an already-published fork version.
Wait for the next upstream release or obtain approval for a version-policy exception when a fork-only fix needs a new publication.

## Setup

- Configure npm trusted publishing for both packages: repository `totto2727-org/reylo`, workflow `publish.yml`, without a GitHub environment.
- Keep the repository public for provenance.
- Complete initial package ownership setup as the npm scope owner.
- Use stage-only publishing permissions and approve staged versions on npm.

## Release

1. Select the upstream published release version, align all versions under the policy above, and pass the SQLite/HCL checks.
2. Build with `nub run build` and inspect `dist/reylo` and `dist/sqlite`.
3. Merge the validated changes into `main` to start `.github/workflows/publish.yml`. No tag push is required.
4. Inspect the staged versions on npm and approve the SQLite engine before the runtime.

The workflow uses shared `setup-nix`, `setup-typescript`, and `publish-npm` actions.
Keep the library template's workflow structure, checkout settings, permissions, and shared action order unless this fork requires a change.
The fork retains Nub for its upstream build and stages its two built package directories instead of the template's single root package.
Publication runs on pushes to `main`, not tags or releases.
The empty `ci` Nix shell satisfies the shared publisher's `nix print-dev-env` contract and manages no JavaScript runtime or package manager.
The setup, build, and publisher steps explicitly select `ci` so CI keeps its existing Nub setup action.
The default shell obtains Nub 0.9.6 from its official flake for local development.
The lockfile uses the library template's pinned Nixpkgs input.
The SQLite tooling bundle includes the HCL parser's license notices.

The publisher stages each distribution separately, with the SQLite engine first.
A partial failure can leave one version staged, so inspect npm before retrying.
Read [upstream differences](upstream-differences.md) for the package boundary and retained source customizations.
