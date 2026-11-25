// oxlint-disable-next-line rules/no-node-imports -- Write exact project and environment files for the native resolver.
import { mkdir, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Write each fixture at the path used by the host.
import path from "node:path";
import { forEachFixtureInOrder } from "./helpers.ts";
import { nativeTestDirectory } from "./native-engine-fixture.ts";

// A project tree: `files` maps a path under a fresh directory to its text.
export const tree = async (files: Record<string, string>): Promise<string> => {
  const root = await nativeTestDirectory("reylo-project-");
  await forEachFixtureInOrder(Object.entries(files), async ([filename, text]) => {
    const destination = path.join(root, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, text);
  });
  return root;
};
