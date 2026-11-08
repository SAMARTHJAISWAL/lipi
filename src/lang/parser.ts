import { LipiError, type BinOp, type Block, type Expr, type Func, type Param, type Program, type Span, type Stmt, type Type } from './ast';
import { lex, type Token } from './lexer';

/** Binary operators by precedence, loosest first. All are left-associative. */
const LEVELS: BinOp[][] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

const span = (a: Span, b: Span): Span => ({ start: a.start, end: b.end });

/** Turn source text into a syntax tree, or throw a LipiError pointing at the problem. */
export function parse(src: string): Program {
  return new Parser(lex(src)).program();
}

class Parser {
  private i = 0;

  constructor(private readonly toks: Token[]) {}

  private get tok(): Token {
    return this.toks[this.i]!;
  }

  private next(): Token {
    const t = this.tok;
    if (t.kind !== 'eof') this.i++;
    return t;
  }

  private is(text: string): boolean {
    const t = this.tok;
    return (t.kind === 'punct' || t.kind === 'op' || t.kind === 'keyword') && t.text === text;
  }

  private eat(text: string): boolean {
    if (!this.is(text)) return false;
    this.next();
    return true;
  }

  private expect(text: string, what = `"${text}"`): Token {
    if (this.is(text)) return this.next();
    throw this.error(`Expected ${what}, found ${this.describe(this.tok)}`);
  }

  private describe(t: Token): string {
    return t.kind === 'eof' ? 'the end of the program' : `"${t.text}"`;
  }

  private error(message: string, s: Span = this.tok.span): LipiError {
    return new LipiError(message, s, 'syntax');
  }

  private name(what: string): Token {
    if (this.tok.kind === 'name') return this.next();
    if (this.tok.kind === 'keyword' || this.tok.kind === 'type') throw this.error(`"${this.tok.text}" is a reserved word and can't be used as ${what}`);
    throw this.error(`Expected ${what}, found ${this.describe(this.tok)}`);
  }

  private type(): Type {
    if (this.tok.kind === 'type') return this.next().text as Type;
    throw this.error(`Expected a type (int, float or bool), found ${this.describe(this.tok)}`);
  }

  program(): Program {
    const funcs: Func[] = [];
    while (this.tok.kind !== 'eof') {
      if (!this.is('fn')) throw this.error(`Expected "fn" to start a function, found ${this.describe(this.tok)}`);
      funcs.push(this.func());
    }
    return { funcs };
  }

  private func(): Func {
    const start = this.expect('fn').span;
    const name = this.name('a function name');
    this.expect('(');
    const params: Param[] = [];
    if (!this.is(')')) {
      do {
        const p = this.name('a parameter name');
        this.expect(':', '":" and a type');
        params.push({ name: p.text, type: this.type(), span: p.span });
      } while (this.eat(','));
    }
    this.expect(')');
    let ret: Type = 'void';
    if (this.eat('->')) ret = this.type();
    const body = this.block();
    return { name: name.text, nameSpan: name.span, params, ret, body, span: span(start, body.span) };
  }

  private block(): Block {
    const start = this.expect('{').span;
    const stmts: Stmt[] = [];
    while (!this.is('}')) {
      if (this.tok.kind === 'eof') throw this.error('This block is missing its closing "}"', start);
      stmts.push(this.stmt());
    }
    const end = this.next().span;
    return { stmts, span: span(start, end) };
  }

