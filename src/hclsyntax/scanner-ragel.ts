/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Translated Ragel executor from HCL 00057cf06d7b38a3f89e6e54d622eee98322b314.
// The three byte scanners share this executor, including EOF transitions and fhold.
export interface RagelTables {
  actions: ArrayLike<number>;
  key_offsets: ArrayLike<number>;
  trans_keys: ArrayLike<number>;
  single_lengths: ArrayLike<number>;
  range_lengths: ArrayLike<number>;
  index_offsets: ArrayLike<number>;
  indicies: ArrayLike<number>;
  trans_targs: ArrayLike<number>;
  trans_actions: ArrayLike<number>;
  from_state_actions?: ArrayLike<number>;
  to_state_actions?: ArrayLike<number>;
  eof_trans?: ArrayLike<number>;
  eof_actions?: ArrayLike<number>;
}
export class RagelState {
  p = 0;
  ts = 0;
  te = 0;
  act = 0;
  done = false;
  cs: number;
  constructor(cs: number) { this.cs = cs; }
}
// Return true from an action to implement the generated `goto _again`.
export function runRagel(data: Uint8Array, t: RagelTables, s: RagelState, action: (id: number) => boolean | void): void {
  const actions = (offset: number): boolean => {
    const count = t.actions[offset++] ?? 0;
    for (let n = 0; n < count; n++) {
      if (action(t.actions[offset++]!) || s.done) return true;
    }
    return false;
  };
  let phase: 'resume' | 'again' | 'test_eof' | 'eof_trans' = s.p === data.length ? 'test_eof' : 'resume';
  let trans = 0;
  executor: while (!s.done) {
    switch (phase) {
      case 'resume': {
        if (s.cs === 0) break executor;
        if (t.from_state_actions) actions(t.from_state_actions[s.cs]!);
        let keys = t.key_offsets[s.cs]!;
        trans = t.index_offsets[s.cs]!;
        let klen = t.single_lengths[s.cs]!;
        let matched = false;
        if (klen > 0) {
          let lower = keys;
          let upper = keys + klen - 1;
          while (upper >= lower) {
            const mid = lower + ((upper - lower) >> 1);
            if (data[s.p]! < t.trans_keys[mid]!) upper = mid - 1;
            else if (data[s.p]! > t.trans_keys[mid]!) lower = mid + 1;
            else {
              trans += mid - keys;
              matched = true;
              break;
            }
          }
          if (!matched) {
            keys += klen;
            trans += klen;
          }
        }
        if (!matched) {
          klen = t.range_lengths[s.cs]!;
          if (klen > 0) {
            let lower = keys;
            let upper = keys + (klen << 1) - 2;
            while (upper >= lower) {
              const mid = lower + (((upper - lower) >> 1) & ~1);
              if (data[s.p]! < t.trans_keys[mid]!) upper = mid - 2;
              else if (data[s.p]! > t.trans_keys[mid + 1]!) lower = mid + 2;
              else {
                trans += (mid - keys) >> 1;
                matched = true;
                break;
              }
            }
            if (!matched) trans += klen;
          }
        }
        trans = t.indicies[trans]!;
        phase = 'eof_trans';
        continue;
      }
      case 'eof_trans':
        s.cs = t.trans_targs[trans]!;
        if (t.trans_actions[trans] !== 0) actions(t.trans_actions[trans]!);
        phase = 'again';
        continue;
      case 'again':
        if (t.to_state_actions) actions(t.to_state_actions[s.cs]!);
        if (s.done || s.cs === 0) break executor;
        s.p++;
        phase = s.p !== data.length ? 'resume' : 'test_eof';
        continue;
      case 'test_eof':
        if (s.p === data.length) {
          if (t.eof_trans && t.eof_trans[s.cs]! > 0) {
            trans = t.eof_trans[s.cs]! - 1;
            phase = 'eof_trans';
            continue;
          }
          if (t.eof_actions) actions(t.eof_actions[s.cs]!);
        }
        break executor;
    }
  }
}
