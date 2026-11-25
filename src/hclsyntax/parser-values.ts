/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// AST nodes and diagnostics translated from hclsyntax/parser.go and parser_template.go.
import type { Diagnostic, Expression, Literal, Range } from "./types.ts";
// oxlint-disable-next-line import/no-relative-parent-imports -- Share the native guard with the package without loading Effect.
import { matchesString } from "../native-predicates.ts";

/**
 * Creates an HCL syntax diagnostic.
 * @param {string} summary - The short HCL diagnostic.
 * @param {string} detail - The full HCL diagnostic.
 * @param {Range} subject - The token or range with the problem.
 * @param {Range} [context] - The enclosing grammar range.
 * @returns {Diagnostic} A diagnostic in parser output order.
 */
// oxlint-disable-next-line eslint/max-params -- The HCL diagnostic carries a message, detail, subject, and optional context range.
export const error = (summary: string, detail: string, subject: Range, context?: Range): Diagnostic =>
  // oxlint-disable-next-line eslint/sort-keys -- Keep the existing diagnostic serialization order.
  ({ severity: "error", summary, detail, subject, ...(context ? { context } : {}) });

export const dynamic = (range: Range, diagnostics?: Diagnostic[]): Expression =>
  ({ kind: "dynamic", range, ...(diagnostics ? { diagnostics } : {}) });

export const literal = (value: Literal["value"], range: Range): Literal =>
  // oxlint-disable-next-line eslint/sort-keys -- Keep the existing AST node serialization order.
  ({ kind: "literal", value: matchesString(value) ? value.normalize("NFC") : value, range });
