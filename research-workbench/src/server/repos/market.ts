import type { Bar } from '../../domain/market/indicators';
import type { MarketContext } from '../../shared/api';
import type { DB } from '../db/connection';
import { nowIso } from '../util';

interface BarRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adj_close: number | null;
  fetched_at: string;
}

export function getBars(db: DB, securityId: string, provider: string, from?: string): Bar[] {
  const rows = (
    from
      ? db.prepare('SELECT * FROM price_bars WHERE security_id = ? AND provider = ? AND date >= ? ORDER BY date').all(securityId, provider, from)
      : db.prepare('SELECT * FROM price_bars WHERE security_id = ? AND provider = ? ORDER BY date').all(securityId, provider)
  ) as BarRow[];
  return rows.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, adjClose: r.adj_close }));
}

export function barsMeta(db: DB, securityId: string, provider: string): { count: number; lastDate: string | null; lastFetchedAt: string | null } {
  const r = db
    .prepare('SELECT COUNT(*) AS c, MAX(date) AS d, MAX(fetched_at) AS f FROM price_bars WHERE security_id = ? AND provider = ?')
    .get(securityId, provider) as { c: number; d: string | null; f: string | null };
  return { count: r.c, lastDate: r.d, lastFetchedAt: r.f };
}

export function upsertBars(db: DB, securityId: string, provider: string, bars: Bar[], fetchedAt = nowIso()): number {
  const stmt = db.prepare(
    `INSERT INTO price_bars (security_id, provider, date, open, high, low, close, volume, adj_close, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(security_id, provider, date) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume, adj_close = excluded.adj_close, fetched_at = excluded.fetched_at`,
  );
  db.transaction(() => {
    for (const b of bars) stmt.run(securityId, provider, b.date, b.open, b.high, b.low, b.close, b.volume, b.adjClose ?? null, fetchedAt);
  })();
  return bars.length;
}

export function getQuote(db: DB, securityId: string, provider: string): MarketContext | null {
  const r = db.prepare('SELECT * FROM quotes WHERE security_id = ? AND provider = ?').get(securityId, provider) as
    | { price: number; currency: string | null; as_of: string; provider: string; fetched_at: string }
    | undefined;
  return r ? { price: r.price, currency: r.currency, asOf: r.as_of, provider: r.provider, fetchedAt: r.fetched_at } : null;
}

export function saveQuote(db: DB, securityId: string, q: MarketContext) {
  db.prepare(
    `INSERT INTO quotes (security_id, provider, price, currency, as_of, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(security_id, provider) DO UPDATE SET price = excluded.price, currency = excluded.currency, as_of = excluded.as_of, fetched_at = excluded.fetched_at`,
  ).run(securityId, q.provider, q.price, q.currency, q.asOf, q.fetchedAt);
}

export function logFetch(db: DB, securityId: string, provider: string, kind: string, status: 'ok' | 'error', message = '') {
  db.prepare('INSERT INTO market_fetch_log (security_id, provider, kind, requested_at, status, message) VALUES (?, ?, ?, ?, ?, ?)').run(securityId, provider, kind, nowIso(), status, message);
}
