/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Go's White_Space excludes BOM. Keep the original port's code points for both scanner and parser.
const whitespace = /[\t\n\v\f\r\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;
const leading = new RegExp(`^${whitespace.source}+`, 'u');
const trailing = new RegExp(`${whitespace.source}+$`, 'u');

export const matchesWhitespace = (character: string): boolean => whitespace.test(character);
export const trimLeadingWhitespace = (value: string): string => value.replace(leading, '');
export const trimTrailingWhitespace = (value: string): string => value.replace(trailing, '');
