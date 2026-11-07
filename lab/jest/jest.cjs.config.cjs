// CommonJS run with no --experimental-vm-modules: Jest cannot require an ES module then, and
// reylo's runtime is one, so babel-jest compiles reylo's own files to CommonJS (an installed copy
// also needs transformIgnorePatterns: ["/node_modules/(?!@totto2727/reylo/)"]).
module.exports = {
  watchman: false,
  testMatch: ["<rootDir>/query.test.cjs"],
  transform: {
    "\\.sql$": "@totto2727/reylo/jest",
    "\\.[jt]s$": ["babel-jest", { presets: ["@babel/preset-typescript"], plugins: ["@babel/plugin-transform-modules-commonjs"] }],
  },
};
