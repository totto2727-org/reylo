/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Translated Ragel executor from HCL 00057cf06d7b38a3f89e6e54d622eee98322b314.
// The three byte scanners share this executor, including EOF transitions and fhold.
// oxlint-disable-next-line import/no-relative-parent-imports -- Use the native sentinel guard without importing Effect.
import { matchesUndefined } from "../native-predicates.ts";

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
const START_INDEX = 0;
const STEP = 1;
const RANGE_PAIR_WIDTH = 2;
const SHIFT_ONE = 1;
const NO_ACTIONS = 0;
const DEAD_STATE = 0;

export class RagelState {
  // oxlint-disable-next-line eslint/id-length -- Ragel actions read and write the original byte cursor property p.
  public p = START_INDEX;
  public ts = START_INDEX;
  public te = START_INDEX;
  public act = START_INDEX;
  public done = false;
  public cs: number;
  public constructor(cs: number) { this.cs = cs; }
}

// oxlint-disable-next-line typescript/no-invalid-void-type -- Generated callbacks either implement goto _again with a boolean or complete naturally without a value.
type RagelAction = (id: number) => boolean | void;
type Phase = "resume" | "again" | "test_eof" | "eof_trans";

interface Scanner {
  actions: (start: number) => void;
  data: Uint8Array;
  state: RagelState;
  tables: RagelTables;
}

interface Position {
  phase: Phase;
  transition: number;
}

interface SearchWindow {
  first: number;
  length: number;
}

const generatedEntry = (values: ArrayLike<number>, index: number): number =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The generated transition tables and active scanner state supply the indexed slots.
  values[index]!;

const performActions = (state: RagelState, tables: RagelTables, action: RagelAction): Scanner["actions"] =>
  (offset) => {
    const count = tables.actions[offset] ?? NO_ACTIONS;
    const cursor = { index: offset };
    const limit = offset + count;
    while (cursor.index < limit) {
      cursor.index += STEP;
      if (Boolean(action(generatedEntry(tables.actions, cursor.index))) || state.done) {return;}
    }
  };

const singleKey = (scanner: Scanner, { first, length }: SearchWindow): number | undefined => {
  const { data, state, tables } = scanner;
  const bounds = { lower: first, upper: first + length - STEP };
  while (bounds.upper >= bounds.lower) {
    // oxlint-disable-next-line eslint/no-bitwise -- Preserve Ragel's signed integer midpoint for each single-byte transition table.
    const middle = bounds.lower + ((bounds.upper - bounds.lower) >> SHIFT_ONE);
    if (generatedEntry(data, state.p) < generatedEntry(tables.trans_keys, middle)) {
      bounds.upper = middle - STEP;
    } else if (generatedEntry(data, state.p) > generatedEntry(tables.trans_keys, middle)) {
      bounds.lower = middle + STEP;
    } else {
      return middle - first;
    }
  }
  return undefined;
};

const rangeKey = (scanner: Scanner, { first, length }: SearchWindow): number | undefined => {
  const { data, state, tables } = scanner;
  // oxlint-disable-next-line eslint/no-bitwise -- Generated range slots are pairs of lower and upper byte bounds.
  const limit = first + (length << SHIFT_ONE) - RANGE_PAIR_WIDTH;
  const bounds = { lower: first, upper: limit };
  while (bounds.upper >= bounds.lower) {
    // oxlint-disable-next-line eslint/no-bitwise -- Ragel rounds the midpoint to the start of a paired lower/upper bound.
    const middle = bounds.lower + (((bounds.upper - bounds.lower) >> SHIFT_ONE) & ~SHIFT_ONE);
    if (generatedEntry(data, state.p) < generatedEntry(tables.trans_keys, middle)) {
      bounds.upper = middle - RANGE_PAIR_WIDTH;
    } else if (generatedEntry(data, state.p) > generatedEntry(tables.trans_keys, middle + STEP)) {
      bounds.lower = middle + RANGE_PAIR_WIDTH;
    } else {
      // oxlint-disable-next-line eslint/no-bitwise -- Convert the paired key position to its generated transition index.
      return (middle - first) >> SHIFT_ONE;
    }
  }
  return undefined;
};

