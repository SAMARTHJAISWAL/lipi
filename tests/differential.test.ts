import { describe, expect, it } from 'vitest';
import { compile } from '../src/lang';
import { program } from './fuzz';
import { runInterp, runWasm } from './run';

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 1500);

describe('differential fuzzing: compiled WebAssembly against the interpreter', () => {
  it(`agrees on ${SEEDS} random programs`, async () => {
    let traps = 0;
    let lines = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const src = program(seed);
      const c = compile(src);
      if (c.error) throw new Error(`seed ${seed}: the generator wrote an invalid program (${c.error.message} at ${c.error.line}:${c.error.col})\n${src}`);
      expect(WebAssembly.validate(c.bytes!), `seed ${seed}: invalid module`).toBe(true);
      const w = await runWasm(src);
      const i = runInterp(src);
      expect(w, `seed ${seed}\n${src}`).toEqual(i);
      if (w.trap) traps++;
      lines += w.out.length;
    }
    // The programs must actually exercise things: plenty of output, and some runtime errors.
    expect(lines).toBeGreaterThan(SEEDS * 1.5);
    expect(traps).toBeGreaterThan(SEEDS * 0.02);
  });
});
