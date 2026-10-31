import { describe, expect, it } from 'vitest';
import { compute } from '../calc/engine';
import { standardTemplate } from './standard';

describe('standard template languages', () => {
  it('builds the same model with Chinese names and notes', () => {
    const en = standardTemplate({ year: 2026 });
    const zh = standardTemplate({ year: 2026, lang: 'zh-TW' });
    expect(zh.nodes).toHaveLength(en.nodes.length);
    // same structure, units and roles; formulas point at the same positions in the tree
    const pos = (s: typeof en) => (f: string | null | undefined) => f?.replace(/\{(n_[a-z0-9]+)\}/g, (_, id: string) => `{${s.nodes.findIndex((n) => n.id === id)}}`);
    expect(zh.nodes.map((n) => [pos(zh)(n.formula), n.role, n.unit, n.parentId && zh.nodes.findIndex((p) => p.id === n.parentId)])).toEqual(
      en.nodes.map((n) => [pos(en)(n.formula), n.role, n.unit, n.parentId && en.nodes.findIndex((p) => p.id === n.parentId)]),
    );
    expect(zh.nodes.find((n) => n.role === 'target_price')?.name).toBe('目標價');
    expect(zh.nodes.find((n) => n.role === 'revenue')?.name).toBe('營收');
    // every name and note is translated except the ones that are abbreviations
    const untranslated = zh.nodes.filter((n) => /[a-z]{3}/.test(n.name) || (n.notes && !/[\u4e00-\u9fff]/.test(n.notes)));
    expect(untranslated.map((n) => n.name)).toEqual([]);
    expect(compute(zh).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
