import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FUNCTIONS } from '../../domain/formula/parser';
import { describeChange } from '../../domain/revision/describe';
import { LINK_RELATIONS, NODE_ROLES, SCENARIOS } from '../../domain/model/types';
import { SCALES, UNIT_KINDS } from '../../domain/units';
import { CATALYST_TYPES, ERROR_CATEGORIES, SOURCE_TYPES } from '../../shared/api';
import { setLang, t, tm } from '../lib/i18n';
import { TABS } from '../lib/router';
import { zhTW } from './index';
import { app } from './zh/app';
import { domain } from './zh/domain';
import { model } from './zh/model';
import { pages } from './zh/pages';
import { records } from './zh/records';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'i18n' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
  });
}

/** English string literals passed to t() / tn() in the client source. */
function usedKeys(): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = [];
  const lit = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\x60([^\x60$]*)\x60`;
  const re = new RegExp(String.raw`\bt\(\s*(?:${lit})|\btn\(\s*[^,]+,\s*(?:${lit})\s*,\s*(?:${lit})`, 'g');
  for (const file of sourceFiles(join(__dirname, '..'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      for (const g of m.slice(1)) if (g !== undefined) out.push({ key: g.replace(/\\(['"\\])/g, '$1'), file });
    }
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => setLang('en'));

describe('zh-TW dictionary', () => {
  it('translates every string literal passed to t() in the client', () => {
    const keys = usedKeys();
    expect(keys.length).toBeGreaterThan(300);
    const missing = [...new Set(keys.filter((k) => !(k.key in zhTW)).map((k) => `${k.file.split('/src/client/')[1]}: ${k.key}`))];
    expect(missing).toEqual([]);
  });

  it('keeps the same {placeholders} as the English key', () => {
    const bad = Object.entries(zhTW).filter(([en, zh]) => placeholders(en).join() !== placeholders(zh).join());
    expect(bad).toEqual([]);
  });

  it('gives one translation to a key that appears in several area files', () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];
    for (const dict of [domain, app, model, pages, records]) {
      for (const [en, zh] of Object.entries(dict)) {
        if (seen.has(en) && seen.get(en) !== zh) clash.push(`${en}: ${seen.get(en)} / ${zh}`);
        seen.set(en, zh);
      }
    }
    expect(clash).toEqual([]);
  });

  it('covers the shared label constants', () => {
    const labels = [
      ...TABS.map((x) => x.label),
      ...SCENARIOS.map((x) => x.name),
      ...NODE_ROLES.map((x) => x.label),
      ...LINK_RELATIONS.map((x) => x.label),
      ...UNIT_KINDS.map((x) => x.label),
      ...SCALES.map((x) => x.label),
      ...SOURCE_TYPES.map((x) => x.label),
      ...CATALYST_TYPES.map((x) => x.label),
      ...ERROR_CATEGORIES.map((x) => x.label),
      ...FUNCTIONS.map((x) => x.help),
    ];
    expect(labels.filter((l) => !(l in zhTW))).toEqual([]);
  });
});

describe('t() and tm()', () => {
  it('returns English by default and Chinese after switching', () => {
    setLang('en');
    expect(t('History')).toBe('History');
    expect(t('Not in dictionary {x}', { x: 1 })).toBe('Not in dictionary 1');
    setLang('zh-TW');
    expect(t('History')).toBe('歷史');
    expect(t('Not in dictionary {x}', { x: 1 })).toBe('Not in dictionary 1');
  });

  it('translates runtime messages, including nested ones', () => {
    setLang('en');
    expect(tm('Division by zero: [Shares] is 0')).toBe('Division by zero: [Shares] is 0');
    setLang('zh-TW');
    expect(tm('2028E: Division by zero: [Shares] is 0')).toBe('2028E：除以零：[Shares] 等於 0');
    expect(tm('Circular dependency: EPS → Net Income → EPS')).toBe('循環參照：EPS → Net Income → EPS');
    expect(tm('No node named "Revnue". Did you mean [Revenue]?')).toBe('找不到名為「Revnue」的節點。你是不是要找 [Revenue]？');
    expect(tm('Unexpected number 3 — is an operator missing?')).toBe('這裡不該出現 數字 3，是不是少了運算符號？');
    expect(tm('Addition: TWD 億 combined with USD mn (different currencies)')).toBe('加法：TWD 億 和 USD mn 放在一起計算（幣別不同）');
    expect(tm('This evidence cannot be deleted. It is part of Research Update #3. Archive it instead; history must stay reconstructable.')).toBe(
      '這份證據不能刪除。它屬於研究更新 #3。請改用封存，歷史紀錄必須能完整重現。',
    );
    expect(tm('Something the patterns do not know')).toBe('Something the patterns do not know');
  });

  it('describes model changes in Chinese', () => {
    const text = describeChange({ type: 'node_added', nodeId: 'n', name: '新客戶', parentName: '營收' } as never, { lang: 'zh-TW' });
    expect(text).toBe('在 營收 底下新增 新客戶');
  });
});
