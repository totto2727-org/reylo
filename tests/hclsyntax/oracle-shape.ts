// Copyright IBM Corp. 2014, 2025
// SPDX-License-Identifier: MPL-2.0
// Shape adapter only. Every expected value comes from the pinned Go oracle.
// oxlint-disable-next-line rules/no-node-imports -- Fail the native conformance runner when the oracle input is malformed.
import assert from "node:assert/strict";
import type { Diagnostic, Pos, Range, Token } from "#reylo-source/hclsyntax/types.ts";
import { isRecord, matchesNull, matchesNumber, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";

type RecordValue = Record<string, unknown>;

const object = (value: unknown): RecordValue => {
  assert.ok(isRecord(value));
  return value;
};

const array = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value));
  return value;
};

const text = (value: unknown): string => {
  assert.ok(matchesString(value));
  return value;
};

const number = (value: unknown): number => {
  assert.ok(matchesNumber(value));
  return value;
};

// oxlint-disable-next-line unicorn/no-null -- The Go oracle encodes absent AST nodes and diagnostic ranges as JSON null.
const ABSENT = null;
const GO_ERROR = 1;

export const position = (value: unknown): Pos => {
  const { Byte, Column, Line } = object(value);
  return { byte: number(Byte), column: number(Column), line: number(Line) };
};

const range = (value: unknown): Range => {
  const { End, Filename, Start } = object(value);
  return { end: position(End), filename: text(Filename), start: position(Start) };
};

const diagnostic = (value: unknown): Diagnostic => {
  const node = object(value);
  return {
    context: matchesNull(node.Context) ? ABSENT : range(node.Context),
    detail: text(node.Detail),
    severity: node.Severity === GO_ERROR ? "error" : "warning",
    subject: matchesNull(node.Subject) ? ABSENT : range(node.Subject),
    summary: text(node.Summary),
  };
};

export const diagnostics = (value: unknown): Diagnostic[] => array(value).map((entry) => diagnostic(entry));

const dynamicLiteral = Symbol("upstream dynamic literal");
const literal = (value: unknown): unknown => {
  const node = object(value);
  switch (node.cty) {
    case "string": case "bool": {return node.value;}
    case "number": {return Number(node.value);}
    case "null": {return ABSENT;}
    case "unknown": {return dynamicLiteral;}
    default: {return assert.fail(`Unsupported oracle literal ${JSON.stringify(node)}`);}
  }
};

const operators: Record<string, string> = {
  add: "+",
  and: "&&",
  divide: "/",
  equal: "==",
  greater: ">",
  greaterEqual: ">=",
  less: "<",
  lessEqual: "<=",
  modulo: "%",
  multiply: "*",
  negate: "-",
  not: "!",
  notEqual: "!=",
  or: "||",
  subtract: "-",
};

const step = (entry: unknown): unknown => {
  const node = object(entry);
  const location = range(node.SrcRange);
  if (node.goType === "TraverseIndex") {
    const value = literal(node.Key);
    return value === dynamicLiteral
      ? { dynamic: true, kind: "index", range: location, value: ABSENT }
      : { kind: "index", range: location, value };
  }
  return { kind: node.goType === "TraverseRoot" ? "root" : "attribute", range: location, value: node.Name };
};

const steps = (value: unknown): unknown[] => array(value).map((entry) => step(entry));

interface OracleNode {
  expression: (key: string) => unknown;
  list: (key: string) => unknown[];
  location: () => Range;
  node: RecordValue;
  read: (value: unknown) => unknown;
}

const objectItem = (entry: unknown, read: OracleNode["read"]): unknown => {
  const item = object(entry);
  return { key: read(item.KeyExpr), value: read(item.ValueExpr) };
};

