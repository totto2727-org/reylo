// The Next.js integration, `export default withReylo(nextConfig)` in next.config.ts: the loader on
// The server for Turbopack and webpack, and a type check that runs the content mapper inside
// `next build`.
//
// Since 16.3, `next build` type-checks with the project's own `tsc` (`experimental.useTypeScriptCli`,
// On by default), which TypeScript 7 is, but with arguments of its own and no `--runExternalCode`
// Among them, and TypeScript takes that flag from the command line alone. So its check never runs
// The mapper and fails on every `.sql` import (TS2307, and TS18068 on tsconfig.json). The wrapper
// Turns that check off and runs the same one with the flag in `compiler.runAfterProductionCompile`,
// Which runs under Turbopack and webpack alike, after the compile and before Next's own type check
// And the prerender (wiki/nextjs.md).
// oxlint-disable-next-line rules/no-node-imports -- Resolve the selected TypeScript config relative to the project.
import path from "node:path";
import { typeCheck } from "./next-type-check.ts";

type AfterCompile = (metadata: { projectDir: string; distDir: string }) => Promise<void>;

// The part of Next's config the wrapper reads or sets, so that reylo has no dependency on next.
// Each field's type admits Next's own, and the rest of the config passes through as it is. Every
// Level is intersected with `object`: one whose properties are all optional is a weak type, which
// A literal sharing none of them, as `{ reactStrictMode: true }` or `{ turbopack: { root } }`,
// Fails, reported as excess properties. An index signature would not do: Next's own `NextConfig`
// And its parts are interfaces, which have none, so they are assignable to one only when its value
// Is `any`, which lets any value through.
// oxlint-disable-next-line typescript/no-explicit-any -- Match Next's public callback type for independently installed webpack versions.
type WebpackHook = (config: any, context: any) => any;

type NextConfig = object & {
  typescript?: object & { ignoreBuildErrors?: boolean; tsconfigPath?: string };
  turbopack?: object & { rules?: Record<string, unknown> };
  webpack?: WebpackHook | null;
  compiler?: object & { runAfterProductionCompile?: AfterCompile };
};

interface WebpackContext { isServer: unknown }
interface WebpackConfig { module: { rules: unknown[] } }

const withWebpack = (
  configured: NextConfig["webpack"], webpackConfig: unknown, context: WebpackContext,
): unknown => {
  const output: unknown = configured ? configured(webpackConfig, context) : webpackConfig;
  const isServer = Boolean(context.isServer);
  if (isServer) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- On the server, Next's webpack hook provides the mutable module rules array.
    (output as WebpackConfig).module.rules.push({ test: /\.sql$/u, use: "@totto2727/reylo/webpack" });
  }
  return output;
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The no-argument form supplies an empty Next config while preserving callers' generic config type.
export const withReylo = function withReylo<Config extends NextConfig>(config: Config = {} as Config): Config {
  const { typescript, turbopack, webpack, compiler } = config;
  // A project that turned Next's type check off has turned Reylo's off with it.
  const check = !(typescript?.ignoreBuildErrors ?? false);
  return {
    ...config,
    turbopack: {
      ...turbopack,
      // Each .sql file becomes a module that runs its statement, on the server only: a client
      // Component that imports one fails the build. A rule of the project's own for *.sql wins.
      // oxlint-disable-next-line eslint/sort-keys -- Keep the public Turbopack rule descriptor's existing key order.
      rules: { "*.sql": { condition: { not: "browser" }, loaders: ["@totto2727/reylo/turbopack"], as: "*.js" }, ...turbopack?.rules },
    },
    webpack(webpackConfig: unknown, context: WebpackContext) {
      return withWebpack(webpack, webpackConfig, context);
    },
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the additions' enumeration order in the public Next config.
    ...(check && {
      typescript: { ...typescript, ignoreBuildErrors: true },
      compiler: {
        ...compiler,
        async runAfterProductionCompile(metadata: { projectDir: string; distDir: string }) {
          await compiler?.runAfterProductionCompile?.(metadata);
          await typeCheck(metadata.projectDir, path.resolve(metadata.projectDir, typescript?.tsconfigPath ?? "tsconfig.json"));
        },
      },
    }),
  };
};
