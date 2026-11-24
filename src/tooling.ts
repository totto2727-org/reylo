// Reylo's build-time half, which each engine package carries as `@totto2727/reylo-<database>/tooling`
// (scripts/build.ts bundles it): the module a build step writes for a `.sql` file, the content
// Mapper and the CLI, with the analysis, the `.reylo/` cache and the project file behind them.
// Reylo's entry points load it the first time they run (src/engine-package.ts).
import type { Tooling } from "./engine-package.ts";
import { releaseConnections } from "./analyze.ts";
import { runCli } from "./commands.ts";
import { sqlModule } from "./loader.ts";
import { mapperHandlers } from "./mapper-server.ts";

// oxlint-disable-next-line import/no-default-export, eslint/sort-keys -- Preserve the published tooling entry's default export and its key order.
export default { sqlModule, releaseConnections, mapperHandlers, runCli } satisfies Tooling;
