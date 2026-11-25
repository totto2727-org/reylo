import { isEmptyString, matchesUndefined } from "./native-predicates.ts";

type UrlPart = { text: string } | { command: string };

const FIRST_CHARACTER = 0;
const CHARACTER_STEP = 1;
const FIRST_COMMAND_DEPTH = 1;
const CLOSED_COMMAND_DEPTH = 0;
const NOT_FOUND = -1;
const COMMAND_START = "$(";
const SCHEME_SEPARATOR = "://";

interface CommandCursor {
  depth: number;
  index: number;
  quote: string | undefined;
}

const advanceQuoted = (cursor: CommandCursor, character: string | undefined): void => {
  if (character === cursor.quote) {
    cursor.quote = undefined;
  } else if (character === "\\" && cursor.quote === '"') {
    cursor.index += CHARACTER_STEP;
  }
};

const advanceCommand = (cursor: CommandCursor, character: string | undefined): void => {
  if (!matchesUndefined(cursor.quote)) {
    advanceQuoted(cursor, character);
  } else if (character === "'" || character === '"') {
    cursor.quote = character;
  } else if (character === "\\") {
    cursor.index += CHARACTER_STEP;
  } else if (character === "(") {
    cursor.depth += CHARACTER_STEP;
  } else if (character === ")") {
    cursor.depth -= CHARACTER_STEP;
  }
};

const commandEnd = (written: string, start: number): number | undefined => {
  const cursor: CommandCursor = { depth: FIRST_COMMAND_DEPTH, index: start, quote: undefined };
  while (cursor.index < written.length && cursor.depth > CLOSED_COMMAND_DEPTH) {
    advanceCommand(cursor, written[cursor.index]);
    cursor.index += CHARACTER_STEP;
  }
  return cursor.depth === CLOSED_COMMAND_DEPTH ? cursor.index : undefined;
};

const appendText = (parts: UrlPart[], text: string): void => {
  if (!isEmptyString(text)) {
    parts.push({ text });
  }
};

interface UrlScan {
  index: number;
  parts: UrlPart[];
}

const appendCommand = (written: string, opening: number, scan: UrlScan): boolean => {
  const start = opening + COMMAND_START.length;
  const end = commandEnd(written, start);
  if (matchesUndefined(end)) {return false;}
  appendText(scan.parts, written.slice(scan.index, opening));
  scan.parts.push({ command: written.slice(start, end - CHARACTER_STEP) });
  scan.index = end;
  return true;
};

// A command closes at its balanced parenthesis outside quotes. An unclosed command reports the opening position.
export const urlParts = (written: string): UrlPart[] | { open: number } => {
  const scan: UrlScan = { index: FIRST_CHARACTER, parts: [] };
  while (scan.index < written.length) {
    const opening = written.indexOf(COMMAND_START, scan.index);
    if (opening === NOT_FOUND) {break;}
    if (!appendCommand(written, opening, scan)) {return { open: opening };}
  }
  appendText(scan.parts, written.slice(scan.index));
  return scan.parts;
};

const markCommands = (parts: UrlPart[]): { placed: Map<number, UrlPart>; skeleton: string } => {
  const result = { placed: new Map<number, UrlPart>(), skeleton: "" };
  Iterator.from(parts).forEach((part) => {
    if ("text" in part) {
      result.skeleton += part.text;
    } else {
      result.placed.set(result.skeleton.length, part);
      result.skeleton += "\0";
    }
  });
  return result;
};

// Encode command output only in the user and password portion. Commands elsewhere retain their printed text.
export const inUserinfo = (parts: UrlPart[]): Set<UrlPart> => {
  const { placed, skeleton } = markCommands(parts);
  const scheme = skeleton.indexOf(SCHEME_SEPARATOR);
  if (scheme === NOT_FOUND) {return new Set();}
  const start = scheme + SCHEME_SEPARATOR.length;
  const ends = ["/", "?", "#"].map((delimiter) => skeleton.indexOf(delimiter, start)).filter((end) => end !== NOT_FOUND);
  const authorityEnd = Math.min(skeleton.length, ...ends);
  const userinfoEnd = skeleton.lastIndexOf("@", authorityEnd - CHARACTER_STEP);
  return new Set(Iterator.from(placed).filter(([at]) => at >= start && at < userinfoEnd).map(([, part]) => part));
};
