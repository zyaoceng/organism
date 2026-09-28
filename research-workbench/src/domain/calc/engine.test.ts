import { describe, expect, it } from 'vitest';
import { indexModel } from '../model/tree';
import { addNode, setFormula, setValue, setUnit } from '../model/ops';
import { SCALAR_KEY, type ModelState } from '../model/types';
import { toStored } from '../formula/refs';
import { fill, idByName, sampleModel } from '../testing/sample';
import { standardTemplate } from '../templates/standard';
import { compute, freeze } from './engine';
import { findCycleWith } from './graph';

const formula = (s: ModelState, nodeId: string, text: string) => {
  const r = toStored(text, indexModel(s), nodeId);
  if (!r.ok) throw new Error(r.error.message);
  return setFormula(s, nodeId, r.stored);
};

describe('calculation engine on the standard template', () => {
  const s = sampleModel(2026);
  const r = compute(s);
  const v = (name: string, key: string, sc: 'bear' | 'base' | 'bull' = 'base', parent?: string) => r.cells[sc][idByName(s, name, parent)][key];

  it('builds EPS from segments through the income statement', () => {
    expect(v('Revenue', 'FY2025').v).toBeCloseTo(1670);
    expect(v('Business A', 'FY2028').v).toBeCloseTo(1728);
    expect(v('Revenue', 'FY2028').v).toBeCloseTo(2769.69375);
    expect(v('Net Income', 'FY2028').v).toBeCloseTo(304.04815);
    expect(v('EPS', 'FY2028').v).toBeCloseTo(304.04815 / 22);
    expect(v('Target Price', SCALAR_KEY).v).toBeCloseTo((304.04815 / 22) * 20);
  });

  it('computes cross-branch metrics (ROIC uses the EPS branch)', () => {
    const oi = v('Operating Income', 'FY2026').v!;
    expect(v('NOPAT', 'FY2026').v).toBeCloseTo(oi * 0.8);
    expect(v('ROIC', 'FY2026').v).toBeCloseTo((oi * 0.8) / 600);
    expect(v('EPS Growth', 'FY2026').v).toBeCloseTo(v('EPS', 'FY2026').v! / v('EPS', 'FY2025').v! - 1);
  });

  it('marks provenance: inputs, formulas, actual vs estimate', () => {
    expect(v('Business A', 'FY2025').src).toBe('input');
    expect(v('Business A', 'FY2025').est).toBe(false);
    expect(v('Business A', 'FY2026').src).toBe('formula');
    expect(v('Business A', 'FY2026').est).toBe(true);
    expect(v('Revenue', 'FY2025').est).toBe(false);
  });

  it('applies scenario overrides only where set and shares actuals', () => {
    expect(v('Business A', 'FY2028', 'bear').v).toBeCloseTo(1000 * 1.1 * 1.05 * 1.0);
    expect(v('Business A', 'FY2028', 'bull').v).toBeCloseTo(1000 * 1.3 * 1.35 * 1.4);
    expect(v('Business B', 'FY2028', 'bull').v).toBeCloseTo(v('Business B', 'FY2028', 'base').v!);
    expect(v('Business A', 'FY2025', 'bear').v).toBe(1000);
    expect(v('Target P/E', SCALAR_KEY, 'bear').v).toBe(14);
    expect(v('Target Price', SCALAR_KEY, 'bull').v).toBeCloseTo(v('EPS', 'FY2028', 'bull').v! * 26);
    expect(v('Target Price', SCALAR_KEY, 'bear').v!).toBeLessThan(v('Target Price', SCALAR_KEY, 'base').v!);
  });

  it('SUM(CHILDREN()) picks up a new segment automatically', () => {
    const rev = idByName(s, 'Revenue');
    const added = addNode(s, { parentId: rev, name: 'Emerging Optionality' });
    let s2 = fill(added.state, added.id, { FY2024: 0, FY2025: 0, FY2026: 10, FY2027: 30, FY2028: 60 });
    const r2 = compute(s2);
    expect(r2.cells.base[rev].FY2028.v).toBeCloseTo(2769.69375 + 60);
    expect(r2.graph.childrenExpansion.get(rev)).toContain(added.id);
    // a percent child is not summed
    const pct = addNode(s2, { parentId: rev, name: 'Mix note', unit: { kind: 'percent', scale: 1 } });
    s2 = fill(pct.state, pct.id, { FY2028: 0.5 });
    expect(compute(s2).cells.base[rev].FY2028.v).toBeCloseTo(2769.69375 + 60);
  });

  it('freezes plain numbers for snapshots', () => {
    const f = freeze(r);
    expect(f.values.base[idByName(s, 'EPS')].FY2028).toBeCloseTo(304.04815 / 22);
    expect(f.est[idByName(s, 'EPS')].FY2025).toBe(false);
    expect(typeof f.engineVersion).toBe('string');
  });
});

