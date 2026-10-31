import { describe, expect, it } from 'vitest';
import type { Bar } from '../market/indicators';
import { entryBarIndex, tradeMetrics, type TradeLike } from './metrics';

/** Weekday bars from 2026-02-02 (a Monday): 20 days up from 100, then 10 days down hard. */
function series(): Bar[] {
  const out: Bar[] = [];
  let price = 100;
  for (let d = new Date('2026-02-02T00:00:00Z'); out.length < 30; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const next = out.length < 20 ? price + 1 : price - 6;
    out.push({ date: d.toISOString().slice(0, 10), open: price, high: Math.max(price, next) + 0.5, low: Math.min(price, next) - 0.5, close: next, volume: 1000 });
    price = next;
  }
  return out;
}

const bars = series();
const trade = (t: Partial<TradeLike>): TradeLike => ({
  side: 'long',
  entryDate: '2026-02-02',
  entryPrice: 100,
  quantity: 10,
  stopAtEntry: 95,
  atrMultiple: 2,
  exitDate: null,
  exitPrice: null,
  fees: 0,
  ...t,
});

describe('trade metrics: bar coverage and the mark', () => {
  it('finds the entry bar only when history covers the entry date', () => {
    expect(entryBarIndex(bars, '2026-02-02')).toBe(0);
    expect(entryBarIndex(bars, '2026-01-15')).toBe(-1);
    expect(entryBarIndex([], '2026-02-02')).toBe(-1);
    // Saturday 2026-02-07: the next bar is Monday 02-09
    expect(bars[entryBarIndex(bars, '2026-02-07')].date).toBe('2026-02-09');
  });

  it('entry before the first bar, exit inside the bars: P&L and R, but no excursions or trailing stop', () => {
    const m = tradeMetrics(trade({ entryDate: '2026-01-15', exitDate: '2026-02-20', exitPrice: 110 }), bars);
    expect(m.pnl).toBeCloseTo(100);
    expect(m.rMultiple).toBeCloseTo(2);
    expect(m.markSource).toBe('exit');
    expect(m.mfe).toBeNull();
    expect(m.mae).toBeNull();
    expect(m.trailingExit).toBeNull();
  });

  it('entry and exit both before the first bar: no trailing-stop exit (regression)', () => {
    // with the entry on the first bar the same history does produce a trailing-stop exit
    expect(tradeMetrics(trade({ exitDate: '2026-03-13', exitPrice: 90 }), bars).trailingExit).not.toBeNull();
    const m = tradeMetrics(trade({ entryDate: '2026-01-05', exitDate: '2026-01-20', exitPrice: 104 }), bars);
    expect(m.trailingExit).toBeNull();
    expect(m.mfe).toBeNull();
    expect(m.pnl).toBeCloseTo(40);
  });

  it('entry on a weekend: excursions start at the next bar', () => {
    const m = tradeMetrics(trade({ entryDate: '2026-02-07', entryPrice: 105, exitDate: '2026-02-10', exitPrice: 106 }), bars);
    // bars 02-09 (105→106) and 02-10 (106→107): high 107.5, low 104.5
    expect(m.mfe).toBeCloseTo(2.5 / 105);
    expect(m.mae).toBeCloseTo(-0.5 / 105);
    expect(m.holdingDays).toBe(3);
  });

  it('open trade: a quote newer than the last bar marks it', () => {
    const m = tradeMetrics(trade({}), bars, { quote: { price: 70, asOf: '2026-03-16T05:30:00.000Z' } });
    expect(m.open).toBe(true);
    expect(m.markSource).toBe('quote');
    expect(m.markPrice).toBe(70);
    expect(m.markDate).toBe('2026-03-16');
    expect(m.rMultiple).toBeCloseTo(-6);
  });

  it('open trade: a quote older than the last bar loses to the bar', () => {
    const m = tradeMetrics(trade({}), bars, { quote: { price: 999, asOf: '2026-03-02T05:30:00.000Z' } });
    expect(m.markSource).toBe('bar');
    expect(m.markPrice).toBe(bars.at(-1)!.close);
    expect(m.markDate).toBe(bars.at(-1)!.date);
  });

  it('open trade without bars: P&L and R from the quote, no excursions', () => {
    const m = tradeMetrics(trade({ fees: 5 }), [], { quote: { price: 110, asOf: '2026-03-16T05:30:00.000Z' } });
    expect(m.markSource).toBe('quote');
    expect(m.pnl).toBeCloseTo(95);
    expect(m.rMultiple).toBeCloseTo(2);
    expect(m.mfe).toBeNull();
    expect(m.trailingExit).toBeNull();
    // an unusable quote is no mark at all
    expect(tradeMetrics(trade({}), [], { quote: { price: 0, asOf: '2026-03-16' } }).markSource).toBeNull();
  });

  it('closed trade: the exit is the mark and any quote is ignored', () => {
    const m = tradeMetrics(trade({ exitDate: '2026-02-20', exitPrice: 110 }), bars, { quote: { price: 1, asOf: '2026-12-31T00:00:00.000Z' } });
    expect(m.markSource).toBe('exit');
    expect(m.markPrice).toBe(110);
  });

  it('short side: R is positive when the price falls', () => {
    const m = tradeMetrics(trade({ side: 'short', entryPrice: 100, stopAtEntry: 105, exitDate: '2026-03-13', exitPrice: 90 }), bars);
    expect(m.rMultiple).toBeCloseTo(2);
    expect(m.returnPct).toBeCloseTo(0.1);
    expect(m.pnl).toBeCloseTo(100);
  });

  it('open trade whose mark predates the entry: no mark-based numbers', () => {
    const m = tradeMetrics(trade({ entryDate: '2026-04-01' }), bars, { quote: { price: 80, asOf: '2026-03-20T00:00:00.000Z' } });
    expect(m).toMatchObject({ markPrice: null, markDate: null, markSource: null, pnl: null, returnPct: null, rMultiple: null, holdingDays: null });
  });
});
