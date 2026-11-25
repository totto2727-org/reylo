// ESM run: `NODE_OPTIONS=--experimental-vm-modules nubx jest -c jest.esm.config.cjs`.
// oxlint-disable-next-line import/no-commonjs -- Jest expects a CommonJS configuration export.
module.exports = {
  extensionsToTreatAsEsm: [".sql"],
  testPathIgnorePatterns: ["/node_modules/"],
  transform: { "\\.sql$": "@totto2727/reylo/jest" },
  watchman: false,
};
