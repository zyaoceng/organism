/**
 * Summary of a set of trades for the trade log and the AI tools. Money stays in each security's
 * currency: there is no cross-currency total anywhere. R multiples are currency-free.
 */
import type { TradeMetrics } from './metrics';

export interface SummaryInput {
  currency: string;
  metrics: Pick<TradeMetrics, 'open' | 'pnl' | 'rMultiple'>;
  /** Error categories of the trade's reviews. */
  reviewCategories: string[];
}

export interface CurrencySummary {
  currency: string;
  closed: number;
  wins: number;
  /** wins / closed trades with a P&L; null without any. */
  winRate: number | null;
  /** Net of fees. */
  realizedPnl: number;
  open: number;
  /** Null when no open trade has a mark. */
  unrealizedPnl: number | null;
}

export interface TradeSummary {
  byCurrency: CurrencySummary[];
  closed: number;
  winRate: number | null;
  /** Mean R of closed trades that had a stop. */
  avgR: number | null;
  rCount: number;
  categories: { category: string; count: number }[];
}

export function summarizeTrades(items: SummaryInput[]): TradeSummary {
  const by = new Map<string, CurrencySummary & { scored: number }>();
  let closed = 0;
  let scored = 0;
  let wins = 0;
  let rSum = 0;
  let rCount = 0;
  const cats = new Map<string, number>();
  for (const it of items) {
    let c = by.get(it.currency);
    if (!c) by.set(it.currency, (c = { currency: it.currency, closed: 0, wins: 0, winRate: null, realizedPnl: 0, open: 0, unrealizedPnl: null, scored: 0 }));
    const { open, pnl, rMultiple } = it.metrics;
    if (open) {
      c.open++;
      if (pnl !== null) c.unrealizedPnl = (c.unrealizedPnl ?? 0) + pnl;
    } else {
      c.closed++;
      closed++;
      if (pnl !== null) {
        c.scored++;
        scored++;
        c.realizedPnl += pnl;
        if (pnl > 0) {
          c.wins++;
          wins++;
        }
      }
      if (rMultiple !== null) {
        rSum += rMultiple;
        rCount++;
      }
    }
    for (const cat of it.reviewCategories) cats.set(cat, (cats.get(cat) ?? 0) + 1);
  }
  const byCurrency = [...by.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map(({ scored: n, ...c }) => ({ ...c, winRate: n ? c.wins / n : null }));
  return {
    byCurrency,
    closed,
    winRate: scored ? wins / scored : null,
    avgR: rCount ? rSum / rCount : null,
    rCount,
    categories: [...cats].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
  };
}