describe('errors are explained', () => {
  it('reports missing inputs with the root cause', () => {
    const s = standardTemplate({ year: 2026 });
    const r = compute(s);
    const eps = r.cells.base[idByName(s, 'EPS')].FY2027;
    expect(eps.v).toBeNull();
    expect(eps.err?.code).toBe('UPSTREAM');
    expect(eps.err?.message).toMatch(/^Missing (input|starting value)/);
    const s2 = setValue(s, idByName(s, 'Revenue'), 'FY2025', 'base', 1000);
    const gp = compute(s2).cells.base[idByName(s, 'Gross Profit')].FY2025;
    expect(gp.err?.code).toBe('MISSING');
    expect(gp.err?.message).toBe('Missing input: Gross Margin, 2025A');
  });

  it('reports division by zero with the denominator', () => {
    let s = sampleModel(2026);
    s = setValue(s, idByName(s, 'Diluted Shares'), 'FY2027', 'base', 0);
    const c = compute(s).cells.base[idByName(s, 'EPS')].FY2027;
    expect(c.err?.code).toBe('DIV0');
    expect(c.err?.message).toBe('Division by zero: [Diluted Shares] is 0');
  });

  it('detects and names circular dependencies', () => {
    const s = sampleModel(2026);
    const gm = idByName(s, 'Gross Margin');
    const ix = indexModel(s);
    const stored = toStored('[EPS] / 100', ix, gm);
    if (!stored.ok) throw new Error();
    const cycle = findCycleWith(s, gm, stored.stored);
    expect(cycle).not.toBeNull();
    const names = cycle!.map((id) => ix.byId.get(id)!.name);
    expect(names[0]).toBe(names[names.length - 1]);
    expect(names).toContain('EPS');
    expect(names).toContain('Gross Margin');
    // even if stored anyway, the engine refuses to evaluate the loop
    const bad = setValue(setFormula(s, gm, stored.stored), gm, 'FY2027', 'base', null);
    const r = compute(bad);
    expect(r.cells.base[gm].FY2027.err?.code).toBe('CYCLE');
    expect(r.issues.some((i) => i.code === 'CYCLE' && /Circular dependency/.test(i.message))).toBe(true);
  });

  it('catches loops that PREV cannot break: scalar reads and forward @period references', () => {
    // (a) PREV() of a single-value node is the same value, so this is a real loop
    let s = sampleModel(2026);
    const xs = addNode(s, { parentId: null, name: 'Xs', unit: { kind: 'number', scale: 1 } });
    s = xs.state;
    const sx = addNode(s, { parentId: null, name: 'Sx', timeMode: 'scalar', unit: { kind: 'number', scale: 1 } });
    s = formula(sx.state, sx.id, '[Xs]@FY2027');
    const stored = toStored('PREV([Sx]) + 1', indexModel(s), xs.id);
    if (!stored.ok) throw new Error();
    expect(findCycleWith(s, xs.id, stored.stored)).not.toBeNull();
    // (b) an absolute reference to a later period closes a loop through PREV
    let t = sampleModel(2026);
    const xa = addNode(t, { parentId: null, name: 'Xa', unit: { kind: 'number', scale: 1 } });
    t = xa.state;
    const yb = addNode(t, { parentId: null, name: 'Yb', unit: { kind: 'number', scale: 1 } });
    t = formula(yb.state, yb.id, 'PREV([Xa]) + 1');
    const st2 = toStored('[Yb]@FY2027 * 2', indexModel(t), xa.id);
    if (!st2.ok) throw new Error();
    const cyc = findCycleWith(t, xa.id, st2.stored);
    expect(cyc).not.toBeNull();
    const r = compute(setFormula(t, xa.id, st2.stored));
    expect(r.issues.some((i) => i.code === 'CYCLE' && i.nodeId === xa.id)).toBe(true);
    // the usual target-price pattern is still fine
    expect(compute(sampleModel(2026)).graph.inCycle.size).toBe(0);
  });

  it('allows self-reference through PREV (not a cycle)', () => {
    const s = sampleModel(2026);
    const a = idByName(s, 'Business A');
    expect(findCycleWith(s, a, s.nodes.find((n) => n.id === a)!.formula)).toBeNull();
  });

  it('PREV before the first period is an explicit error', () => {
    let s = sampleModel(2026);
    const a = idByName(s, 'Business A');
    s = setValue(s, a, 'FY2024', 'base', null);
    const c = compute(s).cells.base[a].FY2024;
    expect(c.err?.code).toBe('MISSING');
    expect(c.err?.message).toMatch(/Missing starting value for Business A/);
  });

  it('asks for a period when a single-value formula reads a time series', () => {
    let s = sampleModel(2026);
    const tp = idByName(s, 'Target Price');
    s = formula(s, tp, '[EPS] * [Target P/E]');
    const c = compute(s).cells.base[tp][SCALAR_KEY];
    expect(c.err?.code).toBe('NEEDS_PERIOD');
    expect(c.err?.message).toMatch(/pick a period/);
  });
});

