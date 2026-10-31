/**
 * Line-level view of a markdown file that prints back byte for byte: BOM, line ending and final
 * newline are kept aside. Plus the fenced-code mask every scanner uses, so markers and headings
 * inside code blocks are never acted on.
 */

export interface Doc {
  bom: boolean;
  eol: '\n' | '\r\n';
  lines: string[];
  finalNewline: boolean;
}

/**
 * Splits on any line break. A file with mixed line endings comes back with the first one
 * everywhere; Obsidian itself always writes uniform endings.
 */
export function parseDoc(text: string): Doc {
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  const m = /\r\n|\r|\n/.exec(body);
  const eol = m?.[0] === '\r\n' ? '\r\n' : '\n';
  if (body === '') return { bom, eol, lines: [], finalNewline: false };
  const lines = body.split(/\r\n|\r|\n/);
  const finalNewline = lines.at(-1) === '';
  if (finalNewline) lines.pop();
  return { bom, eol, lines, finalNewline };
}

export function printDoc(d: Doc): string {
  const text = d.lines.join(d.eol) + (d.finalNewline && d.lines.length ? d.eol : '');
  return (d.bom ? '\uFEFF' : '') + text;
}

const OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * true for every line inside a fenced code block, fence lines included, from `from` on (CommonMark
 * rules: a backtick fence's info string has no backtick; the closer uses the same character, is at
 * least as long and has nothing after it but spaces; an unclosed fence runs to the end of the file).
 */
export function fenceMask(lines: string[], from = 0): boolean[] {
  const mask = lines.map(() => false);
  let fence: { ch: string; n: number } | null = null;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      mask[i] = true;
      const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.n) fence = null;
      continue;
    }
    const m = OPEN_RE.exec(line);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { ch: m[1][0], n: m[1].length };
      mask[i] = true;
    }
  }
  return mask;
}

export const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
