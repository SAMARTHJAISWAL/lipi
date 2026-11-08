import { compile, type CompileResult } from '../lang';
import { BUILTINS } from '../lang/check';
import { TRAP_TEXT, type TrapKind } from '../lang/traps';
import { EXAMPLES } from '../examples';
import { Run, TIME_LIMIT_S } from '../run/runner';
import { Editor } from './editor';
import { renderBytes, renderTokens, renderTree, renderWat } from './views';
import { MAX_SHARED, decode, encode } from './share';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const ms = (x: number) => (x < 0.1 ? '<0.1 ms' : x < 10 ? `${x.toFixed(1)} ms` : `${Math.round(x)} ms`);
const DRAFT = 'lipi:draft';

const TABS = ['output', 'tokens', 'tree', 'wat', 'bytes'] as const;
type Tab = (typeof TABS)[number];

export class App {
  readonly editor: Editor;
  result: CompileResult | null = null;
  private run: Run | null = null;
  private compileTimer = 0;
  private tab: Tab = 'output';
  private canvasCtx: CanvasRenderingContext2D;
  private image: ImageData;
  private pixelsDirty = false;
  private lines: string[] = [];

  constructor() {
    this.editor = new Editor($<HTMLTextAreaElement>('code'), $('highlight'), $('gutter'));
    this.canvasCtx = $<HTMLCanvasElement>('canvas').getContext('2d')!;
    this.image = this.canvasCtx.createImageData(256, 256);
    this.buildExamples();
    this.buildTabs();
    this.buildGuide();

    this.editor.onChange = () => {
      clearTimeout(this.compileTimer);
      this.compileTimer = window.setTimeout(() => this.recompile(), 120);
      try {
        localStorage.setItem(DRAFT, this.editor.value);
      } catch {
        /* no storage: fine */
      }
      $<HTMLSelectElement>('examples').value = '';
    };
    this.editor.onRun = () => this.runNow();
    $('btn-run').addEventListener('click', () => (this.run?.running ? this.run.stop() : this.runNow()));
    $('btn-share').addEventListener('click', () => void this.share());
    window.addEventListener('hashchange', () => void this.loadFromHash());
    void this.start();
  }

  private async start(): Promise<void> {
    if (!(await this.loadFromHash())) {
      let draft: string | null = null;
      try {
        draft = localStorage.getItem(DRAFT);
      } catch {
        /* ignore */
      }
      this.load(draft ?? EXAMPLES.find((e) => e.id === 'mandelbrot')!.source, draft ? '' : 'mandelbrot');
    }
    this.runNow();
  }

  private async loadFromHash(): Promise<boolean> {
    const m = /^#code=(.+)$/.exec(location.hash);
    if (m) {
      const src = await decode(m[1]!);
      if (src !== null) {
        this.load(src, '');
        return true;
      }
    }
    const ex = /^#example=([\w-]+)$/.exec(location.hash);
    const found = ex && EXAMPLES.find((e) => e.id === ex[1]);
    if (found) {
      this.load(found.source, found.id);
      return true;
    }
    return false;
  }

  load(src: string, exampleId: string): void {
    this.editor.value = src;
    $<HTMLSelectElement>('examples').value = exampleId;
    this.recompile();
  }

  // ---- Compiling ------------------------------------------------------------------

  recompile(): CompileResult {
    const r = compile(this.editor.value);
    this.result = r;
    this.editor.setError(r.error ? { start: r.error.start, end: r.error.end, line: r.error.line } : null);
    const d = $('diagnostic');
    if (r.error) {
      d.className = 'diagnostic bad';
      d.innerHTML = `<strong>${r.error.stage === 'syntax' ? 'Syntax error' : 'Type error'}</strong> on line ${r.error.line}, column ${r.error.col}: <span class="msg"></span>`;
      d.querySelector('.msg')!.textContent = r.error.message;
    } else {
      d.className = 'diagnostic ok';
      d.textContent = `Compiles: ${r.bytes!.length.toLocaleString()} bytes of WebAssembly in ${ms(r.timings.lex + r.timings.parse + r.timings.check + r.timings.generate)}.`;
    }
    this.renderPipeline();
    this.renderTab();
    return r;
  }

