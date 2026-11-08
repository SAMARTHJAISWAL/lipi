import type { BinOp, Block, Expr, Stmt, Type } from './ast';
import type { Checked, FuncInfo } from './check';
import { EMPTY_BLOCK, OP, SECTION, VAL, f64, name, section, sleb, uleb, vec, type ValName } from './wasm';

/** Functions the module imports from the page that runs it. */
export const IMPORTS = [
  { name: 'print_int', params: ['i32'] as ValName[] },
  { name: 'print_float', params: ['f64'] as ValName[] },
  { name: 'print_bool', params: ['i32'] as ValName[] },
  { name: 'plot', params: ['i32', 'i32', 'i32'] as ValName[] },
];

/** Where each part of the binary is, for the annotated hex view. */
export interface ByteRegion {
  start: number;
  end: number;
  label: string;
  kind: 'header' | 'type' | 'import' | 'function' | 'export' | 'code' | 'body' | 'custom';
}

export interface Output {
  bytes: Uint8Array<ArrayBuffer>;
  wat: string;
  regions: ByteRegion[];
}

const valOf = (t: Type): ValName => (t === 'float' ? 'f64' : 'i32');

/**
 * Compile a type-checked program to a WebAssembly module, producing the binary
 * and, alongside it, the same code in the WebAssembly text format.
 */
export function generate(c: Checked): Output {
  // Function signatures, de-duplicated into the type section.
  const types: string[] = [];
  const typeIndex = (params: ValName[], result: ValName | null): number => {
    const key = `${params.join(',')}->${result ?? ''}`;
    let i = types.indexOf(key);
    if (i < 0) i = types.push(key) - 1;
    return i;
  };
  const importTypes = IMPORTS.map((im) => typeIndex(im.params, null));
  const funcTypes = c.funcs.map((f) => typeIndex(f.func.params.map((p) => valOf(p.type)), f.func.ret === 'void' ? null : valOf(f.func.ret)));
  const bodies = c.funcs.map((f) => new FuncGen(c, f).run());

  const wat: string[] = ['(module'];
  types.forEach((t, i) => {
    const [ps, r] = t.split('->') as [string, string];
    wat.push(`  (type $t${i} (func${ps ? ` (param ${ps.split(',').join(' ')})` : ''}${r ? ` (result ${r})` : ''}))`);
  });
  // Imports are named $env.<name> in the text, so a user function called print_int can't clash.
  IMPORTS.forEach((im) => wat.push(`  (import "env" "${im.name}" (func $env.${im.name} (param ${im.params.join(' ')})))`));
  bodies.forEach((b) => wat.push(...b.wat));
  wat.push(`  (export "main" (func $main))`, ')');

  // The binary, section by section, keeping track of where everything is.
  const regions: ByteRegion[] = [];
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  regions.push({ start: 0, end: 8, label: 'Header: the magic number "\\0asm" and version 1', kind: 'header' });
  const add = (bytes: number[], label: string, kind: ByteRegion['kind']) => {
    regions.push({ start: out.length, end: out.length + bytes.length, label, kind });
    // A loop, not out.push(...bytes): a big function body would overflow the call stack.
    for (const b of bytes) out.push(b);
  };

  const typeEntries = types.map((t) => {
    const [ps, r] = t.split('->') as [string, string];
    const params = ps ? ps.split(',').map((p) => VAL[p as ValName]) : [];
    return [0x60, ...uleb(params.length), ...params, ...(r ? [1, VAL[r as ValName]] : [0])];
  });
  add(section(SECTION.type, vec(typeEntries)), `Type section: ${types.length} function signatures`, 'type');
  add(
    section(SECTION.import, vec(IMPORTS.map((im, i) => [...name('env'), ...name(im.name), 0x00, ...uleb(importTypes[i]!)]))),
    `Import section: ${IMPORTS.map((i) => i.name).join(', ')} from the page`,
    'import',
  );
  add(section(SECTION.function, vec(funcTypes.map((t) => uleb(t)))), `Function section: the signature of each of the ${c.funcs.length} functions`, 'function');
  const mainIndex = IMPORTS.length + c.funcs.findIndex((f) => f.func.name === 'main');
  add(section(SECTION.export, vec([[...name('main'), 0x00, ...uleb(mainIndex)]])), 'Export section: main, so the page can call it', 'export');

  // Code section: written by hand so each function body gets its own region.
  const encoded = bodies.map((b) => {
    const locals = b.extraLocals;
    // Run-length encode consecutive locals of the same type.
    const groups: [number, ValName][] = [];
    for (const l of locals) {
      const last = groups[groups.length - 1];
      if (last && last[1] === l) last[0]++;
      else groups.push([1, l]);
    }
    const body = [...uleb(groups.length), ...groups.flatMap(([n, t]) => [...uleb(n), VAL[t]])];
    for (const x of b.code) body.push(x);
    body.push(OP.end![0]!);
    const sized = uleb(body.length);
    for (const x of body) sized.push(x);
    return sized;
  });
  const codeBody = uleb(encoded.length);
  for (const e of encoded) for (const x of e) codeBody.push(x);
  const codeHeader = [SECTION.code, ...uleb(codeBody.length), ...uleb(encoded.length)];
  regions.push({ start: out.length, end: out.length + codeHeader.length, label: `Code section: ${encoded.length} function bodies`, kind: 'code' });
  for (const x of codeHeader) out.push(x);
  encoded.forEach((e, i) => add(e, `Body of ${c.funcs[i]!.func.name}: ${e.length} bytes`, 'body'));

  // A "name" custom section, so error messages and stack traces show function names.
  const funcNames = [...IMPORTS.map((im) => im.name), ...c.funcs.map((f) => f.func.name)];
  const names = vec(funcNames.map((n, i) => [...uleb(i), ...name(n)]));
  add(section(SECTION.custom, [...name('name'), 1, ...uleb(names.length), ...names]), 'Custom "name" section: function names for error messages', 'custom');

  return { bytes: new Uint8Array(out), wat: wat.join('\n'), regions };
}

