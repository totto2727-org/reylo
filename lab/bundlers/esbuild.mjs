import * as esbuild from "esbuild";
import reylo from "@totto2727/reylo/esbuild";
await esbuild.build({ entryPoints: ["main.ts"], bundle: true, format: "esm", platform: "node", external: ["@totto2727/reylo", "postgres"], plugins: [reylo()], outfile: "dist/esbuild/main.js" });
console.log("esbuild ok");
