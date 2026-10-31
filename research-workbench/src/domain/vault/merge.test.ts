import { describe, expect, it } from 'vitest';
import { END_LINE, beginLine, scanBlock } from './block';
import { blockHash } from './hash';
import { resolveNote } from './links';
import { createNoteText, mergeNote, rebuildNote } from './merge';
import { extractReflection, REFLECTION_PLACEHOLDER, reflectionTemplate } from './reflection';
import { parseDoc } from './text';
import type { RenderedNote, ResolvedNote } from './types';

const note = (block: string, fm: [string, string][] = [], body = reflectionTemplate()): ResolvedNote => ({
  wbId: 'trd_abcd1234',
  frontmatter: [['wb_id', '"trd_abcd1234"'], ['wb_type', '"trade"'], ...fm],
  block,
  body,
});

const v1 = note('> [!info] 交易 · [[研究工作台/公司/2330 台積電|2330 台積電]]\n\n| a | b |\n|---|---|\n| 方向 | 做多 |');
const v2 = note('> [!info] 交易 · [[研究工作台/公司/2330 台積電|2330 台積電]]\n\n| a | b |\n|---|---|\n| 方向 | 做空 |', [['wb_side', '"short"']]);

const ok = (r: ReturnType<typeof mergeNote>) => {
  if (!r.ok) throw new Error(`conflict ${r.conflict}`);
  return r;
};

describe('createNoteText', () => {
  it('exact layout', () => {
    const n = note('line 1\nline 2', [], '## 反思\nx\n');
    expect(createNoteText(n)).toBe(
      ['---', 'wb_id: "trd_abcd1234"', 'wb_type: "trade"', '---', beginLine(blockHash('line 1\nline 2')), 'line 1', 'line 2', END_LINE, '', '## 反思', 'x', ''].join('\n'),
    );
  });

  it('no body line when the body is empty; always a final newline', () => {
    expect(createNoteText(note('b', [], ''))).toBe(`---\nwb_id: "trd_abcd1234"\nwb_type: "trade"\n---\n${beginLine(blockHash('b'))}\nb\n${END_LINE}\n`);
    expect(createNoteText(note('', [], '')).endsWith(`${beginLine(blockHash(''))}\n${END_LINE}\n`)).toBe(true);
  });

  it('a new note has one block and an empty reflection', () => {
    const t = createNoteText(v1);
    expect(scanBlock(parseDoc(t).lines, 4).kind).toBe('one');
    expect(extractReflection(t)).toEqual({ found: true, text: '', sections: 1 });
  });
});

