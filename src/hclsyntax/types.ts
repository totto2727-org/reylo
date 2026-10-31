/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Parser-reachable AST translated from hashicorp/hcl at
// 00057cf06d7b38a3f89e6e54d622eee98322b314. Evaluation is intentionally excluded.

export interface Pos { line: number; column: number; byte: number }
export interface Range { filename: string; start: Pos; end: Pos }
export interface Token { type: string; bytes: Uint8Array; range: Range }
export interface Diagnostic { severity: 'error' | 'warning'; summary: string; detail: string; subject: Range | null; context?: Range | null }
export interface Body { kind: 'body'; attributes: Record<string, Attribute>; blocks: Block[]; range: Range; endRange: Range }
export interface Attribute { kind: 'attribute'; name: string; expression: Expression; range: Range; nameRange: Range; equalsRange: Range }
export interface Block { kind: 'block'; type: string; labels: string[]; body: Body; range: Range; typeRange: Range; labelRanges: Range[]; openBraceRange: Range; closeBraceRange: Range }
interface Node { range: Range }
export interface Literal extends Node { kind: 'literal'; value: string | number | boolean | null; numberText?: string }
export interface Dynamic extends Node { kind: 'dynamic'; diagnostics?: Diagnostic[] }
export interface TraversalStep { kind: 'root' | 'attribute' | 'index'; value: string | number | boolean | null; range: Range; numberText?: string; dynamic?: boolean }
export interface Traversal extends Node { kind: 'traversal'; parts: (string | number)[]; steps: TraversalStep[] }
export interface RelativeTraversal extends Node { kind: 'relativeTraversal'; source: Expression; steps: TraversalStep[] }
export interface Call extends Node { kind: 'call'; name: string; args: Expression[]; expandFinal: boolean; nameRange: Range; openParenRange: Range; closeParenRange: Range }
export interface Tuple extends Node { kind: 'tuple'; expressions: Expression[]; openRange: Range }
export interface ObjectExpression extends Node { kind: 'object'; items: { key: ObjectKey; value: Expression }[]; openRange: Range }
export interface ObjectKey extends Node { kind: 'objectKey'; wrapped: Expression; forceNonLiteral: boolean }
export interface Unary extends Node { kind: 'unary'; operator: '-' | '!'; operand: Expression; symbolRange: Range }
export interface Binary extends Node { kind: 'binary'; operator: string; left: Expression; right: Expression }
export interface Conditional extends Node { kind: 'conditional'; condition: Expression; trueResult: Expression; falseResult: Expression }
export interface ForExpression extends Node { kind: 'for'; keyVar: string; valueVar: string; collection: Expression; key: Expression | null; value: Expression; condition: Expression | null; group: boolean; openRange: Range; closeRange: Range }
export interface Splat extends Node { kind: 'splat'; source: Expression; each: Expression; item: Anonymous; markerRange: Range; attributeOnly: boolean }
export interface Anonymous extends Node { kind: 'anonymous' }
export interface Index extends Node { kind: 'index'; collection: Expression; key: Expression; openRange: Range; bracketRange: Range }
export interface Parentheses extends Node { kind: 'parentheses'; expression: Expression }
export interface Template extends Node { kind: 'template'; parts: Expression[] }
export interface TemplateWrap extends Node { kind: 'templateWrap'; wrapped: Expression }
export interface TemplateJoin extends Node { kind: 'templateJoin'; tuple: ForExpression }
export type Expression = Literal | Dynamic | Traversal | RelativeTraversal | Call | Tuple | ObjectExpression | ObjectKey | Unary | Binary | Conditional | ForExpression | Splat | Anonymous | Index | Parentheses | Template | TemplateWrap | TemplateJoin;

export function rangeBetween(first: Range, last: Range): Range { return { filename: first.filename, start: { ...first.start }, end: { ...last.end } } }
export function emptyRangeAt(range: Range, at: 'start' | 'end' = 'end'): Range { return { filename: range.filename, start: { ...range[at] }, end: { ...range[at] } } }
export function rangeString(range: Range): string {
  if (range.start.line === range.end.line) return `${range.filename}:${range.start.line},${range.start.column}-${range.end.column}`;
  return `${range.filename}:${range.start.line},${range.start.column}-${range.end.line},${range.end.column}`;
}
/** Match upstream IsStringLiteral, including a literal dynamic error placeholder. */
export function isStringLiteral(expression: Expression): expression is Template & { parts: [Literal | Dynamic] } {
  return expression.kind === 'template' && expression.parts.length === 1 && (expression.parts[0]!.kind === 'literal' || expression.parts[0]!.kind === 'dynamic' && !expression.parts[0]!.diagnostics);
}
export function staticString(expression: Expression): string | undefined {
  if (expression.kind === 'literal' && typeof expression.value === 'string') return expression.value;
  if (isStringLiteral(expression) && expression.parts[0].kind === 'literal' && typeof expression.parts[0].value === 'string') return expression.parts[0].value;
  return undefined;
}
export function staticTraversal(expression: Expression): readonly (string | number)[] | undefined {
  return expression.kind === 'traversal' && !expression.steps.some(step => step.dynamic || typeof step.value !== 'string' && typeof step.value !== 'number') ? expression.parts : undefined;
}

/** Data-only equivalent of the upstream expression StartRange methods. */
export function expressionStartRange(expression: Expression): Range {
  switch (expression.kind) {
    case 'parentheses': return expressionStartRange(expression.expression);
    case 'call': return rangeBetween(expression.nameRange, expression.openParenRange);
    case 'conditional': return expressionStartRange(expression.condition);
    case 'binary': return expressionStartRange(expression.left);
    case 'unary': return expression.symbolRange;
    case 'index': case 'tuple': case 'object': case 'for': return expression.openRange;
    case 'objectKey': return expressionStartRange(expression.wrapped);
    case 'splat': return expression.markerRange;
    case 'template': return expressionStartRange(expression.parts[0]!);
    case 'templateJoin': return expressionStartRange(expression.tuple);
    default: return expression.range;
  }
}
export function staticObjectKey(expression: ObjectKey): string | undefined {
  if (!expression.forceNonLiteral && expression.wrapped.kind === 'traversal' && expression.wrapped.steps.length === 1) return expression.wrapped.parts[0] as string;
  return staticString(expression.wrapped);
}
