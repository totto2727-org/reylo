import { LABEL, MAX_LABEL_LENGTH } from "./json-format-network.ts";
import { punycode } from "./json-format-punycode.ts";
import { isEmptyString, matchesUndefined } from "./native-predicates.ts";

const TEXT_START = 0;
const MAX_HOSTNAME_LENGTH = 253;
const ASCII_LABEL_MARKER = "xn";
const LABEL_DELIMITER = "--";
const LABEL_PAYLOAD_START = ASCII_LABEL_MARKER.length + LABEL_DELIMITER.length;

// oxlint-disable-next-line eslint/no-magic-numbers -- Keep the Unicode virama table as ordered code-point data for IDNA context checks.
const VIRAMA = new Set([0x09_4D, 0x09_CD, 0x0A_4D, 0x0A_CD, 0x0B_4D, 0x0B_CD, 0x0C_4D, 0x0C_CD, 0x0D_3B, 0x0D_3C, 0x0D_4D, 0x0D_CA, 0x0E_3A, 0x0E_BA, 0x0F_84, 0x10_39, 0x10_3A, 0x17_14, 0x17_15, 0x17_34, 0x17_D2, 0x1A_60, 0x1B_44, 0x1B_AA, 0x1B_AB, 0x1B_F2, 0x1B_F3, 0x2D_7F, 0xA8_06, 0xA8_2C, 0xA8_C4, 0xA9_53, 0xA9_C0, 0xAA_F6, 0xAB_ED, 0x1_0A_3F, 0x1_10_46, 0x1_10_70, 0x1_10_7F, 0x1_10_B9, 0x1_11_33, 0x1_11_34, 0x1_11_C0, 0x1_12_35, 0x1_12_EA, 0x1_13_4D, 0x1_14_42, 0x1_14_C2, 0x1_15_BF, 0x1_16_3F, 0x1_16_B6, 0x1_17_2B, 0x1_18_39, 0x1_19_3D, 0x1_19_3E, 0x1_19_E0, 0x1_1A_34, 0x1_1A_47, 0x1_1A_99, 0x1_1C_3F, 0x1_1D_44, 0x1_1D_45, 0x1_1D_97, 0x1_1F_41, 0x1_1F_42]);
// oxlint-disable-next-line eslint/no-magic-numbers -- These ordered code points are the IDNA disallowed exceptions listed above.
const DISALLOWED = new Set([0x06_40, 0x07_FA, 0x30_2E, 0x30_2F, 0x30_31, 0x30_32, 0x30_33, 0x30_34, 0x30_35, 0x30_3B]);
const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Mandaic}\p{Script=Manichaean}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Sogdian}]/u;

const ADJACENT_POSITION = 1;
const KATAKANA_MIDDLE_DOT = "・";

const joinsScriptLetters = (characters: string[], index: number): boolean => {
  const at = (position: number): string => characters[position] ?? "";
  const cursor = { after: index + ADJACENT_POSITION, before: index - ADJACENT_POSITION };
  while (cursor.before >= TEXT_START && /\p{Mn}/u.test(at(cursor.before))) {cursor.before -= ADJACENT_POSITION;}
  while (cursor.after < characters.length && /\p{Mn}/u.test(at(cursor.after))) {cursor.after += ADJACENT_POSITION;}
  return JOINING.test(at(cursor.before)) && JOINING.test(at(cursor.after));
};

const followsVirama = (character: string): boolean => {
  const codePoint = character.codePointAt(TEXT_START);
  return !matchesUndefined(codePoint) && VIRAMA.has(codePoint);
};

const contextAllows = (character: string, index: number, characters: string[]): boolean => {
  const before = characters[index - ADJACENT_POSITION] ?? "";
  const after = characters[index + ADJACENT_POSITION] ?? "";
  switch (character) {
    case "·": { return before === "l" && after === "l"; }
    case "\u0375": { return /\p{Script=Greek}/u.test(after); }
    case "\u05F3":
    case "\u05F4": { return /\p{Script=Hebrew}/u.test(before); }
    case KATAKANA_MIDDLE_DOT: {
      return characters.some((neighbor) => neighbor !== KATAKANA_MIDDLE_DOT && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(neighbor));
    }
    case "\u200D": { return followsVirama(before); }
    case "\u200C": { return followsVirama(before) || joinsScriptLetters(characters, index); }
    default: { return true; }
  }
};

const permitsCodePoint = (character: string, index: number, characters: string[]): boolean => {
  const codePoint = character.codePointAt(TEXT_START);
  return !matchesUndefined(codePoint) && !DISALLOWED.has(codePoint) && contextAllows(character, index, characters);
};

const uLabel = (label: string): boolean => {
  if (isEmptyString(label) || /^\p{M}/u.test(label) || label.slice(ASCII_LABEL_MARKER.length, LABEL_PAYLOAD_START) === LABEL_DELIMITER) {return false;}
  // oxlint-disable-next-line typescript/no-misused-spread -- IDNA contextual checks work on adjacent Unicode code points.
  const characters = [...label];
  if (!characters.every((character, index) => permitsCodePoint(character, index, characters))) {return false;}
  const arabic = characters.some((character) => /[٠-٩]/u.test(character));
  const extended = characters.some((character) => /[۰-۹]/u.test(character));
  return !(arabic && extended);
};

// A-labels must decode to a Unicode label whose contextual characters are permitted.
const permitsLabel = (label: string): boolean => {
  if (isEmptyString(label) || label.length > MAX_LABEL_LENGTH || !LABEL.test(label)) {return false;}
  if (label.slice(ASCII_LABEL_MARKER.length, LABEL_PAYLOAD_START) !== LABEL_DELIMITER) {return true;}
  if (label.slice(TEXT_START, ASCII_LABEL_MARKER.length).toLowerCase() !== ASCII_LABEL_MARKER) {return false;}
  const decoded = punycode(label.slice(LABEL_PAYLOAD_START).toLowerCase());
  return !matchesUndefined(decoded) && uLabel(decoded);
};

export const hostname = (value: string): boolean =>
  !isEmptyString(value) && value.length <= MAX_HOSTNAME_LENGTH && value.split(".").every((label) => permitsLabel(label));
