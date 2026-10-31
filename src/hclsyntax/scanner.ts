/*! @license MPL-2.0
 * Copyright IBM Corp. 2014, 2025
 * Translated source: https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314
 * Covered source and modifications are available in this Reylo fork. See licenses/hashicorp-hcl-MPL-2.0.txt.
 */
// Port of hclsyntax/scan_tokens.go and token.go at HCL revision
// 00057cf06d7b38a3f89e6e54d622eee98322b314. Generated action numbers are retained.
import type { Token, Pos, Diagnostic } from './types.ts';
import * as tables from './scanner-tables.ts';
import * as stringTables from './string-literal-tables.ts';
import { RagelState, runRagel } from './scanner-ragel.ts';
import { scanGraphemeCluster } from './scanner-grapheme.ts';
export { scanGraphemeCluster } from './scanner-grapheme.ts';
export function graphemeClusters(data: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < data.length;) {
    const advance = scanGraphemeCluster(data.subarray(offset));
    result.push(data.subarray(offset, offset + advance));
    offset += advance;
  }
  return result;
}

const selfTokens: Record<number, string> = {
  123: 'TokenOBrace', 125: 'TokenCBrace', 91: 'TokenOBrack', 93: 'TokenCBrack',
  40: 'TokenOParen', 41: 'TokenCParen', 42: 'TokenStar', 47: 'TokenSlash',
  43: 'TokenPlus', 45: 'TokenMinus', 37: 'TokenPercent', 61: 'TokenEqual',
  60: 'TokenLessThan', 62: 'TokenGreaterThan', 33: 'TokenBang', 46: 'TokenDot',
  44: 'TokenComma', 63: 'TokenQuestion', 58: 'TokenColon', 10: 'TokenNewline',
  38: 'TokenBitwiseAnd', 124: 'TokenBitwiseOr', 126: 'TokenBitwiseNot',
  94: 'TokenBitwiseXor', 39: 'TokenApostrophe', 96: 'TokenBacktick', 59: 'TokenSemicolon',
};

