import type { Bar } from '../../domain/market/indicators';
import type { MarketDataProvider, ProviderQuote } from './provider';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * SYNTHETIC prices: a seeded random walk per symbol on weekdays since 2023-01-02. For offline
 * development and demos only; the UI labels it as synthetic everywhere it is shown.
 */
export class DemoProvider implements MarketDataProvider {
  id = 'demo';
  label = 'Demo (synthetic)';
  description = 'Generated random-walk prices for offline use. Not real market data.';
  synthetic = true;
  fetches = true;

  constructor(private readonly today: () => string = () => iso(new Date())) {}

  series(symbol: string): Bar[] {
    const rand = rng(hash(symbol));
    const bars: Bar[] = [];
    let price = 50 + rand() * 250;
    const end = this.today();
    for (let d = new Date('2023-01-02T00:00:00Z'); iso(d) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const drift = 0.0004;
      const vol = 0.018;
      const ret = drift + vol * (rand() + rand() + rand() - 1.5) * 1.4;
      const open = price;
      const close = Math.max(1, price * (1 + ret));
      const high = Math.max(open, close) * (1 + rand() * 0.012);
      const low = Math.min(open, close) * (1 - rand() * 0.012);
      const volume = Math.round(2e6 * (0.5 + rand()) * (1 + Math.abs(ret) * 20));
      const r2 = (x: number) => Math.round(x * 100) / 100;
      bars.push({ date: iso(d), open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume, adjClose: r2(close) });
      price = close;
    }
    return bars;
  }

  async getQuote(symbol: string): Promise<ProviderQuote> {
    const last = this.series(symbol).at(-1);
    if (!last) throw new Error('No demo data');
    return { price: last.close, currency: null, asOf: `${last.date}T13:30:00.000Z` };
  }

  async getHistoricalPrices(symbol: string, startDate: string, endDate: string): Promise<Bar[]> {
    return this.series(symbol).filter((b) => b.date >= startDate && b.date <= endDate);
  }
}
