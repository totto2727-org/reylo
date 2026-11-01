import reylo from "@totto2727/reylo/vite";
export default { input: "main.mjs", external: ["@totto2727/reylo", "postgres"], plugins: [reylo()], output: { dir: "dist/rollup", format: "es", entryFileNames: "main.js" } };