const readers: Record<string, (entry: OracleNode) => unknown> = {
  AnonSymbolExpr: ({ location }) => ({ kind: "anonymous", range: location() }),
  Attribute: ({ expression, location, node }) => ({
    equalsRange: range(node.EqualsRange), expression: expression("Expr"), kind: "attribute",
    name: node.Name, nameRange: range(node.NameRange), range: location(),
  }),
  BinaryOpExpr: ({ expression, location, node }) => ({
    kind: "binary", left: expression("LHS"), operator: operators[text(node.Op)], range: location(), right: expression("RHS"),
  }),
  Block: ({ expression, location, node }) => ({
    body: expression("Body"), closeBraceRange: range(node.CloseBraceRange), kind: "block",
    labelRanges: array(node.LabelRanges).map((entry) => range(entry)), labels: node.Labels,
    openBraceRange: range(node.OpenBraceRange), range: location(), type: node.Type, typeRange: range(node.TypeRange),
  }),
  Body: ({ list, location, node, read }) => ({
    attributes: Object.fromEntries(Object.entries(object(node.Attributes)).map(([name, item]) => [name, read(item)])),
    blocks: list("Blocks"), endRange: range(node.EndRange), kind: "body", range: location(),
  }),
  ConditionalExpr: ({ expression, location }) => ({
    condition: expression("Condition"), falseResult: expression("FalseResult"), kind: "conditional", range: location(), trueResult: expression("TrueResult"),
  }),
  ExprSyntaxError: ({ location, node }) => ({ diagnostics: diagnostics(node.ParseDiags), kind: "dynamic", range: location() }),
  ForExpr: ({ expression, location, node }) => ({
    closeRange: range(node.CloseRange), collection: expression("CollExpr"), condition: expression("CondExpr"),
    group: node.Group, key: expression("KeyExpr"), keyVar: node.KeyVar, kind: "for", openRange: range(node.OpenRange),
    range: location(), value: expression("ValExpr"), valueVar: node.ValVar,
  }),
  FunctionCallExpr: ({ list, location, node }) => ({
    args: list("Args"), closeParenRange: range(node.CloseParenRange), expandFinal: node.ExpandFinal,
    kind: "call", name: node.Name, nameRange: range(node.NameRange), openParenRange: range(node.OpenParenRange), range: location(),
  }),
  IndexExpr: ({ expression, location, node }) => ({
    bracketRange: range(node.BracketRange), collection: expression("Collection"), key: expression("Key"),
    kind: "index", openRange: range(node.OpenRange), range: location(),
  }),
  LiteralValueExpr: ({ location, node }) => {
    const value = literal(node.Val);
    return value === dynamicLiteral ? { kind: "dynamic", range: location() } : { kind: "literal", range: location(), value };
  },
  ObjectConsExpr: ({ location, node, read }) => ({
    items: array(node.Items).map((entry) => objectItem(entry, read)), kind: "object", openRange: range(node.OpenRange), range: location(),
  }),
  ObjectConsKeyExpr: ({ expression, location, node }) => ({
    forceNonLiteral: node.ForceNonLiteral, kind: "objectKey", range: location(), wrapped: expression("Wrapped"),
  }),
  ParenthesesExpr: ({ expression, location }) => ({ expression: expression("Expression"), kind: "parentheses", range: location() }),
  RelativeTraversalExpr: ({ expression, location, node }) => ({
    kind: "relativeTraversal", range: location(), source: expression("Source"), steps: steps(node.Traversal),
  }),
  ScopeTraversalExpr: ({ location, node }) => ({ kind: "traversal", range: location(), steps: steps(node.Traversal) }),
  SplatExpr: ({ expression, location, node }) => ({
    each: expression("Each"), item: expression("Item"), kind: "splat", markerRange: range(node.MarkerRange), range: location(), source: expression("Source"),
  }),
  TemplateExpr: ({ list, location }) => ({ kind: "template", parts: list("Parts"), range: location() }),
  TemplateJoinExpr: ({ expression, location }) => ({ kind: "templateJoin", range: location(), tuple: expression("Tuple") }),
  TemplateWrapExpr: ({ expression, location }) => ({ kind: "templateWrap", range: location(), wrapped: expression("Wrapped") }),
  TupleConsExpr: ({ list, location, node }) => ({
    expressions: list("Exprs"), kind: "tuple", openRange: range(node.OpenRange), range: location(),
  }),
  UnaryOpExpr: ({ expression, location, node }) => ({
    kind: "unary", operand: expression("Val"), operator: operators[text(node.Op)], range: location(), symbolRange: range(node.SymbolRange),
  }),
};

export const oracleAST = (value: unknown): unknown => {
  if (matchesNull(value)) {return ABSENT;}
  const node = object(value);
  const kind = text(node.goType);
  const read = Object.hasOwn(readers, kind) ? readers[kind] : undefined;
  assert.ok(!matchesUndefined(read), `Unhandled Go AST kind ${kind}`);
  return read({
    expression: (key) => oracleAST(node[key]),
    list: (key) => array(node[key]).map((entry) => oracleAST(entry)),
    location: () => range(node.ComputedRange ?? node.SrcRange),
    node,
    read: oracleAST,
  });
};

// Keep every parser field exposed by the Go AST and remove the native convenience fields.
export const actualAST = (value: unknown): unknown => {
  if (Array.isArray(value)) {return value.map((entry) => actualAST(entry));}
  if (!isRecord(value)) {return value;}
  if (matchesString(value.severity) && matchesString(value.summary)) {return { ...value, context: value.context ?? ABSENT };}
  const entries = Object.entries(value).filter(([key, item]) =>
    !matchesUndefined(item) && key !== "numberText" && key !== "attributeOnly" && !(value.kind === "traversal" && key === "parts"),
  );
  return Object.fromEntries(entries.map(([key, item]) => [key, actualAST(item)]));
};

export const actualDiagnostics = (value: Readonly<Diagnostic[]>): Diagnostic[] =>
  value.map((entry) => ({ ...entry, context: entry.context ?? ABSENT }));

export const oracleTokens = (value: unknown): Token[] => array(value).map((entry) => {
  const node = object(entry);
  return { bytes: Buffer.from(text(node.bytes), "base64"), range: range(node.range), type: text(node.type) };
});
