import { LipiError, type Block, type Expr, type Func, type Program, type Span, type Stmt, type Type } from './ast';

/** A variable slot in a function: parameters first, then every `let` and loop variable. */
export interface Local {
  name: string;
  type: Type;
}

export interface FuncInfo {
  func: Func;
  locals: Local[];
  /** Extra hidden slots (a for-loop's end value). */
}

export interface Builtin {
  name: string;
  /** Allowed signatures; the first whose parameters match is used. */
  sigs: { params: Type[]; ret: Type; op: string }[];
  doc: string;
}

/**
 * Functions the language provides. `op` says how the code generator implements
 * each one: an imported host function, or a single WebAssembly instruction.
 */
export const BUILTINS: Builtin[] = [
  {
    name: 'print',
    sigs: [
      { params: ['int'], ret: 'void', op: 'import:print_int' },
      { params: ['float'], ret: 'void', op: 'import:print_float' },
      { params: ['bool'], ret: 'void', op: 'import:print_bool' },
    ],
    doc: 'print(x): writes an int, float or bool on its own line',
  },
  { name: 'plot', sigs: [{ params: ['int', 'int', 'int'], ret: 'void', op: 'import:plot' }], doc: 'plot(x, y, rgb): colours one pixel of the 256 × 256 canvas, e.g. plot(10, 20, 0xff8800)' },
  { name: 'sqrt', sigs: [{ params: ['float'], ret: 'float', op: 'f64.sqrt' }], doc: 'sqrt(x): square root' },
  { name: 'floor', sigs: [{ params: ['float'], ret: 'float', op: 'f64.floor' }], doc: 'floor(x): round down' },
  {
    name: 'abs',
    sigs: [
      { params: ['float'], ret: 'float', op: 'f64.abs' },
      { params: ['int'], ret: 'int', op: 'abs:int' },
    ],
    doc: 'abs(x): absolute value of an int or a float',
  },
  {
    name: 'min',
    sigs: [
      { params: ['float', 'float'], ret: 'float', op: 'f64.min' },
      { params: ['int', 'int'], ret: 'int', op: 'min:int' },
    ],
    doc: 'min(a, b)',
  },
  {
    name: 'max',
    sigs: [
      { params: ['float', 'float'], ret: 'float', op: 'f64.max' },
      { params: ['int', 'int'], ret: 'int', op: 'max:int' },
    ],
    doc: 'max(a, b)',
  },
  {
    name: 'float',
    sigs: [
      { params: ['int'], ret: 'float', op: 'f64.convert_i32_s' },
      { params: ['float'], ret: 'float', op: 'nop' },
    ],
    doc: 'float(n): an int as a float',
  },
  {
    name: 'int',
    sigs: [
      { params: ['float'], ret: 'int', op: 'i32.trunc_sat_f64_s' },
      { params: ['int'], ret: 'int', op: 'nop' },
    ],
    doc: 'int(x): a float rounded towards zero (clamped to the int range; NaN becomes 0)',
  },
];

const BUILTIN_BY_NAME = new Map(BUILTINS.map((b) => [b.name, b]));

/** Everything later stages need to know about a program that type-checked. */
export interface Checked {
  program: Program;
  funcs: FuncInfo[];
  /** The type of every expression. */
  types: Map<Expr, Type>;
  /** The local slot a name, let, assignment or for-loop refers to. */
  slots: Map<object, number>;
  /** For each for-loop, the hidden slot that holds its end value. */
  forEnd: Map<Stmt, number>;
  /** For each call: the user function index, or the chosen builtin op. */
  calls: Map<Expr, { func: number } | { op: string }>;
}

const err = (message: string, span: Span) => new LipiError(message, span, 'type');
const article = (t: Type) => (t === 'int' ? 'an int' : t === 'float' ? 'a float' : t === 'bool' ? 'a bool' : 'nothing');

export function check(program: Program): Checked {
  const out: Checked = { program, funcs: [], types: new Map(), slots: new Map(), forEnd: new Map(), calls: new Map() };
  const byName = new Map<string, number>();
  program.funcs.forEach((f, i) => {
    if (BUILTIN_BY_NAME.has(f.name)) throw err(`"${f.name}" is a built-in function and can't be redefined`, f.nameSpan);
    if (byName.has(f.name)) throw err(`There is already a function called "${f.name}"`, f.nameSpan);
    byName.set(f.name, i);
  });
  const main = program.funcs.find((f) => f.name === 'main');
  if (!main) throw err('A program needs a function called main, where it starts: fn main() { ... }', { start: 0, end: 0 });
  if (main.params.length || main.ret !== 'void') throw err('main takes no parameters and returns nothing: fn main() { ... }', main.nameSpan);

  for (const f of program.funcs) out.funcs.push(new FuncChecker(f, out, byName).run());
  return out;
}

