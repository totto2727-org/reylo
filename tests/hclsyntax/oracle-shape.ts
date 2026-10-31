// Copyright IBM Corp. 2014, 2025
// SPDX-License-Identifier: MPL-2.0
// Shape adapter only. Every expected value comes from the pinned Go oracle.
import assert from 'node:assert/strict';
import type { Diagnostic, Pos, Range } from '../../src/hclsyntax/types.ts';

type RecordValue = Record<string, unknown>;
export interface Fixture {
  api: 'parseConfig' | 'parseExpression' | 'parseTemplate' | 'lexConfig' | 'lexExpression' | 'lexTemplate' | 'scanStringLit' | 'validIdentifier';
  name: string;
  source: string;
  filename: string;
  start: { Line: number; Column: number; Byte: number };
  result: unknown;
  diagnostics: unknown[];
  extra: unknown;
}
function object(value: unknown): RecordValue { assert(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as RecordValue }
function array(value: unknown): unknown[] { assert(Array.isArray(value)); return value }
export function position(value: unknown): Pos { const v = object(value); return { line: v.Line as number, column: v.Column as number, byte: v.Byte as number } }
export function range(value: unknown): Range { const v = object(value); return { filename: v.Filename as string, start: position(v.Start), end: position(v.End) } }
export function diagnostics(value: unknown): Diagnostic[] {
  return array(value).map(item => { const d = object(item); return { severity: d.Severity === 1 ? 'error' : 'warning', summary: d.Summary as string, detail: d.Detail as string, subject: d.Subject === null ? null : range(d.Subject), context: d.Context === null ? null : range(d.Context) } });
}
const dynamicLiteral = Symbol('upstream dynamic literal');
function literal(value: unknown): unknown {
  const v = object(value);
  switch (v.cty) {
    case 'string': case 'bool': return v.value;
    case 'number': return Number(v.value);
    case 'null': return null;
    case 'unknown': return dynamicLiteral;
    default: throw new Error(`Unsupported oracle literal ${JSON.stringify(v)}`);
  }
}
const operators: Record<string, string> = { or: '||', and: '&&', not: '!', equal: '==', notEqual: '!=', greater: '>', greaterEqual: '>=', less: '<', lessEqual: '<=', add: '+', subtract: '-', multiply: '*', divide: '/', modulo: '%', negate: '-' };
function steps(value: unknown): unknown[] {
  return array(value).map(item => { const v = object(item); return v.goType === 'TraverseIndex' ? { kind: 'index', value: literal(v.Key) === dynamicLiteral ? null : literal(v.Key), range: range(v.SrcRange), ...(literal(v.Key) === dynamicLiteral ? { dynamic: true } : {}) } : { kind: v.goType === 'TraverseRoot' ? 'root' : 'attribute', value: v.Name, range: range(v.SrcRange) } });
}
export function oracleAST(value: unknown): unknown {
  if (value === null) return null;
  const v = object(value);
  const r = (): Range => range(v.ComputedRange ?? v.SrcRange);
  const e = (key: string): unknown => oracleAST(v[key]);
  const es = (key: string): unknown[] => array(v[key]).map(oracleAST);
  switch (v.goType) {
    case 'Body': return { kind: 'body', attributes: Object.fromEntries(Object.entries(object(v.Attributes)).map(([name, item]) => [name, oracleAST(item)])), blocks: es('Blocks'), range: r(), endRange: range(v.EndRange) };
    case 'Attribute': return { kind: 'attribute', name: v.Name, expression: e('Expr'), range: r(), nameRange: range(v.NameRange), equalsRange: range(v.EqualsRange) };
    case 'Block': return { kind: 'block', type: v.Type, labels: v.Labels, body: e('Body'), range: r(), typeRange: range(v.TypeRange), labelRanges: array(v.LabelRanges).map(range), openBraceRange: range(v.OpenBraceRange), closeBraceRange: range(v.CloseBraceRange) };
    case 'LiteralValueExpr': return literal(v.Val) === dynamicLiteral ? { kind: 'dynamic', range: r() } : { kind: 'literal', value: literal(v.Val), range: r() };
    case 'ExprSyntaxError': return { kind: 'dynamic', range: r(), diagnostics: diagnostics(v.ParseDiags) };
    case 'ScopeTraversalExpr': return { kind: 'traversal', steps: steps(v.Traversal), range: r() };
    case 'RelativeTraversalExpr': return { kind: 'relativeTraversal', source: e('Source'), steps: steps(v.Traversal), range: r() };
    case 'FunctionCallExpr': return { kind: 'call', name: v.Name, args: es('Args'), expandFinal: v.ExpandFinal, nameRange: range(v.NameRange), openParenRange: range(v.OpenParenRange), closeParenRange: range(v.CloseParenRange), range: r() };
    case 'TupleConsExpr': return { kind: 'tuple', expressions: es('Exprs'), openRange: range(v.OpenRange), range: r() };
    case 'ObjectConsExpr': return { kind: 'object', items: array(v.Items).map(item => { const i = object(item); return { key: oracleAST(i.KeyExpr), value: oracleAST(i.ValueExpr) } }), openRange: range(v.OpenRange), range: r() };
    case 'ObjectConsKeyExpr': return { kind: 'objectKey', wrapped: e('Wrapped'), forceNonLiteral: v.ForceNonLiteral, range: r() };
    case 'UnaryOpExpr': return { kind: 'unary', operator: operators[v.Op as string], operand: e('Val'), symbolRange: range(v.SymbolRange), range: r() };
    case 'BinaryOpExpr': return { kind: 'binary', operator: operators[v.Op as string], left: e('LHS'), right: e('RHS'), range: r() };
    case 'ConditionalExpr': return { kind: 'conditional', condition: e('Condition'), trueResult: e('TrueResult'), falseResult: e('FalseResult'), range: r() };
    case 'ForExpr': return { kind: 'for', keyVar: v.KeyVar, valueVar: v.ValVar, collection: e('CollExpr'), key: e('KeyExpr'), value: e('ValExpr'), condition: e('CondExpr'), group: v.Group, openRange: range(v.OpenRange), closeRange: range(v.CloseRange), range: r() };
    case 'SplatExpr': return { kind: 'splat', source: e('Source'), each: e('Each'), item: e('Item'), markerRange: range(v.MarkerRange), range: r() };
    case 'AnonSymbolExpr': return { kind: 'anonymous', range: r() };
    case 'IndexExpr': return { kind: 'index', collection: e('Collection'), key: e('Key'), openRange: range(v.OpenRange), bracketRange: range(v.BracketRange), range: r() };
    case 'ParenthesesExpr': return { kind: 'parentheses', expression: e('Expression'), range: r() };
    case 'TemplateExpr': return { kind: 'template', parts: es('Parts'), range: r() };
    case 'TemplateWrapExpr': return { kind: 'templateWrap', wrapped: e('Wrapped'), range: r() };
    case 'TemplateJoinExpr': return { kind: 'templateJoin', tuple: e('Tuple'), range: r() };
    default: throw new Error(`Unhandled Go AST kind ${String(v.goType)}`);
  }
}
/** Remove only TS convenience fields absent from the Go AST, not parser data. */
export function actualAST(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(actualAST);
  const v = value as RecordValue;
  if (typeof v.severity === 'string' && typeof v.summary === 'string') return { ...v, context: v.context ?? null };
  return Object.fromEntries(Object.entries(v).filter(([key, item]) => item !== undefined && key !== 'numberText' && key !== 'attributeOnly' && !(v.kind === 'traversal' && key === 'parts')).map(([key, item]) => [key, actualAST(item)]));
}
export function actualDiagnostics(value: readonly Diagnostic[]): Diagnostic[] { return value.map(d => ({ ...d, context: d.context ?? null })) }
export function oracleTokens(value: unknown): unknown[] { return array(value).map(item => { const t = object(item); const r = t.range as { Filename: string; Start: Pos; End: Pos }; return { type: t.type, bytes: Buffer.from(t.bytes as string, 'base64'), range: { filename: r.Filename, start: position(r.Start), end: position(r.End) } } }) }
