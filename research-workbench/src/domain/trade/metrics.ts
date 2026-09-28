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

export interface TradeMetrics {
  open: boolean;
  /** Exit price, or the last close for open trades. */
  markPrice: number | null;
  markDate: string | null;
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

export function tradeMetrics(t: TradeLike, bars: Bar[]): TradeMetrics {
  const dir = t.side === 'long' ? 1 : -1;
  const open = !t.exitDate || t.exitPrice === null;
  const last = bars.at(-1);
  const markPrice = open ? last?.close ?? null : t.exitPrice;
  const markDate = open ? last?.date ?? null : t.exitDate;
  const pnl = markPrice === null ? null : (markPrice - t.entryPrice) * t.quantity * dir - (t.fees || 0);
  const returnPct = markPrice === null ? null : ((markPrice - t.entryPrice) / t.entryPrice) * dir;
  const risk = t.stopAtEntry === null ? null : Math.abs(t.entryPrice - t.stopAtEntry);
  const rMultiple = risk && markPrice !== null ? ((markPrice - t.entryPrice) * dir) / risk : null;
  const holdingDays = markDate ? days(t.entryDate, markDate) : null;

  let mfe: number | null = null;
  let mae: number | null = null;
  const start = bars.findIndex((b) => b.date >= t.entryDate);
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
  return { open, markPrice, markDate, pnl, returnPct, rMultiple, holdingDays, mfe, mae, trailingExit };
}
