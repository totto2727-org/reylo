import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import reylo from "@totto2727/reylo/vite";

export default defineConfig({
  plugins: [reylo(), cloudflare()],
});
