import { fileURLToPath } from "node:url";
export default {
  mode: "development", target: "node", devtool: false,
  entry: "./main.mjs",
  experiments: { outputModule: true },
  output: { path: fileURLToPath(new URL("./dist/rspack", import.meta.url)), filename: "main.js", module: true, chunkFormat: "module" },
  externalsType: "module", externals: { "@totto2727/reylo": "@totto2727/reylo", postgres: "postgres" },
  module: { rules: [{ test: /\.sql$/, use: "@totto2727/reylo/webpack" }] },
};
