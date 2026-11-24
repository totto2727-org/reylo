// The Turbopack loader, `turbopack: { rules: { "*.sql": { loaders: ["reylo/turbopack"], as: "*.js" } } }`
// In a Next.js config: Turbopack runs webpack-style loaders, so it is `reylo/webpack`'s function.
// oxlint-disable-next-line import/no-default-export -- Turbopack looks for the default loader export.
export { default } from "./webpack.ts";
