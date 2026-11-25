import { MissingEngine } from "./engine.ts";
import type { Engine } from "./engine.ts";
import { matchesNull, matchesUndefined } from "./native-predicates.ts";
import { nativeErrorText } from "./native-error-text.ts";
import { readProjectText } from "./project-files.ts";
import type { ProjectFile } from "./project.ts";

const FIRST_FILE_BYTE = 0;
const FIRST_COLUMN = 1;
const FINAL_LINE = -1;

// Line and column of a byte offset in the original UTF-8 configuration.
const place = function (text: string, offset: number): string {
  const before = Buffer.from(text, "utf8").subarray(FIRST_FILE_BYTE, offset).toString("utf8");
  const lines = before.split("\n");
  return `${lines.length}:${(lines.at(FINAL_LINE) ?? "").length + FIRST_COLUMN}`;
};

/**
 * Where the project file sets `types`, which was removed on 2026-10-20: Reylo gives every value
 * its type itself, one representation per SQL type on every driver (src/values.ts), so nothing
 * is left to set. The engine still reads the key, so the loader refuses it first.
 */
const TYPES_KEY = /^types[ \t]*:/mu;

interface ParsedConfig {
  config: ProjectFile;
  error?: string;
}

const parseNativeConfig = (engine: Engine, text: string, label: string): ParsedConfig => {
  const answer = engine.call({ op: "config", text });
  if (answer.status === "config") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native engine validates the YAML configuration and supplies this established shape.
    return { config: answer.config as ProjectFile };
  }
  if (answer.status === "configError") {
    const location = place(text, answer.error.start);
    return { config: {}, error: `${label}:${location}: ${answer.error.message}` };
  }
  return { config: {}, error: `${label}: ${answer.status === "error" ? answer.message : `unexpected ${answer.status}`}` };
};

const parseFile = (engine: Engine | MissingEngine, text: string, label: string): ParsedConfig => {
  const legacy = TYPES_KEY.exec(text);
  if (!matchesNull(legacy)) {
    const offset = Buffer.byteLength(text.slice(FIRST_FILE_BYTE, legacy.index));
    const location = place(text, offset);
    return { config: {}, error: `${label}:${location}: types: the types section was removed on 2026-10-20. Reylo now gives every value one type on every driver, whatever the driver's settings: a 64-bit integer is a BigInt, a decimal its exact text, a timestamptz its ISO 8601 text in UTC, a date and a timestamp their text, JSON parsed and binary data a Uint8Array. Delete the section.` };
  }
  if (engine instanceof MissingEngine) {
    return { config: {}, error: `${label}: ${engine.message}` };
  }
  return parseNativeConfig(engine, text, label);
};

const readFile = (file: string, shown: (filename: string) => string): { text: string } | { error: string } => {
  try {
    return { text: readProjectText(file) };
  } catch (error) {
    return { error: `Cannot read ${shown(file)}: ${nativeErrorText(error, "message")}` };
  }
};

export const readProjectConfig = (engine: Engine | MissingEngine, file: string | undefined, shown: (filename: string) => string): ParsedConfig => {
  if (matchesUndefined(file)) {
    return { config: {} };
  }
  const source = readFile(file, shown);
  return "text" in source ? parseFile(engine, source.text, shown(file)) : { config: {}, error: source.error };
};