// Token accumulation deliberately segments each token separately, as token.go does.
// Whitespace between tokens is ASCII, so the skipped byte count is a column count.
function scanTokens(input: Uint8Array, filename: string, start: Pos, mode: 'normal' | 'template' | 'ident'): Token[] {
  const bom = input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? 3 : 0;
  const data = input.subarray(bom);
  const startByte = start.byte + bom;
  let pos = { ...start, byte: startByte };
  const tokens: Token[] = [];
  const emit = (type: string, from: number, to: number) => {
    const begin: Pos = { ...pos, column: pos.column + from + startByte - pos.byte, byte: from + startByte };
    const end: Pos = { ...begin, byte: to + startByte };
    const bytes = data.subarray(from, to);
    for (let offset = 0; offset < bytes.length;) {
      const n = scanGraphemeCluster(bytes.subarray(offset));
      if ((n === 1 && bytes[offset] === 10) || (n === 2 && bytes[offset] === 13 && bytes[offset + 1] === 10)) {
        end.line++;
        end.column = 1;
      } else end.column++;
      offset += n;
    }
    pos = end;
    tokens.push({ type, bytes, range: { filename, start: begin, end } });
  };
  const s = new RagelState(mode === 'normal' ? tables.en_main : mode === 'template' ? tables.en_bareTemplate : tables.en_identOnly);
  const stack: number[] = [];
  const retBraces: number[] = [];
  const heredocs: { marker: Uint8Array; startOfLine: boolean }[] = [];
  let braces = 0;
  const token = (type: string) => emit(type, s.ts, s.te);
  const selfToken = () => {
    if (s.te - s.ts !== 1) throw new Error('selfToken only works for single-character tokens');
    const type = selfTokens[data[s.ts]!];
    if (!type) throw new Error('Unrecognized scanner self token');
    token(type);
  };
  const call = (cs: number) => { stack.push(s.cs); s.cs = cs; return true; };
  const ret = () => {
    const cs = stack.pop();
    if (cs === undefined) throw new Error('HCL scanner return stack underflow');
    s.cs = cs;
    return true;
  };
  const end = (kind: 'next' | 'hold' | 'rewind') => {
    if (kind === 'next') s.te = s.p + 1;
    else if (kind === 'hold') { s.te = s.p; s.p--; }
    else s.p = s.te - 1;
  };
  const lit = (type: string, kind: 'next' | 'hold' | 'rewind') => { end(kind); token(type); };
  const interp = (type: string, kind: 'next' | 'hold') => {
    lit(type, kind);
    braces++;
    retBraces.push(braces);
    if (heredocs.length) heredocs[heredocs.length - 1]!.startOfLine = false;
    return call(tables.en_main);
  };
  const midline = (kind: 'hold' | 'rewind') => {
    end(kind);
    heredocs[heredocs.length - 1]!.startOfLine = false;
    token('TokenStringLit');
  };
  runRagel(data, tables, s, id => {
    switch (id) {
      case 0: s.p--; break;
      case 1: s.ts = 0; break;
      case 2: s.act = 0; break;
      case 3: s.ts = s.p; break;
      case 4: s.te = s.p + 1; break;
      case 5: s.act = 4; break;
      case 6: s.act = 6; break;
      case 7: case 23: case 35: return interp('TokenTemplateInterp', 'next');
      case 8: case 24: case 36: return interp('TokenTemplateControl', 'next');
      case 9: lit('TokenCQuote', 'next'); return ret();
      case 10: lit('TokenQuotedLit', 'next'); break;
      case 11: case 26: case 38: case 47: case 73: lit('TokenBadUTF8', 'next'); break;
      case 12: case 27: case 39: return interp('TokenTemplateInterp', 'hold');
      case 13: case 28: case 40: return interp('TokenTemplateControl', 'hold');
      case 14: lit('TokenQuotedLit', 'hold'); break;
      case 15: lit('TokenQuotedNewline', 'hold'); break;
      case 16: case 81: lit('TokenInvalid', 'hold'); break;
      case 17: case 30: case 42: case 50: case 80: lit('TokenBadUTF8', 'hold'); break;
      case 18: lit('TokenQuotedLit', 'rewind'); break;
      case 19: case 52: case 85: lit('TokenBadUTF8', 'rewind'); break;
      case 20:
        if (s.act === 4) lit('TokenQuotedLit', 'rewind');
        else if (s.act === 6) lit('TokenInvalid', 'rewind');
        break;
      case 21: s.act = 11; break;
      case 22: s.act = 12; break;
      case 25: {
        s.te = s.p + 1;
        const doc = heredocs[heredocs.length - 1]!;
        if (doc.startOfLine && equalBytes(trimSpace(data.subarray(s.ts, s.te)), doc.marker)) {
          let nls = s.te - 1;
          const nle = s.te;
          s.te--;
          if (data[s.te - 1] === 13) { nls--; s.te--; }
          token('TokenCHeredoc');
          s.ts = nls;
          s.te = nle;
          token('TokenNewline');
          heredocs.pop();
          return ret();
        }
        doc.startOfLine = true;
        token('TokenStringLit');
        break;
      }
      case 29: midline('hold'); break;
      case 31: midline('rewind'); break;
      case 32:
        if (s.act === 0) { s.cs = 0; return true; }
        if (s.act === 11) midline('rewind');
        else if (s.act === 12) lit('TokenBadUTF8', 'rewind');
        break;
      case 33: s.act = 15; break;
      case 34: s.act = 16; break;
      case 37: lit('TokenStringLit', 'next'); break;
      case 41: lit('TokenStringLit', 'hold'); break;
      case 43: lit('TokenStringLit', 'rewind'); break;
      case 44:
        if (s.act === 0) { s.cs = 0; return true; }
        if (s.act === 15) lit('TokenStringLit', 'rewind');
        else if (s.act === 16) lit('TokenBadUTF8', 'rewind');
        break;
      case 45: s.act = 17; break;
      case 46: s.act = 18; break;
      case 48: case 74: lit('TokenInvalid', 'next'); break;
      case 49: case 77: lit('TokenIdent', 'hold'); break;
      case 51: case 83: lit('TokenIdent', 'rewind'); break;
      case 53:
        if (s.act === 17) lit('TokenIdent', 'rewind');
        else if (s.act === 18) lit('TokenBadUTF8', 'rewind');
        break;
      case 54: s.act = 22; break;
      case 55: s.act = 40; break;
      case 56: lit('TokenComment', 'next'); break;
      case 57: lit('TokenNewline', 'next'); break;
      case 58: lit('TokenEqualOp', 'next'); break;
      case 59: lit('TokenNotEqual', 'next'); break;
      case 60: lit('TokenGreaterThanEq', 'next'); break;
      case 61: lit('TokenLessThanEq', 'next'); break;
      case 62: lit('TokenAnd', 'next'); break;
      case 63: lit('TokenOr', 'next'); break;
      case 64: lit('TokenDoubleColon', 'next'); break;
      case 65: lit('TokenEllipsis', 'next'); break;
      case 66: lit('TokenFatArrow', 'next'); break;
      case 67: end('next'); selfToken(); break;
      case 68: lit('TokenOBrace', 'next'); braces++; break;
      case 69: case 70:
        s.te = s.p + 1;
        if (retBraces.length && retBraces[retBraces.length - 1] === braces) {
          token('TokenTemplateSeqEnd');
          braces--;
          retBraces.pop();
          return ret();
        }
        token(id === 69 ? 'TokenCBrace' : 'TokenTemplateSeqEnd');
        braces--;
        break;
      case 71:
        lit('TokenOQuote', 'next');
        return call(tables.en_stringTemplate);
      case 72: {
        lit('TokenOHeredoc', 'next');
        let marker = data.subarray(s.ts + 2, s.te - 1);
        if (marker[0] === 45) marker = marker.subarray(1);
        if (marker[marker.length - 1] === 13) marker = marker.subarray(0, marker.length - 1);
        heredocs.push({ marker, startOfLine: true });
        return call(tables.en_heredocTemplate);
      }
      case 75: end('hold'); break;
      case 76: lit('TokenNumberLit', 'hold'); break;
      case 78: lit('TokenComment', 'hold'); break;
      case 79: end('hold'); selfToken(); break;
      case 82: lit('TokenNumberLit', 'rewind'); break;
      case 84: end('rewind'); selfToken(); break;
      case 86:
        if (s.act === 22) lit('TokenIdent', 'rewind');
        else if (s.act === 40) lit('TokenBadUTF8', 'rewind');
        break;
      default: throw new Error(`Unknown HCL scanner action ${id}`);
    }
  });
  if (s.cs < tables.first_final) emit(mode === 'template' && stack.length === 0 ? 'TokenStringLit' : 'TokenInvalid', s.ts, data.length);
  emit('TokenEOF', data.length, data.length);
  return tokens;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
// bytes.TrimSpace uses Unicode White_Space, which deliberately excludes BOM.
function trimSpace(data: Uint8Array): Uint8Array {
  const ws = (n: number) => (n >= 9 && n <= 13) || n === 32 || n === 0x85 || n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) || n === 0x2028 || n === 0x2029 || n === 0x202f || n === 0x205f || n === 0x3000;
  // The heredoc candidate is already UTF-8 tokenized. Trimming via code points is
  // safe here and preserves the original bytes by calculating UTF-8 widths.
  let from = 0;
  let to = data.length;
  const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
  let leading = true;
  let trailing = 0;
  for (const ch of decoded) {
    const n = ch.codePointAt(0)!;
    const width = n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
    if (ws(n)) {
      if (leading) from += width;
      else trailing += width;
    } else { leading = false; trailing = 0; }
  }
  to -= trailing;
  return data.subarray(from, to);
}