interface Label {
  kind: 'block' | 'loop' | 'if';
  /** What break / continue in the innermost loop should target. */
  role: 'break' | 'continue' | null;
}

class FuncGen {
  readonly code: number[] = [];
  readonly wat: string[] = [];
  readonly extraLocals: ValName[] = [];
  private readonly labels: Label[] = [];
  private readonly localNames: string[];
  private readonly localTypes: ValName[];
  private readonly usedNames = new Set<string>();
  private indent = 2;
  private temps: Partial<Record<ValName, number[]>> = {};

  constructor(
    private readonly c: Checked,
    private readonly info: FuncInfo,
  ) {
    this.localNames = info.locals.map((l) => this.uniqueName(l.name));
    this.localTypes = info.locals.map((l) => valOf(l.type));
  }

  /** A text-format name for a local that no other local in this function uses. */
  private uniqueName(raw: string): string {
    const base = raw.replace(/[^A-Za-z0-9_]/g, '_');
    let n = base;
    for (let k = 1; this.usedNames.has(n); k++) n = `${base}_${k}`;
    this.usedNames.add(n);
    return n;
  }

  run(): { code: number[]; wat: string[]; extraLocals: ValName[] } {
    const f = this.info.func;
    const nParams = f.params.length;
    for (let i = nParams; i < this.info.locals.length; i++) this.extraLocals.push(this.localTypes[i]!);
    this.indent = 4;
    this.block(f.body);
    // Every path returns (the checker made sure), so falling off the end can't happen.
    if (f.ret !== 'void') this.op('unreachable');

    const params = f.params.map((p, i) => `(param $${this.localNames[i]} ${valOf(p.type)})`).join(' ');
    const head = `  (func $${f.name}${params ? ' ' + params : ''}${f.ret === 'void' ? '' : ` (result ${valOf(f.ret)})`}`;
    const locals = this.localNames.slice(nParams).map((n, i) => `(local $${n} ${this.allLocalTypes()[nParams + i]})`);
    return { code: this.code, wat: [head, ...(locals.length ? ['    ' + locals.join(' ')] : []), ...this.wat, '  )'], extraLocals: this.extraLocals };
  }

  private allLocalTypes(): ValName[] {
    return this.localTypes;
  }

