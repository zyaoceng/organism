/**
 * The generated block: everything between one begin marker and one end marker outside code
 * fences. The begin marker carries the hash of what was written, so a hand edit is detected
 * (merge.ts) instead of overwritten.
 */
import { fenceMask } from './text';

export const BEGIN_RE = /^<!-- wb:begin h=([0-9a-f]{16})(?: [^\n]*?)? -->[ \t]*$/;
export const END_RE = /^<!-- wb:end(?: [^\n]*?)? -->[ \t]*$/;
export const beginLine = (h: string) => `<!-- wb:begin h=${h} 研究工作台自動產生，請勿修改此區；你的內容寫在區塊外 -->`;
export const END_LINE = '<!-- wb:end -->';

export type BlockScan =
  | { kind: 'none' }
  | { kind: 'one'; begin: number; end: number; hash: string }
  | { kind: 'invalid'; reason: 'unpaired' | 'multiple' | 'nested' };

export const isMarkerLine = (l: string) => BEGIN_RE.test(l) || END_RE.test(l);

/** Indexes of the marker lines from `from` on that are not inside a code fence. */
export function markerLines(lines: string[], from: number): number[] {
  const mask = fenceMask(lines, from);
  const out: number[] = [];
  for (let i = from; i < lines.length; i++) if (!mask[i] && isMarkerLine(lines[i])) out.push(i);
  return out;
}

/** Exactly one begin followed by one end (outside fences) is `one`; any other marker layout is invalid. */
export function scanBlock(lines: string[], from: number): BlockScan {
  let open: { at: number; hash: string } | null = null;
  let found: { begin: number; end: number; hash: string } | null = null;
  let pairs = 0;
  for (const i of markerLines(lines, from)) {
    const b = BEGIN_RE.exec(lines[i]);
    if (b) {
      if (open) return { kind: 'invalid', reason: 'nested' };
      open = { at: i, hash: b[1] };
    } else {
      if (!open) return { kind: 'invalid', reason: 'unpaired' };
      found = { begin: open.at, end: i, hash: open.hash };
      open = null;
      pairs++;
    }
  }
  if (open) return { kind: 'invalid', reason: 'unpaired' };
  if (pairs > 1) return { kind: 'invalid', reason: 'multiple' };
  return found ? { kind: 'one', ...found } : { kind: 'none' };
}

export const blockContent = (lines: string[], s: Extract<BlockScan, { kind: 'one' }>) => lines.slice(s.begin + 1, s.end).join('\n');
