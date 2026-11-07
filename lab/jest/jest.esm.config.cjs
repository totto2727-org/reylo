// ESM run: `NODE_OPTIONS=--experimental-vm-modules nubx jest -c jest.esm.config.cjs`.
module.exports = {
  watchman: false,
  testPathIgnorePatterns: ["/node_modules/"],
  transform: { "\\.sql$": "@totto2727/reylo/jest" },
  extensionsToTreatAsEsm: [".sql"],
};
