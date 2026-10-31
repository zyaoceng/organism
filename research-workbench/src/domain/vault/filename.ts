/**
 * File and folder names that are safe on macOS, iCloud, Windows (a vault may be opened there) and
 * as Obsidian link targets, plus the default path of every note kind. Names are limited in UTF-8
 * bytes, not characters: a CJK character is 3 bytes.
 */

/** Characters a file system or Obsidian link refuses, mapped to their full-width forms. */
export const FORBIDDEN: Record<string, string> = {
  '/': '／',
  '\\': '＼',
  ':': '：',
  '*': '＊',
  '?': '？',
  '"': '＂',
  '<': '＜',
  '>': '＞',
  '|': '｜',
  '#': '＃',
  '^': '＾',
  '[': '［',
  ']': '］',
};
const FORBIDDEN_RE = /[/\\:*?"<>|#^[\]]/g;

const cpBytes = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** UTF-8 length; a lone surrogate counts as the 3-byte replacement character it is encoded as. */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) n += cpBytes(ch.codePointAt(0)!);
  return n;
}

/** The longest prefix of whole code points that fits in `max` UTF-8 bytes. */
export function truncateUtf8(s: string, max: number): string {
  let n = 0;
  let out = '';
  for (const ch of s) {
    n += cpBytes(ch.codePointAt(0)!);
    if (n > max) break;
    out += ch;
  }
  return out;
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Names Windows reserves, also with an extension after them (CON.md is as reserved as CON). */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i;

/** A file or folder name (without extension) of at most `maxBytes` UTF-8 bytes; never empty. */
export function vaultFileName(raw: string, maxBytes = 200): string {
  let s = raw.replace(LONE_SURROGATE_RE, '\uFFFD').normalize('NFC');
  s = s.replace(/[\n\r\t]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(FORBIDDEN_RE, (c) => FORBIDDEN[c]);
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
  s = s.replace(RESERVED_RE, '$1_');
  s = truncateUtf8(s, maxBytes).replace(/[. ]+$/, '');
  return s || '未命名';
}

/** How the file system compares paths: macOS and iCloud ignore case and Unicode form. */
export const pathKey = (p: string) => p.normalize('NFC').toLowerCase();

const NAME_MAX = 200;

/**
 * `desired`, or `stem (2).md` … `stem (999).md` in the same folder, whichever is free first;
 * `taken` receives the pathKey. The stem is shortened so the name stays within 200 bytes.
 */
export function uniquePath(desired: string, taken: (key: string) => boolean): string {
  if (!taken(pathKey(desired))) return desired;
  const slash = desired.lastIndexOf('/');
  const dir = slash >= 0 ? desired.slice(0, slash + 1) : '';
  const file = desired.slice(slash + 1);
  const dot = file.toLowerCase().endsWith('.md') ? file.length - 3 : file.length;
  const stem = file.slice(0, dot);
  const ext = file.slice(dot);
  for (let k = 2; k <= 999; k++) {
    const suffix = ` (${k})`;
    const short = truncateUtf8(stem, NAME_MAX - utf8Length(suffix)).replace(/[. ]+$/, '');
    const candidate = `${dir}${short}${suffix}${ext}`;
    if (!taken(pathKey(candidate))) return candidate;
  }
  throw new Error(`No free file name for ${desired}`);
}

/** '/'-joined, with empty segments (and doubled or outer slashes) dropped. */
export function joinVault(...segs: string[]): string {
  return segs
    .flatMap((s) => s.split('/'))
    .filter(Boolean)
    .join('/');
}

// ---------------------------------------------------------------- default note paths

/** The first 6 characters of an id's random part: prj_k3f9a0zqxx → k3f9a0. */
export const shortId = (id: string) => (id.split('_')[1] ?? id).slice(0, 6);

export const tickerFolder = (ticker: string) => (ticker.trim() ? vaultFileName(ticker, 100) : '未分類');

const join = (...parts: (string | number)[]) => parts.map(String).filter((p) => p.trim() !== '').join(' ');

/** Paths are relative to the plugin's root folder. */
export const companyNotePath = (c: { ticker: string; name: string }) => `公司/${vaultFileName(join(c.ticker, c.name))}.md`;

export const researchUpdateNotePath = (r: { ticker: string; asOfDate: string | null; seq: number; title: string }) =>
  `研究更新/${tickerFolder(r.ticker)}/${vaultFileName(join(r.ticker, r.asOfDate ?? '無日期', `#${r.seq}`, r.title))}.md`;

export const tradeNotePath = (t: { ticker: string; entryDate: string; side: 'long' | 'short'; id: string }) =>
  `交易/${tickerFolder(t.ticker)}/${vaultFileName(join(t.ticker, t.entryDate, t.side === 'long' ? '做多' : '做空', shortId(t.id)))}.md`;

export const aiSessionNotePath = (s: { date: string; clientLabel: string; id: string }) =>
  `AI 對話/${vaultFileName(join(s.date, s.clientLabel, shortId(s.id)))}.md`;

export const INDEX_PATHS = {
  'index-companies': '_索引/公司總表.md',
  'index-trades': '_索引/交易總表.md',
  'index-ai': '_索引/AI 對話總表.md',
} as const;