  /** A scratch local of the given type, for builtins that need to reuse a value. */
  private temp(t: ValName, n: number): number {
    const list = (this.temps[t] ??= []);
    while (list.length <= n) {
      const idx = this.localTypes.length;
      this.localTypes.push(t);
      this.localNames.push(this.uniqueName(`tmp${idx}`));
      this.extraLocals.push(t);
      list.push(idx);
    }
    return list[n]!;
  }

  private op(o: string, imm: number[] = [], immText = ''): void {
    const bytes = OP[o];
    if (!bytes) throw new Error(`unknown opcode ${o}`);
    this.code.push(...bytes, ...imm);
    if (o === 'end' || o === 'else') this.indent -= 2;
    this.wat.push(' '.repeat(this.indent) + o + (immText ? ' ' + immText : ''));
    if (o === 'block' || o === 'loop' || o === 'if' || o === 'else') this.indent += 2;
  }

  private local(o: 'local.get' | 'local.set' | 'local.tee', slot: number): void {
    this.op(o, uleb(slot), `$${this.localNames[slot]}`);
  }

  private open(o: 'block' | 'loop' | 'if', role: Label['role'], result: ValName | null = null): void {
    this.labels.push({ kind: o, role });
    this.op(o, [result ? VAL[result] : EMPTY_BLOCK], result ? `(result ${result})` : '');
  }

  private close(): void {
    this.labels.pop();
    this.op('end');
  }