  private stmt(): Stmt {
    const t = this.tok;
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'let': {
          this.next();
          const name = this.name('a variable name');
          let type: Type | null = null;
          if (this.eat(':')) type = this.type();
          this.expect('=', '"=" and a value');
          const value = this.expr();
          const end = this.expect(';', '";"').span;
          return { kind: 'let', name: name.text, nameSpan: name.span, type, value, span: span(t.span, end) };
        }
        case 'if':
          return this.ifStmt();
        case 'while': {
          this.next();
          const cond = this.expr();
          const body = this.block();
          return { kind: 'while', cond, body, span: span(t.span, body.span) };
        }
        case 'for': {
          this.next();
          const name = this.name('a loop variable');
          this.expect('in', '"in"');
          const from = this.expr();
          this.expect('..', '".." (as in 0..10)');
          const to = this.expr();
          const body = this.block();
          return { kind: 'for', name: name.text, nameSpan: name.span, from, to, body, span: span(t.span, body.span) };
        }
        case 'break':
        case 'continue': {
          this.next();
          const end = this.expect(';', '";"').span;
          return { kind: t.text, span: span(t.span, end) } as Stmt;
        }
        case 'return': {
          this.next();
          const value = this.is(';') ? null : this.expr();
          const end = this.expect(';', '";"').span;
          return { kind: 'return', value, span: span(t.span, end) };
        }
        case 'fn':
          throw this.error('Functions can only be declared at the top level, not inside another function');
      }
    }
    // Assignment: name op= expr;
    const after = this.toks[this.i + 1];
    if (t.kind === 'name' && after?.kind === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(after.text)) {
      this.next();
      const op = this.next().text as '=' | '+=' | '-=' | '*=' | '/=' | '%=';
      const value = this.expr();
      const end = this.expect(';', '";"').span;
      return { kind: 'assign', name: t.text, nameSpan: t.span, op, value, span: span(t.span, end) };
    }
    const expr = this.expr();
    const end = this.expect(';', '";"').span;
    return { kind: 'expr', expr, span: span(expr.span, end) };
  }

  private ifStmt(): Stmt {
    const start = this.expect('if').span;
    const cond = this.expr();
    const then = this.block();
    let els: Block | null = null;
    if (this.eat('else')) {
      if (this.is('if')) {
        const nested = this.ifStmt();
        els = { stmts: [nested], span: nested.span };
      } else els = this.block();
    }
    return { kind: 'if', cond, then, else: els, span: span(start, (els ?? then).span) };
  }

  expr(level = 0): Expr {
    if (level === LEVELS.length) return this.unary();
    let left = this.expr(level + 1);
    for (;;) {
      const t = this.tok;
      if (t.kind !== 'op' || !(LEVELS[level] as string[]).includes(t.text)) return left;
      this.next();
      const right = this.expr(level + 1);
      left = { kind: 'binary', op: t.text as BinOp, left, right, span: span(left.span, right.span) };
    }
  }

  private unary(): Expr {
    const t = this.tok;
    if (t.kind === 'op' && (t.text === '-' || t.text === '!')) {
      this.next();
      // -2147483648 is the one literal that only fits with its minus sign attached.
      if (t.text === '-' && this.tok.kind === 'int') {
        const lit = this.intLiteral(true);
        return { kind: 'int', value: -lit.value | 0, span: span(t.span, lit.span) };
      }
      const arg = this.unary();
      // Fold "-literal" so the most negative int can be written.
      if (t.text === '-' && arg.kind === 'int') return { kind: 'int', value: -arg.value | 0, span: span(t.span, arg.span) };
      if (t.text === '-' && arg.kind === 'float') return { kind: 'float', value: -arg.value, span: span(t.span, arg.span) };
      return { kind: 'unary', op: t.text, arg, span: span(t.span, arg.span) };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.tok;
    switch (t.kind) {
      case 'int':
        return this.intLiteral(false);
      case 'float':
        this.next();
        return { kind: 'float', value: Number(t.text.replace(/_/g, '')), span: t.span };
      case 'keyword':
        if (t.text === 'true' || t.text === 'false') {
          this.next();
          return { kind: 'bool', value: t.text === 'true', span: t.span };
        }
        break;
      case 'type':
        // int(x) and float(x) are conversions, written like calls.
        if ((t.text === 'int' || t.text === 'float') && this.toks[this.i + 1]?.text === '(') return this.call(this.next());
        break;
      case 'name':
        this.next();
        if (this.is('(')) return this.call(t);
        return { kind: 'name', name: t.text, span: t.span };
      case 'punct':
        if (t.text === '(') {
          this.next();
          const e = this.expr();
          this.expect(')', '")"');
          return e;
        }
        break;
    }
    throw this.error(`Expected a value, found ${this.describe(t)}`);
  }

  /**
   * An int literal. Hex can use all 32 bits; decimal goes up to 2^31 - 1, or 2^31 when
   * `negated` (only a unary minus directly in front sets it), so -2147483648 can be written
   * but `0 - 2147483648` cannot sneak an out-of-range literal past the check.
   */
  private intLiteral(negated: boolean): { kind: 'int'; value: number; span: Span } {
    const t = this.next();
    const text = t.text.replace(/_/g, '');
    const value = Number(text);
    const max = text.startsWith('0x') || text.startsWith('0X') ? 0xffffffff : negated ? 2 ** 31 : 2 ** 31 - 1;
    if (!Number.isSafeInteger(value) || value > max) throw this.error(`${t.text} is too big for an int (32 bits)`, t.span);
    return { kind: 'int', value: value | 0, span: t.span };
  }

  private call(callee: Token): Expr {
    this.expect('(');
    const args: Expr[] = [];
    if (!this.is(')')) {
      do args.push(this.expr());
      while (this.eat(','));
    }
    const end = this.expect(')', '")" to close the call').span;
    return { kind: 'call', callee: callee.text, calleeSpan: callee.span, args, span: span(callee.span, end) };
  }
}
