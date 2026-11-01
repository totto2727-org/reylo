import { defineConfig, loadEnv } from "vite";
import reylo from "@totto2727/reylo/vite";

// Vitest reads this file instead of vite.config.ts: the queries need only Reylo's plugin, not React Router's.
export default defineConfig(({ mode }) => ({
  plugins: [reylo()],
  // `.env` into process.env for the tests' pool, as React Router's plugin does for the app.
  test: { env: loadEnv(mode, process.cwd(), "") },
}));
