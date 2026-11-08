import type { FromWorker } from './worker';
import WorkerUrl from './worker.ts?worker&url';

export interface RunCallbacks {
  out(lines: string[], pixels: { x: number; y: number; rgb: number }[] | null): void;
  finish(result: { kind: 'done'; ms: number; truncated: boolean } | { kind: 'trap'; trap: string; ms: number } | { kind: 'timeout'; seconds: number } | { kind: 'error'; message: string } | { kind: 'stopped' }): void;
}

export const TIME_LIMIT_S = 5;

/** One run of a module in a fresh worker, stopped after TIME_LIMIT_S seconds. */
export class Run {
  private readonly worker: Worker;
  private readonly timer: ReturnType<typeof setTimeout>;
  private done = false;

  constructor(bytes: Uint8Array<ArrayBuffer>, private readonly cb: RunCallbacks) {
    this.worker = new Worker(WorkerUrl, { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.t === 'out') cb.out(m.lines, m.pixels);
      else if (m.t === 'done') this.end({ kind: 'done', ms: m.ms, truncated: m.truncated });
      else if (m.t === 'trap') this.end({ kind: 'trap', trap: m.kind, ms: m.ms });
      else this.end({ kind: 'error', message: m.message });
    };
    this.worker.onerror = (e) => this.end({ kind: 'error', message: e.message || 'The program could not start.' });
    const copy = bytes.slice().buffer;
    this.worker.postMessage({ bytes: copy }, [copy]);
    this.timer = setTimeout(() => this.end({ kind: 'timeout', seconds: TIME_LIMIT_S }), TIME_LIMIT_S * 1000);
  }

  get running(): boolean {
    return !this.done;
  }

  stop(): void {
    this.end({ kind: 'stopped' });
  }

  private end(result: Parameters<RunCallbacks['finish']>[0]): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.worker.terminate();
    this.cb.finish(result);
  }
}
