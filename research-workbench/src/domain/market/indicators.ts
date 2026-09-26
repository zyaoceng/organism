/** Daily bar in the internal format; providers are converted into this shape. */
export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number | null;
}

export interface Quote {
  price: number;
  currency: string | null;
  asOf: string; // provider market time (ISO)
  provider: string;
  fetchedAt: string;
}

export type Series = (number | null)[];

export function sma(values: number[], n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (n <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values: number[], n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < n || n <= 0) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((s, x) => s + x, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Wilder's ATR: first value is the simple mean of the first n true ranges. */
export function atr(bars: Bar[], n = 14): Series {
  const tr = trueRange(bars);
  const out: Series = new Array(bars.length).fill(null);
  if (bars.length < n || n <= 0) return out;
  let prev = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

/** Index of the last bar on or before `date`, or -1. Bars must be sorted by date. */
export function indexAtOrBefore(bars: Bar[], date: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** ATR(n) using only bars up to and including `date` (no look-ahead). */
export function atrAsOf(bars: Bar[], date: string, n = 14): number | null {
  const i = indexAtOrBefore(bars, date);
  if (i < 0) return null;
  return atr(bars.slice(0, i + 1), n)[i];
}

export interface TrailingStopResult {
  /** Stop level per bar from the entry bar onwards (null before entry). */
  stops: Series;
  exit: { index: number; date: string; price: number } | null;
}

/**
 * Chandelier-style trailing stop for a position opened at `entryIndex`:
 * long stop = max(previous stop, close − k × ATR); exits at the close of the first bar that closes
 * through the prior stop. Uses only information available at each bar.
 */
export function trailingStop(bars: Bar[], atrSeries: Series, entryIndex: number, k: number, side: 'long' | 'short' = 'long', initialStop?: number): TrailingStopResult {
  const stops: Series = new Array(bars.length).fill(null);
  if (entryIndex < 0 || entryIndex >= bars.length) return { stops, exit: null };
  const a0 = atrSeries[entryIndex];
  let stop = initialStop ?? (a0 === null ? null : side === 'long' ? bars[entryIndex].close - k * a0 : bars[entryIndex].close + k * a0);
  stops[entryIndex] = stop;
  for (let i = entryIndex + 1; i < bars.length; i++) {
    const b = bars[i];
    if (stop !== null && ((side === 'long' && b.close < stop) || (side === 'short' && b.close > stop))) {
      return { stops, exit: { index: i, date: b.date, price: b.close } };
    }
    const a = atrSeries[i];
    if (a !== null) {
      const cand = side === 'long' ? b.close - k * a : b.close + k * a;
      stop = stop === null ? cand : side === 'long' ? Math.max(stop, cand) : Math.min(stop, cand);
    }
    stops[i] = stop;
  }
  return { stops, exit: null };
}
