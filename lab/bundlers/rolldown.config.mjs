import reylo from "@totto2727/reylo/vite";
export default { input: "main.ts", external: ["@totto2727/reylo", "postgres"], plugins: [reylo()], output: { dir: "dist/rolldown", format: "es", entryFileNames: "main.js" } };
