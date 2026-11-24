import { matchesUndefined } from "./native-predicates.ts";

const DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/iu;

const DATE_LENGTH = 10;
const TIME_START = 11;
const FIRST_MONTH = 1;
const FIRST_DAY = 1;
const LONG_MONTH = 31;
const SHORT_MONTH = 30;
const FEBRUARY = 28;
const LEAP_FEBRUARY = 29;
const COMMON_LEAP_INTERVAL = 4;
const YEARS_PER_CENTURY = 100;
const GREGORIAN_CYCLE = 400;
const EVEN_REMAINDER = 0;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
const LAST_MINUTE_OF_DAY = MINUTES_PER_DAY - 1;
const LEAP_SECOND = 60;
const UTC_OFFSET = 0;

const isLeapYear = (year: number): boolean =>
  year % COMMON_LEAP_INTERVAL === EVEN_REMAINDER &&
  (year % YEARS_PER_CENTURY !== EVEN_REMAINDER || year % GREGORIAN_CYCLE === EVEN_REMAINDER);

const daysOfMonths = (year: number): number[] => [
  LONG_MONTH, isLeapYear(year) ? LEAP_FEBRUARY : FEBRUARY, LONG_MONTH, SHORT_MONTH,
  LONG_MONTH, SHORT_MONTH, LONG_MONTH, LONG_MONTH, SHORT_MONTH, LONG_MONTH, SHORT_MONTH, LONG_MONTH,
];

const date = (value: string): boolean => {
  const parts = DATE.exec(value)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const month = Number(parts.month);
  const day = Number(parts.day);
  const lastDay = daysOfMonths(Number(parts.year))[month - FIRST_MONTH];
  return !matchesUndefined(lastDay) && day >= FIRST_DAY && day <= lastDay;
};

const validClock = (hour: number, minute: number): boolean =>
  hour < HOURS_PER_DAY && minute < MINUTES_PER_HOUR;

const utcOffset = ({ sign, offsetHour, offsetMinute }: Record<string, string | undefined>): number => {
  if (matchesUndefined(sign)) {return UTC_OFFSET;}
  const minutes = Number(offsetHour) * MINUTES_PER_HOUR + Number(offsetMinute);
  return sign === "-" ? -minutes : minutes;
};

const time = (value: string): boolean => {
  const parts = TIME.exec(value)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (!validClock(hour, minute) || second > LEAP_SECOND) {return false;}
  if (!matchesUndefined(parts.sign) && !validClock(Number(parts.offsetHour), Number(parts.offsetMinute))) {return false;}
  if (second !== LEAP_SECOND) {return true;}
  // A leap second ends the UTC day even when written with a local offset.
  const localMinute = hour * MINUTES_PER_HOUR + minute;
  const utcMinute = ((localMinute - utcOffset(parts)) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return utcMinute === LAST_MINUTE_OF_DAY;
};

const INDEX_NOT_FOUND = -1;
const TEXT_START = 0;
const FIRST_SEPARATOR_POSITION = 1;
const IPV6_EMAIL_PREFIX = "ipv6:";
const MAX_EMAIL_DOMAIN_LENGTH = 255;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const SIDE_COUNT_WITH_COMPRESSION = 2;
const IPV6_WORD_COUNT = 8;
const IPV4_EXTRA_WORDS = 1;
const NO_EXTRA_WORDS = 0;
const ASCII_LABEL_MARKER = "xn";
const LABEL_DELIMITER = "--";
const LABEL_PAYLOAD_START = ASCII_LABEL_MARKER.length + LABEL_DELIMITER.length;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u;

const ipv6Groups = (side: string): string[] => (side === "" ? [] : side.split(":"));

const ipv6 = (value: string): boolean => {
  if (!/^[0-9a-f:.]+$/iu.test(value) || value.includes(":::")) {return false;}
  const sides = value.split("::");
  if (sides.length > SIDE_COUNT_WITH_COMPRESSION) {return false;}
  const parts = sides.flatMap(ipv6Groups);
  const tail = parts.at(INDEX_NOT_FOUND) ?? "";
  const embeddedIpv4 = tail.includes(".");
  if (embeddedIpv4 && !IPV4.test(tail)) {return false;}
  const words = parts.length + (embeddedIpv4 ? IPV4_EXTRA_WORDS : NO_EXTRA_WORDS);
  const groups = parts.slice(TEXT_START, embeddedIpv4 ? INDEX_NOT_FOUND : undefined);
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) {return false;}
  return sides.length === SIDE_COUNT_WITH_COMPRESSION ? words < IPV6_WORD_COUNT : words === IPV6_WORD_COUNT;
};

