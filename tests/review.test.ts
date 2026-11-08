/** Regression tests for the problems an independent review found. */
import { describe, expect, it } from 'vitest';
import { compile } from '../src/lang';
import { program } from './fuzz';
import { runInterp, runWasm } from './run';

const main = (body: string) => `fn main() {\n${body}\n}\n`;

describe('review fixes', () => {
  it('only a unary minus lets 2147483648 through', async () => {
    expect(compile(main('  print(0 - 2147483648 / 2);')).error?.message).toMatch(/too big for an int/);
    expect(compile(main('  print(10 - 2147483648 % 7);')).error?.message).toMatch(/too big for an int/);
    expect(compile(main('  print(-(2147483648));')).error?.message).toMatch(/too big for an int/);
    const ok = main('  print(-2147483648);\n  print(- 2147483648 / 2);\n  print(0 - 2147483647 / 2);');
    expect((await runWasm(ok)).out).toEqual(['-2147483648', '-1073741824', '-1073741823']);
  });

  it('writes -0.0 as -0 in the WebAssembly text', () => {
    expect(compile(main('  print(-0.0);')).wat).toMatch(/f64\.const -0\b/);
  });

  it('gives imports their own names in the text, so a print_int function cannot clash', async () => {
    const src = 'fn print_int(n: int) -> int {\n  print(n);\n  return n + 1;\n}\n' + main('  print(print_int(41));');
    const r = compile(src);
    expect(r.wat).toMatch(/func \$env\.print_int/);
    expect(r.wat).toMatch(/\(func \$print_int \(param/);
    expect((await runWasm(src)).out).toEqual(['41', '42']);
  });

  it('never gives two locals the same name in the text', () => {
    const r = compile(main('  let tmp1 = -2;\n  let tmp2 = 3;\n  print(abs(tmp1) + min(tmp1, tmp2));'));
    for (const fn of r.wat.split('(func $').slice(1)) {
      const names = [...fn.matchAll(/\((?:param|local) \$(\w+)/g)].map((m) => m[1]);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('reports absurdly deep nesting as an error instead of crashing', () => {
    const r = compile(main(`  print(${'('.repeat(20000)}1${')'.repeat(20000)});`));
    expect(r.error?.message).toMatch(/nested too deeply/);
  });

  it('compiles a very large function', async () => {
    const src = main('  print(1000);\n'.repeat(40000));
    const r = compile(src);
    expect(r.error).toBeNull();
    expect(WebAssembly.validate(r.bytes!)).toBe(true);
    expect((await runWasm(src)).out).toHaveLength(40000);
  });

  it('explains bad hex numbers', () => {
    expect(compile(main('  print(0x_);')).error?.message).toMatch(/needs digits after 0x/);
    expect(compile(main('  print(0xfg);')).error?.message).toMatch(/"g" is not a hex digit/);
  });

  it('explains returning a call that returns nothing', () => {
    const r = compile('fn g() {\n  print(1);\n}\n' + 'fn main() {\n  return g();\n}\n');
    expect(r.error?.message).toMatch(/returns nothing, so there is no value to return/);
  });

  it('agrees with the interpreter on recursion well within its stack', async () => {
    const src = 'fn d(n: int) -> int {\n  if n == 0 {\n    return 0;\n  }\n  return d(n - 1) + 1;\n}\n' + main('  print(d(400));');
    expect((await runWasm(src)).out).toEqual(['400']);
    expect(runInterp(src).out).toEqual(['400']);
  });
});

describe('the WebAssembly text of random programs', () => {
  it('never repeats a function or local name', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = compile(program(seed));
      // Skip the export line, which refers to $main rather than declaring it.
      const decls = r.wat.split('\n').filter((l) => !l.includes('(export'));
      const funcs = decls.flatMap((l) => [...l.matchAll(/\(func \$([\w.]+)/g)].map((m) => m[1]));
      expect(new Set(funcs).size, `seed ${seed}`).toBe(funcs.length);
      for (const fn of r.wat.split('(func $').slice(1)) {
        const names = [...fn.matchAll(/\((?:param|local) \$(\w+)/g)].map((m) => m[1]);
        expect(new Set(names).size, `seed ${seed}`).toBe(names.length);
      }
    }
  });
});
