// Vitest runs the ESM test unchanged through @totto2727/reylo/vite; `globals` provides the shared test registration.
import reylo from "@totto2727/reylo/vite";

const config = { plugins: [reylo()], test: { globals: true, include: ["query.test.mjs"] } };
// oxlint-disable-next-line import/no-default-export -- Vitest loads this configuration as the default export.
export default config;