export function lexConfig(input: Uint8Array, filename: string, start: Pos = { line: 1, column: 1, byte: 0 }): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens = scanTokens(input, filename, start, 'normal');
  return { tokens, diagnostics: checkInvalidTokens(tokens) };
}
export const lexExpression = lexConfig;
export function lexTemplate(input: Uint8Array, filename: string, start: Pos = { line: 1, column: 1, byte: 0 }): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens = scanTokens(input, filename, start, 'template');
  return { tokens, diagnostics: checkInvalidTokens(tokens) };
}
export function validIdentifier(value: string | Uint8Array): boolean {
  const tokens = scanTokens(typeof value === 'string' ? new TextEncoder().encode(value) : value, '', { line: 0, column: 0, byte: 0 }, 'ident');
  return tokens.length === 2 && tokens[0]!.type === 'TokenIdent' && tokens[1]!.type === 'TokenEOF';
}

// Exact escape/literal segmentation from scan_string_lit.go, not string decoding.
export function scanStringLit(data: Uint8Array, quoted: boolean): Uint8Array[] {
  const s = new RagelState(quoted ? stringTables.en_quoted : stringTables.en_unquoted);
  const ret: Uint8Array[] = [];
  runRagel(data, stringTables, s, id => {
    switch (id) {
      case 0:
        if (s.te < s.p) ret.push(data.subarray(s.te, s.p));
        s.ts = s.p;
        break;
      case 1:
        s.te = s.p;
        ret.push(data.subarray(s.ts, s.te));
        break;
      default: throw new Error(`Unknown string literal scanner action ${id}`);
    }
  });
  if (s.te < s.p) ret.push(data.subarray(s.te, s.p));
  if (s.cs < stringTables.first_final) ret.push(data.subarray(s.p));
  return ret;
}

