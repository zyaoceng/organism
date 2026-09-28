import type { Bar } from '../../domain/market/indicators';
import { addDays, localToday } from '../util';
import { getJson, taiwanCode } from './http';
import { MarketDataError, type MarketDataProvider, type ProviderQuote } from './provider';

interface FinMindResponse<T> {
  msg?: string;
  status?: number;
  data?: T[];
}
interface FinMindPrice {
  date: string;
  stock_id: string;
  Trading_Volume?: number;
  open: number;
  max: number;
  min: number;
  close: number;
}
export interface FinMindStockInfo {
  industry_category?: string;
  stock_id: string;
  stock_name: string;
  type?: string;
  date?: string;
}

/**
 * FinMind open data API (https://finmind.github.io), v4 `/api/v4/data`.
 * Covers Taiwan listed (上市), OTC (上櫃) and emerging (興櫃) stocks with daily OHLCV.
 * Works without a key at a lower hourly limit; set FINMIND_TOKEN for more requests.
 *
 * ENGINEERING ASSUMPTION — the dataset names and fields (TaiwanStockPrice: date, open, max, min,
 * close, Trading_Volume; TaiwanStockInfo: stock_id, stock_name, type) follow FinMind's
 * documentation; they could not be exercised from the build environment (egress blocked).
 */
export class FinMindProvider implements MarketDataProvider {
  id = 'finmind';
  label = 'FinMind (Taiwan listed, OTC and emerging)';
  description =
    'Free Taiwan stock data covering 上市, 上櫃 and 興櫃. Daily prices; the quote is the latest daily close. Optional FINMIND_TOKEN raises the request limit.';
  synthetic = false;
  fetches = true;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly token = process.env.FINMIND_TOKEN ?? '',
    private readonly baseUrl = 'https://api.finmindtrade.com/api/v4/data',
    private readonly today: () => string = localToday,
  ) {}

  async data<T>(params: Record<string, string>): Promise<T[]> {
    const url = `${this.baseUrl}?${new URLSearchParams(params).toString()}`;
    const headers: Record<string, string> = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    const { status, body } = await getJson<FinMindResponse<T>>(this.fetchImpl, 'FinMind', url, headers);
    const code = body.status ?? status;
    if (code === 402 || /upper limit/i.test(body.msg ?? '')) {
      throw new MarketDataError('RATE_LIMITED', 'FinMind request limit reached. Wait an hour or set FINMIND_TOKEN.');
    }
    if (code !== 200) throw new MarketDataError('PROVIDER', `FinMind: ${body.msg ?? `HTTP ${status}`}`);
    return body.data ?? [];
  }

  private code(symbol: string): string {
    const c = taiwanCode(symbol);
    if (!c) throw new MarketDataError('NOT_FOUND', `FinMind only covers Taiwan stocks; "${symbol}" is not a Taiwan stock code`);
    return c;
  }

  async getHistoricalPrices(symbol: string, startDate: string, endDate: string): Promise<Bar[]> {
    const code = this.code(symbol);
    const rows = await this.data<FinMindPrice>({ dataset: 'TaiwanStockPrice', data_id: code, start_date: startDate, end_date: endDate });
    const bars: Bar[] = [];
    for (const r of rows) {
      const vals = [r.open, r.max, r.min, r.close];
      // Days without trades come back as zeros; skip them.
      if (vals.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x <= 0)) continue;
      bars.push({ date: r.date, open: r.open, high: r.max, low: r.min, close: r.close, volume: r.Trading_Volume ?? 0, adjClose: null });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    if (!bars.length && !rows.length) {
      const any = await this.getHistoricalProbe(code);
      if (!any) throw new MarketDataError('NOT_FOUND', `FinMind has no prices for ${code}`);
    }
    return bars;
  }

  /** Distinguish "unknown code" from "no trades in the requested window". */
  private async getHistoricalProbe(code: string): Promise<boolean> {
    const rows = await this.data<FinMindPrice>({ dataset: 'TaiwanStockPrice', data_id: code, start_date: addDays(this.today(), -45), end_date: this.today() });
    return rows.length > 0;
  }

  async getQuote(symbol: string): Promise<ProviderQuote> {
    const code = this.code(symbol);
    const bars = await this.getHistoricalPrices(code, addDays(this.today(), -20), this.today());
    const last = bars.at(-1);
    if (!last) throw new MarketDataError('NOT_FOUND', `FinMind has no recent prices for ${code}`);
    return { price: last.close, currency: 'TWD', asOf: `${last.date}T05:30:00.000Z` };
  }

  stockInfo(): Promise<FinMindStockInfo[]> {
    return this.data<FinMindStockInfo>({ dataset: 'TaiwanStockInfo' });
  }
}
