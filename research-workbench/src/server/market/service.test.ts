import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bar } from '../../domain/market/indicators';
import type { SecurityDTO } from '../../shared/api';
import { openDatabase, type DB } from '../db/connection';
import { getQuote, saveQuote } from '../repos/market';
import { CsvProvider } from './csv';
import { MarketDataError, type MarketDataProvider, type ProviderQuote } from './provider';
import { MarketService } from './service';

const BARS: Bar[] = [
  { date: '2026-10-28', open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
  { date: '2026-10-29', open: 10.5, high: 12, low: 10, close: 11.5, volume: 100 },
];

/** Records when each call starts. */
class RecordingProvider implements MarketDataProvider {
  label: string;
  description = 'test';
  fetches = true;
  starts: number[] = [];
  historyCalls = 0;
  constructor(
    public id: string,
    public synthetic = false,
    private readonly fail?: MarketDataError,
  ) {
    this.label = `Label ${id}`;
  }
  async getQuote(): Promise<ProviderQuote> {
    this.starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 5));
    return { price: 42, currency: null, asOf: '2026-10-29T05:30:00.000Z' };
  }
  async getHistoricalPrices(_s: string, start: string, end: string): Promise<Bar[]> {
    this.starts.push(Date.now());
    this.historyCalls++;
    if (this.fail) throw this.fail;
    return BARS.filter((b) => b.date >= start && b.date <= end);
  }
}

let db: DB;
const sec = (id: string, priceSource: string): SecurityDTO => ({ id, projectId: 'p1', name: id, ticker: id, exchange: 'TWSE', apiSymbol: id, currency: 'TWD', priceSource, isPrimary: true });

function service(providers: MarketDataProvider[], opts: ConstructorParameters<typeof MarketService>[2] = {}) {
  for (const p of providers) {
    db.prepare("INSERT OR IGNORE INTO securities (id, project_id, name, ticker, exchange, api_symbol, currency, price_source) VALUES (?, 'p1', ?, ?, 'TWSE', ?, 'TWD', ?)").run(
      `s_${p.id}`,
      p.id,
      p.id,
      p.id,
      p.id,
    );
  }
  return new MarketService(db, Object.fromEntries(providers.map((p) => [p.id, p])), opts);
}

const gaps = (ts: number[]) => {
  const s = [...ts].sort((a, b) => a - b);
  return s.slice(1).map((t, i) => t - s[i]);
};

beforeEach(() => {
  db = openDatabase(':memory:');
  db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', '2026-10-01', '2026-10-01')").run();
});
afterEach(() => db.close());

describe('market service throttle', () => {
  it('gives concurrent callers of one provider successive slots', async () => {
    const rec = new RecordingProvider('rec');
    const m = service([rec], { minIntervalMs: 60 });
    await Promise.all([1, 2, 3, 4].map(() => m.quote(sec('s_rec', 'rec'), 'rec', true)));
    expect(rec.starts).toHaveLength(4);
    for (const g of gaps(rec.starts)) expect(g).toBeGreaterThanOrEqual(55);
  });

  it('does not serialise two providers against each other', async () => {
    const a = new RecordingProvider('rec');
    const b = new RecordingProvider('rec2');
    const m = service([a, b], { minIntervalMs: 150 });
    await Promise.all([m.quote(sec('s_rec', 'rec'), 'rec', true), m.quote(sec('s_rec', 'rec'), 'rec', true), m.quote(sec('s_rec2', 'rec2'), 'rec2', true)]);
    expect(a.starts[1] - a.starts[0]).toBeGreaterThanOrEqual(145);
    expect(Math.abs(b.starts[0] - a.starts[0])).toBeLessThan(100);
  });

  it('does not delay a synthetic provider', async () => {
    const syn = new RecordingProvider('syn', true);
    const m = service([syn], { minIntervalMs: 500 });
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => m.quote(sec('s_syn', 'syn'), 'syn', true)));
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it('uses a per-provider interval over the default', async () => {
    const rec = new RecordingProvider('rec');
    const m = service([rec], { minIntervalMs: 0, providerIntervalMs: { rec: 80 } });
    await Promise.all([1, 2].map(() => m.quote(sec('s_rec', 'rec'), 'rec', true)));
    expect(rec.starts[1] - rec.starts[0]).toBeGreaterThanOrEqual(75);
  });
});

describe('refreshSecurity', () => {
  it('makes one history call and derives the quote from the last bar', async () => {
    const rec = new RecordingProvider('rec');
    const m = service([rec], { minIntervalMs: 0 });
    const out = await m.refreshSecurity(sec('s_rec', 'rec'));
    expect(out).toEqual({ status: 'ok', lastDate: '2026-10-29' });
    expect(rec.historyCalls).toBe(1);
    expect(rec.starts).toHaveLength(1);
    expect(getQuote(db, 's_rec', 'rec')).toMatchObject({ price: 11.5, currency: 'TWD', asOf: '2026-10-29T00:00:00.000Z', provider: 'rec' });
  });

  it('never replaces a quote from a later day', async () => {
    const rec = new RecordingProvider('rec');
    const m = service([rec], { minIntervalMs: 0 });
    saveQuote(db, 's_rec', { price: 99, currency: 'TWD', asOf: '2026-10-30T05:30:00.000Z', provider: 'rec', fetchedAt: '2026-10-30T05:31:00.000Z' });
    expect((await m.refreshSecurity(sec('s_rec', 'rec'))).status).toBe('ok');
    expect(getQuote(db, 's_rec', 'rec')?.price).toBe(99);
    // a quote from an earlier day is replaced
    saveQuote(db, 's_rec', { price: 98, currency: 'TWD', asOf: '2026-10-27T05:30:00.000Z', provider: 'rec', fetchedAt: '2026-10-27T05:31:00.000Z' });
    await m.refreshSecurity(sec('s_rec', 'rec'));
    expect(getQuote(db, 's_rec', 'rec')?.price).toBe(11.5);
  });

  it('skips CSV and unknown sources, and maps provider errors', async () => {
    const limited = new RecordingProvider('lim', false, new MarketDataError('RATE_LIMITED', 'Too many requests', 60));
    const offline = new RecordingProvider('off', false, new MarketDataError('NETWORK', 'Could not reach X: timeout'));
    const m = service([new CsvProvider(), limited, offline], { minIntervalMs: 0 });
    expect(await m.refreshSecurity(sec('s_csv', 'csv'))).toEqual({ status: 'skipped', message: 'Imported prices only (CSV)' });
    expect(await m.refreshSecurity(sec('s_csv', 'fugle'))).toEqual({ status: 'skipped', message: 'Unknown price source "fugle"' });
    expect(await m.refreshSecurity(sec('s_lim', 'lim'))).toEqual({ status: 'rate_limited', code: 'RATE_LIMITED', message: 'Too many requests', retryAfterSec: 60 });
    expect(await m.refreshSecurity(sec('s_off', 'off'))).toEqual({ status: 'failed', code: 'NETWORK', message: 'Could not reach X: timeout' });
    expect(getQuote(db, 's_lim', 'lim')).toBeNull();
  });

  it('reports the providers it knows', () => {
    const m = service([new CsvProvider(), new RecordingProvider('syn', true), new RecordingProvider('rec')]);
    expect(m.providerInfo('rec')?.label).toBe('Label rec');
    expect(m.providerInfo('nope')).toBeNull();
    expect([...m.syntheticIds()]).toEqual(['syn']);
    expect(m.staleAfterMs).toBe(24 * 3600_000);
  });
});
