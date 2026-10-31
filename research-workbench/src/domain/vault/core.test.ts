import { describe, expect, it } from 'vitest';
import { BEGIN_RE, END_LINE, END_RE, beginLine, blockContent, scanBlock } from './block';
import { findFrontmatter, readTopLevelScalar, renderValue, setAppKeys, topLevelKeys } from './frontmatter';
import { blockHash, fnv1a64, maskLinkTargets, normalizeForHash, reflectionHash } from './hash';
import { LINK_TOKEN_RE, linkToken, resolveLinks, resolveNote } from './links';
import { fenceMask, parseDoc, printDoc } from './text';
import { kindOfWbId, shouldStoreReflection, WB_ID_RE } from './types';

const L = (s: string) => s.split('\n');

describe('ids', () => {
  it('maps prefixes to kinds and rejects anything else', () => {
    expect(kindOfWbId('prj_k3f9a0zqxxab')).toBe('company');
    expect(kindOfWbId('rev_k3f9a0zqxxab')).toBe('research_update');
    expect(kindOfWbId('trd_k3f9a0zqxxab')).toBe('trade');
    expect(kindOfWbId('ais_k3f9a0zqxxab')).toBe('ai_session');
    expect(kindOfWbId('index-trades')).toBe('index');
    for (const bad of ['prj_', 'prj_AB12', 'cat_abcd1234', 'index-foo', 'prj_abcd/../x', ' prj_abcd']) {
      expect(kindOfWbId(bad)).toBeNull();
      expect(WB_ID_RE.test(bad)).toBe(false);
    }
  });

  it('shouldStoreReflection: empty is never a first version; reverts and moves count', () => {
    expect(shouldStoreReflection('h1', true, 'a.md', undefined)).toBe(false);
    expect(shouldStoreReflection('h1', false, 'a.md', undefined)).toBe(true);
    const s = { latest: 'h2', byPath: { 'a.md': 'h2', 'b.md': 'h1' } };
    expect(shouldStoreReflection('h2', false, 'c.md', s)).toBe(false); // same as latest
    expect(shouldStoreReflection('h1', false, 'b.md', s)).toBe(false); // a stale copy at b.md
    expect(shouldStoreReflection('h1', false, 'a.md', s)).toBe(true); // X→Y→X at the same path
    // clearing the text is recorded once (the hash of '' differs from the latest)
    expect(shouldStoreReflection(reflectionHash(''), true, 'a.md', s)).toBe(true);
  });
});

describe('hash', () => {
  it('known FNV-1a 64 vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
    expect(fnv1a64('反思')).toBe('7caae2f43dc39281');
  });

  it('normalizeForHash', () => {
    expect(normalizeForHash('\n\n a  \r\nb\t\r\n\r\n')).toBe(' a\nb');
    expect(normalizeForHash('x\ry')).toBe('x\ny');
    expect(normalizeForHash('e\u0301')).toBe('é');
  });

  it('blockHash ignores endings, trailing spaces, outer blank lines, Unicode form and link targets', () => {
    const h = blockHash('| a | [[x/y|台積電]] |\nline é');
    expect(blockHash('\r\n| a | [[x/y|台積電]] |   \r\nline e\u0301\r\n\r\n')).toBe(h);
    expect(blockHash('| a | [[公司/2330 台積電|台積電]] |\nline é')).toBe(h);
    expect(blockHash('| a | [[wb:prj_abcd|台積電]] |\nline é')).toBe(h);
    expect(blockHash('[[a/b|x]]')).toBe(blockHash('[[c|x]]'));
    expect(blockHash('[[a/b]]')).toBe(blockHash('[[c]]'));
  });

  it('blockHash changes when an alias or any text changes', () => {
    const h = blockHash('see [[a|x]] now');
    expect(blockHash('see [[a|y]] now')).not.toBe(h);
    expect(blockHash('see [[a|x]] nOw')).not.toBe(h);
    expect(blockHash('see [[a]] now')).not.toBe(h);
    expect(blockHash('  see [[a|x]] now')).not.toBe(h); // leading spaces are content
  });

  it('maskLinkTargets keeps escaped table pipes recognisable', () => {
    expect(maskLinkTargets('| [[a/b\\|x]] |')).toBe('| [[§|x]] |');
  });

  it('reflectionHash: CRLF and NFD equal LF and NFC', () => {
    expect(reflectionHash('第一行\r\n第二行 cafe\u0301\r\n')).toBe(reflectionHash('第一行\n第二行 café'));
  });
});

