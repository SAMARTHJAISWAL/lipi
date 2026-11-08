import { LipiError, lineCol, type Program } from './ast';
import { check, type Checked } from './check';
import { generate, type ByteRegion } from './codegen';
import { lex, type Token } from './lexer';
import { parse } from './parser';

export interface CompileResult {
  tokens: Token[];
  program: Program | null;
  checked: Checked | null;
  bytes: Uint8Array<ArrayBuffer> | null;
  wat: string;
  regions: ByteRegion[];
  error: { message: string; stage: 'syntax' | 'type'; line: number; col: number; start: number; end: number } | null;
  /** Milliseconds spent in each stage. */
  timings: { lex: number; parse: number; check: number; generate: number };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Run the whole pipeline, keeping each stage's output so the page can show it. */
export function compile(src: string): CompileResult {
  const r: CompileResult = { tokens: [], program: null, checked: null, bytes: null, wat: '', regions: [], error: null, timings: { lex: 0, parse: 0, check: 0, generate: 0 } };
  try {
    let t = now();
    r.tokens = lex(src);
    r.timings.lex = now() - t;
    t = now();
    r.program = parse(src);
    r.timings.parse = now() - t;
    t = now();
    r.checked = check(r.program);
    r.timings.check = now() - t;
    t = now();
    const out = generate(r.checked);
    r.timings.generate = now() - t;
    r.bytes = out.bytes;
    r.wat = out.wat;
    r.regions = out.regions;
  } catch (caught) {
    let e = caught;
    // Recursion in the compiler itself runs out of stack on absurdly deep nesting.
    if (e instanceof RangeError) e = new LipiError('This program is nested too deeply to compile (thousands of levels of brackets or blocks).', { start: 0, end: 1 }, 'syntax');
    if (!(e instanceof LipiError)) throw e;
    const { line, col } = lineCol(src, e.span.start);
    r.error = { message: e.message, stage: e.stage, line, col, start: e.span.start, end: Math.max(e.span.end, e.span.start + 1) };
  }
  return r;
}

export { formatFloat, interpret, Trap } from './interp';
export { IMPORTS } from './codegen';
export { BUILTINS } from './check';
