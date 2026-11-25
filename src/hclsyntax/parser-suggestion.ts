/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Template keyword suggestion translated from hclsyntax/parser.go.
const START_INDEX = 0;
const SINGLE_EDIT = 1;
const MAXIMUM_SUGGESTION_DISTANCE = 2;

const distanceRow = (previous: number[], candidate: string[], [rowIndex, character]: [number, string]): number[] => {
  const next = [rowIndex + SINGLE_EDIT];
  Iterator.from(candidate.entries()).forEach(([index, entry]) => {
    const substitution = character === entry ? START_INDEX : SINGLE_EDIT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Each previous row contains one distance per code point plus the empty prefix.
    next.push(Math.min(next[index]! + SINGLE_EDIT, previous[index + SINGLE_EDIT]! + SINGLE_EDIT, previous[index]! + substitution));
  });
  return next;
};

const editDistance = (given: string[], candidate: string[]): number => {
  const state = { row: [START_INDEX, ...candidate.map((_character, index) => index + SINGLE_EDIT)] };
  Iterator.from(given.entries()).forEach((entry) => {
    state.row = distanceRow(state.row, candidate, entry);
  });
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The final distance row includes the full candidate at this position.
  return state.row[candidate.length]!;
};

/**
 * Selects the first nearby HCL keyword in the caller's order.
 * @param {string} given - The keyword in the source.
 * @param {string[]} suggestions - Candidate keywords in grammar order.
 * @returns {string} The first close keyword or an empty string.
 */
export const nameSuggestion = (given: string, suggestions: string[]): string => {
  // Upstream computes distance by Unicode code point, using Go runes.
  const characters = Iterator.from(given).toArray();
  return suggestions.find((candidate) => editDistance(characters, Iterator.from(candidate).toArray()) <= MAXIMUM_SUGGESTION_DISTANCE) ?? "";
};