  private renderPipeline(): void {
    const r = this.result!;
    const failed = r.error?.stage;
    const nodes = r.program ? countNodes(r.program) : 0;
    const stages: [string, string, 'ok' | 'bad' | 'off', Tab | null][] = [
      ['Lex', r.tokens.length ? `${r.tokens.length - 1} tokens` : '—', r.tokens.length ? 'ok' : 'bad', 'tokens'],
      ['Parse', r.program ? `${nodes} nodes` : failed === 'syntax' ? 'syntax error' : '—', r.program ? 'ok' : failed === 'syntax' ? 'bad' : 'off', 'tree'],
      ['Check types', r.checked ? 'all typed' : failed === 'type' ? 'type error' : '—', r.checked ? 'ok' : failed === 'type' ? 'bad' : 'off', 'tree'],
      ['Generate', r.bytes ? `${r.bytes.length} bytes` : '—', r.bytes ? 'ok' : 'off', 'wat'],
    ];
    $('pipeline').innerHTML = stages
      .map(([name, info, state, tab]) => `<li class="${state}"><button type="button" data-tab="${tab}"><span class="st-name">${name}</span><span class="st-info">${info}</span></button></li>`)
      .join('');
    for (const b of $('pipeline').querySelectorAll<HTMLButtonElement>('button')) b.addEventListener('click', () => this.selectTab(b.dataset.tab as Tab));
  }

  // ---- Running --------------------------------------------------------------------------

  runNow(): void {
    this.run?.stop();
    const r = this.recompile();
    this.selectTab('output');
    this.lines = [];
    $('console').textContent = '';
    this.image.data.fill(0);
    $('canvas').hidden = true;
    $('output-grid').classList.remove('has-canvas');
    const status = $('run-status');
    if (r.error) {
      status.className = 'run-status bad';
      status.textContent = 'Fix the error first: the program has not been run.';
      return;
    }
    status.className = 'run-status';
    status.textContent = 'Running…';
    this.setRunning(true);
    this.run = new Run(r.bytes!, {
      out: (lines, pixels) => {
        if (lines.length) {
          this.lines.push(...lines);
          const c = $('console');
          c.textContent = this.lines.join('\n');
          c.scrollTop = c.scrollHeight;
        }
        if (pixels) this.paint(pixels);
      },
      finish: (res) => {
        this.setRunning(false);
        this.flushPixels();
        if (res.kind === 'done') {
          status.className = 'run-status ok';
          status.textContent = `Ran in ${ms(res.ms)}${this.lines.length ? ` · ${this.lines.length.toLocaleString()} line${this.lines.length === 1 ? '' : 's'}` : ''}${res.truncated ? ' · output cut off at 5,000 lines' : ''}.`;
          if (!this.lines.length && $('canvas').hidden) $('console').textContent = '(The program finished without printing anything.)';
        } else if (res.kind === 'trap') {
          status.className = 'run-status bad';
          status.textContent = `Stopped with a runtime error after ${ms(res.ms)}: ${TRAP_TEXT[res.trap as TrapKind] ?? res.trap}`;
        } else if (res.kind === 'timeout') {
          status.className = 'run-status bad';
          status.textContent = `Stopped: still running after ${res.seconds} seconds. Is there a loop that never ends?`;
        } else if (res.kind === 'stopped') {
          status.className = 'run-status';
          status.textContent = 'Stopped.';
        } else {
          status.className = 'run-status bad';
          status.textContent = `The program could not run: ${res.message}`;
        }
      },
    });
  }

  private setRunning(on: boolean): void {
    $('run-label').textContent = on ? 'Stop' : 'Run';
    $('btn-run').classList.toggle('running', on);
    $('btn-run').title = on ? `Stop the program (it is stopped anyway after ${TIME_LIMIT_S} s)` : 'Compile and run (Ctrl+Enter)';
  }

