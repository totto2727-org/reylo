// CommonJS run with no --experimental-vm-modules: Jest cannot require an ES module then, and
// Reylo's runtime is one, so babel-jest compiles reylo's own files to CommonJS.
// For an installed copy set transformIgnorePatterns: ["/node_modules/(?!@totto2727/reylo/)"].
// oxlint-disable-next-line import/no-commonjs -- Jest expects a CommonJS configuration export.
module.exports = {
  testMatch: ["<rootDir>/query.test.cjs"],
  transform: {
    "\\.[jt]s$": ["babel-jest", { plugins: ["@babel/plugin-transform-modules-commonjs"], presets: ["@babel/preset-typescript"] }],
    "\\.sql$": "@totto2727/reylo/jest",
  },
  watchman: false,
};
