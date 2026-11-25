// Copyright IBM Corp. 2014, 2025
// SPDX-License-Identifier: MPL-2.0
// oxlint-disable-next-line rules/no-node-imports -- Compare the native Peeker's tokens through Node's assertion library.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs the original Peeker scenarios through Node's test runner.
import { test } from "node:test";
import { Peeker } from "#reylo-source/hclsyntax/peeker.ts";
import type { Range, Token } from "#reylo-source/hclsyntax/types.ts";
import { matchesNumber } from "#reylo-source/native-predicates.ts";

// Full three-scenario table from upstream hclsyntax/peeker_test.go.
const peekerTypes = ['TokenIdent', 'TokenComment', 'TokenIdent', 'TokenComment', 'TokenIdent', 'TokenNewline', 'TokenIdent', 'TokenNewline', 'TokenIdent', 'TokenNewline', 'TokenEOF'];
const zeroPosition = { byte: 0, column: 0, line: 0 };
const emptyRange: Range = { end: zeroPosition, filename: '', start: zeroPosition };
const readPeeker = (peeker: Peeker, length: number, restoreNewlines: boolean): string[] => {
  const actual: string[] = [];
  const eof = Array.from({ length: length + 1 }, (_token, index) => index).find((index) => {
    const peeked = peeker.peek();
    const read = peeker.read();
    assert.equal(peeked.type, read.type);
    actual.push(read.type);
    if (read.type === "TokenEOF") {return true;}
    if (restoreNewlines && index === 4) {peeker.popIncludeNewlines();}
    return false;
  });
  assert.ok(matchesNumber(eof), "The original Peeker scenario must reach its EOF token");
  return actual;
};

[
  { comments: true, expected: peekerTypes, name: 'include comments', push: false },
  { comments: false, expected: ['TokenIdent', 'TokenIdent', 'TokenIdent', 'TokenNewline', 'TokenIdent', 'TokenNewline', 'TokenIdent', 'TokenNewline', 'TokenEOF'], name: 'exclude comments', push: false },
  { comments: false, expected: ['TokenIdent', 'TokenIdent', 'TokenIdent', 'TokenIdent', 'TokenIdent', 'TokenNewline', 'TokenEOF'], name: 'newline stack', push: true },
].forEach((scenario) => {
  // oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
  test(`official HCL TestPeeker: ${scenario.name}`, () => {
    const tokens: Token[] = peekerTypes.map((type) => ({ bytes: new Uint8Array(), range: emptyRange, type }));
    const peeker = new Peeker(tokens, scenario.comments);
    if (scenario.push) {peeker.pushIncludeNewlines(false);}
    const actual = readPeeker(peeker, tokens.length, scenario.push);
    assert.deepEqual(actual, scenario.expected);
    peeker.assertEmptyIncludeNewlinesStack();
  });
});
