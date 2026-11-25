// The build-time half of reylo this package carries (src/tooling.ts). In the repository it is the
// Source itself; scripts/build.ts bundles it into tooling.js for the published package.
// oxlint-disable-next-line import/no-relative-parent-imports, import/no-default-export -- The checkout shim resolves the repository entry and preserves the public tooling default export.
export { default } from "../../src/tooling.ts";
