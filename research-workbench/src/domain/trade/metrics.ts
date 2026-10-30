import { atr, indexAtOrBefore, trailingStop, type Bar } from '../market/indicators';

export interface TradeLike {
  side: 'long' | 'short';
  entryDate: string;
  entryPrice: number;
  quantity: number;
  stopAtEntry: number | null;
  atrMultiple: number | null;
  exitDate: string | null;
  exitPrice: number | null;
  fees: number;
}

export interface MetricsOptions {
  /** Latest cached quote; marks an open trade when it is not older than the last bar. */
  quote?: { price: number; asOf: string } | null;
}

export interface TradeMetrics {
  open: boolean;
  /** Exit price; for open trades the quote or the last close, whichever is newer. */
  markPrice: number | null;
  markDate: string | null;
  /** Where markPrice came from (null when there is no mark). */
  markSource: 'exit' | 'quote' | 'bar' | null;
  pnl: number | null;
  returnPct: number | null;
  /** Result in units of initial risk (entry − stop). */
  rMultiple: number | null;
  holdingDays: number | null;
  /** Max favourable / adverse excursion between entry and exit, as a fraction of entry price. */
  mfe: number | null;
  mae: number | null;
  /** Where a k×ATR(14) trailing stop from the entry would have exited (execution counterfactual). */
  trailingExit: { date: string; price: number; returnPct: number } | null;
}

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** First bar on/after the entry, or -1 when cached history starts after the entry date (or is empty). */
export function entryBarIndex(bars: Bar[], entryDate: string): number {
  if (!bars.length || bars[0].date > entryDate) return -1;
  return bars.findIndex((b) => b.date >= entryDate);
}

export function tradeMetrics(t: TradeLike, bars: Bar[], opts: MetricsOptions = {}): TradeMetrics {
  const dir = t.side === 'long' ? 1 : -1;
  const open = !t.exitDate || t.exitPrice === null;
  const last = bars.at(-1);

  let markPrice: number | null = null;
  let markDate: string | null = null;
  let markSource: TradeMetrics['markSource'] = null;
  if (!open) {
    markPrice = t.exitPrice;
    markDate = t.exitDate;
    markSource = 'exit';
  } else {
    const q = opts.quote && Number.isFinite(opts.quote.price) && opts.quote.price > 0 ? opts.quote : null;
    const qDate = q ? q.asOf.slice(0, 10) : null;
    if (q && qDate && (!last || qDate >= last.date)) {
      markPrice = q.price;
      markDate = qDate;
      markSource = 'quote';
    } else if (last) {
      markPrice = last.close;
      markDate = last.date;
      markSource = 'bar';
    }
    // a price from before the entry says nothing about this trade
    if (markDate !== null && markDate < t.entryDate) {
      markPrice = null;
      markDate = null;
      markSource = null;
    }
  }
  const pnl = markPrice === null ? null : (markPrice - t.entryPrice) * t.quantity * dir - (t.fees || 0);
  const returnPct = markPrice === null ? null : ((markPrice - t.entryPrice) / t.entryPrice) * dir;
  const risk = t.stopAtEntry === null ? null : Math.abs(t.entryPrice - t.stopAtEntry);
  const rMultiple = risk && markPrice !== null ? ((markPrice - t.entryPrice) * dir) / risk : null;
  const holdingDays = markDate ? Math.max(0, days(t.entryDate, markDate)) : null;

  // Excursions and the trailing stop need bars from the entry on; history that starts later
  // would measure from the wrong day.
  let mfe: number | null = null;
  let mae: number | null = null;
  const start = entryBarIndex(bars, t.entryDate);
  const end = markDate ? indexAtOrBefore(bars, markDate) : bars.length - 1;
  if (start >= 0 && end >= start) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = start; i <= end; i++) {
      hi = Math.max(hi, bars[i].high);
      lo = Math.min(lo, bars[i].low);
    }
    const up = (hi - t.entryPrice) / t.entryPrice;
    const down = (lo - t.entryPrice) / t.entryPrice;
    mfe = dir === 1 ? up : -down;
    mae = dir === 1 ? down : -up;
  }

  let trailingExit: TradeMetrics['trailingExit'] = null;
  const k = t.atrMultiple ?? 2;
  if (start >= 0) {
    const res = trailingStop(bars, atr(bars, 14), start, k, t.side, t.stopAtEntry ?? undefined);
    if (res.exit) {
      trailingExit = { date: res.exit.date, price: res.exit.price, returnPct: ((res.exit.price - t.entryPrice) / t.entryPrice) * dir };
    }
  }
  return { open, markPrice, markDate, markSource, pnl, returnPct, rMultiple, holdingDays, mfe, mae, trailingExit };
}
