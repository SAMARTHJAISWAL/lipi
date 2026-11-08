import { describe, expect, it } from 'vitest';
import { compile } from '../src/lang';
import { EXAMPLES } from '../src/examples';
import { runInterp, runWasm } from './run';

const EXPECTED: Record<string, string[] | { plots: number }> = {
  hello: ['42', 'true', String(22 / 7)],
  fizzbuzz: ['1', '2', '0', '4', '-1', '0', '7', '8', '0', '-1', '11', '0', '13', '14', '-2', '16', '17', '0', '19', '-1'],
  fib: ['75025', '75025', '1836311903'],
  primes: ['2', '3', '5', '7', '11', '13', '17', '19', '23', '29', '31', '37', '41', '43', '47'],
  collatz: ['6171', '261'],
  mandelbrot: { plots: 256 * 256 },
  circles: { plots: 256 * 256 },
};

describe('the examples', () => {
  for (const ex of EXAMPLES.filter((e) => e.id !== 'errors')) {
    it(`${ex.title}: compiles to valid WebAssembly and prints the right thing`, async () => {
      const r = compile(ex.source);
      expect(r.error).toBeNull();
      expect(WebAssembly.validate(r.bytes!)).toBe(true);
      const w = await runWasm(ex.source);
      const i = runInterp(ex.source);
      const want = EXPECTED[ex.id]!;
      if (Array.isArray(want)) expect(w.out).toEqual(want);
      else expect(w.plots).toBe(want.plots);
      expect(i).toEqual(w);
    });
  }

  it('the error example explains the mistake', () => {
    const r = compile(EXAMPLES.find((e) => e.id === 'errors')!.source);
    expect(r.error?.stage).toBe('type');
    expect(r.error?.message).toMatch(/area's r must be a float, not an int\. Use float/);
    expect(r.error?.line).toBe(8);
  });
});

describe('regressions found by the fuzzer', () => {
  it('nested min and max keep their own arguments', async () => {
    const src = `fn main() {
  let v1 = 5;
  let v2 = 0x7f;
  print(max(2147483647, max(v1, v2)));
  print(min(-3, min(v2, max(v1, 9))));
  print(abs(min(abs(-4), -abs(7))));
}
`;
    const w = await runWasm(src);
    expect(w.out).toEqual(['2147483647', '-3', '7']);
    expect(runInterp(src)).toEqual(w);
  });
});
