import { describe, expect, it } from 'vitest';
import { compute, freeze } from '../calc/engine';
import { findByRole } from '../model/tree';
import type { ModelState } from '../model/types';
import { sampleModel } from '../testing/sample';
import { frozenTargets, probabilityWeightedTarget, targetPriceCurrency, upside, type ScenarioValues } from './targets';

const tps: ScenarioValues = { bear: 80, base: 100, bull: 140 };

describe('probability-weighted target', () => {
  it('weights that sum to 1', () => {
    const w = probabilityWeightedTarget(tps, { bear: 0.25, base: 0.5, bull: 0.25 });
    expect(w.value).toBeCloseTo(105);
    expect(w.weightSum).toBeCloseTo(1);
    expect(w.normalized).toBe(false);
    expect(w.missing).toEqual([]);
  });

  it('weights that sum to 0.9 are rescaled', () => {
    const w = probabilityWeightedTarget(tps, { bear: 0.2, base: 0.5, bull: 0.2 });
    expect(w.value).toBeCloseTo((0.2 * 80 + 0.5 * 100 + 0.2 * 140) / 0.9);
    expect(w.normalized).toBe(true);
  });

  it('a weighted scenario without a target makes the result null (not 0)', () => {
    const w = probabilityWeightedTarget({ ...tps, bull: null }, { bear: 0.25, base: 0.5, bull: 0.25 });
    expect(w.value).toBeNull();
    expect(w.missing).toEqual(['bull']);
  });

  it('an unweighted scenario without a target is ignored', () => {
    const w = probabilityWeightedTarget({ ...tps, bull: null }, { bear: 0.5, base: 0.5, bull: null });
    expect(w.value).toBeCloseTo(90);
    expect(w.missing).toEqual([]);
  });

  it('no weights at all', () => {
    expect(probabilityWeightedTarget(tps, { bear: null, base: null, bull: null })).toEqual({ value: null, weightSum: 0, normalized: false, missing: [] });
  });

  it('a negative weight is ignored', () => {
    const w = probabilityWeightedTarget(tps, { bear: -0.5, base: 1, bull: 0 });
    expect(w.value).toBeCloseTo(100);
    expect(w.weightSum).toBeCloseTo(1);
  });
});

describe('frozen targets and upside', () => {
  const state = sampleModel(2026);
  const frozen = freeze(compute(state));
  const tp = findByRole(state, 'target_price')!;

  it('reads a scalar target-price node', () => {
    expect(tp.timeMode).toBe('scalar');
    const t = frozenTargets(state, frozen);
    for (const s of ['bear', 'base', 'bull'] as const) expect(t[s]).toBe(frozen.values[s][tp.id]._);
    expect(t.base).toBeGreaterThan(0);
    expect(targetPriceCurrency(state)).toBe('TWD');
  });

  it('reads the basis period of a time-series target-price node', () => {
    const series: ModelState = { ...state, nodes: state.nodes.map((n) => (n.id === tp.id ? { ...n, timeMode: 'series' } : n)) };
    const values = { bear: {}, base: {}, bull: {} } as typeof frozen.values;
    for (const s of ['bear', 'base', 'bull'] as const) values[s] = { [tp.id]: { FY2027: 1, FY2028: s === 'bear' ? 50 : s === 'base' ? 60 : 70 } };
    expect(frozenTargets(series, { ...frozen, values })).toEqual({ bear: 50, base: 60, bull: 70 });
    expect(frozenTargets(series, { ...frozen, values }, 'FY2027')).toEqual({ bear: 1, base: 1, bull: 1 });
  });

  it('no target-price node', () => {
    expect(frozenTargets({ ...state, nodes: state.nodes.filter((n) => n.id !== tp.id) }, frozen)).toEqual({ bear: null, base: null, bull: null });
  });

  it('upside needs a positive price', () => {
    expect(upside(120, 100)).toBeCloseTo(0.2);
    expect(upside(120, 0)).toBeNull();
    expect(upside(120, null)).toBeNull();
    expect(upside(null, 100)).toBeNull();
  });
});