describe('model checks', () => {
  it('warns when currencies or scales are mixed', () => {
    let s = sampleModel(2026);
    const usd = addNode(s, { parentId: null, name: 'US Sales', unit: { kind: 'currency', currency: 'USD', scale: 1e6 } });
    s = fill(usd.state, usd.id, { FY2026: 10 });
    const tot = addNode(s, { parentId: null, name: 'Total', unit: { kind: 'currency', currency: 'TWD', scale: 1e8 } });
    s = formula(tot.state, tot.id, '[Revenue] + [US Sales]');
    const issues = compute(s).issues.filter((i) => i.nodeId === tot.id && i.code === 'UNIT');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/different currencies/);
  });

  it('warns when EPS divides amounts and shares of different scales', () => {
    let s = sampleModel(2026);
    s = setUnit(s, idByName(s, 'Diluted Shares'), { kind: 'shares', scale: 1e6 }, false);
    const issues = compute(s).issues.filter((i) => i.nodeId === idByName(s, 'EPS') && i.code === 'UNIT');
    expect(issues[0]?.message).toMatch(/off by a factor/);
  });

  it('flags a reported value that disagrees with its formula', () => {
    let s = sampleModel(2026);
    const rev = idByName(s, 'Revenue');
    s = setValue(s, rev, 'FY2025', 'base', 1700); // segments sum to 1670
    const r = compute(s);
    expect(r.cells.base[rev].FY2025.v).toBe(1700);
    expect(r.cells.base[rev].FY2025.check).toBeCloseTo(1670);
    expect(r.issues.some((i) => i.nodeId === rev && i.code === 'CHECK')).toBe(true);
  });

  it('flags hard-coded plugs in estimate periods', () => {
    let s = sampleModel(2026);
    const rev = idByName(s, 'Revenue');
    s = setValue(s, rev, 'FY2027', 'base', 3000);
    expect(compute(s).issues.some((i) => i.nodeId === rev && i.code === 'HARDCODED')).toBe(true);
  });
});
