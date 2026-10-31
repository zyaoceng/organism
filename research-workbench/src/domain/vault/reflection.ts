/**
 * The one part of a note the workbench reads back: the user's `## 反思` section(s). Headings and
 * markers inside code fences or the generated block do not count, so generated text can never
 * produce a reflection.
 */
import { isMarkerLine, scanBlock } from './block';
import { findFrontmatter } from './frontmatter';
import { HEADING_RE, fenceMask, parseDoc } from './text';

export const REFLECTION_HEADING = '## 反思';
export const REFLECTION_PLACEHOLDER = '<!-- 在這一段寫反思；研究工作台會讀回這一段（自動產生區以外的內容都不會被修改） -->';
export const reflectionTemplate = () => `${REFLECTION_HEADING}\n${REFLECTION_PLACEHOLDER}\n`;

/**
 * The body of a new note that already has a reflection on the server (a note the user deleted and
 * re-created, a second vault): the stored text under the heading, so the new file reads back as
 * the same text instead of an empty section that would record "cleared". A text with a level 1–2
 * heading of its own goes under `# 反思`, so that heading does not end the section.
 */
export function reflectionBody(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  if (!t) return reflectionTemplate();
  const lines = t.split('\n');
  const masked = fenceMask(lines);
  const high = lines.some((l, i) => !masked[i] && /^ {0,3}#{1,2}(?:[ \t]|$)/.test(l));
  return `${high ? '# 反思' : REFLECTION_HEADING}\n${REFLECTION_PLACEHOLDER}\n${t}\n`;
}

const REFLECTION_RE = /^ {0,3}(#{1,3})[ \t]+反思[ \t]*(?:#+[ \t]*)?$/;

export interface ExtractedReflection {
  found: boolean;
  /** LF line endings, NFC, placeholder lines dropped, outer blank lines trimmed; sections joined by a blank line. */
  text: string;
  sections: number;
}

export function extractReflection(text: string): ExtractedReflection {
  const lines = parseDoc(text).lines;
  const f = findFrontmatter(lines);
  // unclosed frontmatter is not frontmatter to Obsidian either: its lines are body
  const from = f.kind === 'ok' ? f.close + 1 : 0;
  const masked = fenceMask(lines, from);
  for (let i = 0; i < from; i++) masked[i] = true;
  const scan = scanBlock(lines, from);
  if (scan.kind === 'one') for (let i = scan.begin; i <= scan.end; i++) masked[i] = true;
  // with invalid markers every marker line ends a section
  const inBlock = (i: number) => scan.kind === 'one' && i >= scan.begin && i <= scan.end;

  const sections: string[] = [];
  let found = 0;
  let i = from;
  while (i < lines.length) {
    const h = masked[i] ? null : REFLECTION_RE.exec(lines[i]);
    if (!h) {
      i++;
      continue;
    }
    found++;
    const level = h[1].length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (inBlock(j)) break;
      // code fences belong to the section
      if (masked[j]) continue;
      if (isMarkerLine(lines[j])) break;
      const m = HEADING_RE.exec(lines[j]);
      if (m && m[1].length <= level) break;
    }
    const body = lines.slice(i + 1, j).filter((l) => l.trim() !== REFLECTION_PLACEHOLDER);
    let a = 0;
    let b = body.length;
    while (a < b && body[a].trim() === '') a++;
    while (b > a && body[b - 1].trim() === '') b--;
    if (b > a) sections.push(body.slice(a, b).join('\n'));
    i = j;
  }
  return { found: found > 0, text: sections.join('\n\n').normalize('NFC'), sections: found };
}
