/*! @license MIT
 * Copyright (c) 2017 Martin Atkins
 * UTF-8 byte-width behavior adapted from go-textseg/v15 v15.0.0.
 * See licenses/go-textseg-LICENSE.txt.
 */
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

// Go source positions advance one byte for malformed UTF-8, unlike TextDecoder's
// replacement of an incomplete multi-byte sequence as a whole. Keep this byte
// mapping at the boundary; Unicode grapheme rules belong to Intl, not this port.
function utf8SequenceLength(data: Uint8Array): number {
  const a = data[0]!;
  if (a < 0x80) return 1;
  const cont = (n: number | undefined) => n !== undefined && n >= 0x80 && n <= 0xbf;
  if (a >= 0xc2 && a <= 0xdf && cont(data[1])) return 2;
  if (a >= 0xe0 && a <= 0xef && cont(data[1]) && cont(data[2]) && (a !== 0xe0 || data[1]! >= 0xa0) && (a !== 0xed || data[1]! < 0xa0)) return 3;
  if (a >= 0xf0 && a <= 0xf4 && cont(data[1]) && cont(data[2]) && cont(data[3]) && (a !== 0xf0 || data[1]! >= 0x90) && (a !== 0xf4 || data[1]! < 0x90)) return 4;
  return 1;
}

/** Segment once per token and return original UTF-8 slices, not UTF-16 offsets. */
export function graphemeClusters(data: Uint8Array): Uint8Array[] {
  const characters: string[] = [];
  const byteOffsets: number[] = [0];
  let characterOffset = 0;
  for (let offset = 0; offset < data.length;) {
    const length = utf8SequenceLength(data.subarray(offset));
    const character = decoder.decode(data.subarray(offset, offset + length));
    characters.push(character);
    offset += length;
    characterOffset += character.length;
    byteOffsets[characterOffset] = offset;
  }
  const result: Uint8Array[] = [];
  for (const { index, segment } of segmenter.segment(characters.join(''))) {
    result.push(data.subarray(byteOffsets[index]!, byteOffsets[index + segment.length]!));
  }
  return result;
}
