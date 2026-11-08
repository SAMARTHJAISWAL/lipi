/**
 * Random, well-typed lipi programs for differential testing. Every program
 * terminates: loops are counted, and helpers only call helpers defined before them.
 */

const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type T = 'int' | 'float' | 'bool';

interface Var {
  name: string;
  type: T;
  /** Loop counters must not be reassigned, or loops might not end. */
  frozen: boolean;
}

interface Helper {
  name: string;
  params: T[];
  ret: T;
  /** Recursive helpers take a depth first and are only called with a small literal for it. */
  recursive?: boolean;
}

/** Sometimes reuse names that collide with built-ins, imports or the compiler's scratch locals. */
const TRICKY = ['abs', 'min', 'tmp1', 'tmp2', 'x', 'i'];

const INTS = ['0', '1', '-1', '2', '3', '7', '10', '-13', '255', '1000', '65535', '2147483647', '-2147483648', '0x7f', '0xffffffff'];
const FLOATS = ['0.0', '1.0', '-1.0', '0.5', '2.5', '-3.75', '1e10', '1e-3', '123.456', '-0.0', '1e300', '4294967296.0'];

export function program(seed: number): string {
  const r = rng(seed);
  const pick = <X,>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;
  const chance = (p: number) => r() < p;
  let counter = 0;
  const fresh = (p: string) => `${p}${counter++}`;
  const helpers: Helper[] = [];

  function expr(type: T, vars: Var[], depth: number, callable: Helper[]): string {
    const ofType = vars.filter((v) => v.type === type);
    if (depth <= 0 || chance(0.25)) {
      if (ofType.length && chance(0.6)) return pick(ofType).name;
      return type === 'int' ? pick(INTS) : type === 'float' ? pick(FLOATS) : pick(['true', 'false']);
    }
    const d = depth - 1;
    const calls = callable.filter((h) => h.ret === type);
    if (calls.length && chance(0.15)) {
      const h = pick(calls);
      if (h.recursive) return `${h.name}(${Math.floor(r() * 40)})`;
      return `${h.name}(${h.params.map((p) => expr(p, vars, d, callable)).join(', ')})`;
    }
    if (type === 'int') {
      const roll = r();
      if (roll < 0.45) return `(${expr('int', vars, d, callable)} ${pick(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'])} ${expr('int', vars, d, callable)})`;
      if (roll < 0.55) return `-(${expr('int', vars, d, callable)})`;
      if (roll < 0.7) return `int(${expr('float', vars, d, callable)})`;
      if (roll < 0.85) {
        const f = pick(['abs', 'min', 'max']);
        return f === 'abs' ? `abs(${expr('int', vars, d, callable)})` : `${f}(${expr('int', vars, d, callable)}, ${expr('int', vars, d, callable)})`;
      }
      return expr('int', vars, 0, callable);
    }
    if (type === 'float') {
      const roll = r();
      if (roll < 0.5) return `(${expr('float', vars, d, callable)} ${pick(['+', '-', '*', '/'])} ${expr('float', vars, d, callable)})`;
      if (roll < 0.6) return `-(${expr('float', vars, d, callable)})`;
      if (roll < 0.75) return `float(${expr('int', vars, d, callable)})`;
      if (roll < 0.9) {
        const f = pick(['sqrt', 'floor', 'abs', 'min', 'max']);
        return f === 'min' || f === 'max' ? `${f}(${expr('float', vars, d, callable)}, ${expr('float', vars, d, callable)})` : `${f}(${expr('float', vars, d, callable)})`;
      }
      return expr('float', vars, 0, callable);
    }
    const roll = r();
    if (roll < 0.35) {
      const t = pick(['int', 'float'] as const);
      return `(${expr(t, vars, d, callable)} ${pick(['<', '<=', '>', '>=', '==', '!='])} ${expr(t, vars, d, callable)})`;
    }
    if (roll < 0.6) return `(${expr('bool', vars, d, callable)} ${pick(['&&', '||'])} ${expr('bool', vars, d, callable)})`;
    if (roll < 0.7) return `!${expr('bool', vars, d, callable)}`;
    if (roll < 0.8) return `(${expr('bool', vars, d, callable)} == ${expr('bool', vars, d, callable)})`;
    return expr('bool', vars, 0, callable);
  }

  function block(vars: Var[], depth: number, inLoop: boolean, ret: T | null, callable: Helper[], indent: string): string {
    const scope = [...vars];
    /** Names declared directly in this block: these can't be declared again here. */
    const declaredHere = new Set<string>();
    const lines: string[] = [];
    const n = 1 + Math.floor(r() * 5);
    for (let k = 0; k < n; k++) {
      const roll = r();
      const mutable = scope.filter((v) => !v.frozen);
      if (roll < 0.25 || scope.length < 2) {
        const t = pick(['int', 'int', 'float', 'bool'] as const);
        // Shadow an outer variable (only from an inner block), use a tricky name, or a fresh one.
        const outer = vars.filter((v) => !v.frozen && !declaredHere.has(v.name));
        const tricky = TRICKY.filter((n) => !declaredHere.has(n) && !scope.some((v) => v.name === n));
        const name = outer.length && indent.length > 2 && chance(0.15) ? pick(outer).name : tricky.length && chance(0.1) ? pick(tricky) : fresh('v');
        const value = expr(t, scope, 3, callable);
        lines.push(`${indent}let ${name}${chance(0.3) ? `: ${t}` : ''} = ${value};`);
        for (let k = scope.length - 1; k >= 0; k--) if (scope[k]!.name === name) scope.splice(k, 1);
        scope.push({ name, type: t, frozen: false });
        declaredHere.add(name);
      } else if (roll < 0.4 && mutable.length) {
        const v = pick(mutable);
        const ops = v.type === 'int' ? ['=', '+=', '-=', '*=', '/=', '%='] : v.type === 'float' ? ['=', '+=', '-=', '*=', '/='] : ['='];
        lines.push(`${indent}${v.name} ${pick(ops)} ${expr(v.type, scope, 3, callable)};`);
      } else if (roll < 0.6) {
        const t = pick(['int', 'float', 'bool'] as const);
        lines.push(`${indent}print(${expr(t, scope, 3, callable)});`);
      } else if (roll < 0.7 && depth > 0) {
        lines.push(`${indent}if ${expr('bool', scope, 2, callable)} {`, block(scope, depth - 1, inLoop, ret, callable, indent + '  '), `${indent}}${chance(0.5) ? ` else {\n${block(scope, depth - 1, inLoop, ret, callable, indent + '  ')}\n${indent}}` : ''}`);
      } else if (roll < 0.78 && depth > 0) {
        const c = fresh('c');
        lines.push(`${indent}let ${c} = 0;`);
        lines.push(`${indent}while ${c} < ${1 + Math.floor(r() * 5)} && ${expr('bool', scope, 1, callable)} {`);
        lines.push(`${indent}  ${c} += 1;`);
        lines.push(block([...scope, { name: c, type: 'int', frozen: true }], depth - 1, true, ret, callable, indent + '  '));
        lines.push(`${indent}}`);
      } else if (roll < 0.86 && depth > 0) {
        const i = fresh('i');
        lines.push(`${indent}for ${i} in ${pick(['0', '-2', '1'])}..${pick(['0', '3', '5'])} {`);
        lines.push(block([...scope, { name: i, type: 'int', frozen: true }], depth - 1, true, ret, callable, indent + '  '));
        lines.push(`${indent}}`);
      } else if (roll < 0.9 && inLoop) {
        lines.push(`${indent}if ${expr('bool', scope, 1, callable)} {`, `${indent}  ${pick(['break', 'continue'])};`, `${indent}}`);
      } else if (roll < 0.95 && ret) {
        lines.push(`${indent}if ${expr('bool', scope, 1, callable)} {`, `${indent}  return ${expr(ret, scope, 2, callable)};`, `${indent}}`);
      } else {
        lines.push(`${indent}print(${expr('int', scope, 2, callable)});`);
      }
    }
    return lines.join('\n');
  }

  const parts: string[] = [];
  if (chance(0.4)) {
    const name = fresh('rec');
    const step = pick(['+', '-', '*', '^']);
    parts.push(`fn ${name}(d: int) -> int {\n  if d <= 0 {\n    return ${pick(INTS)};\n  }\n  return ${name}(d - 1) ${step} (d * ${pick(['3', '7', '-5', '1000'])});\n}`);
    helpers.push({ name, params: ['int'], ret: 'int', recursive: true });
  }
  if (chance(0.15)) {
    parts.push(`fn print_int(n: int) -> int {\n  print(n);\n  return n + 1;\n}`);
    helpers.push({ name: 'print_int', params: ['int'], ret: 'int' });
  }
  const nHelpers = Math.floor(r() * 3);
  for (let h = 0; h < nHelpers; h++) {
    const params = Array.from({ length: Math.floor(r() * 3) }, () => pick(['int', 'float', 'bool'] as const));
    const ret = pick(['int', 'float', 'bool'] as const);
    const name = fresh('f');
    const vars = params.map((t, i) => ({ name: `p${i}`, type: t, frozen: false }));
    const body = block(vars, 2, false, ret, [...helpers], '  ');
    parts.push(`fn ${name}(${params.map((t, i) => `p${i}: ${t}`).join(', ')}) -> ${ret} {\n${body}\n  return ${expr(ret, vars, 2, [...helpers])};\n}`);
    helpers.push({ name, params, ret });
  }
  parts.push(`fn main() {\n${block([], 3, false, null, helpers, '  ')}\n}`);
  return parts.join('\n\n') + '\n';
}
