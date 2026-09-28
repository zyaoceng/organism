import { describe, expect, it } from 'vitest';
import { FinMindProvider } from './finmind';
import { FugleProvider } from './fugle';
import { taiwanCode } from './http';
import { MarketDataError } from './provider';
import { finmindBoard, parseIsinPage, SymbolSearch, type TaiwanEntry } from './symbols';
import { YahooChartProvider, yahooCandidates } from './yahoo';

type Handler = (url: URL, init?: RequestInit) => { status?: number; json: unknown };
function fakeFetch(handler: Handler) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

const yahooChart = (closes: number[]) => ({
  chart: {
    result: [
      {
        meta: { currency: 'TWD', regularMarketPrice: closes.at(-1), regularMarketTime: 1790000000, gmtoffset: 28800 },
        timestamp: closes.map((_, i) => 1790000000 + i * 86400),
        indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1000) }] },
      },
    ],
    error: null,
  },
});

describe('Taiwan symbols', () => {
  it('strips Yahoo suffixes and rejects non-Taiwan symbols', () => {
    expect(taiwanCode('7899.TWO')).toBe('7899');
    expect(taiwanCode('2330.tw')).toBe('2330');
    expect(taiwanCode('00632R')).toBe('00632R');
    expect(taiwanCode('NVDA')).toBeNull();
  });

  it('tries both .TW and .TWO for Taiwan codes', () => {
    expect(yahooCandidates('7899.TW')).toEqual(['7899.TW', '7899.TWO']);
    expect(yahooCandidates('7899.TWO')).toEqual(['7899.TWO', '7899.TW']);
    expect(yahooCandidates('7899')).toEqual(['7899.TW', '7899.TWO']);
    expect(yahooCandidates('aapl')).toEqual(['AAPL']);
  });
});

describe('YahooChartProvider', () => {
  it('falls back from .TW to .TWO when the first symbol is not found', async () => {
    const { f, calls } = fakeFetch((url) =>
      url.pathname.endsWith('7899.TW') ? { status: 404, json: { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } } } : { json: yahooChart([400, 410]) },
    );
    const y = new YahooChartProvider(f);
    const q = await y.getQuote('7899.TW');
    expect(q.price).toBe(410);
    expect(calls.map((c) => decodeURIComponent(c.url.pathname.split('/').at(-1)!))).toEqual(['7899.TW', '7899.TWO']);
    const bars = await y.getHistoricalPrices('7899.TW', '2026-09-01', '2026-09-28');
    expect(bars).toHaveLength(2);
  });

  it('explains both tried symbols when neither exists', async () => {
    const { f } = fakeFetch(() => ({ status: 404, json: { chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } } }));
    await expect(new YahooChartProvider(f).getQuote('9999')).rejects.toThrow(/9999\.TW or 9999\.TWO/);
  });

  it('does not retry on other errors', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 429, json: {} }));
    await expect(new YahooChartProvider(f).getQuote('2330.TW')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toHaveLength(1);
  });
});

