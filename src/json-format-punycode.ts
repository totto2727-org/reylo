import { matchesUndefined } from "./native-predicates.ts";

// Bootstring constants from RFC 3492 sections 5 and 6.
const PUNYCODE_BASE = 36;
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 26;
const BIAS_SKEW = 38;
const INITIAL_DAMPING = 700;
const INITIAL_BIAS = 72;
const FIRST_NON_ASCII = 0x80;
const MAX_CODE_POINT = 0x10_FF_FF;
const PUNYCODE_LETTERS = 26;
const LEAST_SIGNIFICANT_BIT = 1;
const HALF = 2;
const BASE_MINUS_MIN_THRESHOLD = PUNYCODE_BASE - MIN_THRESHOLD;
const MAX_BIAS_DELTA = Math.floor((BASE_MINUS_MIN_THRESHOLD * MAX_THRESHOLD) / HALF);
const BIAS_NUMERATOR_FACTOR = BASE_MINUS_MIN_THRESHOLD + MIN_THRESHOLD;
const INVALID_DIGIT = -1;
const PUNYCODE_DELIMITER = "-";
const START = 0;
const NEXT = 1;
const DIGIT_START = 0x30;
const LOWERCASE_START = 0x61;

const adaptBias = (delta: number, points: number, first: boolean): number => {
  // oxlint-disable-next-line eslint/no-bitwise -- Preserve the decoder's signed 32-bit reduction of subsequent Bootstring deltas.
  const damped = first ? Math.floor(delta / INITIAL_DAMPING) : delta >> LEAST_SIGNIFICANT_BIT;
  const state = { position: START, remaining: damped + Math.floor(damped / points) };
  while (state.remaining > MAX_BIAS_DELTA) {
    state.remaining = Math.floor(state.remaining / BASE_MINUS_MIN_THRESHOLD);
    state.position += PUNYCODE_BASE;
  }
  return state.position + Math.floor((BIAS_NUMERATOR_FACTOR * state.remaining) / (state.remaining + BIAS_SKEW));
};

const punycodeDigit = (character: string): number => {
  const value = character.codePointAt(START);
  if (matchesUndefined(value)) {return INVALID_DIGIT;}
  if (/[a-z]/u.test(character)) {return value - LOWERCASE_START;}
  if (/[0-9]/u.test(character)) {return value - DIGIT_START + PUNYCODE_LETTERS;}
  return INVALID_DIGIT;
};

interface PunycodeState { bias: number; codePoint: number; index: number; position: number }
interface Steps { basePosition: number; weight: number }

const accumulate = (state: PunycodeState, digit: number, steps: Steps): "done" | "invalid" | "more" => {
  state.index += digit * steps.weight;
  const threshold = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, steps.basePosition - state.bias));
  if (digit < threshold) {return "done";}
  steps.weight *= PUNYCODE_BASE - threshold;
  steps.basePosition += PUNYCODE_BASE;
  return Number.isSafeInteger(state.index) && Number.isSafeInteger(steps.weight) ? "more" : "invalid";
};

const readPunycodeIndex = (input: string, state: PunycodeState): boolean => {
  const steps = { basePosition: PUNYCODE_BASE, weight: NEXT };
  while (state.position < input.length) {
    const digit = punycodeDigit(input.charAt(state.position));
    state.position += NEXT;
    if (digit === INVALID_DIGIT) {return false;}
    const stage = accumulate(state, digit, steps);
    if (stage !== "more") {return stage === "done";}
  }
  return false;
};

const nextCodePoint = (input: string, state: PunycodeState, insertionSlots: number): boolean => {
  const previousIndex = state.index;
  if (!readPunycodeIndex(input, state)) {return false;}
  state.bias = adaptBias(state.index - previousIndex, insertionSlots, previousIndex === START);
  state.codePoint += Math.floor(state.index / insertionSlots);
  state.index %= insertionSlots;
  return !(state.codePoint > MAX_CODE_POINT);
};

const decodeTail = (input: string, output: number[], state: PunycodeState): string | undefined => {
  while (state.position < input.length) {
    if (!nextCodePoint(input, state, output.length + NEXT)) {return undefined;}
    output.splice(state.index, START, state.codePoint);
    state.index += NEXT;
  }
  return String.fromCodePoint(...output);
};

/**
 * Decode a hostname label's Bootstring payload, including any ASCII prefix.
 * @param {string} input - The text after the A-label's prefix.
 * @returns {string | undefined} The Unicode label if decoding succeeded.
 */
export const punycode = (input: string): string | undefined => {
  const delimiter = input.lastIndexOf(PUNYCODE_DELIMITER);
  const basic = delimiter > START;
  const output = basic ? Array.from(input.slice(START, delimiter), (character) => character.codePointAt(START) ?? FIRST_NON_ASCII) : [];
  if (output.some((codePoint) => codePoint >= FIRST_NON_ASCII)) {return undefined;}
  const state = { bias: INITIAL_BIAS, codePoint: FIRST_NON_ASCII, index: START, position: basic ? delimiter + PUNYCODE_DELIMITER.length : START };
  if (state.position >= input.length && !basic) {return undefined;}
  return decodeTail(input, output, state);
};