describe('text', () => {
  it('round-trips BOM, CRLF and the final newline exactly', () => {
    for (const s of ['', '\n', 'a', 'a\n', 'a\r\nb\r\n', '\uFEFFa\nb', '\uFEFF---\r\nx: 1\r\n---\r\n', 'a\n\n\n']) {
      expect(printDoc(parseDoc(s))).toBe(s);
    }
    const d = parseDoc('\uFEFFa\r\nb');
    expect(d).toEqual({ bom: true, eol: '\r\n', lines: ['a', 'b'], finalNewline: false });
  });

  it('mixed line endings take the first one; lone CR (classic Mac) comes back as LF, text unchanged', () => {
    expect(printDoc(parseDoc('a\r\nb\nc\n'))).toBe('a\r\nb\r\nc\r\n');
    expect(printDoc(parseDoc('x\ry\r'))).toBe('x\ny\n');
  });

  it('fenceMask: backticks, tildes, lengths, info strings, unclosed fences', () => {
    expect(fenceMask(L('a\n```js\nx\n```\nb'))).toEqual([false, true, true, true, false]);
    expect(fenceMask(L('~~~\n```\n~~~\nb'))).toEqual([true, true, true, false]);
    // a 4-backtick fence is closed only by 4 or more
    expect(fenceMask(L('````\n```\nx\n`````\ny'))).toEqual([true, true, true, true, false]);
    // a closer may not have an info string
    expect(fenceMask(L('```\n``` js\nx'))).toEqual([true, true, true]);
    // backtick info strings may not contain a backtick (inline code, not a fence)
    expect(fenceMask(L('``` a`b\nx'))).toEqual([false, false]);
    // up to 3 spaces of indent; 4 is an indented code block, not a fence
    expect(fenceMask(L('   ```\nx\n   ```\n    ```\ny'))).toEqual([true, true, true, false, false]);
    // unclosed runs to the end
    expect(fenceMask(L('a\n```\nx\ny'))).toEqual([false, true, true, true]);
    // from: earlier lines are not scanned
    expect(fenceMask(L('```\na\n```\nb'), 1)).toEqual([false, false, true, true]);
    // a fence inside a blockquote is not a top-level fence
    expect(fenceMask(L('> ```\nx'))).toEqual([false, false]);
  });
});

