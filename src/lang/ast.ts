/** Positions are character offsets into the source; line and column are worked out when reporting. */
export interface Span {
  start: number;
  end: number;
}

export type Type = 'int' | 'float' | 'bool' | 'void';

export type Expr =
  | { kind: 'int'; value: number; span: Span }
  | { kind: 'float'; value: number; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'name'; name: string; span: Span }
  | { kind: 'unary'; op: '-' | '!'; arg: Expr; span: Span }
  | { kind: 'binary'; op: BinOp; left: Expr; right: Expr; span: Span }
  | { kind: 'call'; callee: string; calleeSpan: Span; args: Expr[]; span: Span };

export type BinOp =
  | '+' | '-' | '*' | '/' | '%'
  | '<' | '<=' | '>' | '>=' | '==' | '!='
  | '&&' | '||'
  | '&' | '|' | '^' | '<<' | '>>';

export type Stmt =
  | { kind: 'let'; name: string; nameSpan: Span; type: Type | null; value: Expr; span: Span }
  | { kind: 'assign'; name: string; nameSpan: Span; op: '=' | '+=' | '-=' | '*=' | '/=' | '%='; value: Expr; span: Span }
  | { kind: 'if'; cond: Expr; then: Block; else: Block | null; span: Span }
  | { kind: 'while'; cond: Expr; body: Block; span: Span }
  | { kind: 'for'; name: string; nameSpan: Span; from: Expr; to: Expr; body: Block; span: Span }
  | { kind: 'break'; span: Span }
  | { kind: 'continue'; span: Span }
  | { kind: 'return'; value: Expr | null; span: Span }
  | { kind: 'expr'; expr: Expr; span: Span };

export interface Block {
  stmts: Stmt[];
  span: Span;
}

export interface Param {
  name: string;
  type: Type;
  span: Span;
}

export interface Func {
  name: string;
  nameSpan: Span;
  params: Param[];
  ret: Type;
  body: Block;
  span: Span;
}

export interface Program {
  funcs: Func[];
}

/** A compile error with where it happened. */
export class LipiError extends Error {
  constructor(
    message: string,
    readonly span: Span,
    readonly stage: 'syntax' | 'type',
  ) {
    super(message);
  }
}

export function lineCol(src: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') {
      line++;
      last = i;
    }
  }
  return { line, col: offset - last };
}
