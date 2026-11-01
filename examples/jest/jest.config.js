// The ES module run: `nub run test`, which starts Jest with Node's --experimental-vm-modules.
/** @type {import("jest").Config} */
export default {
  // Reylo: Jest loads tests through its own runtime, which no preload reaches, so this
  // transformer turns each imported .sql file into its query module.
  transform: { "\\.sql$": "@totto2727/reylo/jest" },
  // Reylo: a query's module is an ES module, like the .ts tests that import it (Jest strips
  // their types itself, through Node, since no transform claims them).
  extensionsToTreatAsEsm: [".ts", ".sql"],
};