describe('frontmatter', () => {
  it('findFrontmatter', () => {
    expect(findFrontmatter(L('a\n---\nb\n---'))).toEqual({ kind: 'none' });
    expect(findFrontmatter([])).toEqual({ kind: 'none' });
    expect(findFrontmatter(L('---\na: 1\n---\nbody'))).toEqual({ kind: 'ok', open: 0, close: 2 });
    expect(findFrontmatter(L('---  \na: 1\n...\nbody'))).toEqual({ kind: 'ok', open: 0, close: 2 });
    expect(findFrontmatter(L('---\n---'))).toEqual({ kind: 'ok', open: 0, close: 1 });
    expect(findFrontmatter(L('---\na: 1\nbody'))).toEqual({ kind: 'unclosed' });
    expect(findFrontmatter(L(' ---\na: 1\n---'))).toEqual({ kind: 'none' });
  });

  it('topLevelKeys: extents include indented lines, column-0 sequences and inner blanks, not trailing blanks', () => {
    const fm = L('a: 1\nb: |\n  x\n\n  y\n\nc:\n- 1\n- 2\n# comment\n"q": 1\nd: 2\n\n');
    expect(topLevelKeys(fm)).toEqual([
      { key: 'a', start: 0, end: 1 },
      { key: 'b', start: 1, end: 5 },
      { key: 'c', start: 6, end: 9 },
      { key: 'd', start: 11, end: 12 },
    ]);
    // indented keys are not top-level
    expect(topLevelKeys(L('a:\n  wb_id: x')).map((k) => k.key)).toEqual(['a']);
  });

  const entries: [string, string][] = [
    ['wb_id', '"prj_abcd"'],
    ['wb_type', '"company"'],
  ];

  it('keeps user keys, comments, blank lines and order; replaces wb_ keys in place', () => {
    const fm = L('title: 我的筆記\n# 我的註解\nwb_type: "old"\n\ntags:\n  - a\n  - b\nwb_id: "prj_abcd"\naliases: [x]');
    expect(setAppKeys(fm, entries)).toEqual(L('title: 我的筆記\n# 我的註解\nwb_type: "company"\n\ntags:\n  - a\n  - b\nwb_id: "prj_abcd"\naliases: [x]'));
  });

  it('appends missing keys before trailing blank lines', () => {
    expect(setAppKeys(L('title: x\n\n'), entries)).toEqual(L('title: x\nwb_id: "prj_abcd"\nwb_type: "company"\n\n'));
    expect(setAppKeys([], entries)).toEqual(['wb_id: "prj_abcd"', 'wb_type: "company"']);
  });

  it('a multi-line wb_ value becomes one line and the next user key is intact', () => {
    const fm = L('wb_type: |\n  line 1\n  line 2\nmine: 1\nwb_id:\n  - a\n  - b\nother: 2');
    expect(setAppKeys(fm, entries)).toEqual(L('wb_type: "company"\nmine: 1\nwb_id: "prj_abcd"\nother: 2'));
    const fm2 = L('wb_id:\n- a\n- b\nnext: 1');
    expect(setAppKeys(fm2, entries)).toEqual(L('wb_id: "prj_abcd"\nnext: 1\nwb_type: "company"'));
  });

  it('collapses a duplicated wb_id, drops stale wb_ keys, leaves look-alikes', () => {
    const fm = L('wb_id: "prj_abcd"\nwbx: 1\nwb_old: 2\nmy_wb_id: 3\nwb_id: "prj_zzzz"\nWB_ID: 4');
    expect(setAppKeys(fm, entries)).toEqual(L('wb_id: "prj_abcd"\nwbx: 1\nmy_wb_id: 3\nWB_ID: 4\nwb_type: "company"'));
  });

  it('handles frontmatter reformatted by Obsidian (bare strings, 2-space lists)', () => {
    const fm = L('wb_id: prj_abcd\nwb_type: company\ntags:\n  - 半導體\ncssclasses:\n  - wide');
    expect(setAppKeys(fm, entries)).toEqual(L('wb_id: "prj_abcd"\nwb_type: "company"\ntags:\n  - 半導體\ncssclasses:\n  - wide'));
    expect(readTopLevelScalar(fm, 'wb_id')).toBe('prj_abcd');
  });

  it('readTopLevelScalar: quoting forms and comments', () => {
    const fm = L(
      [
        'a: "x \\"q\\" \\u53cd # no"  # c',
        "b: 'it''s # here' # c",
        'c: bare value # comment',
        'd: bare#hash',
        'e:',
        'f: |',
        '  block',
        '  wb_id: inner',
      ].join('\n'),
    );
    expect(readTopLevelScalar(fm, 'a')).toBe('x "q" 反 # no');
    expect(readTopLevelScalar(fm, 'b')).toBe("it's # here");
    expect(readTopLevelScalar(fm, 'c')).toBe('bare value');
    expect(readTopLevelScalar(fm, 'd')).toBe('bare#hash');
    expect(readTopLevelScalar(fm, 'e')).toBe('');
    expect(readTopLevelScalar(fm, 'f')).toBeNull();
    expect(readTopLevelScalar(fm, 'wb_id')).toBeNull();
    expect(readTopLevelScalar(fm, 'missing')).toBeNull();
  });

  it('renderValue', () => {
    expect(renderValue('0050')).toBe('"0050"');
    expect(renderValue('a "b" \\ c\nd: #e')).toBe('"a \\"b\\" \\\\ c\\nd: #e"');
    expect(renderValue('x\u2028y')).toBe('"x\\u2028y"');
    expect(renderValue(0.1 + 0.2)).toBe('0.3');
    expect(renderValue(1234.5)).toBe('1234.5');
    expect(renderValue(-0.00012)).toBe('-0.00012');
    expect(renderValue(NaN)).toBe('null');
    expect(renderValue(Infinity)).toBe('null');
    expect(renderValue(true)).toBe('true');
    expect(renderValue(null)).toBe('null');
    expect(renderValue({ date: '2026-10-01' })).toBe('2026-10-01');
    expect(renderValue({ date: '2026-10' })).toBe('"2026-10"');
    expect(renderValue({ link: 'prj_abcd', alias: 'x' })).toBe('null');
    expect(renderValue({ link: 'prj_abcd', alias: 'x' }, () => '[[公司/x|x]]')).toBe('"[[公司/x|x]]"');
    // the rendered string reads back as itself
    for (const s of ['0050', 'a "b" \\ c', '#x', 'k: v', '反思']) expect(readTopLevelScalar([`k: ${renderValue(s)}`], 'k')).toBe(s);
  });
});

