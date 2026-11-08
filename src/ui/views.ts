import type { Block, Expr, Func, Program, Stmt } from '../lang/ast';
import type { Checked } from '../lang/check';
import type { ByteRegion } from '../lang/codegen';
import type { Token } from '../lang/lexer';
import { formatFloat } from '../lang/interp';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderTokens(el: HTMLElement, tokens: Token[]): void {
  const shown = tokens.filter((t) => t.kind !== 'eof');
  el.innerHTML = shown.length
    ? shown.map((t) => `<span class="tok t-${t.kind}" title="${t.kind} at offset ${t.span.start}">${esc(t.text)}</span>`).join('') + `<p class="count">${shown.length} tokens</p>`
    : '<p class="empty">No tokens yet.</p>';
}

/** The syntax tree as nested, collapsible lists, annotated with types. */
export function renderTree(el: HTMLElement, program: Program | null, checked: Checked | null): void {
  if (!program) {
    el.innerHTML = '<p class="empty">The tree appears once the program parses.</p>';
    return;
  }
  const type = (e: Expr) => {
    const t = checked?.types.get(e);
    return t ? ` <span class="ty">${t}</span>` : '';
  };
  const node = (label: string, children: string[] = [], open = true) =>
    children.length
      ? `<li><details${open ? ' open' : ''}><summary>${label}</summary><ul>${children.join('')}</ul></details></li>`
      : `<li><span class="leaf">${label}</span></li>`;
  const expr = (e: Expr): string => {
    switch (e.kind) {
      case 'int':
      case 'bool':
        return node(`<b>${e.kind}</b> <code>${String(e.value)}</code>${type(e)}`);
      case 'float':
        return node(`<b>float</b> <code>${formatFloat(e.value)}</code>${type(e)}`);
      case 'name':
        return node(`<b>variable</b> <code>${esc(e.name)}</code>${type(e)}`);
      case 'unary':
        return node(`<b>unary</b> <code>${e.op}</code>${type(e)}`, [expr(e.arg)]);
      case 'binary':
        return node(`<b>binary</b> <code>${esc(e.op)}</code>${type(e)}`, [expr(e.left), expr(e.right)]);
      case 'call':
        return node(`<b>call</b> <code>${esc(e.callee)}</code>${type(e)}`, e.args.map(expr));
    }
  };
  const block = (b: Block): string[] => b.stmts.map(stmt);
  const stmt = (s: Stmt): string => {
    switch (s.kind) {
      case 'let':
        return node(`<b>let</b> <code>${esc(s.name)}</code>${s.type ? ` <span class="ty">${s.type}</span>` : ''}`, [expr(s.value)]);
      case 'assign':
        return node(`<b>assign</b> <code>${esc(s.name)} ${s.op}</code>`, [expr(s.value)]);
      case 'if':
        return node('<b>if</b>', [node('condition', [expr(s.cond)]), node('then', block(s.then)), ...(s.else ? [node('else', block(s.else))] : [])]);
      case 'while':
        return node('<b>while</b>', [node('condition', [expr(s.cond)]), node('body', block(s.body))]);
      case 'for':
        return node(`<b>for</b> <code>${esc(s.name)}</code>`, [node('from', [expr(s.from)]), node('to', [expr(s.to)]), node('body', block(s.body))]);
      case 'break':
      case 'continue':
        return node(`<b>${s.kind}</b>`);
      case 'return':
        return node('<b>return</b>', s.value ? [expr(s.value)] : []);
      case 'expr':
        return expr(s.expr);
    }
  };
  const func = (f: Func) =>
    node(
      `<b>fn</b> <code>${esc(f.name)}(${f.params.map((p) => `${esc(p.name)}: ${p.type}`).join(', ')})${f.ret === 'void' ? '' : ` -&gt; ${f.ret}`}</code>`,
      block(f.body),
    );
  el.innerHTML = `<ul class="root">${program.funcs.map(func).join('')}</ul>`;
}

/** WebAssembly text, lightly coloured. */
export function renderWat(el: HTMLElement, wat: string): void {
  if (!wat) {
    el.innerHTML = '<span class="empty">The WebAssembly appears once the program compiles.</span>';
    return;
  }
  el.innerHTML = esc(wat)
    .replace(/(\$[\w.]+)/g, '<span class="w-id">$1</span>')
    .replace(/\b(i32|f64)\.([a-z_0-9]+)/g, '<span class="w-num">$1.$2</span>')
    .replace(/\b(local\.(?:get|set|tee)|call|br_if|br|return|select|drop|unreachable)\b/g, '<span class="w-ctl">$1</span>')
    .replace(/^(\s*)(block|loop|if|else|end)\b/gm, '$1<span class="w-blk">$2</span>')
    .replace(/\((module|type|import|func|param|result|local|export)\b/g, '(<span class="w-kw">$1</span>');
}

const KIND_LABEL: Record<ByteRegion['kind'], string> = {
  header: 'Header',
  type: 'Types',
  import: 'Imports',
  function: 'Function list',
  export: 'Exports',
  code: 'Code section',
  body: 'Function bodies',
  custom: 'Names',
};

/** The binary as a hex dump, coloured by which part of the module each byte belongs to. */
export function renderBytes(hex: HTMLElement, legend: HTMLElement, note: HTMLElement, bytes: Uint8Array | null, regions: ByteRegion[]): void {
  if (!bytes) {
    hex.innerHTML = '<p class="empty">The bytes appear once the program compiles.</p>';
    legend.innerHTML = '';
    return;
  }
  note.textContent = `The module itself: ${bytes.length.toLocaleString()} bytes, exactly as the browser receives them. Hover a byte to see which part it belongs to.`;
  const regionAt = new Array<ByteRegion | undefined>(bytes.length);
  for (const r of regions) for (let i = r.start; i < r.end; i++) regionAt[i] = r;
  const rows: string[] = [];
  const limit = Math.min(bytes.length, 8192);
  for (let off = 0; off < limit; off += 16) {
    let cells = '';
    let ascii = '';
    for (let i = off; i < Math.min(off + 16, limit); i++) {
      const r = regionAt[i];
      const b = bytes[i]!;
      cells += `<span class="b k-${r?.kind ?? 'none'}" title="${esc(r ? `${r.label} (bytes ${r.start}–${r.end - 1})` : '')}">${b.toString(16).padStart(2, '0')}</span>`;
      ascii += b >= 0x20 && b < 0x7f ? esc(String.fromCharCode(b)) : '·';
    }
    rows.push(`<div class="row"><span class="off">${off.toString(16).padStart(4, '0')}</span><span class="cells">${cells}</span><span class="ascii">${ascii}</span></div>`);
  }
  if (bytes.length > limit) rows.push(`<p class="empty">… and ${(bytes.length - limit).toLocaleString()} more bytes.</p>`);
  hex.innerHTML = rows.join('');
  const kinds = [...new Set(regions.map((r) => r.kind))];
  legend.innerHTML = kinds
    .map((k) => {
      const size = regions.filter((r) => r.kind === k).reduce((n, r) => n + r.end - r.start, 0);
      return `<li><span class="sw k-${k}"></span>${KIND_LABEL[k]} <span class="sz">${size} B</span></li>`;
    })
    .join('');
}