  private branchTo(role: 'break' | 'continue', conditional = false): void {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      if (this.labels[i]!.role === role) {
        const depth = this.labels.length - 1 - i;
        this.op(conditional ? 'br_if' : 'br', uleb(depth), String(depth));
        return;
      }
    }
    throw new Error(`no ${role} target`);
  }

  private block(b: Block): void {
    for (const s of b.stmts) this.stmt(s);
  }

  private stmt(s: Stmt): void {
    switch (s.kind) {
      case 'let':
        this.expr(s.value);
        this.local('local.set', this.c.slots.get(s)!);
        return;
      case 'assign': {
        const slot = this.c.slots.get(s)!;
        if (s.op === '=') this.expr(s.value);
        else {
          this.local('local.get', slot);
          this.expr(s.value);
          this.binop(s.op.slice(0, 1) as BinOp, this.c.types.get(s.value)!);
        }
        this.local('local.set', slot);
        return;
      }
      case 'if':
        this.expr(s.cond);
        this.open('if', null);
        this.block(s.then);
        if (s.else) {
          this.op('else');
          this.block(s.else);
        }
        this.close();
        return;
      case 'while':
        // block $break { loop $continue { if !cond break; body; continue } }
        this.open('block', 'break');
        this.open('loop', 'continue');
        this.expr(s.cond);
        this.op('i32.eqz');
        this.branchTo('break', true);
        this.block(s.body);
        this.op('br', uleb(0), '0');
        this.close();
        this.close();
        return;
      case 'for': {
        // i = from; end = to; block $break { loop { if i >= end break; block $continue { body } i += 1 } }
        const i = this.c.slots.get(s)!;
        const end = this.c.forEnd.get(s)!;
        this.expr(s.from);
        this.local('local.set', i);
        this.expr(s.to);
        this.local('local.set', end);
        this.open('block', 'break');
        this.open('loop', null);
        this.local('local.get', i);
        this.local('local.get', end);
        this.op('i32.ge_s');
        this.branchTo('break', true);
        this.open('block', 'continue');
        this.block(s.body);
        this.close();
        this.local('local.get', i);
        this.op('i32.const', sleb(1), '1');
        this.op('i32.add');
        this.local('local.set', i);
        this.op('br', uleb(0), '0');
        this.close();
        this.close();
        return;
      }
      case 'break':
        this.branchTo('break');
        return;
      case 'continue':
        this.branchTo('continue');
        return;
      case 'return':
        if (s.value) this.expr(s.value);
        this.op('return');
        return;
      case 'expr':
        this.expr(s.expr);
        if (this.c.types.get(s.expr) !== 'void') this.op('drop');
        return;
    }
  }

  private expr(e: Expr): void {
    switch (e.kind) {
      case 'int':
        this.op('i32.const', sleb(e.value), String(e.value));
        return;
      case 'float':
        this.op('f64.const', f64(e.value), Object.is(e.value, -0) ? '-0' : Number.isFinite(e.value) ? String(e.value) : e.value > 0 ? 'inf' : e.value < 0 ? '-inf' : 'nan');
        return;
      case 'bool':
        this.op('i32.const', sleb(e.value ? 1 : 0), e.value ? '1' : '0');
        return;
      case 'name':
        this.local('local.get', this.c.slots.get(e)!);
        return;
      case 'unary': {
        const t = this.c.types.get(e.arg)!;
        if (e.op === '!') {
          this.expr(e.arg);
          this.op('i32.eqz');
        } else if (t === 'float') {
          this.expr(e.arg);
          this.op('f64.neg');
        } else {
          this.op('i32.const', sleb(0), '0');
          this.expr(e.arg);
          this.op('i32.sub');
        }
        return;
      }
      case 'binary': {
        if (e.op === '&&' || e.op === '||') {
          // Short-circuit: the right side runs only if it decides the result.
          this.expr(e.left);
          this.open('if', null, 'i32');
          if (e.op === '&&') this.expr(e.right);
          else this.op('i32.const', sleb(1), '1');
          this.op('else');
          if (e.op === '&&') this.op('i32.const', sleb(0), '0');
          else this.expr(e.right);
          this.close();
          return;
        }
        this.expr(e.left);
        this.expr(e.right);
        this.binop(e.op, this.c.types.get(e.left)!);
        return;
      }
      case 'call': {
        const target = this.c.calls.get(e)!;
        if ('func' in target) {
          for (const a of e.args) this.expr(a);
          const idx = IMPORTS.length + target.func;
          this.op('call', uleb(idx), `$${this.c.program.funcs[target.func]!.name}`);
          return;
        }
        const op = target.op;
        if (op.startsWith('import:')) {
          for (const a of e.args) this.expr(a);
          const n = op.slice(7);
          this.op('call', uleb(IMPORTS.findIndex((im) => im.name === n)), `$env.${n}`);
          return;
        }
        if (op === 'abs:int') {
          // select(0 - x, x, x < 0)
          const t = this.temp('i32', 0);
          this.expr(e.args[0]!);
          this.local('local.set', t);
          this.op('i32.const', sleb(0), '0');
          this.local('local.get', t);
          this.op('i32.sub');
          this.local('local.get', t);
          this.local('local.get', t);
          this.op('i32.const', sleb(0), '0');
          this.op('i32.lt_s');
          this.op('select');
          return;
        }
        if (op === 'min:int' || op === 'max:int') {
          // select(a, b, a < b) for min, a > b for max. Both arguments are evaluated
          // before either scratch local is written: a nested min/max uses the same
          // scratch locals, and would otherwise overwrite a before it is read.
          const a = this.temp('i32', 0);
          const b = this.temp('i32', 1);
          this.expr(e.args[0]!);
          this.expr(e.args[1]!);
          this.local('local.set', b);
          this.local('local.set', a);
          this.local('local.get', a);
          this.local('local.get', b);
          this.local('local.get', a);
          this.local('local.get', b);
          this.op(op === 'min:int' ? 'i32.lt_s' : 'i32.gt_s');
          this.op('select');
          return;
        }
        for (const a of e.args) this.expr(a);
        if (op !== 'nop') this.op(op);
        return;
      }
    }
  }

  private binop(op: BinOp, t: Type): void {
    const f = t === 'float';
    const table: Record<string, string> = f
      ? { '+': 'f64.add', '-': 'f64.sub', '*': 'f64.mul', '/': 'f64.div', '<': 'f64.lt', '<=': 'f64.le', '>': 'f64.gt', '>=': 'f64.ge', '==': 'f64.eq', '!=': 'f64.ne' }
      : {
          '+': 'i32.add', '-': 'i32.sub', '*': 'i32.mul', '/': 'i32.div_s', '%': 'i32.rem_s',
          '<': 'i32.lt_s', '<=': 'i32.le_s', '>': 'i32.gt_s', '>=': 'i32.ge_s', '==': 'i32.eq', '!=': 'i32.ne',
          '&': 'i32.and', '|': 'i32.or', '^': 'i32.xor', '<<': 'i32.shl', '>>': 'i32.shr_s',
        };
    this.op(table[op]!);
  }
}