// RFC 5321's mailbox, in ASCII: a dot-string or a quoted string, `@`, and a domain of letter,
// Digit and hyphen labels or an address literal.
const ATOM = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~]+";
const DOT_STRING = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`);
const QUOTED = /^"(?:[\u0020\u0021\u0023-\u005B\u005D-\u007E]|\\[\u0020-\u007E])*"$/u;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const email = function email(value: string): boolean {
  const separator = value.lastIndexOf("@");
  if (separator < FIRST_SEPARATOR_POSITION) {return false;}
  const local = value.slice(TEXT_START, separator);
  const domain = value.slice(separator + "@".length);
  if (!(DOT_STRING.test(local) || QUOTED.test(local))) {return false;}
  if (domain.startsWith("[") && domain.endsWith("]")) {
    const literal = domain.slice("[".length, -"]".length);
    return /^ipv6:/iu.test(literal) ? ipv6(literal.slice(IPV6_EMAIL_PREFIX.length)) : IPV4.test(literal);
  }
  return domain.length <= MAX_EMAIL_DOMAIN_LENGTH && domain.split(".").every((label) => label.length <= MAX_LABEL_LENGTH && LABEL.test(label));
};

// RFC 3986's URI: a scheme, `:`, an authority after `//` or a path, a query and a fragment, each
// Of the characters its part allows, a `%` always followed by two hexadecimal digits.
const UNRESERVED = String.raw`A-Za-z0-9\-._~`;
const SUB_DELIMS = "!$&'()*+,;=";
const PCT = "%[0-9A-Fa-f]{2}";
const PCHAR = `(?:[${UNRESERVED}${SUB_DELIMS}:@]|${PCT})`;
const URI = new RegExp(`^[A-Za-z][A-Za-z0-9+.-]*:(?://(?<authority>[^/?#]*))?(?<path>(?:/|${PCHAR})*)(?:\\?(?:${PCHAR}|[/?])*)?(?:#(?:${PCHAR}|[/?])*)?$`, "u");
const USERINFO = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}:]|${PCT})*$`);
const REG_NAME = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}]|${PCT})*$`);

const uri = function uri(value: string): boolean {
  const parts = URI.exec(value)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const { authority, path } = parts;
  // Without an authority a path may not start with `//`.
  if (matchesUndefined(authority)) {return !(path ?? "").startsWith("//");}
  const separator = authority.lastIndexOf("@");
  if (separator !== INDEX_NOT_FOUND && !USERINFO.test(authority.slice(TEXT_START, separator))) {return false;}
  const hostport = authority.slice(separator + "@".length);
  if (hostport.startsWith("[")) {
    const close = hostport.indexOf("]");
    if (close === INDEX_NOT_FOUND) {return false;}
    const literal = hostport.slice("[".length, close);
    const validAddress = /^v[0-9a-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+$/i.test(literal) || ipv6(literal);
    return validAddress && /^(?::\d*)?$/u.test(hostport.slice(close + "]".length));
  }
  const colon = hostport.lastIndexOf(":");
  const host = colon !== INDEX_NOT_FOUND ? hostport.slice(TEXT_START, colon) : hostport;
  if (colon !== INDEX_NOT_FOUND && !/^\d*$/u.test(hostport.slice(colon + ":".length))) {return false;}
  return REG_NAME.test(host);
};

// oxlint-disable-next-line eslint/no-magic-numbers -- Keep the Unicode virama table as ordered code-point data for IDNA context checks.
const VIRAMA = new Set([0x09_4D, 0x09_CD, 0x0A_4D, 0x0A_CD, 0x0B_4D, 0x0B_CD, 0x0C_4D, 0x0C_CD, 0x0D_3B, 0x0D_3C, 0x0D_4D, 0x0D_CA, 0x0E_3A, 0x0E_BA, 0x0F_84, 0x10_39, 0x10_3A, 0x17_14, 0x17_15, 0x17_34, 0x17_D2, 0x1A_60, 0x1B_44, 0x1B_AA, 0x1B_AB, 0x1B_F2, 0x1B_F3, 0x2D_7F, 0xA8_06, 0xA8_2C, 0xA8_C4, 0xA9_53, 0xA9_C0, 0xAA_F6, 0xAB_ED, 0x1_0A_3F, 0x1_10_46, 0x1_10_70, 0x1_10_7F, 0x1_10_B9, 0x1_11_33, 0x1_11_34, 0x1_11_C0, 0x1_12_35, 0x1_12_EA, 0x1_13_4D, 0x1_14_42, 0x1_14_C2, 0x1_15_BF, 0x1_16_3F, 0x1_16_B6, 0x1_17_2B, 0x1_18_39, 0x1_19_3D, 0x1_19_3E, 0x1_19_E0, 0x1_1A_34, 0x1_1A_47, 0x1_1A_99, 0x1_1C_3F, 0x1_1D_44, 0x1_1D_45, 0x1_1D_97, 0x1_1F_41, 0x1_1F_42]);
// oxlint-disable-next-line eslint/no-magic-numbers -- These ordered code points are the IDNA disallowed exceptions listed above.
const DISALLOWED = new Set([0x06_40, 0x07_FA, 0x30_2E, 0x30_2F, 0x30_31, 0x30_32, 0x30_33, 0x30_34, 0x30_35, 0x30_3B]);
const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Mandaic}\p{Script=Manichaean}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Sogdian}]/u;