describe('mergeNote', () => {
  const created = createNoteText(v1);
  const userAbove = '# 我的標題\n\n使用者寫的前言\n';
  const userBelow = '\n## 反思\n我覺得這筆進場太早。\n\n```\n<!-- wb:begin h=0123456789abcdef -->\n```\n\n## 其他\n自由文字 [[別的筆記]]\n';
  const withUser = created.replace('---\n<!-- wb:begin', `---\n${userAbove}<!-- wb:begin`).replace(/\n\n## 反思\n[^\n]*\n$/, userBelow);

  it('changes only the block and the wb_ keys; everything else byte-identical', () => {
    const current = withUser.replace('wb_type: "trade"', 'wb_type: "trade"\ntitle: 使用者的屬性\ntags:\n  - 半導體');
    const r = ok(mergeNote(current, v2));
    expect(r.changed).toBe(true);
    const before = current.split('\n');
    const after = r.text.split('\n');
    // user lines survive in order
    for (const l of ['title: 使用者的屬性', 'tags:', '  - 半導體', '# 我的標題', '使用者寫的前言', '我覺得這筆進場太早。', '自由文字 [[別的筆記]]']) {
      expect(after).toContain(l);
    }
    expect(r.text.slice(r.text.indexOf(END_LINE))).toBe(current.slice(current.indexOf(END_LINE)));
    const fmEnd = (ls: string[]) => ls.indexOf('---', 1);
    expect(after.slice(fmEnd(after) + 1, after.findIndex((l) => l.startsWith('<!-- wb:begin')))).toEqual(
      before.slice(fmEnd(before) + 1, before.findIndex((l) => l.startsWith('<!-- wb:begin'))),
    );
    expect(after).toContain('wb_side: "short"');
    expect(after).toContain('| 方向 | 做空 |');
    expect(after).not.toContain('| 方向 | 做多 |');
    // and the next sync is a no-op
    expect(ok(mergeNote(r.text, v2))).toEqual({ ok: true, text: r.text, changed: false });
  });

  it('no change → changed: false and identical text', () => {
    expect(ok(mergeNote(withUser, v1))).toEqual({ ok: true, text: withUser, changed: false });
  });

  it('a hand edit of the block is a conflict, unless it equals the new content', () => {
    const edited = withUser.replace('| 方向 | 做多 |', '| 方向 | 做多（我改的） |');
    expect(mergeNote(edited, v2)).toEqual({ ok: false, conflict: 'hand-edited' });
    const sameAsNew = withUser.replace('| 方向 | 做多 |', '| 方向 | 做空 |');
    const r = ok(mergeNote(sameAsNew, v2));
    expect(r.text).toContain(beginLine(blockHash(v2.block)));
  });

  it('whitespace-only noise inside the block (CRLF, trailing spaces) is not a hand edit', () => {
    const noisy = withUser.replace('| 方向 | 做多 |', '| 方向 | 做多 |   ');
    expect(ok(mergeNote(noisy, v2)).changed).toBe(true);
  });

  it('a link target rewritten by an Obsidian rename is not a conflict, and the text takes the new target', () => {
    const renamed = withUser.replace('[[研究工作台/公司/2330 台積電|', '[[研究工作台/公司/改名後|');
    const moved = note(v1.block.replace('研究工作台/公司/2330 台積電', '研究工作台/公司/改名後'));
    const r = ok(mergeNote(renamed, v2));
    expect(r.text).toContain('[[研究工作台/公司/2330 台積電|2330 台積電]]');
    expect(ok(mergeNote(renamed, moved)).changed).toBe(false);
  });

  it('each unsafe state is its own conflict and nothing is written', () => {
    expect(mergeNote('# 只有使用者文字\n', v2)).toEqual({ ok: false, conflict: 'missing-markers' });
    expect(mergeNote(withUser.replace(END_LINE, ''), v2)).toEqual({ ok: false, conflict: 'invalid-markers' });
    expect(mergeNote(`${withUser}\n${beginLine(blockHash('x'))}\nx\n${END_LINE}\n`, v2)).toEqual({ ok: false, conflict: 'invalid-markers' });
    expect(mergeNote(withUser.replace(/^---\n([\s\S]*?)\n---\n/, '---\n$1\n'), v2)).toEqual({ ok: false, conflict: 'invalid-frontmatter' });
    expect(mergeNote(withUser.replace('wb_id: "trd_abcd1234"', 'wb_id: trd_other999'), v2)).toEqual({ ok: false, conflict: 'id-mismatch' });
  });

  it('markers that exist only inside a code fence count as missing', () => {
    const fenced = withUser.replace(/(<!-- wb:begin[\s\S]*?<!-- wb:end -->)/, '```\n$1\n```');
    expect(mergeNote(fenced, v2)).toEqual({ ok: false, conflict: 'missing-markers' });
  });

  it('a file without frontmatter gets one; the rest is kept', () => {
    const bare = withUser.replace(/^---\n[\s\S]*?\n---\n/, '');
    const r = ok(mergeNote(bare, v2));
    expect(r.text.startsWith('---\nwb_id: "trd_abcd1234"\nwb_type: "trade"\nwb_side: "short"\n---\n# 我的標題\n')).toBe(true);
    expect(r.text.endsWith(bare.slice(bare.indexOf(END_LINE)))).toBe(true);
  });

  it('a CRLF file with a BOM comes back as CRLF with the BOM', () => {
    const crlf = `﻿${withUser.replace(/\n/g, '\r\n')}`;
    const r = ok(mergeNote(crlf, v2));
    expect(r.text.startsWith('﻿---\r\n')).toBe(true);
    expect(r.text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(ok(mergeNote(crlf, v1)).changed).toBe(false);
  });

  it('a file without a final newline keeps none', () => {
    const noNl = withUser.replace(/\n$/, '');
    expect(ok(mergeNote(noNl, v2)).text.endsWith('\n')).toBe(false);
  });

  it('an empty wb_id is not a mismatch', () => {
    const empty = withUser.replace('wb_id: "trd_abcd1234"', 'wb_id:');
    expect(ok(mergeNote(empty, v2)).text).toContain('wb_id: "trd_abcd1234"');
  });

  it('never uses the body', () => {
    const r = ok(mergeNote(withUser, { ...v2, body: '這段不該出現' }));
    expect(r.text).not.toContain('這段不該出現');
  });
});

describe('rebuildNote', () => {
  const created = createNoteText(v1);

  it('keeps hand-edited text in a callout after the new block; twice is the same as once', () => {
    const edited = created.replace('| 方向 | 做多 |', '| 方向 | 做多（我改的） |');
    const r = ok(rebuildNote(edited, v2, '2026-10-31 10:00'));
    expect(r.text).toContain('> [!note]- 你修改過的舊自動產生區（2026-10-31 10:00）');
    expect(r.text).toContain('> | 方向 | 做多（我改的） |');
    expect(r.text).toContain('| 方向 | 做空 |');
    expect(ok(mergeNote(r.text, v2)).changed).toBe(false);
    expect(ok(rebuildNote(r.text, v2, 'later')).text).toBe(r.text);
    expect(extractReflection(r.text)).toEqual({ found: true, text: '', sections: 1 });
  });

  it('an unedited block is simply replaced', () => {
    const r = ok(rebuildNote(created, v2, 'now'));
    expect(r.text).toBe(ok(mergeNote(created, v2)).text);
  });

  it('missing markers: a new block right after the frontmatter, user text kept', () => {
    const user = '---\ntitle: 我的\nwb_id: "trd_abcd1234"\n---\n使用者的內容\n';
    const r = ok(rebuildNote(user, v2, 'now'));
    expect(r.text).toBe(`---\ntitle: 我的\nwb_id: "trd_abcd1234"\nwb_type: "trade"\nwb_side: "short"\n---\n${beginLine(blockHash(v2.block))}\n${v2.block}\n${END_LINE}\n\n使用者的內容\n`);
    expect(ok(rebuildNote(r.text, v2, 'later')).text).toBe(r.text);
    // a file with no frontmatter and no final newline
    const r2 = ok(rebuildNote('只有一行', v2, 'now'));
    expect(r2.text.endsWith(`${END_LINE}\n\n只有一行\n`)).toBe(true);
  });

  it('invalid markers: marker lines removed (text between them kept), one new block', () => {
    const broken = `${created}\n${beginLine('0123456789abcdef')}\n我在第二個區塊裡寫的字\n\`\`\`\n${END_LINE}\n\`\`\`\n`;
    const r = ok(rebuildNote(broken, v2, 'now'));
    const lines = parseDoc(r.text).lines;
    expect(scanBlock(lines, lines.indexOf('---', 1) + 1).kind).toBe('one');
    expect(r.text).toContain('我在第二個區塊裡寫的字');
    expect(r.text).toContain('| 方向 | 做多 |'); // the old block's text stays as plain text
    expect(r.text).toContain(`\`\`\`\n${END_LINE}\n\`\`\``); // the fenced marker is user text
    expect(ok(rebuildNote(r.text, v2, 'later')).text).toBe(r.text);
  });

  it('still refuses unclosed frontmatter and another note’s id', () => {
    expect(rebuildNote('---\ntitle: x\nbody', v2, 'now')).toEqual({ ok: false, conflict: 'invalid-frontmatter' });
    expect(rebuildNote(created.replace('trd_abcd1234', 'trd_zzzz9999'), v2, 'now')).toEqual({ ok: false, conflict: 'id-mismatch' });
  });
});

describe('round trip through resolveNote', () => {
  it('a rendered note with link tokens merges cleanly after the target note moves', () => {
    const rendered: RenderedNote = {
      wbId: 'trd_abcd1234',
      kind: 'trade',
      deleted: false,
      path: 'x.md',
      frontmatter: [['wb_id', 'trd_abcd1234']],
      block: '> [[wb:prj_abcd1234|2330 台積電]]\n\n| x | [[wb:prj_abcd1234\\|2330]] |',
      body: reflectionTemplate(),
    };
    const at = (p: string) => resolveNote(rendered, () => p);
    const text = createNoteText(at('研究工作台/公司/舊'));
    const r = ok(mergeNote(text, at('研究工作台/公司/新')));
    expect(r.text).toContain('[[研究工作台/公司/新\\|2330]]');
    expect(r.text).toContain(REFLECTION_PLACEHOLDER);
  });
});