class FuncChecker {
  private readonly locals: Local[] = [];
  private scopes: Map<string, number>[] = [];
  private loops = 0;

  constructor(
    private readonly f: Func,
    private readonly out: Checked,
    private readonly byName: Map<string, number>,
  ) {}

  run(): FuncInfo {
    const params = new Map<string, number>();
    for (const p of this.f.params) {
      if (params.has(p.name)) throw err(`Two parameters are called "${p.name}"`, p.span);
      params.set(p.name, this.slot(p.name, p.type));
    }
    this.scopes = [params];
    const returns = this.block(this.f.body, false);
    if (this.f.ret !== 'void' && !returns) {
      throw err(`${this.f.name} must return ${article(this.f.ret)} on every path; this point can be reached without a return`, { start: this.f.body.span.end - 1, end: this.f.body.span.end });
    }
    return { func: this.f, locals: this.locals };
  }

  private slot(name: string, type: Type): number {
    this.locals.push({ name, type });
    return this.locals.length - 1;
  }

  private lookup(name: string, s: Span): number {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const slot = this.scopes[i]!.get(name);
      if (slot !== undefined) return slot;
    }
    if (this.byName.has(name) || BUILTIN_BY_NAME.has(name)) throw err(`"${name}" is a function; call it with ${name}(...)`, s);
    throw err(`There is no variable called "${name}" here. Declare it first with let ${name} = ...;`, s);
  }

  /** Check a block; returns true if every path through it ends in a return. */
  private block(b: Block, newScope = true): boolean {
    if (newScope) this.scopes.push(new Map());
    let returns = false;
    for (const s of b.stmts) {
      if (returns) throw err('This code can never run: it comes after a return, break or continue', s.span);
      returns = this.stmt(s);
    }
    if (newScope) this.scopes.pop();
    return returns;
  }

  /** Returns true if the statement never falls through to the next one. */
  private stmt(s: Stmt): boolean {
    switch (s.kind) {
      case 'let': {
        const t = this.expr(s.value);
        if (t === 'void') throw err('This call returns nothing, so it has no value to store', s.value.span);
        if (s.type && s.type !== t) throw err(`${s.name} is declared as ${s.type} but the value is ${article(t)}${hint(s.type, t)}`, s.value.span);
        const scope = this.scopes[this.scopes.length - 1]!;
        if (scope.has(s.name)) throw err(`"${s.name}" is already declared in this block; to change it, write ${s.name} = ...;`, s.nameSpan);
        const slot = this.slot(s.name, t);
        this.out.slots.set(s, slot);
        scope.set(s.name, slot);
        return false;
      }
      case 'assign': {
        const slot = this.lookup(s.name, s.nameSpan);
        const target = this.locals[slot]!.type;
        const t = this.expr(s.value);
        if (s.op !== '=') this.arith(s.op.slice(0, 1) as '+', target, t, s.span);
        else if (t !== target) throw err(`${s.name} holds ${article(target)}, so it can't be given ${article(t)}${hint(target, t)}`, s.value.span);
        this.out.slots.set(s, slot);
        return false;
      }
      case 'if': {
        this.cond(s.cond, 'if');
        const a = this.block(s.then);
        const b = s.else ? this.block(s.else) : false;
        return a && b;
      }
      case 'while': {
        this.cond(s.cond, 'while');
        this.loops++;
        this.block(s.body);
        this.loops--;
        // `while true` with no break never falls through, but we don't try to prove that.
        return false;
      }
      case 'for': {
        for (const [e, which] of [[s.from, 'start'], [s.to, 'end']] as const) {
          const t = this.expr(e);
          if (t !== 'int') throw err(`A for loop's ${which} must be an int, not ${article(t)}`, e.span);
        }
        this.scopes.push(new Map());
        const slot = this.slot(s.name, 'int');
        this.out.slots.set(s, slot);
        this.out.forEnd.set(s, this.slot(`${s.name} (end)`, 'int'));
        this.scopes[this.scopes.length - 1]!.set(s.name, slot);
        this.loops++;
        this.block(s.body);
        this.loops--;
        this.scopes.pop();
        return false;
      }
      case 'break':
      case 'continue':
        if (!this.loops) throw err(`${s.kind} can only be used inside a while or for loop`, s.span);
        return true;
      case 'return': {
        const want = this.f.ret;
        if (!s.value) {
          if (want !== 'void') throw err(`${this.f.name} must return ${article(want)}`, s.span);
          return true;
        }
        const t = this.expr(s.value);
        if (t === 'void') throw err(`This call returns nothing, so there is no value to return. Call it on its own line, then write return;`, s.value.span);
        if (want === 'void') throw err(`${this.f.name} doesn't return a value; add -> ${t} after its parameters if it should`, s.value.span);
        if (t !== want) throw err(`${this.f.name} returns ${article(want)}, but this is ${article(t)}${hint(want, t)}`, s.value.span);
        return true;
      }
      case 'expr':
        if (s.expr.kind !== 'call') throw err('This value is computed and then thrown away. Did you mean to store it with let, or print it?', s.expr.span);
        this.expr(s.expr);
        return false;
    }
  }

  private cond(e: Expr, where: string): void {
    const t = this.expr(e);
    if (t !== 'bool') throw err(`The condition of ${where} must be a bool (like x > 0), not ${article(t)}`, e.span);
  }

  private arith(op: string, a: Type, b: Type, s: Span): Type {
    if (a !== b) throw err(`Can't use ${op} on ${article(a)} and ${article(b)}${a === 'int' || b === 'int' ? '. Convert one side with float(...) or int(...)' : ''}`, s);
    if (a !== 'int' && a !== 'float') throw err(`${op} works on numbers, not ${article(a)}s`, s);
    if (op === '%' && a !== 'int') throw err('% (remainder) works on ints only', s);
    return a;
  }

  expr(e: Expr): Type {
    const t = this.exprInner(e);
    this.out.types.set(e, t);
    return t;
  }

  private exprInner(e: Expr): Type {
    switch (e.kind) {
      case 'int':
        return 'int';
      case 'float':
        return 'float';
      case 'bool':
        return 'bool';
      case 'name': {
        const slot = this.lookup(e.name, e.span);
        this.out.slots.set(e, slot);
        return this.locals[slot]!.type;
      }
      case 'unary': {
        const t = this.expr(e.arg);
        if (e.op === '!' && t !== 'bool') throw err(`! works on bools, not ${article(t)}`, e.span);
        if (e.op === '-' && t !== 'int' && t !== 'float') throw err(`- works on numbers, not ${article(t)}`, e.span);
        return t;
      }
      case 'binary': {
        const a = this.expr(e.left);
        const b = this.expr(e.right);
        switch (e.op) {
          case '&&':
          case '||':
            if (a !== 'bool' || b !== 'bool') throw err(`${e.op} combines bools, not ${article(a === 'bool' ? b : a)}`, e.span);
            return 'bool';
          case '==':
          case '!=':
            if (a !== b) throw err(`Can't compare ${article(a)} with ${article(b)}`, e.span);
            if (a === 'void') throw err('Nothing to compare: this call returns no value', e.span);
            return 'bool';
          case '<':
          case '<=':
          case '>':
          case '>=':
            this.arith(e.op, a, b, e.span);
            return 'bool';
          case '&':
          case '|':
          case '^':
          case '<<':
          case '>>':
            if (a !== 'int' || b !== 'int') throw err(`${e.op} works on ints only`, e.span);
            return 'int';
          default:
            return this.arith(e.op, a, b, e.span);
        }
      }
      case 'call': {
        const args = e.args.map((a) => this.expr(a));
        const builtin = BUILTIN_BY_NAME.get(e.callee);
        if (builtin) {
          const sig = builtin.sigs.find((s) => s.params.length === args.length && s.params.every((p, i) => p === args[i]));
          if (!sig) {
            const want = builtin.sigs.map((s) => `${e.callee}(${s.params.join(', ')})`).join(' or ');
            throw err(`${e.callee} takes ${want}, not ${e.callee}(${args.join(', ')})`, e.span);
          }
          this.out.calls.set(e, { op: sig.op });
          return sig.ret;
        }
        const idx = this.byName.get(e.callee);
        if (idx === undefined) {
          const close = [...this.byName.keys(), ...BUILTIN_BY_NAME.keys()].find((n) => near(n, e.callee));
          throw err(`There is no function called "${e.callee}"${close ? `. Did you mean ${close}?` : ''}`, e.calleeSpan);
        }
        const f = this.out.program.funcs[idx]!;
        if (f.params.length !== args.length) throw err(`${f.name} takes ${f.params.length} argument${f.params.length === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`, e.span);
        f.params.forEach((p, i) => {
          if (args[i] !== p.type) throw err(`${f.name}'s ${p.name} must be ${article(p.type)}, not ${article(args[i]!)}${hint(p.type, args[i]!)}`, e.args[i]!.span);
        });
        this.out.calls.set(e, { func: idx });
        return f.ret;
      }
    }
  }
}

function hint(want: Type, got: Type): string {
  if (want === 'float' && got === 'int') return '. Use float(...) to convert, or write the number with a decimal point (2.0)';
  if (want === 'int' && got === 'float') return '. Use int(...) to convert';
  return '';
}

/** Edit distance at most 2 (for "did you mean"). */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]! <= 2;
}