describe('block markers', () => {
  const H = '0123456789abcdef';
  const doc = (s: string) => scanBlock(L(s), 0);

  it('a single pair, with trailing spaces and extra hint text', () => {
    const s = doc(`intro\n${beginLine(H)}\nx\ny\n${END_LINE}\nafter`);
    expect(s).toEqual({ kind: 'one', begin: 1, end: 4, hash: H });
    if (s.kind === 'one') expect(blockContent(L(`intro\n${beginLine(H)}\nx\ny\n${END_LINE}`), s)).toBe('x\ny');
    expect(doc(`<!-- wb:begin h=${H} -->  \n<!-- wb:end anything -->\t`).kind).toBe('one');
    expect(BEGIN_RE.test(`<!-- wb:begin h=${H} 任意提示 -->`)).toBe(true);
    expect(END_RE.test('<!-- wb:end -->')).toBe(true);
  });

  it('none, and the invalid layouts', () => {
    expect(doc('just text')).toEqual({ kind: 'none' });
    expect(doc(`${beginLine(H)}\nx`)).toEqual({ kind: 'invalid', reason: 'unpaired' });
    expect(doc(`x\n${END_LINE}`)).toEqual({ kind: 'invalid', reason: 'unpaired' });
    expect(doc(`${END_LINE}\n${beginLine(H)}`)).toEqual({ kind: 'invalid', reason: 'unpaired' });
    expect(doc(`${beginLine(H)}\n${beginLine(H)}\n${END_LINE}\n${END_LINE}`)).toEqual({ kind: 'invalid', reason: 'nested' });
    expect(doc(`${beginLine(H)}\n${END_LINE}\n${beginLine(H)}\n${END_LINE}`)).toEqual({ kind: 'invalid', reason: 'multiple' });
    expect(doc(`${beginLine(H)}\n${END_LINE}\n${END_LINE}`)).toEqual({ kind: 'invalid', reason: 'unpaired' });
  });

  it('markers inside fences are ignored', () => {
    expect(doc(`\`\`\`\n${beginLine(H)}\n${END_LINE}\n\`\`\``)).toEqual({ kind: 'none' });
    expect(doc(`${beginLine(H)}\nx\n${END_LINE}\n~~~\n${beginLine(H)}\n${END_LINE}\n~~~`).kind).toBe('one');
    // a 4-backtick fence is not closed by 3: the second pair stays inside it
    expect(doc(`${beginLine(H)}\n${END_LINE}\n\`\`\`\`\n\`\`\`\n${beginLine(H)}\n${END_LINE}\n\`\`\`\``).kind).toBe('one');
  });

  it('an unclosed fence before the end marker makes the block invalid', () => {
    expect(doc(`${beginLine(H)}\n\`\`\`\nx\n${END_LINE}`)).toEqual({ kind: 'invalid', reason: 'unpaired' });
  });

  it('a block containing its own closed fence is valid', () => {
    expect(doc(`${beginLine(H)}\n\`\`\`\ncode\n\`\`\`\n${END_LINE}`)).toEqual({ kind: 'one', begin: 0, end: 4, hash: H });
  });

  it('quoted or indented markers are not markers', () => {
    expect(doc(`> ${beginLine(H)}\n> ${END_LINE}`)).toEqual({ kind: 'none' });
    expect(doc(`    ${beginLine(H)}\n    ${END_LINE}`)).toEqual({ kind: 'none' });
    expect(doc(`<!-- wb:begin h=XYZ -->\n${END_LINE}`)).toEqual({ kind: 'invalid', reason: 'unpaired' });
  });

  it('scans from the given line only (frontmatter is skipped by the caller)', () => {
    expect(scanBlock(L(`---\nx: "${END_LINE}"\n---\n${beginLine(H)}\n${END_LINE}`), 3)).toEqual({ kind: 'one', begin: 3, end: 4, hash: H });
  });
});

