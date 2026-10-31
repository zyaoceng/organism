import type { Bar } from '../../domain/market/indicators';
import { addDays } from '../util';
import { getJson, taiwanCode } from './http';
import { MarketDataError, type MarketDataProvider, type ProviderQuote } from './provider';

interface FugleQuote {
  symbol?: string;
  name?: string;
  lastPrice?: number;
  closePrice?: number;
  previousClose?: number;
  referencePrice?: number;
  lastUpdated?: number;
  date?: string;
  message?: string;
}
interface FugleCandles {
  symbol?: string;
  data?: { date: string; open: number; high: number; low: number; close: number; volume?: number }[];
  message?: string;
}

/**
 * Fugle (富果) Market Data API v1.0, https://developer.fugle.tw — a broker-grade Taiwan feed with
 * intraday quotes. Needs a free API key from Fugle in FUGLE_API_KEY; the provider is only offered
 * when the key is set.
 *
 * ENGINEERING ASSUMPTION — endpoints `/stock/intraday/quote/{symbol}` and
 * `/stock/historical/candles/{symbol}` (header X-API-KEY) follow Fugle's documentation and were
 * not exercised from the build environment. Candles are requested one year at a time.
 */
export class FugleProvider implements MarketDataProvider {
  id = 'fugle';
  label = 'Fugle (Taiwan, API key)';
  description = 'Fugle (富果) market data API: real-time quote and daily candles for Taiwan stocks. Uses FUGLE_API_KEY.';
  synthetic = false;
  fetches = true;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.fugle.tw/marketdata/v1.0/stock',
  ) {}

  private async call<T extends { message?: string }>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const { status, body } = await getJson<T>(this.fetchImpl, 'Fugle', `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`, { 'X-API-KEY': this.apiKey });
    if (status === 401 || status === 403) throw new MarketDataError('PROVIDER', 'Fugle rejected the API key (FUGLE_API_KEY)');
    if (status === 404) throw new MarketDataError('NOT_FOUND', `Fugle: ${body.message ?? 'symbol not found'}`);
    if (status >= 400) throw new MarketDataError('PROVIDER', `Fugle: ${body.message ?? `HTTP ${status}`}`);
    return body;
  }

  private code(symbol: string): string {
    const c = taiwanCode(symbol);
    if (!c) throw new MarketDataError('NOT_FOUND', `Fugle only covers Taiwan stocks; "${symbol}" is not a Taiwan stock code`);
    return c;
  }

  async getQuote(symbol: string): Promise<ProviderQuote> {
    const q = await this.call<FugleQuote>(`/intraday/quote/${this.code(symbol)}`);
    const price = [q.lastPrice, q.closePrice, q.previousClose, q.referencePrice].find((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
    if (price === undefined) throw new MarketDataError('PROVIDER', 'Fugle response has no price');
    const asOf = typeof q.lastUpdated === 'number' ? new Date(q.lastUpdated / 1000).toISOString() : q.date ? `${q.date}T05:30:00.000Z` : new Date().toISOString();
    return { price, currency: 'TWD', asOf };
  }

  async getHistoricalPrices(symbol: string, startDate: string, endDate: string): Promise<Bar[]> {
    const code = this.code(symbol);
    const byDate = new Map<string, Bar>();
    for (let from = startDate; from <= endDate; from = addDays(from, 365)) {
      const to = addDays(from, 364) < endDate ? addDays(from, 364) : endDate;
      const r = await this.call<FugleCandles>(`/historical/candles/${code}`, { from, to, fields: 'open,high,low,close,volume' });
      for (const c of r.data ?? []) {
        if ([c.open, c.high, c.low, c.close].some((x) => typeof x !== 'number' || !(x > 0))) continue;
        byDate.set(c.date, { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, adjClose: null });
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}