const ADJACENT_POSITION = 1;
const KATAKANA_MIDDLE_DOT = "・";

const joinsScriptLetters = (characters: string[], index: number): boolean => {
  const at = (position: number): string => characters[position] ?? "";
  // oxlint-disable-next-line rules/no-let -- Scan backward over combining marks to the joining letter.
  let before = index - ADJACENT_POSITION;
  while (before >= TEXT_START && /\p{Mn}/u.test(at(before))) {before -= ADJACENT_POSITION;}
  // oxlint-disable-next-line rules/no-let -- Scan forward over combining marks to the joining letter.
  let after = index + ADJACENT_POSITION;
  while (after < characters.length && /\p{Mn}/u.test(at(after))) {after += ADJACENT_POSITION;}
  return JOINING.test(at(before)) && JOINING.test(at(after));
};

const followsVirama = (character: string): boolean => {
  const codePoint = character.codePointAt(TEXT_START);
  return !matchesUndefined(codePoint) && VIRAMA.has(codePoint);
};

const permitsCodePoint = (character: string, index: number, characters: string[]): boolean => {
  const codePoint = character.codePointAt(TEXT_START);
  if (matchesUndefined(codePoint) || DISALLOWED.has(codePoint)) {return false;}
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

const uLabel = (label: string): boolean => {
  if (label === "" || /^\p{M}/u.test(label) || label.slice(ASCII_LABEL_MARKER.length, LABEL_PAYLOAD_START) === LABEL_DELIMITER) {return false;}
  const characters = [...label];
  if (!characters.every(permitsCodePoint)) {return false;}
  const arabic = characters.some((character) => /[٠-٩]/u.test(character));
  const extended = characters.some((character) => /[۰-۹]/u.test(character));
  return !(arabic && extended);
};

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
const BASE_MINUS_MIN_THRESHOLD = PUNYCODE_BASE - MIN_THRESHOLD;
const MAX_BIAS_DELTA = (BASE_MINUS_MIN_THRESHOLD * MAX_THRESHOLD) >> LEAST_SIGNIFICANT_BIT;
const BIAS_NUMERATOR_FACTOR = BASE_MINUS_MIN_THRESHOLD + 1;
const INVALID_DIGIT = -1;
const PUNYCODE_DELIMITER = "-";

const adaptBias = (delta: number, points: number, first: boolean): number => {
  const damped = first ? Math.floor(delta / INITIAL_DAMPING) : delta >> LEAST_SIGNIFICANT_BIT;
  // oxlint-disable-next-line rules/no-let -- Each division reduces the remaining range before computing the new bias.
  let remaining = damped + Math.floor(damped / points);
  // oxlint-disable-next-line rules/no-let -- Each division advances a base position in the Bootstring bias.
  let basePosition = 0;
  while (remaining > MAX_BIAS_DELTA) {
    remaining = Math.floor(remaining / BASE_MINUS_MIN_THRESHOLD);
    basePosition += PUNYCODE_BASE;
  }
  return basePosition + Math.floor((BIAS_NUMERATOR_FACTOR * remaining) / (remaining + BIAS_SKEW));
};

const punycodeDigit = (character: string): number => {
  if (/[a-z]/u.test(character)) {return character.charCodeAt(TEXT_START) - "a".charCodeAt(TEXT_START);}
  if (/[0-9]/u.test(character)) {return character.charCodeAt(TEXT_START) - "0".charCodeAt(TEXT_START) + PUNYCODE_LETTERS;}
  return INVALID_DIGIT;
};

interface PunycodeState {
  bias: number;
  index: number;
  position: number;
}

const readPunycodeIndex = (input: string, state: PunycodeState): boolean => {
  // oxlint-disable-next-line rules/no-let -- Bootstring increases the weight after each continuation digit.
  let weight = 1;
  for (let basePosition = PUNYCODE_BASE; ; basePosition += PUNYCODE_BASE) {
    const character = input[state.position];
    if (matchesUndefined(character)) {return false;}
    state.position += character.length;
    const digit = punycodeDigit(character);
    if (digit === INVALID_DIGIT) {return false;}
    state.index += digit * weight;
    const threshold = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, basePosition - state.bias));
    if (digit < threshold) {return true;}
    weight *= PUNYCODE_BASE - threshold;
    if (!Number.isSafeInteger(state.index) || !Number.isSafeInteger(weight)) {return false;}
  }
};

