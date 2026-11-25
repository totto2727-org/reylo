/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Template token reading translated from hclsyntax/parser.go and parser_template.go.
import { nameSuggestion } from "./parser-suggestion.ts";
import { readInterpolation, sequenceEnd, SEQUENCE_END, TILDE_BYTE } from "./parser-template-sequence.ts";
import type { TemplateHost, TemplateSequence } from "./parser-template-sequence.ts";
import type { TemplateParts, TemplateToken } from "./parser-template-tokens.ts";
import { error } from "./parser-values.ts";
import { parseStringLiteralToken } from "./string-literal.ts";
import { emptyRangeAt, rangeBetween as between } from "./types.ts";
import type { Range, Token } from "./types.ts";
// oxlint-disable-next-line import/no-relative-parent-imports -- Access native guards without introducing the optional Effect runtime.
import { isEmptyString, matchesUndefined } from "../native-predicates.ts";
import { trimLeadingWhitespace, trimTrailingWhitespace } from "./whitespace.ts";

interface TemplateReader extends TemplateSequence {
  literalBefore: boolean;
  parts: TemplateToken[];
}

interface TrimFlags {
  following: boolean;
  previous: boolean;
}

interface DirectiveTokens {
  marker: Token;
  token: Token;
}

interface DirectiveNames {
  keyVar: string;
  valueVar: string;
}

const decoder = new TextDecoder();
const TRIM_OPEN_LENGTH = 3;
const OPEN_TRIM_BYTE = 2;
const LAST_PART = -1;
const NO_DIRECTIVE = undefined;
const DIRECTIVES = ["if", "for", "else", "endif", "endfor"];

const cloneRange = ({ end, filename, start }: Range): Range =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public source range key order.
  ({ filename, start: { ...start }, end: { ...end } });

const appendLiteral = ({ host, parts }: TemplateReader, token: Token, strip: boolean): void => {
  const result = parseStringLiteralToken(token);
  host.diagnostics.push(...result.diagnostics);
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the template token key order used by the grammar.
  parts.push({ kind: "literal", value: strip ? trimLeadingWhitespace(result.value) : result.value, range: cloneRange(token.range) });
};

const trimPrevious = (parts: TemplateToken[], next: Token, canTrim: boolean): void => {
  if (!canTrim || next.bytes.length !== TRIM_OPEN_LENGTH || next.bytes[OPEN_TRIM_BYTE] !== TILDE_BYTE) {return;}
  const previous = parts.at(LAST_PART);
  if (previous?.kind === "literal") {previous.value = trimTrailingWhitespace(previous.value);}
};

const reportForDirective = (host: TemplateHost, detail: string): void => {
  if (!host.recovery) {
    host.diagnostics.push(error("Invalid 'for' directive", detail, host.peek().range));
  }
};

const directiveName = (host: TemplateHost, failure: string): string | undefined => {
  if (host.peek().type !== "TokenIdent") {
    reportForDirective(host, failure);
    return NO_DIRECTIVE;
  }
  return decoder.decode(host.read().bytes);
};

const directiveNames = (host: TemplateHost): DirectiveNames | undefined => {
  const first = directiveName(host, "For directive requires variable name after 'for'.");
  if (matchesUndefined(first)) {return NO_DIRECTIVE;}
  if (host.peek().type !== "TokenComma") {return { keyVar: "", valueVar: first };}
  host.read();
  const valueVar = directiveName(host, "For directive requires value variable name after comma.");
  return matchesUndefined(valueVar) ? NO_DIRECTIVE : { keyVar: first, valueVar };
};

const makeForToken = (host: TemplateHost, start: Range, { keyVar, valueVar }: DirectiveNames): TemplateToken => {
  const collection = host.parseExpression();
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the template token field order.
  return { kind: "for", keyVar, valueVar, collection, range: between(start, host.nextRange()) };
};

const forDirective = (host: TemplateHost, start: Range): TemplateToken | undefined => {
  const names = directiveNames(host);
  if (!names) {return NO_DIRECTIVE;}
  const token = host.peek();
  if (token.type !== "TokenIdent" || decoder.decode(token.bytes) !== "in") {
    reportForDirective(host, "For directive requires 'in' keyword after names.");
    return NO_DIRECTIVE;
  }
  host.read();
  return makeForToken(host, start, names);
};

const reportUnsupportedDirective = (host: TemplateHost, { marker, token }: DirectiveTokens, word: string): void => {
  if (!host.recovery) {
    const suggestion = nameSuggestion(word, DIRECTIVES);
    const help = isEmptyString(suggestion) ? "" : ` Did you mean ${JSON.stringify(suggestion)}?`;
    host.diagnostics.push(error("Invalid template control keyword", `${JSON.stringify(word)} is not a valid template control keyword.${help}`, token.range, between(marker.range, token.range)));
  }
};

