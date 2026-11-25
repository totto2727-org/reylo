// Lay out the plain type from the module renderer for the playground and documentation cards.
import { isEmptyArray, isEmptyString, matchesUndefined } from "./native-predicates.ts";
import { parseType } from "./type-syntax.ts";
import type { Member, TypeNode } from "./type-syntax.ts";

export { parseType } from "./type-syntax.ts";

const ZERO_COLUMNS = 0;
const INDENT_STEP = 2;
const FIELD_SEPARATOR = ": ";
const UNION_SEPARATOR = " | ";
const ARRAY_SUFFIX = "[]";
const MEMBER_SUFFIX = ";";
const OPEN_GROUP = "(";
const CLOSE_GROUP = ")";
const NEXT_MEMBER = 1;

const oneLineDoc = (doc: string): string => doc.replace(/\n\s*\*\/$/u, " */").replaceAll(/(?:\n[ \t]*\*[ \t]*)+/gu, " ").replace(/^\/\*\*\s*/u, "/** ");

const nonemptyDoc = (doc: string | undefined): boolean => !matchesUndefined(doc) && !isEmptyString(doc);

const hasDoc = (node: TypeNode): boolean => {
  if (node.kind === "name") {return false;}
  if (node.kind === "object") {return node.members.some(({ doc, type }) => nonemptyDoc(doc) || hasDoc(type));}
  if (node.kind === "union") {return node.of.some((member) => hasDoc(member));}
  return hasDoc(node.of);
};

const flat = (node: TypeNode): string => {
  if (node.kind === "name") {return node.text;}
  if (node.kind === "object") {
    const fields = node.members.map(({ key, type, doc }) => {
      const comment = matchesUndefined(doc) ? "" : `${oneLineDoc(doc)} `;
      return `${comment}${key}${FIELD_SEPARATOR}${flat(type)}`;
    });
    return isEmptyArray(fields) ? "{}" : `{ ${fields.join("; ")} }`;
  }
  if (node.kind === "union") {return node.of.map((member) => flat(member)).join(UNION_SEPARATOR);}
  const item = flat(node.of);
  return node.of.kind === "union" ? `${OPEN_GROUP}${item}${CLOSE_GROUP}${ARRAY_SUFFIX}` : `${item}${ARRAY_SUFFIX}`;
};

interface Layout { indent: number; lead: number; reserve: number; width: number }

const indentedDoc = (doc: string | undefined, indent: string): string => {
  if (matchesUndefined(doc) || isEmptyString(doc)) {return "";}
  return `${doc.split("\n").map((line) => indent + line).join("\n")}\n`;
};

const remainingUnionColumns = (members: TypeNode[], index: number, reserve: number): number => {
  const following = members.slice(index + NEXT_MEMBER);
  if (isEmptyArray(following)) {return reserve;}
  const tail = flat({ kind: "union", of: following });
  return reserve + UNION_SEPARATOR.length + tail.length;
};

const afterPrint = (text: string, lead: number): number => {
  const lines = text.split("\n");
  const last = lines.at(-NEXT_MEMBER) ?? "";
  return (text.includes("\n") ? last.length : lead + last.length) + UNION_SEPARATOR.length;
};

type Printer = (node: TypeNode, layout: Layout) => string;

const multilineField = ({ doc, key, type }: Member, layout: Layout, print: Printer): string => {
  const { indent, width } = layout;
  const depth = indent + INDENT_STEP;
  const inner = " ".repeat(depth);
  const value = print(type, { indent: depth, lead: depth + key.length + FIELD_SEPARATOR.length, reserve: MEMBER_SUFFIX.length, width });
  return `${indentedDoc(doc, inner)}${inner}${key}${FIELD_SEPARATOR}${value}${MEMBER_SUFFIX}`;
};

const multilineUnion = (members: TypeNode[], layout: Layout, print: Printer): string => {
  const line = { length: layout.lead };
  return members.map((member, index) => {
    const reserve = remainingUnionColumns(members, index, layout.reserve);
    const text = print(member, { ...layout, lead: line.length, reserve });
    line.length = afterPrint(text, line.length);
    return text;
  }).join(UNION_SEPARATOR);
};

const multilineArray = (item: TypeNode, layout: Layout, print: Printer): string => {
  const { lead, reserve } = layout;
  if (item.kind === "union") {
    const inner = print(item, { ...layout, lead: lead + OPEN_GROUP.length, reserve: reserve + CLOSE_GROUP.length + ARRAY_SUFFIX.length });
    return `${OPEN_GROUP}${inner}${CLOSE_GROUP}${ARRAY_SUFFIX}`;
  }
  return `${print(item, { ...layout, reserve: reserve + ARRAY_SUFFIX.length })}${ARRAY_SUFFIX}`;
};

const print = (node: TypeNode, layout: Layout): string => {
  const { indent, lead, reserve, width } = layout;
  const one = flat(node);
  // At finite widths, place a field's documentation on the lines above it.
  if (lead + one.length + reserve <= width && (width === Infinity || !hasDoc(node))) {return one;}
  if (node.kind === "name") {return one;}
  if (node.kind === "object") {return `{\n${node.members.map((item) => multilineField(item, layout, print)).join("\n")}\n${" ".repeat(indent)}}`;}
  return node.kind === "union" ? multilineUnion(node.of, layout, print) : multilineArray(node.of, layout, print);
};

/**
 * Format one generated TypeScript type at the requested display width.
 * @param {string} text - Generated type text to format.
 * @param {number} width - Available UTF-16 columns.
 * @returns {string} The formatted type.
 */
export const formatType = function formatType(text: string, width: number): string {
  return print(parseType(text), { indent: ZERO_COLUMNS, lead: ZERO_COLUMNS, reserve: ZERO_COLUMNS, width });
};

/**
 * Render the return type for the driver's query cardinality.
 * @param {string} row - The generated type of one row.
 * @param {string} cardinality - The query's result cardinality.
 * @returns {string} The return type of the query.
 */
export const resultType = function resultType(row: string, cardinality: string): string {
  if (cardinality === "none" || row === "never") {return "void";}
  const wrapped = /\|/u.test(row.replaceAll(/\{[^{}]*\}/gu, "")) ? `(${row})` : row;
  if (cardinality === "one") {return row;}
  if (cardinality === "maybeOne") {return `${row} | null`;}
  return `${wrapped}[]`;
};
