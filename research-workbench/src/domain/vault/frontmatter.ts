/**
 * Frontmatter edited as text, never parsed and re-serialised: the app rewrites only its own `wb_*`
 * keys, one line each, and every other line (user keys, comments, order, Obsidian's formatting)
 * stays byte-identical.
 */
import type { FmValue } from './types';

export type FrontmatterScan = { kind: 'none' } | { kind: 'ok'; open: 0; close: number } | { kind: 'unclosed' };

/** Frontmatter exists only when the first line is `---`; it ends at the next `---` or `...` line. */
export function findFrontmatter(lines: string[]): FrontmatterScan {
  if (!lines.length || !/^---[ \t]*$/.test(lines[0])) return { kind: 'none' };
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) return { kind: 'ok', open: 0, close: i };
  return { kind: 'unclosed' };
}

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t].*)?$/;
/** Lines that continue the value of the key above them: blank, indented, or a column-0 block sequence. */
const continues = (l: string) => l.trim() === '' || l[0] === ' ' || l[0] === '\t' || l[0] === '-';

export interface KeyExtent {
  key: string;
  start: number;
  /** Exclusive. */
  end: number;
}

/** Top-level keys of the frontmatter lines (without the delimiters) and the lines each one owns. */
export function topLevelKeys(fm: string[]): KeyExtent[] {
  const out: KeyExtent[] = [];
  for (let i = 0; i < fm.length; i++) {
    const m = KEY_RE.exec(fm[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < fm.length && continues(fm[end])) end++;
    // trailing blank lines separate keys; they belong to neither
    while (end > i + 1 && fm[end - 1].trim() === '') end--;
    out.push({ key: m[1], start: i, end });
    i = end - 1;
  }
  return out;
}

/**
 * Indented `# …` lines inside an app key's extent are YAML comments the user wrote (unless the key
 * holds a `|`/`>` block scalar, whose lines are text): they are kept when the key is rewritten or
 * dropped, so replacing a value never removes a user line.
 */
function ownedComments(fm: string[], x: KeyExtent): string[] {
  const line = fm[x.start];
  if (/^[|>]/.test(line.slice(line.indexOf(':') + 1).trim())) return [];
  return fm.slice(x.start + 1, x.end).filter((l) => /^[ \t]+#/.test(l));
}

/**
 * Sets the app's keys. Each listed key's whole extent becomes one `key: yaml` line (a duplicate
 * key: first occurrence replaced, the rest deleted), missing keys are appended in order before any
 * trailing blank lines, other keys with the prefix are deleted, and every other line is kept as is.
 */
export function setAppKeys(fm: string[], entries: [string, string][], prefix = 'wb_'): string[] {
  const wanted = new Map(entries);
  const written = new Set<string>();
  const extents = topLevelKeys(fm);
  const out: string[] = [];
  let cursor = 0;
  for (const x of extents) {
    out.push(...fm.slice(cursor, x.start));
    cursor = x.end;
    if (wanted.has(x.key)) {
      if (!written.has(x.key)) out.push(`${x.key}: ${wanted.get(x.key)}`);
      written.add(x.key);
      out.push(...ownedComments(fm, x));
    } else if (!x.key.startsWith(prefix)) {
      out.push(...fm.slice(x.start, x.end));
    } else {
      out.push(...ownedComments(fm, x));
    }
  }
  out.push(...fm.slice(cursor));
  let tail = out.length;
  while (tail > 0 && out[tail - 1].trim() === '') tail--;
  const missing = entries.filter(([k]) => !written.has(k)).map(([k, v]) => `${k}: ${v}`);
  out.splice(tail, 0, ...missing);
  return out;
}

/** Strips a ` # comment` that follows a bare value. */
const stripComment = (v: string) => v.replace(/(^|[ \t])#.*$/, '').trim();

/**
 * The value of a top-level single-line scalar: "…" (JSON escapes), '…' ('' is a quote) or bare,
 * each with an optional trailing comment. null when the key is absent or the value is a block.
 */
export function readTopLevelScalar(fm: string[], key: string): string | null {
  const x = topLevelKeys(fm).find((k) => k.key === key);
  if (!x) return null;
  const line = fm[x.start];
  const raw = line.slice(line.indexOf(':') + 1).trim();
  if (raw.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  }
  if (raw.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(raw);
    return m ? m[1].replace(/''/g, "'") : null;
  }
  const bare = stripComment(raw);
  if (/^[|>]/.test(bare)) return null;
  return bare;
}

/** JSON string, also escaping the characters YAML treats as line breaks and JSON leaves raw. */
const quoteYaml = (s: string) => JSON.stringify(s).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * YAML text of one value. Strings are always double-quoted, so "0050" stays a string and `:` or
 * `#` cannot change the meaning. `{link}` needs the vault path, so it renders here only through
 * `linkText` (links.ts passes it); without one it is null.
 */
export function renderValue(v: FmValue, linkText?: (link: string, alias: string) => string | null): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return quoteYaml(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(12))) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if ('date' in v) return /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? v.date : quoteYaml(v.date);
  const text = linkText?.(v.link, v.alias) ?? null;
  return text === null ? 'null' : quoteYaml(text);
}
