import { isEmptyString, matchesUndefined } from "./native-predicates.ts";

const INDEX_NOT_FOUND = -1;
const TEXT_START = 0;
const FIRST_SEPARATOR_POSITION = 1;
const IPV6_EMAIL_PREFIX = "ipv6:";
const MAX_EMAIL_DOMAIN_LENGTH = 255;
export const MAX_LABEL_LENGTH = 63;
const SIDE_COUNT_WITH_COMPRESSION = 2;
const IPV6_WORD_COUNT = 8;
const IPV4_EXTRA_WORDS = 1;
const NO_EXTRA_WORDS = 0;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u;

const ipv6Groups = (side: string): string[] => isEmptyString(side) ? [] : side.split(":");

const ipv6WordCount = (parts: string[]): number => {
  const tail = parts.at(INDEX_NOT_FOUND) ?? "";
  const embeddedIpv4 = tail.includes(".");
  if (embeddedIpv4 && !IPV4.test(tail)) {return INDEX_NOT_FOUND;}
  const groups = embeddedIpv4 ? parts.slice(TEXT_START, INDEX_NOT_FOUND) : parts;
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) {return INDEX_NOT_FOUND;}
  return parts.length + (embeddedIpv4 ? IPV4_EXTRA_WORDS : NO_EXTRA_WORDS);
};

export const ipv6 = (value: string): boolean => {
  if (!/^[0-9a-f:.]+$/iu.test(value) || value.includes(":::")) {return false;}
  const sides = value.split("::");
  if (sides.length > SIDE_COUNT_WITH_COMPRESSION) {return false;}
  const words = ipv6WordCount(sides.flatMap((side) => ipv6Groups(side)));
  if (words === INDEX_NOT_FOUND) {return false;}
  return sides.length === SIDE_COUNT_WITH_COMPRESSION ? words < IPV6_WORD_COUNT : words === IPV6_WORD_COUNT;
};

export const ipv4 = (value: string): boolean => IPV4.test(value);

// RFC 5321's mailbox, in ASCII: a dot-string or a quoted string, `@`, and a domain of letter,
// Digit and hyphen labels or an address literal.
const ATOM = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~]+";
const DOT_STRING = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`, "u");
const QUOTED = /^"(?:[\u0020\u0021\u0023-\u005B\u005D-\u007E]|\\[\u0020-\u007E])*"$/u;
export const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const emailDomain = (domain: string): boolean => {
  if (domain.startsWith("[") && domain.endsWith("]")) {
    const literal = domain.slice("[".length, -"]".length);
    return /^ipv6:/iu.test(literal) ? ipv6(literal.slice(IPV6_EMAIL_PREFIX.length)) : IPV4.test(literal);
  }
  return domain.length <= MAX_EMAIL_DOMAIN_LENGTH && domain.split(".").every((label) => label.length <= MAX_LABEL_LENGTH && LABEL.test(label));
};

export const email = (value: string): boolean => {
  const separator = value.lastIndexOf("@");
  if (separator < FIRST_SEPARATOR_POSITION) {return false;}
  const local = value.slice(TEXT_START, separator);
  const domain = value.slice(separator + "@".length);
  return (DOT_STRING.test(local) || QUOTED.test(local)) && emailDomain(domain);
};

// RFC 3986's URI: a scheme, `:`, an authority after `//` or a path, a query and a fragment, each
// Of the characters its part allows, a `%` always followed by two hexadecimal digits.
const UNRESERVED = String.raw`A-Za-z0-9\-._~`;
const SUB_DELIMS = "!$&'()*+,;=";
const PCT = "%[0-9A-Fa-f]{2}";
const PCHAR = `(?:[${UNRESERVED}${SUB_DELIMS}:@]|${PCT})`;
const URI = new RegExp(`^[A-Za-z][A-Za-z0-9+.-]*:(?://(?<authority>[^/?#]*))?(?<path>(?:/|${PCHAR})*)(?:\\?(?:${PCHAR}|[/?])*)?(?:#(?:${PCHAR}|[/?])*)?$`, "u");
const USERINFO = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}:]|${PCT})*$`, "u");
const REG_NAME = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}]|${PCT})*$`, "u");

const addressWithPort = (value: string): boolean => {
  const close = value.indexOf("]");
  if (close === INDEX_NOT_FOUND) {return false;}
  const literal = value.slice("[".length, close);
  const isFuture = /^[vV][0-9A-Fa-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+$/u.test(literal);
  return (isFuture || ipv6(literal)) && /^(?::\d*)?$/u.test(value.slice(close + "]".length));
};

const regNameWithPort = (value: string): boolean => {
  const colon = value.lastIndexOf(":");
  if (colon === INDEX_NOT_FOUND) {return REG_NAME.test(value);}
  return /^\d*$/u.test(value.slice(colon + ":".length)) && REG_NAME.test(value.slice(TEXT_START, colon));
};

const uriAuthority = (authority: string): boolean => {
  const separator = authority.lastIndexOf("@");
  if (separator !== INDEX_NOT_FOUND && !USERINFO.test(authority.slice(TEXT_START, separator))) {return false;}
  const hostport = authority.slice(separator + "@".length);
  return hostport.startsWith("[") ? addressWithPort(hostport) : regNameWithPort(hostport);
};

export const uri = (value: string): boolean => {
  const parts = URI.exec(value)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const { authority, path } = parts;
  // An authority is required for a path that begins with two slashes.
  return matchesUndefined(authority) ? !(path ?? "").startsWith("//") : uriAuthority(authority);
};
