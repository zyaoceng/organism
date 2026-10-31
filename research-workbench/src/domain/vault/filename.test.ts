import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN,
  INDEX_PATHS,
  aiSessionNotePath,
  companyNotePath,
  joinVault,
  pathKey,
  researchUpdateNotePath,
  tradeNotePath,
  truncateUtf8,
  uniquePath,
  utf8Length,
  vaultFileName,
} from './filename';

describe('vaultFileName', () => {
  it('maps every forbidden character to its full-width form', () => {
    for (const [c, r] of Object.entries(FORBIDDEN)) expect(vaultFileName(`a${c}b`)).toBe(`a${r}b`);
    expect(vaultFileName('BRK/B: "x" <y> |z| #1 ^2 [3] *?\\')).toBe('BRK／B： ＂x＂ ＜y＞ ｜z｜ ＃1 ＾2 ［3］ ＊？＼');
  });

  it('control characters: tabs and line breaks become spaces, the rest are removed', () => {
    expect(vaultFileName('a\tb\nc\r\nd\u0000e\u0007f\u007f')).toBe('a b c def');
  });

  it('NFC, whitespace collapsed', () => {
    expect(vaultFileName('café')).toBe('café');
    expect(vaultFileName('  a   b　c  ')).toBe('a b c');
  });

  it('leading dots and trailing dots or spaces are removed', () => {
    expect(vaultFileName('.hidden')).toBe('hidden');
    expect(vaultFileName('...x')).toBe('x');
    expect(vaultFileName('x. .')).toBe('x');
    expect(vaultFileName('a.b')).toBe('a.b');
  });

  it('an empty or all-dots name becomes 未命名; forbidden-only names keep their full-width forms', () => {
    expect(vaultFileName('')).toBe('未命名');
    expect(vaultFileName(' . . ')).toBe('未命名');
    expect(vaultFileName('\u0000\u0001')).toBe('未命名');
    expect(vaultFileName('//')).toBe('／／');
  });

  it('Windows reserved names get _', () => {
    expect(vaultFileName('CON')).toBe('CON_');
    expect(vaultFileName('lpt1')).toBe('lpt1_');
    expect(vaultFileName('aux.x')).toBe('aux_.x');
    expect(vaultFileName('CONSOLE')).toBe('CONSOLE');
    expect(vaultFileName('com0')).toBe('com0');
  });

  it('cut to the byte limit on whole code points; a 4-byte emoji is never split', () => {
    const cjk = '台'.repeat(100);
    expect(utf8Length(cjk)).toBe(300);
    const cut = vaultFileName(cjk);
    expect(utf8Length(cut)).toBeLessThanOrEqual(200);
    expect(cut).toBe('台'.repeat(66));
    const emoji = `${'a'.repeat(198)}😀`;
    expect(vaultFileName(emoji)).toBe('a'.repeat(198));
    expect(truncateUtf8('ab😀', 5)).toBe('ab');
    expect(truncateUtf8('ab😀', 6)).toBe('ab😀');
    // a cut that leaves a trailing space or dot strips it
    expect(vaultFileName(`${'a'.repeat(199)} b`)).toBe('a'.repeat(199));
    expect(vaultFileName('台灣 積體', 7)).toBe('台灣');
  });

  it('lone surrogates become the replacement character', () => {
    expect(vaultFileName('a\uD800b')).toBe('a�b');
    expect(utf8Length('\uD800')).toBe(3);
  });
});

describe('uniquePath', () => {
  it('returns the desired path when free', () => {
    expect(uniquePath('公司/x.md', () => false)).toBe('公司/x.md');
  });

  it('detects collisions across case and Unicode form, and goes on to (3)', () => {
    const taken = new Set([pathKey('公司/A.md'), pathKey('公司/a (2).md'), pathKey('公司/Café.md')]);
    expect(uniquePath('公司/a.md', (k) => taken.has(k))).toBe('公司/a (3).md');
    expect(uniquePath('公司/café.md', (k) => taken.has(k))).toBe('公司/café (2).md');
    expect(pathKey('A/Café.md')).toBe(pathKey('a/café.MD'));
  });

  it('shortens the stem to stay within 200 bytes', () => {
    const stem = '台'.repeat(66);
    const p = uniquePath(`交易/${stem}.md`, (k) => k === pathKey(`交易/${stem}.md`));
    const name = p.slice('交易/'.length, -'.md'.length);
    expect(name.endsWith(' (2)')).toBe(true);
    expect(utf8Length(name)).toBeLessThanOrEqual(200);
  });

  it('throws when every candidate is taken', () => {
    expect(() => uniquePath('x.md', () => true)).toThrow();
  });
});

describe('paths', () => {
  it('joinVault drops empty segments', () => {
    expect(joinVault('研究工作台/', '/公司', '', 'x.md')).toBe('研究工作台/公司/x.md');
    expect(joinVault('', 'a')).toBe('a');
  });

  it('note paths', () => {
    expect(companyNotePath({ ticker: '2330', name: '台積電' })).toBe('公司/2330 台積電.md');
    expect(companyNotePath({ ticker: '', name: '未上市' })).toBe('公司/未上市.md');
    expect(researchUpdateNotePath({ ticker: 'BRK/B', asOfDate: null, seq: 5, title: '法說後: 上修?' })).toBe('研究更新/BRK／B/BRK／B 無日期 ＃5 法說後： 上修？.md');
    expect(researchUpdateNotePath({ ticker: '', asOfDate: '2026-09-30', seq: 1, title: '初始' })).toBe('研究更新/未分類/2026-09-30 ＃1 初始.md');
    expect(tradeNotePath({ ticker: '2330', entryDate: '2026-10-01', side: 'long', id: 'trd_k3f9a0zqxxab' })).toBe('交易/2330/2330 2026-10-01 做多 k3f9a0.md');
    expect(tradeNotePath({ ticker: '2330', entryDate: '2026-10-01', side: 'short', id: 'trd_k3f9a0zqxxab' })).toContain('做空');
    expect(aiSessionNotePath({ date: '2026-10-01', clientLabel: 'Claude 桌面版', id: 'ais_abcdefghijkl' })).toBe('AI 對話/2026-10-01 Claude 桌面版 abcdef.md');
    expect(Object.values(INDEX_PATHS)).toEqual(['_索引/公司總表.md', '_索引/交易總表.md', '_索引/AI 對話總表.md']);
  });

  it('ticker folders are capped at 100 bytes', () => {
    const p = tradeNotePath({ ticker: '長'.repeat(50), entryDate: '2026-10-01', side: 'long', id: 'trd_abcdefgh' });
    expect(utf8Length(p.split('/')[1])).toBeLessThanOrEqual(100);
    expect(utf8Length(p.split('/')[2])).toBeLessThanOrEqual(203);
  });
});
