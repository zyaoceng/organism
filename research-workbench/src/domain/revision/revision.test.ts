import { describe, expect, it } from 'vitest';
import { compute } from '../calc/engine';
import { addLink, addNode, addThesis, renameNode, setFormula, setValue, updateThesis } from '../model/ops';
import { indexModel } from '../model/tree';
import { SCALAR_KEY } from '../model/types';
import { toStored } from '../formula/refs';
import { fill, idByName, sampleModel } from '../testing/sample';
import { describeChange } from './describe';
import { diffStates } from './diff';
import { basisPeriodId, computeImpact, keyOutputs } from './impact';

describe('diff', () => {
  it('is empty for identical states', () => {
    const s = sampleModel(2026);
    expect(diffStates(s, s)).toEqual([]);
    expect(diffStates(s, JSON.parse(JSON.stringify(s)))).toEqual([]);
  });

  it('lists value, override, formula, structure, link and thesis changes', () => {
    const a = sampleModel(2026);
    const g = idByName(a, 'YoY Growth', 'Business A');
    const gm = idByName(a, 'Gross Margin');
    let b = setValue(a, g, 'FY2028', 'base', 0.47);
    b = setValue(b, g, 'FY2028', 'bull', 0.6);
    b = setValue(b, gm, 'FY2028', 'base', 0.22);
    b = renameNode(b, idByName(b, 'Business C'), 'AI Business');
    const added = addNode(b, { parentId: idByName(b, 'Revenue'), name: 'Legacy' });
    b = added.state;
    b = addLink(b, { evidenceId: 'ev1', nodeId: g, relation: 'triggered', locator: 'p.13' }).state;
    const t = addThesis(b, { statement: '800V adoption begins in FY27', invalidation: 'No qualification by Q2 FY27' });
    b = t.state;
    const nopat = idByName(b, 'NOPAT');
    const f = toStored('[Operating Income] * (1 - [Tax Rate]) * 0.95', indexModel(b), nopat);
    if (!f.ok) throw new Error();
    b = setFormula(b, nopat, f.stored);

    const changes = diffStates(a, b);
    const types = changes.map((c) => c.type);
    expect(types).toContain('value_changed');
    expect(types).toContain('node_renamed');
    expect(types).toContain('node_added');
    expect(types).toContain('link_added');
    expect(types).toContain('thesis_added');
    expect(types).toContain('formula_changed');
    const text = changes.map((c) => describeChange(c, { periodLabel: (k) => k.replace('FY', '') + 'E', evidenceTitle: () => 'Q2 call' }));
    expect(text).toContain('YoY Growth 2028E: 20.0% → 47.0%');
    expect(text.filter((t) => t === 'YoY Growth 2028E: 20.0% → 47.0%')).toHaveLength(1);
    expect(changes.filter((c) => c.type === 'value_changed')).toHaveLength(3);
    expect(text).toContain('YoY Growth 2028E (Bull): 40.0% → 60.0%');
    expect(text).toContain('Gross Margin 2028E: 21.0% → 22.0%');
    expect(text).toContain('Renamed Business C → AI Business');
    expect(text.some((x) => x.startsWith('NOPAT formula: [Operating Income] * (1 - [Tax Rate]) → '))).toBe(true);
    expect(text).toContain('Evidence “Q2 call” linked to YoY Growth (triggered, p.13)');

    const zh = changes.map((c) => describeChange(c, { periodLabel: (k) => k.replace('FY', '') + 'E', evidenceTitle: () => 'Q2 call', lang: 'zh-TW' }));
    expect(zh).toContain('YoY Growth 2028E：20.0% → 47.0%');
    expect(zh).toContain('YoY Growth 2028E（多頭）：40.0% → 60.0%');
    expect(zh).toContain('改名 Business C → AI Business');
    expect(zh).toContain('證據 「Q2 call」 連結到 YoY Growth（觸發修改，p.13）');

    const b2 = updateThesis(b, t.id, { status: 'invalidated' });
    const d2 = diffStates(b, b2);
    expect(d2).toHaveLength(1);
    expect(describeChange(d2[0])).toMatch(/→ invalidated/);
    expect(describeChange(d2[0], { lang: 'zh-TW' })).toMatch(/→ 已推翻$/);
  });
});

