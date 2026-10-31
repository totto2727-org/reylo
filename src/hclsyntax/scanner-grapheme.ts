/*! @license MIT
 * Copyright (c) 2017 Martin Atkins
 * Translated from go-textseg/v15 v15.0.0. See licenses/go-textseg-LICENSE.txt.
 */
// Port of go-textseg/v15 v15.0.0, textseg/grapheme_clusters.go.
// Unicode 15 is the HCL reference behavior on Go versions below 1.27.
import * as tables from './grapheme-tables.ts';
import { RagelState, runRagel } from './scanner-ragel.ts';

// utf8.DecodeRune's byte count, including its one-byte advance on malformed UTF-8.
export function utf8SequenceLength(data: Uint8Array): number {
  if (data.length === 0) return 0;
  const a = data[0]!;
  if (a < 0x80) return 1;
  const cont = (n: number | undefined) => n !== undefined && n >= 0x80 && n <= 0xbf;
  if (a >= 0xc2 && a <= 0xdf && cont(data[1])) return 2;
  if (a >= 0xe0 && a <= 0xef && cont(data[1]) && cont(data[2]) && (a !== 0xe0 || data[1]! >= 0xa0) && (a !== 0xed || data[1]! < 0xa0)) return 3;
  if (a >= 0xf0 && a <= 0xf4 && cont(data[1]) && cont(data[2]) && cont(data[3]) && (a !== 0xf0 || data[1]! >= 0x90) && (a !== 0xf4 || data[1]! < 0x90)) return 4;
  return 1;
}

// The caller always supplies a complete buffer, corresponding to atEOF=true.
export function scanGraphemeCluster(data: Uint8Array): number {
  if (data.length === 0) return 0;
  const s = new RagelState(tables.start);
  let endPos = 0;
  let advance = 0;
  runRagel(data, tables, s, id => {
    switch (id) {
      case 0: break; // startPos=p, unused when only the advance is needed
      case 1: endPos = s.p; break;
      case 2: s.ts = 0; break;
      case 3: s.act = 0; break;
      case 4: s.ts = s.p; break;
      case 5: s.te = s.p + 1; break;
      case 6: s.act = 3; break;
      case 7: s.act = 4; break;
      case 8: s.act = 8; break;
      case 9: case 10:
        s.te = s.p + 1;
        advance = endPos + 1;
        s.done = true;
        break;
      case 11: case 12: case 13: case 14: case 15: case 16:
        s.te = s.p;
        s.p--;
        advance = endPos + 1;
        s.done = true;
        break;
      case 17: case 18: case 19: case 20: case 21: case 22:
        s.p = s.te - 1;
        advance = endPos + 1;
        s.done = true;
        break;
      case 23:
        if (s.act === 0) {
          s.cs = 0;
          return true;
        }
        if (s.act === 3 || s.act === 4 || s.act === 8) {
          s.p = s.te - 1;
          advance = endPos + 1;
          s.done = true;
        }
        break;
      default: throw new Error(`Unknown grapheme scanner action ${id}`);
    }
  });
  return advance || utf8SequenceLength(data);
}
