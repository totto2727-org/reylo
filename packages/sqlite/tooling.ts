// The build-time half of reylo this package carries (src/tooling.ts). In the repository it is the
// Source itself; scripts/build.ts bundles it into tooling.js for the published package.
// oxlint-disable-next-line import/no-relative-parent-imports -- This checkout shim loads the bundler entry point from the repository root.
export { default } from "../../src/tooling.ts";
