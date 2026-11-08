# @totto2727/reylo-sqlite

SQLite and static Atlas HCL build-time tooling for [`@totto2727/reylo`](https://www.npmjs.com/package/@totto2727/reylo).
The runtime entry points load the content mapper, bundler steps, and CLI from this package.

```sh
npm install @totto2727/reylo
npm install -D @totto2727/reylo-sqlite
```

Install the two fork packages at the same version.
This package pins upstream `@reylosql/engine-*` optional dependencies to `0.7.0`.
Fork package release `0.7.1` retains that upstream native release.
The package manager selects the binary for the host OS, CPU, and Linux libc.
Do not omit optional dependencies when installing analysis tooling.
No Rust compiler, local binary build, WebAssembly component, or WASI shim is needed for normal use.

The engine runs in a child process during analysis.
The application still executes queries through its own SQLite driver.
HCL parsing remains local TypeScript code, and its static schema is analyzed by the native engine without opening an application database or running migrations.

Supported binary targets follow upstream v0.7.0: macOS and Windows on x64 or arm64, and Linux on x64 or arm64 with glibc or musl.
An unsupported platform or missing optional package produces an error with installation guidance.
`REYLO_ENGINE_PATH` can select a compatible `reylo 0.7.0` executable explicitly.
Local `target/` builds are not selected automatically, and this fork does not retain native engine sources or build tools.
Other dialects inside the upstream binary do not expand this fork's SQLite/HCL support matrix.
