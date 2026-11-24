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
  public p = 0;
  public ts = 0;
  public te = 0;
  public act = 0;
  public done = false;
  public cs: number;
  public constructor(cs: number) { this.cs = cs; }
}
const NO_ACTIONS = 0;
const FIRST_ACTION_OFFSET = 1;
const DEAD_STATE = 0;

const generatedEntry = (values: ArrayLike<number>, index: number): number =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The generated transition tables and active scanner state supply the indexed slots.
  values[index]!
;

// Return true from an action to implement the generated `goto _again`.
export function runRagel(data: Uint8Array, tables: RagelTables, state: RagelState, action: (id: number) => boolean | void): void {
  const actions = (offset: number): boolean => {
    const count = tables.actions[offset] ?? NO_ACTIONS;
    let actionIndex = offset;
    const lastAction = offset + count;
    while (actionIndex < lastAction) {
      actionIndex += FIRST_ACTION_OFFSET;
      if (action(generatedEntry(tables.actions, actionIndex)) || state.done) {return true;}
    }
    return false;
  };
  let phase: 'resume' | 'again' | 'test_eof' | 'eof_trans' = state.p === data.length ? 'test_eof' : 'resume';
  let trans = 0;
  while (!state.done) {
    switch (phase) {
      case 'resume': {
        if (state.cs === DEAD_STATE) {return;}
        if (tables.from_state_actions) {actions(generatedEntry(tables.from_state_actions, state.cs));}
        let keys = generatedEntry(tables.key_offsets, state.cs);
        trans = generatedEntry(tables.index_offsets, state.cs);
        let klen = generatedEntry(tables.single_lengths, state.cs);
        let matched = false;
        if (klen > 0) {
          let lower = keys;
          let upper = keys + klen - 1;
          while (upper >= lower) {
            const mid = lower + ((upper - lower) >> 1);
            if (generatedEntry(data, state.p) < generatedEntry(tables.trans_keys, mid)) {upper = mid - 1;}
            else if (generatedEntry(data, state.p) > generatedEntry(tables.trans_keys, mid)) {lower = mid + 1;}
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
          klen = generatedEntry(tables.range_lengths, state.cs);
          if (klen > 0) {
            let lower = keys;
            let upper = keys + (klen << 1) - 2;
            while (upper >= lower) {
              const mid = lower + (((upper - lower) >> 1) & ~1);
              if (generatedEntry(data, state.p) < generatedEntry(tables.trans_keys, mid)) {upper = mid - 2;}
              else if (generatedEntry(data, state.p) > generatedEntry(tables.trans_keys, mid + 1)) {lower = mid + 2;}
              else {
                trans += (mid - keys) >> 1;
                matched = true;
                break;
              }
            }
            if (!matched) {trans += klen;}
          }
        }
        trans = generatedEntry(tables.indicies, trans);
        phase = 'eof_trans';
        continue;
      }
      case 'eof_trans': {
        state.cs = generatedEntry(tables.trans_targs, trans);
        if (tables.trans_actions[trans] !== NO_ACTIONS) {actions(generatedEntry(tables.trans_actions, trans));}
        phase = 'again';
        continue;
      }
      case 'again': {
        if (tables.to_state_actions) {actions(generatedEntry(tables.to_state_actions, state.cs));}
        if (state.done || state.cs === DEAD_STATE) {return;}
        state.p += 1;
        phase = state.p === data.length ? 'test_eof' : 'resume';
        continue;
      }
      case 'test_eof': {
        if (state.p === data.length) {
          if (tables.eof_trans && generatedEntry(tables.eof_trans, state.cs) > 0) {
            trans = generatedEntry(tables.eof_trans, state.cs) - 1;
            phase = 'eof_trans';
            continue;
          }
          if (tables.eof_actions) {actions(generatedEntry(tables.eof_actions, state.cs));}
        }
        return;
      }
    }
  }
}
