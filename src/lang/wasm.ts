/**
 * A tiny WebAssembly binary encoder: just what the code generator needs.
 * Reference: the WebAssembly Core Specification, section 5 (Binary Format).
 */

export const VAL = { i32: 0x7f, f64: 0x7c } as const;
export type ValName = keyof typeof VAL;
export const EMPTY_BLOCK = 0x40;

/** Unsigned LEB128. */
export function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

/** Signed LEB128 for a 32-bit integer. */
export function sleb(n: number): number[] {
  n |= 0;
  const out: number[] = [];
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    const done = (n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

/** IEEE 754 double, little-endian. */
export function f64(x: number): number[] {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x, true);
  return [...new Uint8Array(b.buffer)];
}

export function name(s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [...uleb(bytes.length), ...bytes];
}

export function vec(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

export const SECTION = { custom: 0, type: 1, import: 2, function: 3, export: 7, code: 10 } as const;

export function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

/** Opcodes used by the code generator, by their text-format name. */
export const OP: Record<string, number[]> = {
  unreachable: [0x00],
  nop: [0x01],
  block: [0x02],
  loop: [0x03],
  if: [0x04],
  else: [0x05],
  end: [0x0b],
  br: [0x0c],
  br_if: [0x0d],
  return: [0x0f],
  call: [0x10],
  drop: [0x1a],
  select: [0x1b],
  'local.get': [0x20],
  'local.set': [0x21],
  'local.tee': [0x22],
  'i32.const': [0x41],
  'f64.const': [0x44],
  'i32.eqz': [0x45],
  'i32.eq': [0x46],
  'i32.ne': [0x47],
  'i32.lt_s': [0x48],
  'i32.gt_s': [0x4a],
  'i32.le_s': [0x4c],
  'i32.ge_s': [0x4e],
  'f64.eq': [0x61],
  'f64.ne': [0x62],
  'f64.lt': [0x63],
  'f64.gt': [0x64],
  'f64.le': [0x65],
  'f64.ge': [0x66],
  'i32.add': [0x6a],
  'i32.sub': [0x6b],
  'i32.mul': [0x6c],
  'i32.div_s': [0x6d],
  'i32.rem_s': [0x6f],
  'i32.and': [0x71],
  'i32.or': [0x72],
  'i32.xor': [0x73],
  'i32.shl': [0x74],
  'i32.shr_s': [0x75],
  'f64.abs': [0x99],
  'f64.neg': [0x9a],
  'f64.floor': [0x9c],
  'f64.sqrt': [0x9f],
  'f64.add': [0xa0],
  'f64.sub': [0xa1],
  'f64.mul': [0xa2],
  'f64.div': [0xa3],
  'f64.min': [0xa4],
  'f64.max': [0xa5],
  'f64.convert_i32_s': [0xb7],
  'i32.trunc_sat_f64_s': [0xfc, 0x02],
};
