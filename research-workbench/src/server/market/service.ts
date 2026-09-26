import type { BarsResponse, MarketContext, ProviderDTO, QuoteResponse, SecurityDTO } from '../../shared/api';
import type { DB } from '../db/connection';
import { barsMeta, getBars, getQuote, logFetch, saveQuote, upsertBars } from '../repos/market';
import { addDays, badRequest, localToday, nowIso } from '../util';
import { parseOhlcvCsv } from './csv';
import { MarketDataError, type MarketDataProvider } from './provider';

export interface MarketServiceOptions {
  /** A cached quote younger than this is returned without calling the provider. */
  quoteTtlMs?: number;
  /** Minimum spacing between calls to the same provider. */
  minIntervalMs?: number;
  /** A quote older than this is flagged stale in responses. */
  staleAfterMs?: number;
  historyYears?: number;
}

/**
 * Wraps providers with a SQLite cache, incremental history, simple per-provider throttling and
 * typed errors. Cached data is returned (flagged) when a refresh fails.
 */
export class MarketService {
  private lastCall = new Map<string, number>();
  private readonly opts: Required<MarketServiceOptions>;

  constructor(
    private readonly db: DB,
    private readonly providers: Record<string, MarketDataProvider>,
    opts: MarketServiceOptions = {},
  ) {
    this.opts = { quoteTtlMs: 60_000, minIntervalMs: 1_000, staleAfterMs: 24 * 3600_000, historyYears: 3, ...opts };
  }

  listProviders(): ProviderDTO[] {
    return Object.values(this.providers).map((p) => ({ id: p.id, label: p.label, description: p.description, synthetic: p.synthetic, fetches: p.fetches }));
  }

  provider(id: string): MarketDataProvider {
    const p = this.providers[id];
    if (!p) throw badRequest(`Unknown market data provider "${id}". Available: ${Object.keys(this.providers).join(', ')}`);
    return p;
  }

  private async throttle(providerId: string) {
    const last = this.lastCall.get(providerId) ?? 0;
    const wait = last + this.opts.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall.set(providerId, Date.now());
  }

  private describe(e: unknown): string {
    if (e instanceof MarketDataError) return `${e.code}: ${e.message}${e.retryAfterSec ? ` (retry after ${e.retryAfterSec}s)` : ''}`;
    return `ERROR: ${(e as Error).message}`;
  }

  private isStale(q: MarketContext | null): boolean {
    if (!q) return true;
    return Date.now() - Date.parse(q.fetchedAt) > this.opts.staleAfterMs;
  }

  async quote(security: SecurityDTO, providerId = security.priceSource, refresh = false): Promise<QuoteResponse> {
    const p = this.provider(providerId);
    const cached = getQuote(this.db, security.id, providerId);
    if (!p.fetches) {
      // CSV: the "quote" is the last imported close.
      const last = getBars(this.db, security.id, providerId).at(-1);
      const meta = barsMeta(this.db, security.id, providerId);
      const q = last ? { price: last.close, currency: security.currency, asOf: `${last.date}T00:00:00.000Z`, provider: providerId, fetchedAt: meta.lastFetchedAt ?? nowIso() } : null;
      if (q) saveQuote(this.db, security.id, q);
      return { quote: q, stale: this.isStale(q), error: q ? null : 'No imported prices yet. Import a CSV file.' };
    }
    if (cached && !refresh && Date.now() - Date.parse(cached.fetchedAt) < this.opts.quoteTtlMs) {
      return { quote: cached, stale: false, error: null };
    }
    try {
      await this.throttle(providerId);
      const q = await p.getQuote(security.apiSymbol);
      const ctx: MarketContext = { price: q.price, currency: q.currency ?? security.currency, asOf: q.asOf, provider: providerId, fetchedAt: nowIso() };
      saveQuote(this.db, security.id, ctx);
      logFetch(this.db, security.id, providerId, 'quote', 'ok');
      return { quote: ctx, stale: false, error: null };
    } catch (e) {
      const msg = this.describe(e);
      logFetch(this.db, security.id, providerId, 'quote', 'error', msg);
      return { quote: cached, stale: true, error: msg };
    }
  }

  async bars(security: SecurityDTO, providerId = security.priceSource, refresh = false): Promise<BarsResponse> {
    const p = this.provider(providerId);
    const meta = barsMeta(this.db, security.id, providerId);
    let error: string | null = null;
    const needFetch = p.fetches && (refresh || meta.count === 0);
    if (needFetch) {
      const end = localToday();
      const start = meta.lastDate ? addDays(meta.lastDate, -7) : addDays(end, -365 * this.opts.historyYears);
      try {
        await this.throttle(providerId);
        const fetched = await p.getHistoricalPrices(security.apiSymbol, start, end);
        upsertBars(this.db, security.id, providerId, fetched);
        logFetch(this.db, security.id, providerId, 'history', 'ok', `${fetched.length} bars ${start}..${end}`);
      } catch (e) {
        error = this.describe(e);
        logFetch(this.db, security.id, providerId, 'history', 'error', error);
      }
    }
    const bars = getBars(this.db, security.id, providerId).map((b) => ({ ...b, adjClose: b.adjClose ?? null }));
    return { provider: providerId, bars, lastFetchedAt: barsMeta(this.db, security.id, providerId).lastFetchedAt, error };
  }

  importCsv(security: SecurityDTO, text: string, filename: string): { imported: number; skipped: number; first: string; last: string } {
    const { bars, skipped } = parseOhlcvCsv(text);
    upsertBars(this.db, security.id, 'csv', bars);
    logFetch(this.db, security.id, 'csv', 'csv_import', 'ok', `${filename}: ${bars.length} rows, ${skipped} skipped`);
    return { imported: bars.length, skipped, first: bars[0].date, last: bars[bars.length - 1].date };
  }
}
