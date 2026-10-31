/**
 * Writing a rendered note into a file the user may have edited. Only the generated block and the
 * `wb_*` frontmatter keys are ever replaced; every other line is kept byte for byte. Whenever the
 * file is not in a state where that is certain (block edited by hand, markers missing or
 * duplicated, frontmatter not closed, another note's id), the merge refuses with a conflict and
 * the caller writes nothing.
 */
import { END_LINE, beginLine, blockContent, markerLines, scanBlock, type BlockScan } from './block';
import { findFrontmatter, readTopLevelScalar, setAppKeys, type FrontmatterScan } from './frontmatter';
import { blockHash, normalizeForHash } from './hash';
import { parseDoc, printDoc, type Doc } from './text';
import type { ConflictReason, ResolvedNote } from './types';

export type MergeConflict = Exclude<ConflictReason, 'duplicate-id' | 'write-failed' | 'unavailable'>;
export type MergeResult = { ok: true; text: string; changed: boolean } | { ok: false; conflict: MergeConflict };

const splitLines = (s: string) => (s === '' ? [] : s.replace(/\r\n?/g, '\n').split('\n'));

/** Begin marker (with the hash of the block), the block, end marker. */
function blockLines(n: ResolvedNote): string[] {
  return [beginLine(blockHash(n.block)), ...splitLines(n.block), END_LINE];
}

const fmLines = (n: ResolvedNote) => n.frontmatter.map(([k, v]) => `${k}: ${v}`);

/** The text of a new note: frontmatter, block, a blank line and the body (omitted when empty). */
export function createNoteText(n: ResolvedNote): string {
  const lines = ['---', ...fmLines(n), '---', ...blockLines(n)];
  const body = n.body.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (body) lines.push('', ...body.split('\n'));
  return `${lines.join('\n')}\n`;
}

interface Opened {
  doc: Doc;
  fm: Extract<FrontmatterScan, { kind: 'ok' }> | null;
  /** First line after the frontmatter. */
  from: number;
  scan: BlockScan;
}

function open(current: string, n: ResolvedNote): Opened | MergeConflict {
  const doc = parseDoc(current);
  const f = findFrontmatter(doc.lines);
  if (f.kind === 'unclosed') return 'invalid-frontmatter';
  const fm = f.kind === 'ok' ? f : null;
  if (fm) {
    const id = readTopLevelScalar(doc.lines.slice(1, fm.close), 'wb_id');
    if (id !== null && id !== '' && id !== n.wbId) return 'id-mismatch';
  }
  const from = fm ? fm.close + 1 : 0;
  return { doc, fm, from, scan: scanBlock(doc.lines, from) };
}

/** Rewrites the wb_ keys in place, or puts a new frontmatter at the top. Must run after any block edit (the frontmatter sits above it). */
function applyFrontmatter(o: Opened, n: ResolvedNote) {
  const lines = o.doc.lines;
  if (o.fm) {
    const inner = setAppKeys(lines.slice(1, o.fm.close), n.frontmatter);
    lines.splice(1, o.fm.close - 1, ...inner);
  } else {
    lines.splice(0, 0, '---', ...fmLines(n), '---');
  }
}

/** The block was changed by hand: its text no longer matches the hash written with it, and is not what we would write now. */
const handEdited = (old: string, hash: string, n: ResolvedNote) =>
  blockHash(old) !== hash && normalizeForHash(old) !== normalizeForHash(n.block);

function finish(current: string, o: Opened): MergeResult {
  const text = printDoc(o.doc);
  return { ok: true, text, changed: text !== current };
}

/** The normal sync: replace the block and the wb_ keys, or report why that is not safe. `n.body` is never used. */
export function mergeNote(current: string, n: ResolvedNote): MergeResult {
  const o = open(current, n);
  if (typeof o === 'string') return { ok: false, conflict: o };
  if (o.scan.kind === 'none') return { ok: false, conflict: 'missing-markers' };
  if (o.scan.kind === 'invalid') return { ok: false, conflict: 'invalid-markers' };
  const s = o.scan;
  if (handEdited(blockContent(o.doc.lines, s), s.hash, n)) return { ok: false, conflict: 'hand-edited' };
  o.doc.lines.splice(s.begin, s.end - s.begin + 1, ...blockLines(n));
  applyFrontmatter(o, n);
  return finish(current, o);
}

/**
 * The user's "rebuild" command: makes the note valid again without losing any text. A hand-edited
 * block is replaced but its old text is kept, quoted in a collapsed callout right after the new
 * block; missing markers get a new block after the frontmatter; duplicated or unpaired markers are
 * removed (the text between them stays) and a new block is inserted. Running it twice changes
 * nothing the second time. Unclosed frontmatter and another note's id are still conflicts.
 */
export function rebuildNote(current: string, n: ResolvedNote, nowLabel: string): MergeResult {
  const o = open(current, n);
  if (typeof o === 'string') return { ok: false, conflict: o };
  const lines = o.doc.lines;
  if (o.scan.kind === 'one') {
    const s = o.scan;
    const oldLines = lines.slice(s.begin + 1, s.end);
    const keep = handEdited(oldLines.join('\n'), s.hash, n)
      ? ['', `> [!note]- 你修改過的舊自動產生區（${nowLabel}）`, ...oldLines.map((l) => (l === '' ? '>' : `> ${l}`))]
      : [];
    lines.splice(s.begin, s.end - s.begin + 1, ...blockLines(n), ...keep);
  } else {
    if (o.scan.kind === 'invalid') {
      for (const i of markerLines(lines, o.from).reverse()) lines.splice(i, 1);
    }
    lines.splice(o.from, 0, ...blockLines(n), '');
  }
  applyFrontmatter(o, n);
  if (!o.doc.finalNewline && lines.length) o.doc.finalNewline = true;
  return finish(current, o);
}
