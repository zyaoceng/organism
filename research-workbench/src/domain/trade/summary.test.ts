import { describe, expect, it } from 'vitest';
import { summarizeTrades, type SummaryInput } from './summary';

const item = (currency: string, open: boolean, pnl: number | null, rMultiple: number | null, reviewCategories: string[] = []): SummaryInput => ({
  currency,
  metrics: { open, pnl, rMultiple },
  reviewCategories,
});

describe('trade summary', () => {
  it('keeps each currency separate and leaves open trades out of win rate and R', () => {
    const s = summarizeTrades([
      item('USD', false, 500, 2, ['timing_catalyst']),
      item('TWD', false, 12_000, 1.5, ['trading_execution', 'timing_catalyst']),
      item('TWD', false, -3_000, -1, ['timing_catalyst']),
      item('TWD', true, 8_000, 3),
      item('TWD', false, null, null),
    ]);
    expect(s.byCurrency.map((c) => c.currency)).toEqual(['TWD', 'USD']);
    const twd = s.byCurrency[0];
    expect(twd).toEqual({ currency: 'TWD', closed: 3, wins: 1, winRate: 0.5, realizedPnl: 9_000, open: 1, unrealizedPnl: 8_000 });
    expect(s.byCurrency[1]).toMatchObject({ closed: 1, wins: 1, winRate: 1, realizedPnl: 500, open: 0 });
    expect(s.closed).toBe(4);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.avgR).toBeCloseTo(2.5 / 3);
    expect(s.rCount).toBe(3);
    expect(s.categories).toEqual([
      { category: 'timing_catalyst', count: 3 },
      { category: 'trading_execution', count: 1 },
    ]);
    expect(Object.keys(s)).not.toContain('totalPnl');
  });

  it('unrealized P&L is null when no open trade has a mark', () => {
    const s = summarizeTrades([item('USD', true, null, null), item('USD', true, null, null)]);
    expect(s.byCurrency[0]).toMatchObject({ open: 2, unrealizedPnl: null, closed: 0, winRate: null });
    expect(s.winRate).toBeNull();
    expect(s.avgR).toBeNull();
  });

  it('empty input', () => {
    expect(summarizeTrades([])).toEqual({ byCurrency: [], closed: 0, winRate: null, avgR: null, rCount: 0, categories: [] });
  });
});
