/** Helpers: run a program both ways and collect what it prints. */
import { compile, formatFloat, interpret, Trap } from '../src/lang';
import { trapKind } from '../src/lang/traps';

export interface RunResult {
  out: string[];
  plots: number;
  trap: string | null;
}

export async function runWasm(src: string): Promise<RunResult> {
  const r = compile(src);
  if (r.error) throw new Error(`compile error: ${r.error.message} at ${r.error.line}:${r.error.col}`);
  const out: string[] = [];
  let plots = 0;
  const env = {
    print_int: (x: number) => out.push(String(x)),
    print_float: (x: number) => out.push(formatFloat(x)),
    print_bool: (x: number) => out.push(x ? 'true' : 'false'),
    plot: () => plots++,
  };
  const { instance } = await WebAssembly.instantiate(r.bytes!, { env });
  try {
    (instance.exports.main as () => void)();
    return { out, plots, trap: null };
  } catch (e) {
    return { out, plots, trap: normaliseTrap(e as Error) };
  }
}

export function runInterp(src: string): RunResult {
  const r = compile(src);
  if (r.error) throw new Error(`compile error: ${r.error.message}`);
  const out: string[] = [];
  let plots = 0;
  try {
    interpret(r.checked!, { print: (s) => out.push(s), plot: () => plots++ });
    return { out, plots, trap: null };
  } catch (e) {
    if (e instanceof Trap) return { out, plots, trap: e.message };
    if (e instanceof RangeError) return { out, plots, trap: 'stack overflow' };
    throw e;
  }
}

/** WebAssembly engines word trap messages differently; map them to the interpreter's. */
export function normaliseTrap(e: Error): string {
  return trapKind(e.message) ?? e.message;
}
