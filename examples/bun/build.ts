import reylo from "@totto2727/reylo/esbuild";
import { build } from "bun";

// Reylo's esbuild plugin builds each .sql import into the bundle, which then runs without the preload
const result = await build({
  entrypoints: ["src/main.ts"],
  outdir: "dist",
  plugins: [reylo()],
  target: "bun",
});
result.outputs.forEach((output) => {process.stdout.write(`built ${output.path}\n`);});