  private paint(pixels: { x: number; y: number; rgb: number }[]): void {
    const d = this.image.data;
    for (const p of pixels) {
      const o = (p.y * 256 + p.x) * 4;
      d[o] = (p.rgb >> 16) & 255;
      d[o + 1] = (p.rgb >> 8) & 255;
      d[o + 2] = p.rgb & 255;
      d[o + 3] = 255;
    }
    $('canvas').hidden = false;
    $('output-grid').classList.add('has-canvas');
    if (!this.pixelsDirty) {
      this.pixelsDirty = true;
      requestAnimationFrame(() => this.flushPixels());
    }
  }

  private flushPixels(): void {
    this.pixelsDirty = false;
    this.canvasCtx.putImageData(this.image, 0, 0);
  }

  // ---- Tabs, examples, sharing --------------------------------------------------------------

  private buildTabs(): void {
    for (const t of TABS) {
      $(`tab-${t}`).addEventListener('click', () => this.selectTab(t));
      $(`tab-${t}`).addEventListener('keydown', (e) => {
        const i = TABS.indexOf(t);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
          this.selectTab(next);
          $(`tab-${next}`).focus();
        }
      });
    }
  }

  selectTab(t: Tab): void {
    this.tab = t;
    for (const x of TABS) {
      const on = x === t;
      $(`tab-${x}`).setAttribute('aria-selected', String(on));
      $(`tab-${x}`).tabIndex = on ? 0 : -1;
      $(`view-${x}`).hidden = !on;
    }
    this.renderTab();
  }

  private renderTab(): void {
    const r = this.result;
    if (!r) return;
    if (this.tab === 'tokens') renderTokens($('tokens'), r.tokens);
    else if (this.tab === 'tree') renderTree($('tree'), r.program, r.checked);
    else if (this.tab === 'wat') renderWat($('wat'), r.wat);
    else if (this.tab === 'bytes') renderBytes($('hex'), $('legend'), $('bytes-note'), r.bytes, r.regions);
  }

  private buildExamples(): void {
    const sel = $<HTMLSelectElement>('examples');
    sel.innerHTML = `<option value="">Examples…</option>` + EXAMPLES.map((e) => `<option value="${e.id}">${e.title}</option>`).join('');
    sel.addEventListener('change', () => {
      const ex = EXAMPLES.find((e) => e.id === sel.value);
      if (!ex) return;
      this.load(ex.source, ex.id);
      history.replaceState(null, '', `#example=${ex.id}`);
      this.runNow();
    });
  }

  private buildGuide(): void {
    $('builtins').innerHTML = BUILTINS.map((b) => `<li><code>${b.doc.split(':')[0]}</code>${b.doc.includes(':') ? ` ${b.doc.split(':').slice(1).join(':')}` : ''}</li>`).join('');
  }

  private async share(): Promise<void> {
    if (this.editor.value.length > MAX_SHARED) {
      this.toast(`This program is too long to share as a link (over ${MAX_SHARED.toLocaleString()} characters).`);
      return;
    }
    let url: string;
    try {
      url = `${location.origin}${location.pathname}#code=${await encode(this.editor.value)}`;
    } catch {
      this.toast('Could not make a link for this program.');
      return;
    }
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Link copied: it opens this exact program.');
    } catch {
      this.toast('The link to this program is now in the address bar.');
    }
  }

  private toastTimer = 0;

  private toast(text: string): void {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), 2800);
  }
}

function countNodes(p: { funcs: unknown[] }): number {
  let n = 0;
  const walk = (x: unknown) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(walk);
    const o = x as Record<string, unknown>;
    if (typeof o.kind === 'string') n++;
    for (const [k, v] of Object.entries(o)) if (k !== 'span' && k !== 'nameSpan' && k !== 'calleeSpan') walk(v);
  };
  walk(p.funcs);
  return n + p.funcs.length;
}
