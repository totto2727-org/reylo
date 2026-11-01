import { join } from "node:path";
import type { NextConfig } from "next";
import { withReylo } from "@totto2727/reylo/next";

const nextConfig: NextConfig = {
  agentRules: false,
  turbopack: {
    // The lab's node_modules/@totto2727/reylo is a symlink to the repository root, outside this directory;
    // Turbopack resolves nothing outside its root, so the root is the repository here. An app that
    // installs reylo from the registry keeps the default root.
    root: join(import.meta.dirname, "../.."),
  },
};

// withReylo sends *.sql through @totto2727/reylo/turbopack and @totto2727/reylo/webpack on the server only, and runs
// `tsc --noEmit --runExternalCode` inside next build in place of Next's own check, which cannot run
// the content mapper.
export default withReylo(nextConfig);
