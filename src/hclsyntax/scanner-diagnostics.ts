/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Invalid token diagnostics translated from hclsyntax/token.go.
import { error } from "./parser-values.ts";
import type { Diagnostic, Token } from "./types.ts";
// oxlint-disable-next-line import/no-relative-parent-imports -- Use the native sentinel guard in the standalone lexer.
import { matchesUndefined } from "../native-predicates.ts";

interface Reports {
  diagnostics: Diagnostic[];
  emitted: Set<string>;
  numberOfBitwise: number;
  quoteCounts: Map<string, number>;
}

const FIRST_COUNT = 0;
const STEP = 1;
const BITWISE_LIMIT = 4;
const PAIRED_QUOTE_PERIOD = 2;
const LAST_TRACKED_QUOTE = 2;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

const bitwiseSuggestions = new Map([
  ["TokenBitwiseAnd", ' Did you mean boolean AND ("&&")?'],
  ["TokenBitwiseOr", ' Did you mean boolean OR ("||")?'],
  ["TokenBitwiseXor", ""],
  ["TokenBitwiseNot", ' Did you mean boolean NOT ("!")?'],
]);

const quoteHelp = new Map([
  ["TokenBacktick", 'The "`" character is not valid. To create a multi-line string, use the "heredoc" syntax, like "<<EOT".'],
  ["TokenApostrophe", 'Single quotes are not valid. Use double quotes (") to enclose strings.'],
]);

type ReportMessage = Readonly<[summary: string, detail: string]>;
const singleReports = new Map<string, ReportMessage>([
  ["TokenStarStar", ["Unsupported operator", '"**" is not a supported operator. Exponentiation is not supported as an operator.']],
  ["TokenSemicolon", ["Invalid character", 'The ";" character is not valid. Use newlines to separate arguments and blocks, and commas to separate items in collection values.']],
  ["TokenTabs", ["Invalid character", "Tab characters may not be used. The recommended indentation style is two spaces per indent."]],
  ["TokenBadUTF8", ["Invalid character encoding", "All input files must be UTF-8 encoded. Ensure that UTF-8 encoding is selected in your editor."]],
]);

const addReport = (reports: Reports, token: Token, [summary, detail]: ReportMessage): void => {
  // oxlint-disable-next-line eslint/sort-keys -- Copy the original range with its public position order.
  const range = { ...token.range, start: { ...token.range.start }, end: { ...token.range.end } };
  reports.diagnostics.push(error(summary, detail, range));
};

const bitwise = (reports: Reports, token: Token, suggestion: string): void => {
  if (reports.numberOfBitwise < BITWISE_LIMIT) {
    addReport(reports, token, ["Unsupported operator", `Bitwise operators are not supported.${suggestion}`]);
    reports.numberOfBitwise += STEP;
  }
};

const invalidQuote = (reports: Reports, token: Token, detail: string): void => {
  const count = reports.quoteCounts.get(token.type) ?? FIRST_COUNT;
  if (count % PAIRED_QUOTE_PERIOD === FIRST_COUNT) {
    addReport(reports, token, ["Invalid character", detail]);
  }
  if (count <= LAST_TRACKED_QUOTE) {reports.quoteCounts.set(token.type, count + STEP);}
};

const invalidCharacter = (token: Token): ReportMessage => {
  const text = decoder.decode(token.bytes);
  return ["Invalid character", text === "“" || text === "”"
    ? '"Curly quotes" are not valid here. These can sometimes be inadvertently introduced when sharing code via documents or discussion forums. It might help to replace the character with a "straight quote".'
    : "This character is not used within the language."];
};

const reportInvalid = (reports: Reports, token: Token): void => {
  if (token.type === "TokenQuotedNewline") {
    addReport(reports, token, ["Invalid multi-line string", String.raw`Quoted strings may not be split over multiple lines. To produce a multi-line string, either use the \n escape to represent a newline character or use the "heredoc" multi-line template syntax.`]);
  } else if (token.type === "TokenInvalid") {
    addReport(reports, token, invalidCharacter(token));
  }
};

const reportOther = (reports: Reports, token: Token): void => {
  const once = singleReports.get(token.type);
  if (once) {
    if (!reports.emitted.has(token.type)) {
      addReport(reports, token, once);
      reports.emitted.add(token.type);
    }
  } else {
    reportInvalid(reports, token);
  }
};

const recordToken = (reports: Reports, token: Token): void => {
  const name = token.type;
  const suggestion = bitwiseSuggestions.get(name);
  const quote = quoteHelp.get(name);
  if (matchesUndefined(suggestion)) {
    if (matchesUndefined(quote)) {reportOther(reports, token);}
    else {invalidQuote(reports, token, quote);}
  } else {
    bitwise(reports, token, suggestion);
  }
};

/**
 * Reports invalid HCL tokens in source order.
 * @param {Token[]} tokens - The source token stream.
 * @returns {Diagnostic[]} The upstream-compatible token diagnostics.
 */
export const checkInvalidTokens = function checkInvalidTokens(tokens: Token[]): Diagnostic[] {
  const reports: Reports = {
    diagnostics: [], emitted: new Set(), numberOfBitwise: FIRST_COUNT, quoteCounts: new Map(),
  };
  Iterator.from(tokens).forEach((token) => {recordToken(reports, token);});
  return reports.diagnostics;
};
