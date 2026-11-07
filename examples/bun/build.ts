import reylo from "@totto2727/reylo/esbuild";

// Reylo's esbuild plugin builds each .sql import into the bundle, which then runs without the preload
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  target: "bun",
  plugins: [reylo()],
  outdir: "dist",
});
for (const output of result.outputs) console.log(`built ${output.path}`);
