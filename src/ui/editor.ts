import { BUILTINS } from '../lang/check';
import { KEYWORDS, TYPES } from '../lang/lexer';

const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Colour source text for display. Unlike the real lexer this never fails: it is
 * run on half-typed code on every keystroke.
 */
export function highlight(src: string, error: { start: number; end: number } | null): string {
  const re = /(\/\/[^\n]*)|(0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(\.\.|->|[+\-*/%<>=!&|^]=?|&&|\|\|)|([(){},;:])/g;
  const out: string[] = [];
  let last = 0;
  const push = (from: number, to: number, cls: string | null) => {
    if (to <= from) return;
    // Split around the error range so it can be underlined across token boundaries.
    const cuts = [from, to];
    if (error) for (const p of [error.start, error.end]) if (p > from && p < to) cuts.splice(cuts.length - 1, 0, p);
    cuts.sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i]!;
      const b = cuts[i + 1]!;
      let html = esc(src.slice(a, b));
      if (cls) html = `<span class="${cls}">${html}</span>`;
      if (error && a >= error.start && b <= error.end) html = `<mark class="err">${html}</mark>`;
      out.push(html);
    }
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    push(last, m.index, null);
    const text = m[0];
    let cls: string;
    if (m[1]) cls = 'c-comment';
    else if (m[2]) cls = 'c-number';
    else if (m[3]) {
      if (text === 'true' || text === 'false') cls = 'c-number';
      else if (KEYWORDS.has(text)) cls = 'c-keyword';
      else if (TYPES.has(text)) cls = 'c-type';
      else if (BUILTIN_NAMES.has(text)) cls = 'c-builtin';
      else if (/^\s*\(/.test(src.slice(m.index + text.length))) cls = 'c-func';
      else cls = 'c-name';
    } else if (m[4]) cls = 'c-op';
    else cls = 'c-punct';
    push(m.index, m.index + text.length, cls);
    last = m.index + text.length;
  }
  push(last, src.length, null);
  // An error at the very end (a missing "}") gets a visible marker.
  if (error && error.start >= src.length) out.push('<mark class="err eol"> </mark>');
  // A trailing newline needs a character after it, or the last line collapses.
  return out.join('') + '\n';
}

/** Wire a textarea to its highlight layer and line-number gutter. */
export class Editor {
  onChange: (() => void) | null = null;
  onRun: (() => void) | null = null;
  private error: { start: number; end: number; line: number } | null = null;

  constructor(
    readonly area: HTMLTextAreaElement,
    private readonly layer: HTMLElement,
    private readonly gutter: HTMLElement,
  ) {
    area.addEventListener('input', () => {
      this.render();
      this.onChange?.();
    });
    area.addEventListener('scroll', () => this.sync());
    area.addEventListener('keydown', (e) => this.key(e));
  }

  get value(): string {
    return this.area.value;
  }

  set value(v: string) {
    this.area.value = v;
    this.render();
  }

  setError(e: { start: number; end: number; line: number } | null): void {
    this.error = e;
    this.render();
  }

  render(): void {
    this.layer.innerHTML = highlight(this.area.value, this.error);
    const lines = this.area.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= lines; i++) html += `<span${this.error?.line === i ? ' class="bad"' : ''}>${i}</span>`;
    this.gutter.innerHTML = html;
    this.sync();
  }

  private sync(): void {
    this.layer.style.transform = `translate(${-this.area.scrollLeft}px, ${-this.area.scrollTop}px)`;
    this.gutter.style.transform = `translateY(${-this.area.scrollTop}px)`;
  }

  private key(e: KeyboardEvent): void {
    const a = this.area;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      this.onRun?.();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Indent with two spaces. (Escape, then Tab, still moves focus on: textarea default after Escape is not trapped.)
      e.preventDefault();
      this.insert('  ');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Keep the current indentation, and indent one more level after an opening brace.
      const before = a.value.slice(0, a.selectionStart);
      const lineStart = before.lastIndexOf('\n') + 1;
      const indent = /^ */.exec(before.slice(lineStart))![0];
      const extra = before.trimEnd().endsWith('{') ? '  ' : '';
      e.preventDefault();
      this.insert('\n' + indent + extra);
      return;
    }
    if (e.key === '}') {
      // Outdent a closing brace typed on an otherwise empty line.
      const before = a.value.slice(0, a.selectionStart);
      const lineStart = before.lastIndexOf('\n') + 1;
      if (/^ {2,}$/.test(before.slice(lineStart)) && a.selectionStart === a.selectionEnd) {
        e.preventDefault();
        a.setSelectionRange(a.selectionStart - 2, a.selectionStart);
        this.insert('}');
      }
    }
  }

  /** Insert text at the cursor in a way that keeps the browser's undo history. */
  private insert(text: string): void {
    const a = this.area;
    a.focus();
    if (!document.execCommand('insertText', false, text)) {
      a.setRangeText(text, a.selectionStart, a.selectionEnd, 'end');
      a.dispatchEvent(new Event('input'));
    }
  }
}
