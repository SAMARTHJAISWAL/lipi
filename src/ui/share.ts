/**
 * A program in a link: deflate-compressed and base64url-encoded into the URL
 * fragment (which browsers never send to a server). Older browsers without
 * CompressionStream get plain base64url, marked with a leading "u".
 */

/** Longest program a link may hold, in characters. Decoding stops as soon as it is passed. */
export const MAX_SHARED = 100_000;

function b64(bytes: Uint8Array): string {
  // In chunks: String.fromCharCode(...bytes) overflows the stack for large programs.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * Inflate, but give up as soon as the output passes the limit: a hostile link could
 * otherwise expand a couple of megabytes into gigabytes and freeze the tab.
 */
async function inflateCapped(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function encode(src: string): Promise<string> {
  const raw = new TextEncoder().encode(src);
  if (typeof CompressionStream === 'undefined') return 'u' + b64(raw);
  return 'z' + b64(await compress(raw));
}

export async function decode(s: string): Promise<string | null> {
  try {
    // UTF-8 uses at most 4 bytes per character.
    const maxBytes = MAX_SHARED * 4;
    if (s.startsWith('u')) {
      if (s.length > (maxBytes * 4) / 3 + 4) return null;
      const text = new TextDecoder().decode(unb64(s.slice(1)));
      return text.length <= MAX_SHARED ? text : null;
    }
    if (s.startsWith('z') && typeof DecompressionStream !== 'undefined') {
      const bytes = await inflateCapped(unb64(s.slice(1)), maxBytes);
      if (!bytes) return null;
      const text = new TextDecoder().decode(bytes);
      return text.length <= MAX_SHARED ? text : null;
    }
  } catch {
    /* a damaged link: ignore it */
  }
  return null;
}
