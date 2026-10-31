// Copyright IBM Corp. 2014, 2025
// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseConfig, parseExpression, parseTemplate } from '../../src/hclsyntax/parser.ts';
import { lexConfig, lexExpression, lexTemplate, scanStringLit, validIdentifier } from '../../src/hclsyntax/scanner.ts';
import { Peeker } from '../../src/hclsyntax/peeker.ts';
import { isStringLiteral, type Range, type Token } from '../../src/hclsyntax/types.ts';
import { actualAST, actualDiagnostics, diagnostics, oracleAST, oracleTokens, position, type Fixture } from './oracle-shape.ts';

const fixtures = readFileSync(new URL('./fixtures.jsonl', import.meta.url), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Fixture);
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')) as { fixtures: number; functions: Record<string, { name: string; calls: number; cases: number }[]> };

function assertNumericLexemes(value: unknown, source: Buffer, startByte: number): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(item => assertNumericLexemes(item, source, startByte)); return }
  const v = value as Record<string, unknown>;
  if (v.kind === 'literal' && typeof v.value === 'number') {
    const r = v.range as Range;
    assert.equal(v.numberText, source.subarray(r.start.byte - startByte, r.end.byte - startByte).toString('utf8'), 'numeric literal must preserve its exact source spelling');
  }
  for (const item of Object.values(v)) assertNumericLexemes(item, source, startByte);
}

for (const [index, fixture] of fixtures.entries()) {
  test(`official HCL ${fixture.api} #${index}: ${fixture.name}`, () => {
    const source = Buffer.from(fixture.source, 'base64');
    const start = position(fixture.start);
    switch (fixture.api) {
      case 'lexConfig': case 'lexExpression': case 'lexTemplate': {
        const result = { lexConfig, lexExpression, lexTemplate }[fixture.api](source, fixture.filename, start);
        assert.deepEqual(result.tokens.map(t => ({ ...t, bytes: Buffer.from(t.bytes) })), oracleTokens(fixture.extra));
        assert.deepEqual(actualDiagnostics(result.diagnostics), diagnostics(fixture.diagnostics));
        break;
      }
      case 'scanStringLit': {
        const extra = fixture.extra as { quoted: boolean; slices: string[] | null };
        assert.deepEqual(scanStringLit(source, extra.quoted).map(slice => Buffer.from(slice)), (extra.slices ?? []).map(slice => Buffer.from(slice, 'base64')));
        break;
      }
      case 'validIdentifier':
        assert.equal(validIdentifier(source), fixture.result);
        break;
      case 'parseConfig': {
        const result = parseConfig(source, fixture.filename, start);
        assert.deepEqual(actualDiagnostics(result.diagnostics), diagnostics(fixture.diagnostics));
        assert.deepEqual(actualAST(result.body), oracleAST(fixture.result));
        assertNumericLexemes(result.body, source, start.byte);
        break;
      }
      case 'parseExpression': case 'parseTemplate': {
        const result = { parseExpression, parseTemplate }[fixture.api](source, fixture.filename, start);
        assert.deepEqual(actualDiagnostics(result.diagnostics), diagnostics(fixture.diagnostics));
        assert.deepEqual(actualAST(result.expression), oracleAST(fixture.result));
        assertNumericLexemes(result.expression, source, start.byte);
        if (fixture.name.startsWith('TestTemplateExprIsStringLiteral/')) assert.equal(isStringLiteral(result.expression), (fixture.extra as { isStringLiteral: boolean }).isStringLiteral);
        break;
      }
    }
  });
}

test('official HCL fixture manifest maps every exported case without silent omissions', () => {
  assert.equal(fixtures.length, manifest.fixtures);
  for (const functions of Object.values(manifest.functions)) for (const entry of functions) {
    const matched = fixtures.filter(fixture => fixture.name.split('/')[0] === entry.name);
    assert.equal(matched.length, entry.calls, entry.name);
    assert.equal(new Set(matched.map(fixture => fixture.name)).size, entry.cases, entry.name);
  }
  for (const required of ['TestParseConfig', 'TestParseConfig_incompleteFunctionCall', 'TestParseConfigDiagnostics', 'TestScanTokens_normal', 'TestScanTokens_template', 'TestScanStringLit', 'TestCheckInvalidTokensTest', 'TestValidIdentifier', 'TestExpressionParseAndValue', 'TestExpressionErrorMessages', 'TestParseExpression_incompleteFunctionCall', 'TestTemplateExprParseAndValue', 'TestTemplateExprIsStringLiteral']) assert(fixtures.some(fixture => fixture.name.split('/')[0] === required), required);
});

// Full three-scenario table from upstream hclsyntax/peeker_test.go.
const peekerTypes = ['TokenIdent', 'TokenComment', 'TokenIdent', 'TokenComment', 'TokenIdent', 'TokenNewline', 'TokenIdent', 'TokenNewline', 'TokenIdent', 'TokenNewline', 'TokenEOF'];
const emptyRange: Range = { filename: '', start: { line: 0, column: 0, byte: 0 }, end: { line: 0, column: 0, byte: 0 } };
for (const scenario of [
  { name: 'include comments', comments: true, push: false, expected: peekerTypes },
  { name: 'exclude comments', comments: false, push: false, expected: ['TokenIdent', 'TokenIdent', 'TokenIdent', 'TokenNewline', 'TokenIdent', 'TokenNewline', 'TokenIdent', 'TokenNewline', 'TokenEOF'] },
  { name: 'newline stack', comments: false, push: true, expected: ['TokenIdent', 'TokenIdent', 'TokenIdent', 'TokenIdent', 'TokenIdent', 'TokenNewline', 'TokenEOF'] },
]) test(`official HCL TestPeeker: ${scenario.name}`, () => {
  const tokens: Token[] = peekerTypes.map(type => ({ type, bytes: new Uint8Array(), range: emptyRange }));
  const peeker = new Peeker(tokens, scenario.comments);
  if (scenario.push) peeker.pushIncludeNewlines(false);
  const actual: string[] = [];
  for (let index = 0; index <= tokens.length; index++) {
    const peeked = peeker.peek();
    const read = peeker.read();
    assert.equal(peeked.type, read.type);
    actual.push(read.type);
    if (read.type === 'TokenEOF') break;
    if (scenario.push && index === 4) peeker.popIncludeNewlines();
  }
  assert.deepEqual(actual, scenario.expected);
  peeker.assertEmptyIncludeNewlinesStack();
});
