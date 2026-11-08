/// <reference lib="webworker" />
/**
 * Runs a compiled module off the main thread, so a program that never ends can
 * be stopped without freezing the page. Output is sent back in batches.
 */
import { formatFloat } from '../lang/interp';
import { trapKind } from '../lang/traps';

export type FromWorker =
  | { t: 'out'; lines: string[]; pixels: { x: number; y: number; rgb: number }[] | null }
  | { t: 'done'; ms: number; truncated: boolean }
  | { t: 'trap'; kind: string; message: string; ms: number }
  | { t: 'error'; message: string };

const MAX_LINES = 5000;

self.onmessage = async (e: MessageEvent<{ bytes: ArrayBuffer }>) => {
  let lines: string[] = [];
  let pixels: { x: number; y: number; rgb: number }[] = [];
  let total = 0;
  let truncated = false;
  let last = performance.now();
  const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
  const flush = (force = false) => {
    const now = performance.now();
    if (!force && now - last < 60) return;
    last = now;
    if (lines.length || pixels.length) post({ t: 'out', lines, pixels: pixels.length ? pixels : null });
    lines = [];
    pixels = [];
  };
  const line = (s: string) => {
    if (total >= MAX_LINES) {
      truncated = true;
      return;
    }
    total++;
    lines.push(s);
    flush();
  };
  const env = {
    print_int: (x: number) => line(String(x)),
    print_float: (x: number) => line(formatFloat(x)),
    print_bool: (x: number) => line(x ? 'true' : 'false'),
    plot: (x: number, y: number, rgb: number) => {
      if (x >= 0 && x < 256 && y >= 0 && y < 256) pixels.push({ x, y, rgb });
      if (pixels.length >= 4096) flush();
    },
  };
  let start = performance.now();
  try {
    const { instance } = await WebAssembly.instantiate(e.data.bytes, { env });
    start = performance.now();
    (instance.exports.main as () => void)();
    flush(true);
    post({ t: 'done', ms: performance.now() - start, truncated });
  } catch (err) {
    flush(true);
    const message = (err as Error).message ?? String(err);
    const kind = trapKind(message);
    if (kind) post({ t: 'trap', kind, message, ms: performance.now() - start });
    else post({ t: 'error', message });
  }
};