const directiveToken = (host: TemplateHost, tokens: DirectiveTokens, word: string): TemplateToken | undefined => {
  const { marker } = tokens;
  switch (word) {
    case "if": {
      const condition = host.parseExpression();
      // oxlint-disable-next-line eslint/sort-keys -- Preserve the template token field order.
      return { kind: "if", condition, range: between(marker.range, host.nextRange()) };
    }
    case "else": case "endif": case "endfor": {
      return { kind: word, range: between(marker.range, host.nextRange()) };
    }
    case "for": {return forDirective(host, marker.range);}
    default: {reportUnsupportedDirective(host, tokens, word); return NO_DIRECTIVE;}
  }
};

const reportIncompleteDirective = (host: TemplateHost, heading: Token, marker: Token): void => {
  if (!host.recovery) {
    host.diagnostics.push(error("Invalid template directive", 'A template directive keyword ("if", "for", etc) is expected at the beginning of a %{ sequence.', heading.range, between(marker.range, heading.range)));
  }
};

const readDirective = ({ host }: TemplateReader, marker: Token): { part: TemplateToken; word: string } | undefined => {
  const heading = host.peek();
  if (heading.type !== "TokenIdent") {
    reportIncompleteDirective(host, heading, marker);
    return NO_DIRECTIVE;
  }
  host.read();
  const word = decoder.decode(heading.bytes);
  const part = directiveToken(host, { marker, token: heading }, word);
  return part ? { part, word } : NO_DIRECTIVE;
};

const acceptDirective = (state: TemplateReader, { part, word }: { part: TemplateToken; word: string }): void => {
  state.parts.push(part);
  const { host, startRange } = state;
  sequenceEnd(state, (close) => {
    host.diagnostics.push(error(`Extra characters in ${word} marker`, "Expected a closing brace to end the sequence, but found extra characters.", close.range, between(startRange, close.range)));
  });
};

const readControl = (state: TemplateReader, marker: Token): void => {
  const { host } = state;
  host.pushIncludeNewlines(false);
  const directive = readDirective(state, marker);
  if (directive) {acceptDirective(state, directive);}
  else {host.recover(SEQUENCE_END);}
  host.popIncludeNewlines();
};

const recoverTemplate = ({ end, host, startRange }: TemplateReader, token: Token): Range => {
  if (!host.recovery) {
    host.diagnostics.push(error("Unterminated template string", "No closing marker was found for the string.", token.range, between(startRange, token.range)));
  }
  return host.recover(end).range;
};

const trimFlags = (state: TemplateReader): TrimFlags => {
  const flags = { following: state.trimFollowing, previous: state.literalBefore };
  state.trimFollowing = false;
  state.literalBefore = false;
  return flags;
};

const appendInterpolation = (state: TemplateReader, token: Token): void => {
  const interpolation = readInterpolation(state, token);
  state.parts.push({ kind: "interpolation", ...interpolation });
};

const appendSequence = (state: TemplateReader, token: Token, previous: boolean): void => {
  trimPrevious(state.parts, token, previous);
  if (token.type === "TokenTemplateInterp") {appendInterpolation(state, token);}
  else {readControl(state, token);}
};

const appendPart = (state: TemplateReader, token: Token): Range | undefined => {
  const trim = trimFlags(state);
  if (token.type === "TokenStringLit" || token.type === "TokenQuotedLit") {
    appendLiteral(state, token, trim.following);
    state.literalBefore = true;
  } else if (token.type === "TokenTemplateInterp" || token.type === "TokenTemplateControl") {
    appendSequence(state, token, trim.previous);
  } else {
    return recoverTemplate(state, token);
  }
  return NO_DIRECTIVE;
};

const readUntilTemplateEnd = (state: TemplateReader): Range => {
  const { end, host } = state;
  // oxlint-disable-next-line rules/no-for-loops -- Read each token through the template closer or recovery.
  for (;;) {
    const token = host.read();
    if (token.type === end) {return token.range;}
    const recoveredEnd = appendPart(state, token);
    if (!matchesUndefined(recoveredEnd)) {return recoveredEnd;}
  }
};

/**
 * Reads the raw tokens of a template without changing its public expression form.
 * @param {TemplateHost} host - The existing recursive-descent parser and diagnostics.
 * @param {string} end - The token type that ends this template.
 * @returns {TemplateParts} The parts and full consumed source range.
 */
export const readTemplateParts = (host: TemplateHost, end: string): TemplateParts => {
  const startRange = host.nextRange();
  const parts: TemplateToken[] = [];
  const endRange = readUntilTemplateEnd({ end, host, literalBefore: false, parts, startRange, trimFollowing: false });
  if (!parts.length) {
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the empty template token field order.
    parts.push({ kind: "literal", value: "", range: emptyRangeAt(startRange) });
  }
  parts.push({ kind: "end", range: endRange });
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the template parts field order.
  return { tokens: parts, range: between(startRange, endRange) };
};
