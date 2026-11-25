// oxlint-disable-next-line rules/no-node-imports -- The mapper configuration identity uses the host's existing SHA-1 digest.
import { createHash } from "node:crypto";
// oxlint-disable-next-line rules/no-node-imports -- Snapshot the HCL source when TypeScript opens its project.
import { readFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Resolve TypeScript's project path through the native filesystem.
import path from "node:path";
import { isEmptyString, matchesUndefined } from "./native-predicates.ts";
import { hclPath, PROJECT_FILE } from "./project.ts";
import type { ResolvedProject } from "./project.ts";

const SETTINGS_LOCATION_DIAGNOSTIC = 104;

export interface OptionDiagnostic { code: number; messageText: string; path: string[] }

export const projectName = (directory: string, filename: string | undefined): string => {
  if (matchesUndefined(filename) || isEmptyString(filename)) {return PROJECT_FILE;}
  const relative = path.relative(directory, filename).split(path.sep).join("/");
  return isEmptyString(relative) ? filename : relative;
};

const schemaDigest = ({ root, url }: ResolvedProject): string | undefined => {
  try {
    const source = matchesUndefined(url) || isEmptyString(url) ? undefined : hclPath(url, root);
    if (matchesUndefined(source) || isEmptyString(source)) {return undefined;}
    // oxlint-disable-next-line node/no-sync -- The project configuration snapshot includes the exact bytes read when TypeScript opens it.
    return createHash("sha1").update(readFileSync(source)).digest("hex");
  } catch {
    return "unreadable HCL source";
  }
};

export const configDigest = (project: ResolvedProject, options: Record<string, unknown> | undefined): string => {
  const schema = schemaDigest(project);
  // The digest encodes absent settings as null in this JSON array.
  const content = [project.file, project.dialect, project.strictParams, project.url, project.error, options, ...(matchesUndefined(schema) ? [] : [schema])];
  return createHash("sha1").update(JSON.stringify(content)).digest("hex");
};

export const optionDiagnostics = (options: Record<string, unknown> | undefined, filename: string): OptionDiagnostic[] =>
  Object.keys(options ?? {}).map((key) => (
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the mapper option diagnostic wire order.
    { path: [key], messageText: `reylo reads its settings from ${filename}, not from the content mapper's options; move "${key}" there.`, code: SETTINGS_LOCATION_DIAGNOSTIC }
  ));
