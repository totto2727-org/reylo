import { join } from "node:path";
import type { NextConfig } from "next";
import { withReylo } from "@totto2727/reylo/next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // Only because Reylo is linked from this repository's dist/, outside this directory, and
    // Turbopack resolves nothing outside its root. An app that installs reylo drops this line.
    root: join(import.meta.dirname, "../.."),
  },
};

// Reylo: each .sql file becomes a module that runs its statement, on the server only, under
// Turbopack and webpack; and next build's type check runs the content mapper.
export default withReylo(nextConfig);