export function checkInvalidTokens(tokens: Token[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let toldBitwise = 0, toldExponent = 0, toldBacktick = 0, toldApostrophe = 0, toldSemicolon = 0, toldTabs = 0, toldBadUTF8 = 0;
  for (const tok of tokens) {
    const add = (summary: string, detail: string) => diagnostics.push({ severity: 'error', summary, detail, subject: { ...tok.range, start: { ...tok.range.start }, end: { ...tok.range.end } } });
    switch (tok.type) {
      case 'TokenBitwiseAnd': case 'TokenBitwiseOr': case 'TokenBitwiseXor': case 'TokenBitwiseNot':
        if (toldBitwise < 4) {
          const suggestion = tok.type === 'TokenBitwiseAnd' ? ' Did you mean boolean AND ("&&")?' : tok.type === 'TokenBitwiseOr' ? ' Did you mean boolean OR ("||")?' : tok.type === 'TokenBitwiseNot' ? ' Did you mean boolean NOT ("!")?' : '';
          add('Unsupported operator', `Bitwise operators are not supported.${suggestion}`);
          toldBitwise++;
        }
        break;
      case 'TokenStarStar':
        if (toldExponent < 1) {
          add('Unsupported operator', '"**" is not a supported operator. Exponentiation is not supported as an operator.');
          toldExponent++;
        }
        break;
      case 'TokenBacktick':
        if (toldBacktick % 2 === 0) add('Invalid character', 'The "`" character is not valid. To create a multi-line string, use the "heredoc" syntax, like "<<EOT".');
        if (toldBacktick <= 2) toldBacktick++;
        break;
      case 'TokenApostrophe':
        if (toldApostrophe % 2 === 0) add('Invalid character', 'Single quotes are not valid. Use double quotes (") to enclose strings.');
        if (toldApostrophe <= 2) toldApostrophe++;
        break;
      case 'TokenSemicolon':
        if (toldSemicolon < 1) {
          add('Invalid character', 'The ";" character is not valid. Use newlines to separate arguments and blocks, and commas to separate items in collection values.');
          toldSemicolon++;
        }
        break;
      case 'TokenTabs':
        if (toldTabs < 1) {
          add('Invalid character', 'Tab characters may not be used. The recommended indentation style is two spaces per indent.');
          toldTabs++;
        }
        break;
      case 'TokenBadUTF8':
        if (toldBadUTF8 < 1) {
          add('Invalid character encoding', 'All input files must be UTF-8 encoded. Ensure that UTF-8 encoding is selected in your editor.');
          toldBadUTF8++;
        }
        break;
      case 'TokenQuotedNewline':
        add('Invalid multi-line string', 'Quoted strings may not be split over multiple lines. To produce a multi-line string, either use the \\n escape to represent a newline character or use the "heredoc" multi-line template syntax.');
        break;
      case 'TokenInvalid': {
        const chars = new TextDecoder('utf-8', { ignoreBOM: true }).decode(tok.bytes);
        add('Invalid character', chars === '“' || chars === '”' ? '"Curly quotes" are not valid here. These can sometimes be inadvertently introduced when sharing code via documents or discussion forums. It might help to replace the character with a "straight quote".' : 'This character is not used within the language.');
        break;
      }
    }
  }
  return diagnostics;
}
