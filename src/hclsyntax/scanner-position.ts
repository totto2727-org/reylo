/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Token source coordinates translated from hclsyntax/token.go.
import { graphemeClusters } from "./scanner-grapheme.ts";
import type { Pos, Token } from "./types.ts";

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const LINE_FEED_LENGTH = 1;
const CRLF_LENGTH = 2;
const FIRST_BYTE = 0;
const SECOND_BYTE = 1;
const FIRST_COLUMN = 1;
const STEP = 1;

interface Coordinates {
  filename: string;
  start: Pos;
  startByte: number;
}

interface TokenCollection {
  emit: (type: string, from: number, to: number) => void;
  tokens: Token[];
}

const isNewline = (cluster: Uint8Array): boolean =>
  (cluster.length === LINE_FEED_LENGTH && cluster[FIRST_BYTE] === LINE_FEED) ||
  (cluster.length === CRLF_LENGTH && cluster[FIRST_BYTE] === CARRIAGE_RETURN && cluster[SECOND_BYTE] === LINE_FEED);

const endPosition = (begin: Pos, bytes: Uint8Array, absoluteEnd: number): Pos => {
  const end = { ...begin, byte: absoluteEnd };
  Iterator.from(graphemeClusters(bytes)).forEach((cluster) => {
    if (isNewline(cluster)) {
      end.line += STEP;
      end.column = FIRST_COLUMN;
    } else {
      end.column += STEP;
    }
  });
  return end;
};

/**
 * Accumulates byte slices and their grapheme coordinates in scanner order.
 * @param {Uint8Array} data - The source bytes after any BOM.
 * @param {Coordinates} coordinates - The original filename, position, and absolute byte offset.
 * @returns {TokenCollection} The token emitter and accumulated tokens.
 */
export const tokenCollector = (data: Uint8Array, { filename, start, startByte }: Coordinates): TokenCollection => {
  const cursor = { previous: { ...start, byte: startByte } };
  const tokens: Token[] = [];
  const emit = (type: string, from: number, to: number): void => {
    // Whitespace skipped between tokens is ASCII. Its byte count is also its column count.
    const { previous } = cursor;
    // oxlint-disable-next-line eslint/sort-keys -- Replace the column and byte on the copied source position.
    const begin = { ...previous, column: previous.column + from + startByte - previous.byte, byte: from + startByte };
    const bytes = data.subarray(from, to);
    const end = endPosition(begin, bytes, to + startByte);
    cursor.previous = end;
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the public token and source range field order.
    tokens.push({ type, bytes, range: { filename, start: begin, end } });
  };
  return { emit, tokens };
};
