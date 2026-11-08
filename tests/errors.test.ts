import { describe, expect, it } from 'vitest';
import { compile } from '../src/lang';

const err = (src: string) => compile(src).error;
const main = (body: string) => `fn main() {\n${body}\n}\n`;

describe('error messages point at the problem and say what to do', () => {
  it.each([
    ['a missing semicolon', main('  let x = 1\n  print(x);'), 'syntax', /Expected ";", found "print"/, 3, 3],
    ['an unclosed block', 'fn main() {\n  print(1);\n', 'syntax', /missing its closing "\}"/, 1, 11],
    ['a stray character', main('  let x = 1 @ 2;'), 'syntax', /Unexpected character "@"/, 2, 13],
    ['a keyword as a name', main('  let while = 1;'), 'syntax', /"while" is a reserved word/, 2, 7],
    ['a too-large number', main('  let x = 2147483648;'), 'syntax', /too big for an int/, 2, 11],
    ['no main', 'fn helper() {}\n', 'type', /needs a function called main/, 1, 1],
    ['an undeclared variable', main('  print(y);'), 'type', /no variable called "y"/, 2, 9],
    ['mixing int and float', main('  let x = 1 + 2.0;'), 'type', /Can't use \+ on an int and a float\. Convert/, 2, 11],
    ['a float condition', main('  if 1.5 { print(1); }'), 'type', /condition of if must be a bool/, 2, 6],
    ['a typo in a function name', main('  prnt(1);'), 'type', /no function called "prnt"\. Did you mean print\?/, 2, 3],
    ['wrong argument count', 'fn sq(x: int) -> int { return x * x; }\n' + main('  print(sq(1, 2));'), 'type', /sq takes 1 argument, but 2 were given/, 3, 9],
    ['a missing return', 'fn f(x: int) -> int {\n  if x > 0 { return 1; }\n}\n' + main(''), 'type', /must return an int on every path/, 3, 1],
    ['break outside a loop', main('  break;'), 'type', /only be used inside a while or for loop/, 2, 3],
    ['unreachable code', main('  for i in 0..3 {\n    break;\n    print(i);\n  }'), 'type', /can never run/, 4, 5],
    ['% on floats', main('  let x = 5.0 % 2.0;'), 'type', /works on ints only/, 2, 11],
    ['redeclaring in one block', main('  let x = 1;\n  let x = 2;'), 'type', /already declared in this block; to change it, write x = \.\.\.;/, 3, 7],
    ['a value thrown away', main('  1 + 2;'), 'type', /computed and then thrown away/, 2, 3],
  ])('%s', (_, src, stage, message, line, col) => {
    const e = err(src);
    expect(e, src).not.toBeNull();
    expect(e!.stage).toBe(stage);
    expect(e!.message).toMatch(message);
    expect([e!.line, e!.col]).toEqual([line, col]);
  });

  it('allows shadowing in an inner block', () => {
    expect(err(main('  let x = 1;\n  if true {\n    let x = 2.5;\n    print(x);\n  }\n  print(x);'))).toBeNull();
  });

  it('allows -2147483648 and hex up to 0xffffffff', () => {
    expect(err(main('  print(-2147483648);\n  print(0xffffffff);'))).toBeNull();
  });
});

describe('the binary map', () => {
  it('covers every byte exactly once, in order', () => {
    const r = compile('fn sq(x: int) -> int { return x * x; }\nfn main() { print(sq(12)); }\n');
    const regions = [...r.regions].sort((a, b) => a.start - b.start);
    expect(regions[0]!.start).toBe(0);
    for (let i = 1; i < regions.length; i++) expect(regions[i]!.start).toBe(regions[i - 1]!.end);
    expect(regions.at(-1)!.end).toBe(r.bytes!.length);
    expect(regions.filter((x) => x.kind === 'body').map((x) => x.label)).toEqual([expect.stringMatching(/^Body of sq/), expect.stringMatching(/^Body of main/)]);
  });

  it('writes WebAssembly text that names every function and local', () => {
    const r = compile('fn sq(x: int) -> int { let y = x * x; return y; }\nfn main() { print(sq(3)); }\n');
    expect(r.wat).toMatch(/\(func \$sq \(param \$x i32\) \(result i32\)/);
    expect(r.wat).toMatch(/\(local \$y i32\)/);
    expect(r.wat).toMatch(/call \$sq/);
    expect(r.wat).toMatch(/\(export "main" \(func \$main\)\)/);
  });
});
