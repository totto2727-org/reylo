/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Parser-reachable AST translated from hashicorp/hcl at
// 00057cf06d7b38a3f89e6e54d622eee98322b314. Evaluation is intentionally excluded.

// oxlint-disable-next-line import/no-relative-parent-imports -- Reuse the package's native guards without loading Effect.
import { matchesNumber, matchesString } from "../native-predicates.ts";

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

export const rangeBetween = function rangeBetween(first: Range, last: Range): Range {
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public source range field order.
  return { filename: first.filename, start: { ...first.start }, end: { ...last.end } };
};
export const emptyRangeAt = function emptyRangeAt(range: Range, at: "start" | "end" = "end"): Range {
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public source range field order.
  return { filename: range.filename, start: { ...range[at] }, end: { ...range[at] } };
};
export const rangeString = function rangeString(range: Range): string {
  if (range.start.line === range.end.line) {return `${range.filename}:${range.start.line},${range.start.column}-${range.end.column}`;}
  return `${range.filename}:${range.start.line},${range.start.column}-${range.end.line},${range.end.column}`;
};
const FIRST_PART = 0;
const SINGLE_PART = 1;

/**
 * Recognizes the upstream string-literal AST, including a dynamic error placeholder.
 * @param {Expression} expression - The expression to inspect.
 * @returns {boolean} Whether it has a single literal or eligible dynamic part.
 */
// oxlint-disable-next-line rules/no-type-predicate -- Preserve the public nonempty tuple narrowing without transporting HCL nodes through Effect.
export const isStringLiteral = function isStringLiteral(expression: Expression): expression is Template & { parts: [Literal | Dynamic] } {
  if (expression.kind !== "template" || expression.parts.length !== SINGLE_PART) {return false;}
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Parser-produced single-part templates carry a dense part array.
  const part = expression.parts[FIRST_PART]!;
  return part.kind === "literal" || (part.kind === "dynamic" && !part.diagnostics);
};
export const staticString = function staticString(expression: Expression): string | undefined {
  if (expression.kind === 'literal' && matchesString(expression.value)) {return expression.value;}
  if (isStringLiteral(expression) && expression.parts[FIRST_PART].kind === 'literal' && matchesString(expression.parts[FIRST_PART].value)) {return expression.parts[FIRST_PART].value;}
  return undefined;
};
export const staticTraversal = function staticTraversal(expression: Expression): Readonly<(string | number)[]> | undefined {
  return expression.kind === 'traversal' && !expression.steps.some(step => (step.dynamic ?? false) || (!matchesString(step.value) && !matchesNumber(step.value))) ? expression.parts : undefined;
};

const expressionStartChild = (expression: Expression): { node: Expression } | undefined => {
  if (expression.kind === "parentheses") {return { node: expression.expression };}
  if (expression.kind === "conditional" || expression.kind === "binary") {
    return { node: expression.kind === "conditional" ? expression.condition : expression.left };
  }
  if (expression.kind === "objectKey" || expression.kind === "templateJoin") {
    return { node: expression.kind === "objectKey" ? expression.wrapped : expression.tuple };
  }
  if (expression.kind === "template") {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A parsed template always emits at least a literal or interpolation part.
    return { node: expression.parts[FIRST_PART]! };
  }
  return undefined;
};

/**
 * Finds the start range that upstream HCL assigns to an expression.
 * @param {Expression} expression - The data-only expression AST.
 * @returns {Range} The range of its first syntactic element.
 */
export const expressionStartRange = function expressionStartRange(expression: Expression): Range {
  const child = expressionStartChild(expression);
  if (child) {return expressionStartRange(child.node);}
  if (expression.kind === "call") {return rangeBetween(expression.nameRange, expression.openParenRange);}
  if (expression.kind === "unary" || expression.kind === "splat") {
    return expression.kind === "unary" ? expression.symbolRange : expression.markerRange;
  }
  if (expression.kind === "index" || expression.kind === "tuple" || expression.kind === "object" || expression.kind === "for") {
    return expression.openRange;
  }
  return expression.range;
};
export const staticObjectKey = function staticObjectKey(expression: ObjectKey): string | undefined {
  if (!expression.forceNonLiteral && expression.wrapped.kind === "traversal" && expression.wrapped.steps.length === SINGLE_PART) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A parsed traversal's first part is its root identifier, with numeric parts only in later indexes.
    return expression.wrapped.parts[FIRST_PART] as string;
  }
  return staticString(expression.wrapped);
};
