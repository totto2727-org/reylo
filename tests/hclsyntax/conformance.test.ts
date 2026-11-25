// Copyright IBM Corp. 2014, 2025
// SPDX-License-Identifier: MPL-2.0
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from 'node:assert/strict';
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { readFile } from 'node:fs/promises';
// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from 'node:test';
import { parseConfig, parseExpression, parseTemplate } from '#reylo-source/hclsyntax/parser.ts';
import { lexConfig, lexExpression, lexTemplate, scanStringLit, validIdentifier } from '#reylo-source/hclsyntax/scanner.ts';
import { isStringLiteral } from '#reylo-source/hclsyntax/types.ts';
import { actualAST, actualDiagnostics, diagnostics, oracleAST, oracleTokens, position } from './oracle-shape.ts';
import { readFixture } from './oracle-input.ts';
import { isRecord, matchesBoolean, matchesNull, matchesNumber, matchesString } from "#reylo-source/native-predicates.ts";

import manifest from "./manifest.json" with { type: "json" };

const fixtureSource = await readFile(new URL("fixtures.jsonl", import.meta.url), "utf8");
const fixtures = fixtureSource.trimEnd().split("\n").map((line) => readFixture(line));
type Fixture = ReturnType<typeof readFixture>;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test('HCL string tokens retain UTF-8 byte ranges and grapheme columns through Intl', () => {
  const source = Buffer.from('a = "e\u0301😀"\n');
  const scanned = lexConfig(source, 'unicode.hcl');
  assert.deepEqual(scanned.diagnostics, []);
  const literal = scanned.tokens.find(token => token.type === 'TokenQuotedLit');
  assert.ok(literal);
  assert.deepEqual(Buffer.from(literal.bytes), Buffer.from('e\u0301😀'));
  assert.deepEqual(literal.range, {
    end: { byte: 12, column: 8, line: 1 },
    filename: 'unicode.hcl',
    start: { byte: 5, column: 6, line: 1 },
  });
  const parsed = parseConfig(source, 'unicode.hcl');
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(Object.keys(parsed.body.attributes), ['a']);
});

const assertLiteralSpelling = (value: Record<string, unknown>, source: Buffer, startByte: number): void => {
  assert.ok(isRecord(value.range) && isRecord(value.range.start) && isRecord(value.range.end));
  const start = value.range.start.byte;
  const end = value.range.end.byte;
  assert.ok(matchesNumber(start) && matchesNumber(end));
  assert.equal(value.numberText, source.subarray(start - startByte, end - startByte).toString("utf8"), "numeric literal must preserve its exact source spelling");
};

const assertNumericLexemes = (value: unknown, source: Buffer, startByte: number): void => {
  if (Array.isArray(value)) {
    value.forEach((item) => {assertNumericLexemes(item, source, startByte);});
    return;
  }
  if (!isRecord(value)) {return;}
  if (value.kind === "literal" && matchesNumber(value.value)) {
    assertLiteralSpelling(value, source, startByte);
  }
  Object.values(value).forEach((item) => {assertNumericLexemes(item, source, startByte);});
};

const verifySlices = (fixture: Fixture, source: Buffer): void => {
  const { extra } = fixture;
  assert.ok(isRecord(extra) && matchesBoolean(extra.quoted));
  const { quoted } = extra;
  const slices: unknown = extra.slices;
  assert.ok(matchesNull(slices) || (Array.isArray(slices) && slices.every((slice) => matchesString(slice))));
  assert.deepEqual(
    scanStringLit(source, quoted).map((slice) => Buffer.from(slice)),
    (slices ?? []).map((slice) => Buffer.from(slice, "base64")),
  );
};

const SCANNERS = { lexConfig, lexExpression, lexTemplate };
const PARSERS = { parseExpression, parseTemplate };

type Start = ReturnType<typeof position>;

const verifyConfig = (fixture: Fixture, source: Buffer, start: Start): void => {
  const result = parseConfig(source, fixture.filename, start);
  assert.deepEqual(actualDiagnostics(result.diagnostics), diagnostics(fixture.diagnostics));
  assert.deepEqual(actualAST(result.body), oracleAST(fixture.result));
  assertNumericLexemes(result.body, source, start.byte);
};

const verifyExpression = (fixture: Fixture, source: Buffer, start: Start): void => {
  assert.ok(fixture.api === "parseExpression" || fixture.api === "parseTemplate");
  const result = PARSERS[fixture.api](source, fixture.filename, start);
  assert.deepEqual(actualDiagnostics(result.diagnostics), diagnostics(fixture.diagnostics));
  assert.deepEqual(actualAST(result.expression), oracleAST(fixture.result));
  assertNumericLexemes(result.expression, source, start.byte);
  if (fixture.name.startsWith("TestTemplateExprIsStringLiteral/")) {
    assert.ok(isRecord(fixture.extra) && matchesBoolean(fixture.extra.isStringLiteral));
    assert.equal(isStringLiteral(result.expression), fixture.extra.isStringLiteral);
  }
};

const verifyTokens = (fixture: Fixture, source: Buffer, start: Start): void => {
  const { api } = fixture;
  assert.ok(api === "lexConfig" || api === "lexExpression" || api === "lexTemplate");
  const result = SCANNERS[api](source, fixture.filename, start);
  const tokens = result.tokens.map(({ bytes, range, type }) => ({ bytes: Buffer.from(bytes), range, type }));
  assert.deepEqual(tokens, oracleTokens(fixture.extra));
  assert.deepEqual(actualDiagnostics(result.diagnostics), diagnostics(fixture.diagnostics));
};

type Verify = (fixture: Fixture, source: Buffer, start: Start) => void;
const checks: Record<Fixture["api"], Verify> = {
  lexConfig: verifyTokens,
  lexExpression: verifyTokens,
  lexTemplate: verifyTokens,
  parseConfig: verifyConfig,
  parseExpression: verifyExpression,
  parseTemplate: verifyExpression,
  scanStringLit: verifySlices,
  validIdentifier: (fixture, source) => {assert.equal(validIdentifier(source), fixture.result);},
};

const verifyCase = (fixture: Fixture): void => {
  const source = Buffer.from(fixture.source, "base64");
  checks[fixture.api](fixture, source, position(fixture.start));
};

fixtures.forEach((fixture, index) => {
  // oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
  test(`official HCL ${fixture.api} #${index}: ${fixture.name}`, () => {verifyCase(fixture);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test('official HCL fixture manifest maps every exported case without silent omissions', () => {
  assert.equal(fixtures.length, manifest.fixtures);
  Object.values(manifest.functions).forEach((functions) => {functions.forEach((entry) => {
    const matched = fixtures.filter(fixture => fixture.name.split('/')[0] === entry.name);
    assert.equal(matched.length, entry.calls, entry.name);
    assert.equal(new Set(matched.map(fixture => fixture.name)).size, entry.cases, entry.name);
  });});
  Iterator.from(['TestParseConfig', 'TestParseConfig_incompleteFunctionCall', 'TestParseConfigDiagnostics', 'TestScanTokens_normal', 'TestScanTokens_template', 'TestScanStringLit', 'TestCheckInvalidTokensTest', 'TestValidIdentifier', 'TestExpressionParseAndValue', 'TestExpressionErrorMessages', 'TestParseExpression_incompleteFunctionCall', 'TestTemplateExprParseAndValue', 'TestTemplateExprIsStringLiteral']).forEach((required) => {assert.ok(fixtures.some(fixture => fixture.name.split('/')[0] === required), required);});
});
