# Publish fork packages

This guide is for fork maintainers who stage and approve npm releases.
The fork uses `.github/workflows/publish.yml` to stage these public packages:

- `@totto2727/reylo`
- `@totto2727/reylo-postgres`
- `@totto2727/reylo-sqlite`
- `@totto2727/reylo-mysql`
- `@totto2727/reylo-duckdb`

## Configure trusted publishing

Before the first release, an npm package owner must configure each package separately.
The owner must have permission to publish public packages in the `@totto2727` scope.
If npm requires an initial package version before it permits trusted-publisher configuration, complete that initial setup separately as the package owner.
The workflow does not create package ownership or supply a bootstrap token.

For each package, configure a GitHub Actions trusted publisher with these exact values:

| Setting | Value |
| --- | --- |
| Repository owner | `totto2727-org` |
| Repository | `reylo` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Publication permission | Stage only |

Create the `npm` GitHub environment in `totto2727-org/reylo`.
Restrict its deployment branches to `main` and configure required reviewers for release approval.
Keep the repository public for npm provenance.
The workflow requests `contents: read` and `id-token: write` and uses OIDC authentication.
It does not require an `NPM_TOKEN`, a deploy key, or release-tag credentials.
Trusted-publisher setup is required to stage packages, but does not prevent workflow implementation or local build checks.

## Stage a version

1. Confirm that the intended commit passes the repository's CI checks.
2. Set the same version in the root manifest and all four engine manifests, including the root's exact-version engine peers.
3. Merge the release changes into `main`.
4. Approve the `npm` environment deployment when GitHub requests it.

A push to `main` starts the workflow.
To retry a version, select **Stage fork packages on npm** in GitHub Actions and run it with the `main` branch selected.
Manual runs from other branches fail before checkout or installation.
Do not start a retry until an earlier run has finished.
The workflow serializes runs and does not cancel a run that is already staging packages.

The workflow retains nub 0.9.6 on Node 24.
It installs the root and `site/` dependencies with frozen lockfiles, then runs the complete upstream build.
The npm CLI must be at least 11.15.0 for staging support.
The workflow follows upstream's npm 11 installation and checks this minimum version explicitly.
It does not use the shared monorepo publisher because that action requires Nix and Vite+.

The build writes five distributions under `dist/` and checks that their versions agree.
Source manifests remain private to prevent accidental source publication.
Only the generated distributions are staged with provenance and public access.
The engines are staged first, in PostgreSQL, SQLite, MySQL, and DuckDB order, followed by the runtime.
No Rust or WebAssembly rebuild is added to this workflow.

## Approve staged packages

A successful workflow does not mean that a new version is available to install.
The inherited staging helper skips versions already served by npm and accepts conflicts that indicate an existing staged or published version.
Check the npm staged queue for each of the five package names.
An npm maintainer must approve the staged engine versions first and the runtime version last, with the required npm two-factor authentication.
Use npm's staged-package interface or the npm staging commands from the maintainer's own authenticated terminal.
GitHub environment approval alone does not approve packages on npm.
After approval, confirm that npm serves all five packages at the intended version before announcing the release.

A partial failure can leave some engines staged without the runtime.
Inspect the failed job, correct the cause, then rerun the workflow on `main`.
The inherited `.github/scripts/npm-stage-publish.sh` handles versions already present or already staged.
Do not assume that a conflict proves that npm serves the intended package contents.

The upstream `.github/workflows/release.yml` remains unchanged.
It is not the supported fork publication entry point and requires separate upstream release configuration.
This fork workflow does not create Git tags, GitHub releases, or move the documentation release branch.
