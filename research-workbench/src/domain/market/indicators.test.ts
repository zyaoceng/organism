import { describe, expect, it } from 'vitest';
import { tradeMetrics } from '../trade/metrics';
import { atr, atrAsOf, ema, indexAtOrBefore, sma, trailingStop, trueRange, type Bar } from './indicators';

const bar = (date: string, o: number, h: number, l: number, c: number, v = 1000): Bar => ({ date, open: o, high: h, low: l, close: c, volume: v });

const bars: Bar[] = [
  bar('2026-01-01', 10, 11, 9, 10),
  bar('2026-01-02', 10, 12, 10, 11),
  bar('2026-01-05', 11, 11.5, 9.5, 10),
  bar('2026-01-06', 10, 13, 10, 12.5),
  bar('2026-01-07', 12.5, 13, 12, 12.8),
];

describe('indicators', () => {
  it('sma and ema', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(4);
  });

  it('true range uses the previous close', () => {
    expect(trueRange(bars)).toEqual([2, 2, 2, 3, 1]);
  });

  it("Wilder's ATR", () => {
    const a = atr(bars, 3);
    expect(a[0]).toBeNull();
    expect(a[2]).toBeCloseTo((2 + 2 + 2) / 3);
    expect(a[3]).toBeCloseTo((a[2]! * 2 + 3) / 3);
    expect(a[4]).toBeCloseTo((a[3]! * 2 + 1) / 3);
  });

  it('ATR as of a date ignores later bars', () => {
    expect(atrAsOf(bars, '2026-01-05', 3)).toBeCloseTo((2 + 2 + 2) / 3);
    expect(atrAsOf(bars, '2026-01-04', 3)).toBeNull();
    expect(indexAtOrBefore(bars, '2026-01-03')).toBe(1);
    expect(indexAtOrBefore(bars, '2025-12-31')).toBe(-1);
  });

  it('trailing stop ratchets up and exits on a close through it', () => {
    const series: Bar[] = [
      bar('d1', 100, 101, 99, 100),
      bar('d2', 100, 106, 100, 105),
      bar('d3', 105, 111, 105, 110),
      bar('d4', 110, 110, 100, 101),
    ];
    const a = [2, 2, 2, 2];
    const r = trailingStop(series, a, 0, 2, 'long');
    expect(r.stops.slice(0, 3)).toEqual([96, 101, 106]);
    expect(r.exit).toEqual({ index: 3, date: 'd4', price: 101 });
  });

  it('trade metrics: P&L, R multiple, excursions', () => {
    const m = tradeMetrics(
      { side: 'long', entryDate: '2026-01-02', entryPrice: 11, quantity: 100, stopAtEntry: 10, atrMultiple: 2, exitDate: '2026-01-06', exitPrice: 12.5, fees: 5 },
      bars,
    );
    expect(m.open).toBe(false);
    expect(m.pnl).toBeCloseTo(145);
    expect(m.rMultiple).toBeCloseTo(1.5);
    expect(m.returnPct).toBeCloseTo(1.5 / 11);
    expect(m.mfe).toBeCloseTo(2 / 11);
    expect(m.mae).toBeCloseTo(-1.5 / 11);
    expect(m.holdingDays).toBe(4);
  });
});
