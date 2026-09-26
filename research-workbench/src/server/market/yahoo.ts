import type { Bar } from '../../domain/market/indicators';
import { MarketDataError, type MarketDataProvider, type ProviderQuote } from './provider';

/**
 * Yahoo Finance chart endpoint (`/v8/finance/chart/{symbol}`).
 *
 * ENGINEERING ASSUMPTION — this endpoint is undocumented. The response shape used here
 * (chart.result[0].meta, timestamp[], indicators.quote[0].open/high/low/close/volume,
 * indicators.adjclose[0].adjclose) is assumed from common use and could not be exercised in the
 * build environment (egress blocked). The parser is defensive and fails with a PROVIDER error if
 * the shape differs. Taiwan listings use the `.TW` (TWSE) / `.TWO` (TPEx) suffix.
 */
export class YahooChartProvider implements MarketDataProvider {
  id = 'yahoo';
  label = 'Yahoo Finance (unofficial)';
  description = 'Undocumented public chart endpoint. Works for US and Taiwan symbols (2301.TW) when reachable; may change or rate-limit without notice.';
  synthetic = false;
  fetches = true;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://query1.finance.yahoo.com',
  ) {}

  private async call(symbol: string, params: Record<string, string>): Promise<YahooResult> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (research-workbench)', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new MarketDataError('NETWORK', `Could not reach Yahoo Finance: ${(e as Error).message}`);
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new MarketDataError('RATE_LIMITED', 'Yahoo Finance rate limit reached. Try again later.', Number.isFinite(ra) ? ra : undefined);
    }
    if (res.status === 404) throw new MarketDataError('NOT_FOUND', `Symbol ${symbol} not found at Yahoo Finance`);
    let body: YahooResponse;
    try {
      body = (await res.json()) as YahooResponse;
    } catch {
      throw new MarketDataError(
        'PROVIDER',
        res.ok ? 'Yahoo Finance returned an unexpected (non-JSON) response' : `Yahoo Finance refused the request (HTTP ${res.status}); the endpoint may be blocked from this network. Use CSV import meanwhile.`,
      );
    }
    const err = body?.chart?.error;
    if (err) {
      const code = /not found/i.test(err.code ?? '') || /no data/i.test(err.description ?? '') ? 'NOT_FOUND' : 'PROVIDER';
      throw new MarketDataError(code, `Yahoo Finance: ${err.description ?? err.code ?? 'unknown error'} (${symbol})`);
    }
    if (!res.ok) throw new MarketDataError('PROVIDER', `Yahoo Finance HTTP ${res.status}`);
    const result = body?.chart?.result?.[0];
    if (!result || !result.meta) throw new MarketDataError('PROVIDER', 'Unexpected Yahoo Finance response shape');
    return result;
  }

  async getQuote(symbol: string): Promise<ProviderQuote> {
    const r = await this.call(symbol, { range: '5d', interval: '1d' });
    const price = r.meta.regularMarketPrice;
    const time = r.meta.regularMarketTime;
    if (typeof price !== 'number' || !Number.isFinite(price)) throw new MarketDataError('PROVIDER', 'Yahoo Finance response has no price');
    return {
      price,
      currency: r.meta.currency ?? null,
      asOf: typeof time === 'number' ? new Date(time * 1000).toISOString() : new Date().toISOString(),
    };
  }

  async getHistoricalPrices(symbol: string, startDate: string, endDate: string): Promise<Bar[]> {
    const p1 = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
    const p2 = Math.floor(Date.parse(`${endDate}T00:00:00Z`) / 1000) + 86_400;
    const r = await this.call(symbol, { period1: String(p1), period2: String(p2), interval: '1d', includeAdjustedClose: 'true', events: 'div,split' });
    return parseYahooBars(r);
  }
}

interface YahooResult {
  meta: { currency?: string; regularMarketPrice?: number; regularMarketTime?: number; gmtoffset?: number };
  timestamp?: number[];
  indicators?: {
    quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[];
    adjclose?: { adjclose?: (number | null)[] }[];
  };
}
interface YahooResponse {
  chart?: { result?: YahooResult[] | null; error?: { code?: string; description?: string } | null };
}

export function parseYahooBars(r: YahooResult): Bar[] {
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const adj = r.indicators?.adjclose?.[0]?.adjclose ?? [];
  const offset = r.meta.gmtoffset ?? 0;
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if ([o, h, l, c].some((x) => typeof x !== 'number' || !Number.isFinite(x))) continue;
    const date = new Date((ts[i] + offset) * 1000).toISOString().slice(0, 10);
    const bar: Bar = { date, open: o!, high: h!, low: l!, close: c!, volume: q.volume?.[i] ?? 0, adjClose: typeof adj[i] === 'number' ? adj[i] : null };
    if (out.length && out[out.length - 1].date === date) out[out.length - 1] = bar;
    else out.push(bar);
  }
  return out;
}