describe('links', () => {
  it('linkToken sanitises the alias', () => {
    expect(linkToken('prj_abcd', 'a|b [c]\nd')).toBe('[[wb:prj_abcd|a｜b ［c］ d]]');
    expect(linkToken('prj_abcd', 'x', true)).toBe('[[wb:prj_abcd\\|x]]');
  });

  it('resolveLinks: hits become vault links, misses the plain alias', () => {
    const lookup = (id: string) => (id === 'prj_abcd' ? '研究工作台/公司/2330 台積電' : null);
    const t = `a ${linkToken('prj_abcd', '台積電')} b ${linkToken('rev_zzzz', '#5')} | ${linkToken('prj_abcd', 'x', true)} |`;
    expect(resolveLinks(t, lookup)).toBe('a [[研究工作台/公司/2330 台積電|台積電]] b #5 | [[研究工作台/公司/2330 台積電\\|x]] |');
    // ordinary wikilinks are untouched
    expect(resolveLinks('[[other note|x]] [[wb:]]', lookup)).toBe('[[other note|x]] [[wb:]]');
    expect(LINK_TOKEN_RE.global).toBe(true);
  });

  it('resolveNote renders frontmatter values and resolves block and body', () => {
    const lookup = (id: string) => (id === 'prj_abcd' ? '公司/x' : null);
    const r = resolveNote(
      {
        wbId: 'trd_abcd',
        kind: 'trade',
        deleted: false,
        path: 'p.md',
        frontmatter: [
          ['wb_id', 'trd_abcd'],
          ['wb_company', { link: 'prj_abcd', alias: '2330 台積電' }],
          ['wb_research_update', { link: 'rev_gone', alias: '#1' }],
          ['wb_entry_date', { date: '2026-10-01' }],
        ],
        block: `> ${linkToken('prj_abcd', 'A')}`,
        body: linkToken('rev_gone', 'B'),
      },
      lookup,
    );
    expect(r).toEqual({
      wbId: 'trd_abcd',
      frontmatter: [
        ['wb_id', '"trd_abcd"'],
        ['wb_company', '"[[公司/x|2330 台積電]]"'],
        ['wb_research_update', 'null'],
        ['wb_entry_date', '2026-10-01'],
      ],
      block: '> [[公司/x|A]]',
      body: 'B',
    });
  });
});

describe('setAppKeys keeps user comments inside app keys (regression)', () => {
  const entries: [string, string][] = [
    ['wb_id', '"trd_abcd1234"'],
    ['wb_type', '"trade"'],
  ];
  it('an indented comment under a wb_ scalar or list survives the rewrite, twice', () => {
    const fm = L('wb_id: "trd_abcd1234"\n  # 我的註解：這是去年的交易\ntags: [a]\nwb_type:\n  - old\n  # 清單裡的註解');
    const once = setAppKeys(fm, entries);
    expect(once).toEqual(L('wb_id: "trd_abcd1234"\n  # 我的註解：這是去年的交易\ntags: [a]\nwb_type: "trade"\n  # 清單裡的註解'));
    expect(setAppKeys(once, entries)).toEqual(once);
  });
  it('a stale wb_ key is dropped but its comment stays; block-scalar text is not mistaken for a comment', () => {
    expect(setAppKeys(L('wb_old: 1\n  # 留著\nwb_id: "x"'), entries)).toEqual(L('  # 留著\nwb_id: "trd_abcd1234"\nwb_type: "trade"'));
    expect(setAppKeys(L('wb_type: |\n  # not a comment\nwb_id: "x"'), entries)).toEqual(L('wb_type: "trade"\nwb_id: "trd_abcd1234"'));
  });
});
