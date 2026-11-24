/*! @license MIT
 * Copyright (c) 2017 Martin Atkins
 * UTF-8 byte-width behavior adapted from go-textseg/v15 v15.0.0.
 * See licenses/go-textseg-LICENSE.txt.
 */
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

const FIRST_CONTINUATION = 0x80;
const LAST_CONTINUATION = 0xBF;
const FIRST_TWO_BYTE_LEAD = 0xC2;
const LAST_TWO_BYTE_LEAD = 0xDF;
const FIRST_THREE_BYTE_LEAD = 0xE0;
const LAST_THREE_BYTE_LEAD = 0xEF;
const SURROGATE_LEAD = 0xED;
const FIRST_FOUR_BYTE_LEAD = 0xF0;
const LAST_FOUR_BYTE_LEAD = 0xF4;
const THREE_BYTE_BOUNDARY = 0xA0;
const FOUR_BYTE_BOUNDARY = 0x90;
const MISSING_BYTE = -1;
const SINGLE_BYTE = 1;
const TWO_BYTES = 2;
const THREE_BYTES = 3;
const FOUR_BYTES = 4;
const START_OFFSET = 0;

const isContinuation = (byte: number): boolean =>
  byte >= FIRST_CONTINUATION && byte <= LAST_CONTINUATION;

const acceptsThreeByteLead = (lead: number, second: number): boolean =>
  lead >= FIRST_THREE_BYTE_LEAD && lead <= LAST_THREE_BYTE_LEAD &&
  (lead !== FIRST_THREE_BYTE_LEAD || second >= THREE_BYTE_BOUNDARY) &&
  (lead !== SURROGATE_LEAD || second < THREE_BYTE_BOUNDARY);

const acceptsFourByteLead = (lead: number, second: number): boolean =>
  lead >= FIRST_FOUR_BYTE_LEAD && lead <= LAST_FOUR_BYTE_LEAD &&
  (lead !== FIRST_FOUR_BYTE_LEAD || second >= FOUR_BYTE_BOUNDARY) &&
  (lead !== LAST_FOUR_BYTE_LEAD || second < FOUR_BYTE_BOUNDARY);

const longerSequenceLength = (data: Uint8Array, lead: number, second: number): number => {
  if (!isContinuation(data[2] ?? MISSING_BYTE)) {return SINGLE_BYTE;}
  if (acceptsThreeByteLead(lead, second)) {return THREE_BYTES;}
  if (acceptsFourByteLead(lead, second) && isContinuation(data[3] ?? MISSING_BYTE)) {return FOUR_BYTES;}
  return SINGLE_BYTE;
};

// Go source positions advance one byte for malformed UTF-8, unlike TextDecoder's
// Replacement of an incomplete multi-byte sequence as a whole. Keep this byte
// Mapping at the boundary; Unicode grapheme rules belong to Intl, not this port.
const utf8SequenceLength = (data: Uint8Array): number => {
  const lead = data[0] ?? MISSING_BYTE;
  const second = data[1] ?? MISSING_BYTE;
  if (lead < FIRST_CONTINUATION || !isContinuation(second)) {return SINGLE_BYTE;}
  if (lead >= FIRST_TWO_BYTE_LEAD && lead <= LAST_TWO_BYTE_LEAD) {return TWO_BYTES;}
  return longerSequenceLength(data, lead, second);
};

const decodeByteOffsets = (data: Uint8Array): { byteOffsets: number[]; characters: string[] } => {
  const decoded: { byteOffsets: number[]; characters: string[] } = {
    byteOffsets: [START_OFFSET],
    characters: [],
  };
  const position = { byte: START_OFFSET, character: START_OFFSET };
  while (position.byte < data.length) {
    const end = position.byte + utf8SequenceLength(data.subarray(position.byte));
    const character = decoder.decode(data.subarray(position.byte, end));
    decoded.characters.push(character);
    position.byte = end;
    position.character += character.length;
    decoded.byteOffsets[position.character] = end;
  }
  return decoded;
};

/**
 * @param {Uint8Array} data - The UTF-8 buffer to segment.
 * @returns {Uint8Array[]} The original UTF-8 slices for the grapheme clusters.
 */
export const graphemeClusters = (data: Uint8Array): Uint8Array[] => {
  const { byteOffsets, characters } = decodeByteOffsets(data);
  return Array.from(segmenter.segment(characters.join('')), ({ index, segment }) =>
    data.subarray(byteOffsets[index], byteOffsets[index + segment.length]),
  );
};
