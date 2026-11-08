/**
 * WebAssembly engines describe the same runtime error in different words
 * (V8: "divide by zero", "remainder by zero", "divide result unrepresentable";
 * SpiderMonkey: "integer divide by zero", "integer overflow"). Map them all to
 * the interpreter's names, and to a sentence for people.
 */
export type TrapKind = 'integer divide by zero' | 'integer overflow' | 'unreachable' | 'stack overflow';

export function trapKind(message: string): TrapKind | null {
  const m = message.toLowerCase();
  if (m.includes('divide by zero') || m.includes('division by zero') || m.includes('remainder by zero')) return 'integer divide by zero';
  if (m.includes('unrepresentable') || (m.includes('overflow') && !m.includes('stack') && !m.includes('call'))) return 'integer overflow';
  if (m.includes('unreachable')) return 'unreachable';
  if (m.includes('stack') || m.includes('too much recursion') || m.includes('call stack')) return 'stack overflow';
  return null;
}

export const TRAP_TEXT: Record<TrapKind, string> = {
  'integer divide by zero': 'Division by zero: an int was divided by 0 (with / or %).',
  'integer overflow': 'Integer overflow: -2147483648 / -1 is too big for an int.',
  unreachable: 'A function reached its end without returning a value.',
  'stack overflow': 'Too much recursion: a function kept calling itself until the call stack ran out.',
};
