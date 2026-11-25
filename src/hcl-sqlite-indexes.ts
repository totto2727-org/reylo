import { attribute, boolean, columnList, fail, identifier, label, localColumn, requireNoLabels, shape, string } from "./hcl-sqlite-fields.ts";
import type { Block } from "./hclsyntax/types.ts";
import { isEmptyArray, isEmptyString } from "./native-predicates.ts";

export const IMPLICIT_INDEX_PREFIX = "sqlite_autoindex_";

interface Indexes {
  constraints: string[];
  statements: string[];
}

const termValue = (term: Block, columns: ReadonlySet<string>): string => {
  const { body } = term;
  const { column, expr } = body.attributes;
  if (column && !expr) {return identifier(localColumn(column.expression, columns));}
  if (expr && !column) {return `(${string(expr.expression)})`;}
  return fail(term, "An index term requires exactly one column or expr.");
};

const indexTerm = (term: Block, columns: ReadonlySet<string>, seen: Set<string>): string => {
  requireNoLabels(term);
  shape(term.body, ["column", "expr", "desc"], []);
  const value = termValue(term, columns);
  if (seen.has(value)) {fail(term, "Duplicate index term.");}
  seen.add(value);
  const { desc } = term.body.attributes;
  return value + (desc && boolean(desc.expression) ? " DESC" : "");
};

const indexTerms = (block: Block, on: Block[], columns: ReadonlySet<string>): string[] => {
  const { body } = block;
  if (body.attributes.columns) {
    if (!isEmptyArray(on)) {fail(block, "An index must use either columns or on blocks, not both.");}
    return columnList(attribute(body, "columns"), columns).map((name) => identifier(name));
  }
  if (isEmptyArray(on)) {fail(block, "An index requires columns or on blocks.");}
  const seen = new Set<string>();
  return on.map((term) => indexTerm(term, columns, seen));
};

const indexParts = (block: Block, columns: ReadonlySet<string>): {
  on: Block[]; terms: string; unique: boolean; where: string;
} => {
  const { body } = block;
  shape(body, ["columns", "unique", "where"], ["on"]);
  const unique = body.attributes.unique ? boolean(attribute(body, "unique")) : false;
  const on = body.blocks.filter((child) => child.type === "on");
  const terms = indexTerms(block, on, columns).join(", ");
  const where = body.attributes.where ? ` WHERE ${string(attribute(body, "where"))}` : "";
  return { on, terms, unique, where };
};

const appendIndex = (
  indexes: Indexes, table: { columns: ReadonlySet<string>; name: string }, { block, name }: { block: Block; name: string },
): void => {
  const { on, terms, unique, where } = indexParts(block, table.columns);
  if (name.startsWith(IMPLICIT_INDEX_PREFIX)) {
    // SQLite reserves Atlas inspection's implicit index names for UNIQUE constraints.
    if (!unique || !isEmptyArray(on) || !isEmptyString(where)) {
      fail(block, "An implicit SQLite autoindex must describe a plain UNIQUE column constraint.");
    }
    indexes.constraints.push(`UNIQUE (${terms})`);
    return;
  }
  indexes.statements.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${identifier(name)} ON ${identifier(table.name)} (${terms})${where}`);
};

export const indexesFor = (table: { block: Block; columns: ReadonlySet<string>; name: string }): Indexes => {
  const indexes: Indexes = { constraints: [], statements: [] };
  const names = new Set<string>();
  table.block.body.blocks.filter((block) => block.type === "index").forEach((block) => {
    const name = label(block);
    if (names.has(name)) {fail(block, `Duplicate index ${name}.`);}
    names.add(name);
    appendIndex(indexes, table, { block, name });
  });
  return indexes;
};
