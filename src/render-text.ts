import { isEmptyArray } from "./native-predicates.ts";

/** The name generated modules import for unrestricted JSON values. */
export const JSON_TYPE = "Json";

export const orNull = (type: string): string => type === JSON_TYPE ? type : `${type} | null`;
export const ident = (name: string): string => /^[A-Za-z_$][\w$]*$/u.test(name) ? name : JSON.stringify(name);

export const objectFields = (fields: string[]): string =>
  isEmptyArray(fields) ? "Record<never, never>" : `{ ${fields.join("; ")} }`;

const NEXT_COLUMN = 1;

/**
 * Keep the last occurrence of each column, as the driver's result object does.
 * @template Item
 * @param {Readonly<Item[]>} items - The database's columns in result order.
 * @returns {Item[]} The columns retained in their original relative order.
 */
export const lastOfEachName = function lastOfEachName<Item extends { name: string }>(items: Readonly<Item[]>): Item[] {
  return items.filter((item, index) => !items.slice(index + NEXT_COLUMN).some((later) => later.name === item.name));
};

const STEP = 1;
const TOP_LEVEL = 0;
const OPENING = "{([<";
const CLOSING = "})]>";

interface Scan { depth: number; index: number; quoted: boolean }

const visit = (cursor: Scan, part: string): void => {
  if (cursor.quoted) {
    if (part === "\\") {cursor.index += STEP;}
    else if (part === '"') {cursor.quoted = false;}
    return;
  }
  if (part === '"') {cursor.quoted = true;}
  else if (OPENING.includes(part)) {cursor.depth += STEP;}
  else if (CLOSING.includes(part)) {cursor.depth -= STEP;}
};

export const grouped = (text: string): string => {
  const cursor = { depth: TOP_LEVEL, index: TOP_LEVEL, quoted: false };
  while (cursor.index < text.length) {
    const part = text.charAt(cursor.index);
    cursor.index += STEP;
    if (part === "|" && !cursor.quoted && cursor.depth === TOP_LEVEL) {return `(${text})`;}
    visit(cursor, part);
  }
  return text;
};
