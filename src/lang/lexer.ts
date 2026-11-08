import { LipiError, type Span } from './ast';

export type TokenKind = 'int' | 'float' | 'name' | 'keyword' | 'type' | 'op' | 'punct' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  span: Span;
}

export const KEYWORDS = new Set(['fn', 'let', 'if', 'else', 'while', 'for', 'in', 'break', 'continue', 'return', 'true', 'false']);
export const TYPES = new Set(['int', 'float', 'bool']);

// Longest first, so "<=" wins over "<".
const OPS = ['..', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '->', '+=', '-=', '*=', '/=', '%=', '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^'];
const PUNCT = new Set(['(', ')', '{', '}', ',', ';', ':']);

const isDigit = (c: string) => c >= '0' && c <= '9';
const isNameStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isName = (c: string) => isNameStart(c) || isDigit(c);

/** Split source text into tokens. Comments (`// ...`) and whitespace are skipped. */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (isDigit(c)) {
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < src.length && /[0-9a-fA-F_]/.test(src[i]!)) i++;
        if (!/[0-9a-fA-F]/.test(src.slice(start + 2, i))) throw new LipiError('A hex number needs digits after 0x, like 0xff', { start, end: Math.max(i, start + 2) }, 'syntax');
        if (isName(src[i] ?? '')) throw new LipiError(`"${src[i]}" is not a hex digit (0-9, a-f)`, { start: i, end: i + 1 }, 'syntax');
        out.push({ kind: 'int', text: src.slice(start, i), span: { start, end: i } });
        continue;
      }
      while (i < src.length && (isDigit(src[i]!) || src[i] === '_')) i++;
      let kind: TokenKind = 'int';
      // A dot followed by a digit makes a float; "0..10" stays a range.
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        kind = 'float';
        i++;
        while (i < src.length && (isDigit(src[i]!) || src[i] === '_')) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (isDigit(src[i] ?? '')) {
          kind = 'float';
          while (i < src.length && isDigit(src[i]!)) i++;
        } else i = save;
      }
      if (isNameStart(src[i] ?? '')) throw new LipiError(`Unexpected letter in a number`, { start: i, end: i + 1 }, 'syntax');
      out.push({ kind, text: src.slice(start, i), span: { start, end: i } });
      continue;
    }
    if (isNameStart(c)) {
      while (i < src.length && isName(src[i]!)) i++;
      const text = src.slice(start, i);
      out.push({ kind: KEYWORDS.has(text) ? 'keyword' : TYPES.has(text) ? 'type' : 'name', text, span: { start, end: i } });
      continue;
    }
    if (PUNCT.has(c)) {
      out.push({ kind: 'punct', text: c, span: { start, end: i + 1 } });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ kind: 'op', text: op, span: { start, end: i + op.length } });
      i += op.length;
      continue;
    }
    throw new LipiError(`Unexpected character ${JSON.stringify(c)}`, { start, end: i + 1 }, 'syntax');
  }
  out.push({ kind: 'eof', text: '', span: { start: src.length, end: src.length } });
  return out;
}
