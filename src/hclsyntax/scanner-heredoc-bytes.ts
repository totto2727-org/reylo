/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Heredoc delimiter comparison translated from hclsyntax/scan_tokens.go.
import { matchesWhitespace } from "./whitespace.ts";

const START = 0;
const STEP = 1;
const MAX_ASCII = 0x7F;
const MAX_TWO_BYTE = 0x7_FF;
const MAX_THREE_BYTE = 0xFF_FF;
const TWO_BYTES = 2;
const THREE_BYTES = 3;
const FOUR_BYTES = 4;
const decoder = new TextDecoder(undefined, { ignoreBOM: true });

const utf8Width = (character: string): number => {
  const codePoint = character.codePointAt(START) ?? START;
  if (codePoint <= MAX_ASCII) {return STEP;}
  if (codePoint <= MAX_TWO_BYTE) {return TWO_BYTES;}
  if (codePoint <= MAX_THREE_BYTE) {return THREE_BYTES;}
  return FOUR_BYTES;
};

// Heredoc candidates are already tokenized. Trim their original bytes using decoded widths.
const trimSpace = (data: Uint8Array): Uint8Array => {
  const bounds = { leading: START, seenContent: false, trailing: START };
  Iterator.from(decoder.decode(data)).forEach((character) => {
    if (!matchesWhitespace(character)) {
      bounds.seenContent = true;
      bounds.trailing = START;
      return;
    }
    const width = utf8Width(character);
    if (bounds.seenContent) {bounds.trailing += width;}
    else {bounds.leading += width;}
  });
  return data.subarray(bounds.leading, data.length - bounds.trailing);
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const matchesHeredocMarker = (candidate: Uint8Array, marker: Uint8Array): boolean =>
  sameBytes(trimSpace(candidate), marker);