/** RFC 3492's decoding of a Punycode string, or `undefined` where it is not one. */
const punycode = (input: string): string | undefined => {
  const delimiter = input.lastIndexOf(PUNYCODE_DELIMITER);
  const hasBasicPrefix = delimiter > TEXT_START;
  const output = hasBasicPrefix
    ? Array.from(input.slice(TEXT_START, delimiter), (character) => character.codePointAt(TEXT_START)!)
    : [];
  if (output.some((codePoint) => codePoint >= FIRST_NON_ASCII)) {return undefined;}
  const state = { bias: INITIAL_BIAS, index: TEXT_START, position: hasBasicPrefix ? delimiter + PUNYCODE_DELIMITER.length : TEXT_START };
  if (state.position >= input.length && !hasBasicPrefix) {return undefined;}
  // oxlint-disable-next-line rules/no-let -- Each code point is decoded relative to the previous one.
  let codePoint = FIRST_NON_ASCII;
  while (state.position < input.length) {
    const previousIndex = state.index;
    if (!readPunycodeIndex(input, state)) {return undefined;}
    const insertionSlots = output.length + 1;
    state.bias = adaptBias(state.index - previousIndex, insertionSlots, previousIndex === TEXT_START);
    codePoint += Math.floor(state.index / insertionSlots);
    state.index %= insertionSlots;
    if (codePoint > MAX_CODE_POINT) {return undefined;}
    output.splice(state.index, 0, codePoint);
    state.index += 1;
  }
  return String.fromCodePoint(...output);
};

// RFC 1123's host name: labels of letters, digits and hyphens, at most 63 characters each and 253
// In all. A label with `--` in its third and fourth places is an A-label (`xn--`), whose Punycode
// Must decode (RFC 3492) to a U-label that IDNA 2008's contextual rules allow (RFC 5892,
// Appendix A): this checks the ones for MIDDLE DOT, Greek KERAIA, Hebrew GERESH and GERSHAYIM,
// KATAKANA MIDDLE DOT, the two sets of Arabic-Indic digits, the joiners after a virama, a combining
// Mark first, and the code points RFC 5892 lists as DISALLOWED exceptions. A ZERO WIDTH NON-JOINER
// That follows no virama is taken where it joins two letters of a joining script, short of the
// Unicode joining types the rule names.
const hostname = (value: string): boolean => {
  if (value === "" || value.length > MAX_HOSTNAME_LENGTH) {return false;}
  return value.split(".").every((label) => {
    if (label === "" || label.length > MAX_LABEL_LENGTH || !LABEL.test(label)) {return false;}
    if (label.slice(ASCII_LABEL_MARKER.length, LABEL_PAYLOAD_START) !== LABEL_DELIMITER) {return true;}
    if (label.slice(TEXT_START, ASCII_LABEL_MARKER.length).toLowerCase() !== ASCII_LABEL_MARKER) {return false;}
    const decoded = punycode(label.slice(LABEL_PAYLOAD_START).toLowerCase());
    return !matchesUndefined(decoded) && uLabel(decoded);
  });
};

/** The formats this file asserts (RFC 3339, RFC 4122, RFC 5321's address form loosely, RFC 3986's scheme): any other passes. */
export const matchesJsonFormat = (name: string, value: string): boolean => {
  switch (name) {
    case "date": { return date(value); }
    case "time": { return time(value); }
    case "date-time": {
      const separator = value.search(/[tT ]/u);
      return separator === DATE_LENGTH && date(value.slice(0, separator)) && time(value.slice(TIME_START));
    }
    case "uuid": { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
    case "email": { return email(value); }
    case "ipv4": { return IPV4.test(value); }
    case "ipv6": { return ipv6(value); }
    case "uri": { return uri(value); }
    case "hostname": { return hostname(value); }
    case "regex": {
      try {
        new RegExp(value, "u");
        return true;
      } catch {
        return false;
      }
    }
    default: { return true; }
  }
};
