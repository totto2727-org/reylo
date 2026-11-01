import { defineConfig } from "vite";
import reylo from "@totto2727/reylo/vite";
export default defineConfig({
  plugins: [reylo()],
  build: { ssr: "main.ts", outDir: "dist/vite", rollupOptions: { external: ["@totto2727/reylo", "postgres"], output: { format: "es", entryFileNames: "main.js" } } },
});
