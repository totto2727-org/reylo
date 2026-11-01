import * as esbuild from "esbuild";
import reylo from "@totto2727/reylo/esbuild";

await esbuild.build({
  entryPoints: ["src/server.ts"],
  bundle: true, // reylo, postgres and the queries all go into the one file
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [reylo()], // turns each .sql import into a module that runs the query
  outfile: "dist/server.mjs",
  sourcemap: true,
});