describe('FinMindProvider', () => {
  const today = () => '2026-09-28';

  it('reads TaiwanStockPrice, strips the suffix, skips days without trades and sends the token', async () => {
    const { f, calls } = fakeFetch(() => ({
      json: {
        msg: 'success',
        status: 200,
        data: [
          { date: '2026-09-25', stock_id: '7899', Trading_Volume: 12000, open: 401, max: 420, min: 398, close: 415 },
          { date: '2026-09-24', stock_id: '7899', Trading_Volume: 0, open: 0, max: 0, min: 0, close: 0 },
          { date: '2026-09-23', stock_id: '7899', Trading_Volume: 9000, open: 390, max: 402, min: 385, close: 400 },
        ],
      },
    }));
    const p = new FinMindProvider(f, 'tok', undefined, today);
    const bars = await p.getHistoricalPrices('7899.TWO', '2026-09-01', '2026-09-28');
    expect(bars.map((b) => [b.date, b.high, b.low, b.close, b.volume])).toEqual([
      ['2026-09-23', 402, 385, 400, 9000],
      ['2026-09-25', 420, 398, 415, 12000],
    ]);
    expect(calls[0].url.searchParams.get('dataset')).toBe('TaiwanStockPrice');
    expect(calls[0].url.searchParams.get('data_id')).toBe('7899');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    const q = await p.getQuote('7899');
    expect(q).toMatchObject({ price: 415, currency: 'TWD' });
  });

  it('maps the request limit and unknown codes to typed errors', async () => {
    const limited = fakeFetch(() => ({ status: 402, json: { msg: 'Requests reach the upper limit.', status: 402 } }));
    await expect(new FinMindProvider(limited.f, '', undefined, today).getQuote('2330')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const empty = fakeFetch(() => ({ json: { msg: 'success', status: 200, data: [] } }));
    await expect(new FinMindProvider(empty.f, '', undefined, today).getQuote('9998')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(new FinMindProvider(empty.f, '', undefined, today).getQuote('NVDA')).rejects.toBeInstanceOf(MarketDataError);
  });
});

describe('FugleProvider', () => {
  it('sends the API key, reads the quote and requests candles one year at a time', async () => {
    const { f, calls } = fakeFetch((url) =>
      url.pathname.includes('/intraday/quote/')
        ? { json: { symbol: '2330', lastPrice: 1234.5, lastUpdated: 1790000000000000 } }
        : { json: { symbol: '2330', data: [{ date: url.searchParams.get('from'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] } },
    );
    const p = new FugleProvider('key', f);
    expect((await p.getQuote('2330.TW')).price).toBe(1234.5);
    const bars = await p.getHistoricalPrices('2330.TW', '2024-01-01', '2026-09-28');
    expect(calls[0].headers['X-API-KEY']).toBe('key');
    const candleCalls = calls.filter((c) => c.url.pathname.includes('/historical/candles/2330'));
    expect(candleCalls.map((c) => [c.url.searchParams.get('from'), c.url.searchParams.get('to')])).toEqual([
      ['2024-01-01', '2024-12-30'],
      ['2024-12-31', '2025-12-30'],
      ['2025-12-31', '2026-09-28'],
    ]);
    expect(bars).toHaveLength(3);
  });

  it('reports a rejected key clearly', async () => {
    const { f } = fakeFetch(() => ({ status: 401, json: { message: 'Unauthorized' } }));
    await expect(new FugleProvider('bad', f).getQuote('2330')).rejects.toThrow(/FUGLE_API_KEY/);
  });
});

describe('symbol search', () => {
  const directory: TaiwanEntry[] = [
    { code: '2330', name: '台積電', board: 'listed', industry: '半導體業' },
    { code: '2301', name: '光寶科', board: 'listed' },
    { code: '7899', name: '景美', board: 'emerging', industry: '半導體業' },
    { code: '3105', name: '穩懋', board: 'otc' },
  ];

  it('finds Taiwan stocks by code or Chinese name with the right suffix and source', async () => {
    const s = new SymbolSearch({ taiwanDirectory: async () => directory, yahooSearch: async () => [] });
    const byCode = await s.search('7899');
    expect(byCode.results[0]).toMatchObject({ ticker: '7899', name: '景美', exchange: 'Emerging', board: 'emerging', apiSymbol: '7899.TWO', suggestedProvider: 'finmind', currency: 'TWD' });
    expect((await s.search('景美')).results[0].ticker).toBe('7899');
    expect((await s.search('穩懋')).results[0]).toMatchObject({ apiSymbol: '3105.TWO', exchange: 'TPEx' });
    expect((await s.search('23')).results.map((r) => r.ticker)).toEqual(['2301', '2330']);
  });

  it('uses Yahoo for English names and US tickers', async () => {
    const s = new SymbolSearch({
      taiwanDirectory: async () => directory,
      yahooSearch: async () => [
        { symbol: 'NVDA', longname: 'NVIDIA Corporation', exchange: 'NMS', quoteType: 'EQUITY' },
        { symbol: '2330.TW', shortname: 'TAIWAN SEMICONDUCTOR MANUFACTURING', exchange: 'TAI', quoteType: 'EQUITY' },
      ],
    });
    const r = await s.search('nvidia');
    expect(r.results[0]).toMatchObject({ ticker: 'NVDA', exchange: 'NASDAQ', currency: 'USD', apiSymbol: 'NVDA', suggestedProvider: 'yahoo' });
    expect(r.results[1]).toMatchObject({ ticker: '2330', exchange: 'TWSE', apiSymbol: '2330.TW' });
  });

  it('falls back to Yahoo when the Taiwan list is unavailable, and reports the failure', async () => {
    let loads = 0;
    const s = new SymbolSearch({
      taiwanDirectory: async () => {
        loads++;
        throw new Error('blocked');
      },
      yahooSearch: async () => [{ symbol: '7899.TWO', shortname: 'JINGMEI', exchange: 'TWO', quoteType: 'EQUITY' }],
    });
    const r = await s.search('7899');
    expect(r.results[0]).toMatchObject({ ticker: '7899', apiSymbol: '7899.TWO' });
    expect(r.errors[0]).toMatch(/blocked/);
    await s.search('2330');
    expect(loads).toBe(1);
  });

  it('parses the TWSE ISIN list and maps FinMind board types', () => {
    const html = `<table><tr><td bgcolor=#FAFAD2>7899　景美</td><td bgcolor=#FAFAD2>TW0007899008</td><td bgcolor=#FAFAD2>2026/02/24</td><td bgcolor=#FAFAD2>興櫃</td><td bgcolor=#FAFAD2>半導體業</td><td>ESVUFR</td><td></td></tr>
      <tr><td bgcolor=#FAFAD2>030001　某權證</td><td>TW13Z0000001</td><td>2026/01/01</td><td>上市</td><td></td><td>RWSCCE</td><td></td></tr></table>`;
    expect(parseIsinPage(html, 'emerging')).toEqual([{ code: '7899', name: '景美', board: 'emerging', industry: '半導體業' }]);
    expect(finmindBoard('twse')).toBe('listed');
    expect(finmindBoard('tpex')).toBe('otc');
    expect(finmindBoard('emerging')).toBe('emerging');
    expect(finmindBoard('index')).toBeNull();
  });
});
