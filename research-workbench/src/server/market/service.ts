import { quoteFreshness } from '../../domain/portfolio/flags';
import type { BarsResponse, MarketContext, ProviderDTO, QuoteResponse, SecurityDTO } from '../../shared/api';
import type { DB } from '../db/connection';
import { barsMeta, getBars, getQuote, lastBar, logFetch, saveQuote, upsertBars } from '../repos/market';
import { addDays, badRequest, localToday, nowIso } from '../util';
import { parseOhlcvCsv } from './csv';
import { MarketDataError, type MarketDataProvider, type MarketErrorCode } from './provider';

export interface MarketServiceOptions {
  /** A cached quote younger than this is returned without calling the provider. */
  quoteTtlMs?: number;
  /** Minimum spacing between calls to the same provider. */
  minIntervalMs?: number;
  /** Per-provider spacing that overrides minIntervalMs (Yahoo's unofficial endpoint gets more room). */
  providerIntervalMs?: Record<string, number>;
  /** A quote older than this is flagged stale in responses. */
  staleAfterMs?: number;
  historyYears?: number;
}

/** Result of refreshing one security ("update all prices"). */
export type RefreshOutcome =
  | { status: 'ok'; lastDate: string | null }
  | { status: 'skipped'; message: string }
  | { status: 'failed' | 'rate_limited'; code: MarketErrorCode | 'ERROR'; message: string; retryAfterSec?: number };

/**
 * Wraps providers with a SQLite cache, incremental history, per-provider throttling and typed
 * errors. Cached data is returned (flagged) when a refresh fails.
 */
export class MarketService {
  private gates = new Map<string, Promise<void>>();
  private lastStart = new Map<string, number>();
  private readonly opts: Required<MarketServiceOptions>;

  constructor(
    private readonly db: DB,
    private readonly providers: Record<string, MarketDataProvider>,
    opts: MarketServiceOptions = {},
  ) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    this.opts = { quoteTtlMs: 60_000, minIntervalMs: 1_000, providerIntervalMs: { yahoo: 1_500 }, staleAfterMs: 24 * 3600_000, historyYears: 3, ...given };
  }

  get staleAfterMs(): number {
    return this.opts.staleAfterMs;
  }

  listProviders(): ProviderDTO[] {
    return Object.values(this.providers).map((p) => this.toDTO(p));
  }

  providerInfo(id: string): ProviderDTO | null {
    const p = this.providers[id];
    return p ? this.toDTO(p) : null;
  }

  /** Providers whose prices are generated (demo): labelled SYNTHETIC wherever they are shown. */
  syntheticIds(): Set<string> {
    return new Set(Object.values(this.providers).filter((p) => p.synthetic).map((p) => p.id));
  }

  private toDTO(p: MarketDataProvider): ProviderDTO {
    return { id: p.id, label: p.label, description: p.description, synthetic: p.synthetic, fetches: p.fetches };
  }

  provider(id: string): MarketDataProvider {
    const p = this.providers[id];
    if (!p) throw badRequest(`Unknown market data provider "${id}". Available: ${Object.keys(this.providers).join(', ')}`);
    return p;
  }

  /** One promise chain per provider: concurrent callers get successive slots `interval` apart. */
  private throttle(p: MarketDataProvider): Promise<void> {
    if (p.synthetic || !p.fetches) return Promise.resolve(); // demo and CSV make no network calls
    const interval = this.opts.providerIntervalMs[p.id] ?? this.opts.minIntervalMs;
    const slot = (this.gates.get(p.id) ?? Promise.resolve()).then(async () => {
      const wait = (this.lastStart.get(p.id) ?? 0) + interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart.set(p.id, Date.now());
    });
    this.gates.set(p.id, slot);
    return slot;
  }

  private describe(e: unknown): string {
    if (e instanceof MarketDataError) return `${e.code}: ${e.message}${e.retryAfterSec ? ` (retry after ${e.retryAfterSec}s)` : ''}`;
    return `ERROR: ${(e as Error).message}`;
  }

  private isStale(q: MarketContext | null): boolean {
    return quoteFreshness(q, new Date(), localToday(), this.opts.staleAfterMs).stale;
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
      await this.throttle(p);
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

  /** Incremental daily bars (from a week before the last cached day, else historyYears back). */
  private async fetchHistory(security: SecurityDTO, p: MarketDataProvider): Promise<Error | null> {
    const meta = barsMeta(this.db, security.id, p.id);
    const end = localToday();
    const start = meta.lastDate ? addDays(meta.lastDate, -7) : addDays(end, -365 * this.opts.historyYears);
    try {
      await this.throttle(p);
      const fetched = await p.getHistoricalPrices(security.apiSymbol, start, end);
      upsertBars(this.db, security.id, p.id, fetched);
      logFetch(this.db, security.id, p.id, 'history', 'ok', `${fetched.length} bars ${start}..${end}`);
      return null;
    } catch (e) {
      logFetch(this.db, security.id, p.id, 'history', 'error', this.describe(e));
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  async bars(security: SecurityDTO, providerId = security.priceSource, refresh = false): Promise<BarsResponse> {
    const p = this.provider(providerId);
    const meta = barsMeta(this.db, security.id, providerId);
    let error: string | null = null;
    if (p.fetches && (refresh || meta.count === 0)) {
      const e = await this.fetchHistory(security, p);
      error = e ? this.describe(e) : null;
    }
    const bars = getBars(this.db, security.id, providerId).map((b) => ({ ...b, adjClose: b.adjClose ?? null }));
    return { provider: providerId, bars, lastFetchedAt: barsMeta(this.db, security.id, providerId).lastFetchedAt, error };
  }

  /** One provider call per security: incremental daily bars, then the quote derived from the last bar. */
  async refreshSecurity(security: SecurityDTO): Promise<RefreshOutcome> {
    const p = this.providers[security.priceSource];
    if (!p) return { status: 'skipped', message: `Unknown price source "${security.priceSource}"` };
    if (!p.fetches) return { status: 'skipped', message: 'Imported prices only (CSV)' };
    const e = await this.fetchHistory(security, p);
    if (e) {
      const m = e instanceof MarketDataError ? e : null;
      if (m?.code === 'RATE_LIMITED') return { status: 'rate_limited', code: m.code, message: m.message, retryAfterSec: m.retryAfterSec };
      return { status: 'failed', code: m?.code ?? 'ERROR', message: e.message };
    }
    const last = lastBar(this.db, security.id, p.id);
    const cached = getQuote(this.db, security.id, p.id);
    // same shape as the CSV quote; never replaces a live quote from a later day
    if (last && (!cached || last.date >= cached.asOf.slice(0, 10))) {
      saveQuote(this.db, security.id, { price: last.close, currency: security.currency, asOf: `${last.date}T00:00:00.000Z`, provider: p.id, fetchedAt: nowIso() });
    }
    return { status: 'ok', lastDate: last?.date ?? null };
  }

  importCsv(security: SecurityDTO, text: string, filename: string): { imported: number; skipped: number; first: string; last: string } {
    const { bars, skipped } = parseOhlcvCsv(text);
    upsertBars(this.db, security.id, 'csv', bars);
    logFetch(this.db, security.id, 'csv', 'csv_import', 'ok', `${filename}: ${bars.length} rows, ${skipped} skipped`);
    return { imported: bars.length, skipped, first: bars[0].date, last: bars[bars.length - 1].date };
  }
}
