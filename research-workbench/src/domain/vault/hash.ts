/**
 * Hashes of generated blocks and reflections. The normalisation makes the hash blind to what
 * editors and sync services change without the user meaning to: line endings, Unicode form,
 * trailing spaces, outer blank lines and (for blocks) link targets, which Obsidian rewrites when a
 * linked note is renamed.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/** 64-bit FNV-1a over the UTF-8 bytes, as 16 lowercase hex characters. */
export function fnv1a64(s: string): string {
  let h = FNV_OFFSET;
  for (const b of encoder.encode(s)) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK;
  return h.toString(16).padStart(16, '0');
}

/** LF line endings, NFC, no trailing whitespace on any line, no leading or trailing blank lines. */
export function normalizeForHash(s: string): string {
  const lines = s.replace(/\r\n?/g, '\n').normalize('NFC').split('\n').map((l) => l.trimEnd());
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a] === '') a++;
  while (b > a && lines[b - 1] === '') b--;
  return lines.slice(a, b).join('\n');
}

/** [[target|alias]] → [[§|alias]] and [[target]] → [[§]]: the alias still counts, the target does not. */
export const maskLinkTargets = (s: string) => s.replace(/\[\[([^[\]|\n]*)(\|[^[\]\n]*)?\]\]/g, (_m, _t, a = '') => `[[§${a}]]`);

export const blockHash = (b: string) => fnv1a64(maskLinkTargets(normalizeForHash(b)));

export const reflectionHash = (t: string) => fnv1a64(normalizeForHash(t));
