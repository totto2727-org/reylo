import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import reylo from "@totto2727/reylo/vite";

export default defineConfig({
  plugins: [reylo(), reactRouter()],
});
