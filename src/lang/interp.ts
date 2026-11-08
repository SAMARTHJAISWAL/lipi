import type { Block, Expr, Stmt } from './ast';
import type { Checked } from './check';

/**
 * A straightforward tree-walking interpreter for checked programs. It is the
 * reference the compiler is tested against: the same program must print the
 * same lines and fail with the same error whether it is interpreted here or
 * compiled to WebAssembly and run.
 */

export class Trap extends Error {}

export interface Host {
  print(text: string): void;
  plot(x: number, y: number, rgb: number): void;
}

/** How print shows a value: shared by the interpreter and the page that runs WebAssembly. */
export function formatFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (Object.is(x, -0)) return '-0.0';
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return `${x}.0`;
  return String(x);
}

/** WebAssembly's i32.trunc_sat_f64_s: towards zero, clamped, NaN is 0. */
export function truncSat(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x) | 0;
}

class Return {
  constructor(readonly value: number | boolean | undefined) {}
}
class Break {}
class Continue {}

type Value = number | boolean;

export function interpret(c: Checked, host: Host, maxSteps = 50_000_000): void {
  let steps = 0;
  const tick = () => {
    if (++steps > maxSteps) throw new Trap('step limit reached');
  };

  const call = (index: number, args: Value[]): Value | undefined => {
    const info = c.funcs[index]!;
    const frame: Value[] = new Array(info.locals.length).fill(0);
    args.forEach((a, i) => (frame[i] = a));
    try {
      block(info.func.body, frame);
    } catch (r) {
      if (r instanceof Return) return r.value;
      throw r;
    }
    if (info.func.ret !== 'void') throw new Trap('unreachable');
    return undefined;
  };

  const block = (b: Block, frame: Value[]): void => {
    for (const s of b.stmts) stmt(s, frame);
  };

  const stmt = (s: Stmt, frame: Value[]): void => {
    tick();
    switch (s.kind) {
      case 'let':
        frame[c.slots.get(s)!] = expr(s.value, frame)!;
        return;
      case 'assign': {
        const slot = c.slots.get(s)!;
        const v = expr(s.value, frame)!;
        frame[slot] = s.op === '=' ? v : arith(s.op.slice(0, 1), frame[slot]!, v, c.types.get(s.value) === 'float');
        return;
      }
      case 'if':
        if (expr(s.cond, frame)) block(s.then, frame);
        else if (s.else) block(s.else, frame);
        return;
      case 'while':
        while (expr(s.cond, frame)) {
          tick();
          try {
            block(s.body, frame);
          } catch (x) {
            if (x instanceof Break) break;
            if (x instanceof Continue) continue;
            throw x;
          }
        }
        return;
      case 'for': {
        const i = c.slots.get(s)!;
        frame[i] = expr(s.from, frame)!;
        const end = expr(s.to, frame) as number;
        frame[c.forEnd.get(s)!] = end;
        while ((frame[i] as number) < end) {
          tick();
          try {
            block(s.body, frame);
          } catch (x) {
            if (x instanceof Break) break;
            if (!(x instanceof Continue)) throw x;
          }
          frame[i] = ((frame[i] as number) + 1) | 0;
        }
        return;
      }
      case 'break':
        throw new Break();
      case 'continue':
        throw new Continue();
      case 'return':
        throw new Return(s.value ? expr(s.value, frame) : undefined);
      case 'expr':
        expr(s.expr, frame);
        return;
    }
  };

  const expr = (e: Expr, frame: Value[]): Value | undefined => {
    switch (e.kind) {
      case 'int':
      case 'float':
      case 'bool':
        return e.value;
      case 'name':
        return frame[c.slots.get(e)!];
      case 'unary': {
        const v = expr(e.arg, frame)!;
        if (e.op === '!') return !v;
        return c.types.get(e.arg) === 'float' ? -(v as number) : (0 - (v as number)) | 0;
      }
      case 'binary': {
        if (e.op === '&&') return Boolean(expr(e.left, frame)) && Boolean(expr(e.right, frame));
        if (e.op === '||') return Boolean(expr(e.left, frame)) || Boolean(expr(e.right, frame));
        const a = expr(e.left, frame)!;
        const b = expr(e.right, frame)!;
        const isFloat = c.types.get(e.left) === 'float';
        switch (e.op) {
          case '<':
            return a < b;
          case '<=':
            return a <= b;
          case '>':
            return a > b;
          case '>=':
            return a >= b;
          case '==':
            return a === b;
          case '!=':
            return a !== b;
          case '&':
            return (a as number) & (b as number);
          case '|':
            return (a as number) | (b as number);
          case '^':
            return (a as number) ^ (b as number);
          case '<<':
            return (a as number) << (b as number);
          case '>>':
            return (a as number) >> (b as number);
          default:
            return arith(e.op, a, b, isFloat);
        }
      }
      case 'call': {
        tick();
        const target = c.calls.get(e)!;
        const args = e.args.map((a) => expr(a, frame)!);
        if ('func' in target) return call(target.func, args);
        const [x, y, z] = args as number[];
        switch (target.op) {
          case 'import:print_int':
            host.print(String(x));
            return;
          case 'import:print_float':
            host.print(formatFloat(x!));
            return;
          case 'import:print_bool':
            host.print(args[0] ? 'true' : 'false');
            return;
          case 'import:plot':
            host.plot(x!, y!, z!);
            return;
          case 'f64.sqrt':
            return Math.sqrt(x!);
          case 'f64.floor':
            return Math.floor(x!);
          case 'f64.abs':
            return Math.abs(x!);
          case 'abs:int':
            return x! < 0 ? (0 - x!) | 0 : x;
          case 'f64.min':
            return Math.min(x!, y!);
          case 'f64.max':
            return Math.max(x!, y!);
          case 'min:int':
            return x! < y! ? x : y;
          case 'max:int':
            return x! > y! ? x : y;
          case 'f64.convert_i32_s':
            return x;
          case 'i32.trunc_sat_f64_s':
            return truncSat(x!);
          case 'nop':
            return x;
        }
        throw new Error(`unknown builtin ${target.op}`);
      }
    }
  };

  const mainIndex = c.funcs.findIndex((f) => f.func.name === 'main');
  call(mainIndex, []);
}

function arith(op: string, a: Value, b: Value, isFloat: boolean): number {
  const x = a as number;
  const y = b as number;
  if (isFloat) {
    switch (op) {
      case '+':
        return x + y;
      case '-':
        return x - y;
      case '*':
        return x * y;
      case '/':
        return x / y;
    }
  }
  switch (op) {
    case '+':
      return (x + y) | 0;
    case '-':
      return (x - y) | 0;
    case '*':
      return Math.imul(x, y);
    case '/':
      if (y === 0) throw new Trap('integer divide by zero');
      if (x === -2147483648 && y === -1) throw new Trap('integer overflow');
      return (x / y) | 0;
    case '%':
      if (y === 0) throw new Trap('integer divide by zero');
      return x % y | 0;
  }
  throw new Error(`unknown operator ${op}`);
}
