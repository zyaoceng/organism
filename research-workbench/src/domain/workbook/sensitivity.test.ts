import { describe, expect, it } from 'vitest';
import { computeSensitivity } from './sensitivity';
import type { CellOverride, CellRef, CellValue, FormulaEngine, SelfCheckReport, WorkbookData } from './types';

/** A four-cell model: revenue = 1000 × (1 + growth); target = (multiple × revenue + 500) ÷ shares; eps = revenue × 0.2 ÷ shares. */
class FakeEngine implements FormulaEngine {
  private overrides = new Map<string, number>();
  sets = 0;
  load(_workbook: WorkbookData): void {}
  set(overrides: CellOverride[]): void {
    this.sets++;
    this.overrides = new Map(overrides.map((o) => [o.address, o.value]));
  }
  get(cells: CellRef[]): CellValue[] {
    const v = (address: string, base: number) => this.overrides.get(address) ?? base;
    const revenue = 1000 * (1 + v('B1', 0.2));
    const shares = v('B3', 100);
    const values: Record<string, CellValue> = { B10: revenue, B11: (v('B2', 25) * revenue + 500) / shares, B12: (revenue * 0.2) / shares, B13: '#DIV/0!' };
    return cells.map((c) => values[c.address] ?? null);
  }
  selfCheck(): SelfCheckReport {
    throw new Error('not used');
  }
  current() {
    return [...this.overrides];
  }
}

const row = (id: string, valueCell: string, low: number | null, high: number | null) => ({ id, label: id, section: null, sheet: 'S', valueCell, low, high });
const outputs = { targetPrice: { sheet: 'S', address: 'B11' }, revenue: { sheet: 'S', address: 'B10' }, eps: { sheet: 'S', address: 'B12' } };

describe('computeSensitivity', () => {
  it('moves each assumption to its low and high end and sorts by the target-price change', () => {
    const engine = new FakeEngine();
    const result = computeSensitivity(engine, { assumptions: [row('growth', 'B1', 0.1, 0.3), row('shares', 'B3', 99, 101), row('multiple', 'B2', null, null)], outputs });
    expect(result.base).toEqual({ targetPrice: 305, revenue: 1200, eps: 2.4 });
    expect(result.rows.map((r) => r.id)).toEqual(['growth', 'shares']);
    expect(result.withoutRange).toEqual(['multiple']);
    const growth = result.rows[0];
    expect(growth).toMatchObject({ low: 0.1, high: 0.3, rangeSource: 'sheet' });
    expect(growth.revenue).toEqual({ atLow: 1100, atHigh: 1300, delta: 200 });
    expect(growth.targetPrice.delta).toBeCloseTo(50, 9);
    expect(growth.eps.delta).toBeCloseTo(0.4, 9);
    // more shares, lower price: the change is negative and still ranked by its size
    expect(result.rows[1].targetPrice.delta).toBeCloseTo(-6.1, 2);
    expect(result.rows[1].revenue.delta).toBe(0);
  });

  it('a trial range brings in an assumption the sheet gives no range, and replaces the sheet range', () => {
    const engine = new FakeEngine();
    const result = computeSensitivity(engine, {
      assumptions: [row('growth', 'B1', 0.1, 0.3), row('multiple', 'B2', null, null)],
      outputs,
      trialRanges: { multiple: { low: 20, high: 30 }, growth: { low: 0.19, high: 0.21 } },
    });
    expect(result.rows.map((r) => [r.id, r.rangeSource])).toEqual([
      ['multiple', 'trial'],
      ['growth', 'trial'],
    ]);
    expect(result.rows[0].targetPrice).toEqual({ atLow: 245, atHigh: 365, delta: 120 });
    expect(result.rows[1].targetPrice.delta).toBeCloseTo(5, 9);
    expect(result.withoutRange).toEqual([]);
  });

  it('keeps the trial values already entered, and leaves the engine holding them', () => {
    const engine = new FakeEngine();
    const baseOverrides = [
      { sheet: 'S', address: 'B2', value: 30 },
      { sheet: 'S', address: 'B1', value: 0.25 },
    ];
    const result = computeSensitivity(engine, { assumptions: [row('growth', 'B1', 0.1, 0.3)], outputs, baseOverrides });
    expect(result.base.targetPrice).toBe(380);
    // the multiple stays at 30 while growth moves; growth's own override is replaced
    expect(result.rows[0].targetPrice).toEqual({ atLow: 335, atHigh: 395, delta: 60 });
    expect(engine.current()).toEqual([
      ['B2', 30],
      ['B1', 0.25],
    ]);
  });

  it('an output that is missing or not a number gives null, and such rows go last', () => {
    const engine = new FakeEngine();
    const result = computeSensitivity(engine, { assumptions: [row('growth', 'B1', 0.1, 0.3)], outputs: { targetPrice: { sheet: 'S', address: 'B13' }, revenue: null, eps: outputs.eps } });
    expect(result.base).toEqual({ targetPrice: null, revenue: null, eps: 2.4 });
    expect(result.rows[0].targetPrice).toEqual({ atLow: null, atHigh: null, delta: null });
    expect(result.rows[0].eps.delta).toBeCloseTo(0.4, 9);
  });
});