describe('impact and attribution', () => {
  it('reports downstream EPS and target price changes', () => {
    const a = sampleModel(2026);
    const g = idByName(a, 'YoY Growth', 'Business A');
    const gm = idByName(a, 'Gross Margin');
    let b = setValue(a, g, 'FY2028', 'base', 0.47);
    b = setValue(b, gm, 'FY2028', 'base', 0.22);

    const impact = computeImpact(a, b);
    expect(impact.basisPeriodId).toBe('FY2028');
    const tp = impact.headline.targetPrice.find((h) => h.scenario === 'base')!;
    const ra = compute(a);
    const rb = compute(b);
    expect(tp.before).toBeCloseTo(ra.cells.base[idByName(a, 'Target Price')][SCALAR_KEY].v!);
    expect(tp.after).toBeCloseTo(rb.cells.base[idByName(a, 'Target Price')][SCALAR_KEY].v!);
    expect(tp.after!).toBeGreaterThan(tp.before!);
    // bear scenario unaffected by the base growth edit on Business A (bear overrides FY2028)
    const bearTp = impact.headline.targetPrice.find((h) => h.scenario === 'bear')!;
    expect(bearTp.after! - bearTp.before!).toBeCloseTo(
      rb.cells.bear[idByName(a, 'Target Price')][SCALAR_KEY].v! - ra.cells.bear[idByName(a, 'Target Price')][SCALAR_KEY].v!,
    );

    // causal chain in dependency order: inputs before Revenue before EPS before Target Price
    const names = impact.nodes.map((n) => n.name);
    expect(names.indexOf('YoY Growth')).toBeLessThan(names.indexOf('Business A'));
    expect(names.indexOf('Business A')).toBeLessThan(names.indexOf('Revenue'));
    expect(names.indexOf('Revenue')).toBeLessThan(names.indexOf('EPS'));
    expect(names.indexOf('EPS')).toBeLessThan(names.indexOf('Target Price'));
    expect(impact.nodes.find((n) => n.name === 'YoY Growth')!.direct).toBe(true);
    expect(impact.nodes.find((n) => n.name === 'Revenue')!.direct).toBe(false);

    // marginal attribution + residual adds up to the total change
    expect(impact.attribution.map((r) => r.name).sort()).toEqual(['Gross Margin', 'YoY Growth']);
    const sum = impact.attribution.reduce((s, r) => s + (r.targetPrice.base ?? 0), 0) + (impact.residual.targetPrice.base ?? 0);
    expect(sum).toBeCloseTo(tp.after! - tp.before!);
    // growth and margin interact multiplicatively, so the residual is non-zero but small
    expect(Math.abs(impact.residual.targetPrice.base!)).toBeGreaterThan(0);
    expect(Math.abs(impact.residual.targetPrice.base!)).toBeLessThan(Math.abs(tp.after! - tp.before!) * 0.1);
  });

  it('attributes a basis-year roll through the target price formula', () => {
    const a = sampleModel(2026);
    const tp = idByName(a, 'Target Price');
    const f = toStored('[EPS]@FY2027 * [Target P/E]', indexModel(a), tp);
    if (!f.ok) throw new Error();
    const b = setFormula(a, tp, f.stored);
    expect(basisPeriodId(b)).toBe('FY2027');
    const impact = computeImpact(a, b);
    const base = impact.headline.targetPrice.find((h) => h.scenario === 'base')!;
    expect(base.after!).toBeLessThan(base.before!);
    expect(impact.attribution[0].name).toBe('Target Price');
  });

  it('handles new nodes that feed existing ones', () => {
    const a = sampleModel(2026);
    const rev = idByName(a, 'Revenue');
    const added = addNode(a, { parentId: rev, name: 'Emerging' });
    const b = fill(added.state, added.id, { FY2024: 0, FY2025: 0, FY2026: 10, FY2027: 20, FY2028: 40 });
    const impact = computeImpact(a, b);
    expect(impact.nodes[0].name).toBe('Emerging');
    expect(impact.nodes[0].direct).toBe(true);
    // no existing node changed directly, so the whole effect is in the residual
    expect(impact.attribution).toHaveLength(0);
    const tp = impact.headline.targetPrice.find((h) => h.scenario === 'base')!;
    expect(impact.residual.targetPrice.base).toBeCloseTo(tp.after! - tp.before!);
  });

  it('keyOutputs reads role nodes', () => {
    const s = sampleModel(2026);
    const k = keyOutputs(s, compute(s));
    expect(k.targetMultiple).toEqual({ bear: 14, base: 20, bull: 26 });
    expect(k.eps.base).toBeCloseTo(304.04815 / 22);
  });
});
