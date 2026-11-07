// Vitest runs the ESM test unchanged through @totto2727/reylo/vite; `globals` provides Jest's test and expect.
import reylo from "@totto2727/reylo/vite";
export default { plugins: [reylo()], test: { include: ["query.test.mjs"], globals: true } };