const searchLength = (length: number): number => length > START_INDEX ? length : START_INDEX;

const nextTransition = (scanner: Scanner): number => {
  const { state, tables } = scanner;
  const keyStart = generatedEntry(tables.key_offsets, state.cs);
  const transitionStart = generatedEntry(tables.index_offsets, state.cs);
  const singleLength = searchLength(generatedEntry(tables.single_lengths, state.cs));
  const single = singleKey(scanner, { first: keyStart, length: singleLength });
  if (!matchesUndefined(single)) {return generatedEntry(tables.indicies, transitionStart + single);}
  const rangeLength = searchLength(generatedEntry(tables.range_lengths, state.cs));
  const range = rangeKey(scanner, { first: keyStart + singleLength, length: rangeLength });
  return generatedEntry(tables.indicies, transitionStart + singleLength + (range ?? rangeLength));
};

const runStateActions = (scanner: Scanner, table: ArrayLike<number> | undefined): void => {
  if (table) {scanner.actions(generatedEntry(table, scanner.state.cs));}
};

const resume = (scanner: Scanner, position: Position): boolean => {
  if (scanner.state.cs === DEAD_STATE) {return false;}
  runStateActions(scanner, scanner.tables.from_state_actions);
  position.transition = nextTransition(scanner);
  position.phase = "eof_trans";
  return true;
};

const applyTransition = ({ actions, state, tables }: Scanner, position: Position): boolean => {
  const { transition } = position;
  state.cs = generatedEntry(tables.trans_targs, transition);
  if (tables.trans_actions[transition] !== NO_ACTIONS) {
    actions(generatedEntry(tables.trans_actions, transition));
  }
  position.phase = "again";
  return true;
};

const startingPhase = (state: RagelState, data: Uint8Array): Phase =>
  state.p === data.length ? "test_eof" : "resume";

const again = (scanner: Scanner, position: Position): boolean => {
  const { data, state, tables } = scanner;
  runStateActions(scanner, tables.to_state_actions);
  if (state.done || state.cs === DEAD_STATE) {return false;}
  state.p += STEP;
  position.phase = startingPhase(state, data);
  return true;
};

const eof = (scanner: Scanner, position: Position): boolean => {
  const { data, state, tables } = scanner;
  if (state.p !== data.length) {return false;}
  if (tables.eof_trans && generatedEntry(tables.eof_trans, state.cs) > START_INDEX) {
    position.transition = generatedEntry(tables.eof_trans, state.cs) - STEP;
    position.phase = "eof_trans";
    return true;
  }
  runStateActions(scanner, tables.eof_actions);
  return false;
};

const scanPhase = (scanner: Scanner, position: Position): boolean => {
  switch (position.phase) {
    case "resume": {return resume(scanner, position);}
    case "eof_trans": {return applyTransition(scanner, position);}
    case "again": {return again(scanner, position);}
    case "test_eof": {return eof(scanner, position);}
    default: {return false;}
  }
};

/**
 * Runs the generated Ragel byte transitions and their state actions.
 * Returning true from an action is the generated goto _again operation.
 * @param {Uint8Array} data - The source bytes.
 * @param {RagelTables} tables - One scanner's generated transition tables.
 * @param {RagelState} state - The mutable scanner cursor and action state.
 * @param {RagelAction} action - Runs a numbered action from the generated program.
 */
// oxlint-disable-next-line eslint/max-params -- Keep the generated scanner protocol and its separate input, tables, state, and callback.
export const runRagel = function runRagel(data: Uint8Array, tables: RagelTables, state: RagelState, action: RagelAction): void {
  const scanner = { actions: performActions(state, tables, action), data, state, tables };
  const position = { phase: startingPhase(state, data), transition: START_INDEX };
  while (!state.done && scanPhase(scanner, position)) {
    // A phase either prepares the next transition or exits the scanner.
  }
};
