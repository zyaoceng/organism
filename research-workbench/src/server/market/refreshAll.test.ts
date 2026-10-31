import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bar } from '../../domain/market/indicators';
import { openDatabase, type DB } from '../db/connection';
import type { MarketDataProvider, ProviderQuote } from './provider';
import { PriceRefresher, SHUTDOWN_MESSAGE } from './refreshAll';
import { MarketService } from './service';

/** Each history call waits `delayMs`; `hang` never answers. */
class SlowProvider implements MarketDataProvider {
  id = 'slow';
  label = 'Slow';
  description = 'test';
  synthetic = false;
  fetches = true;
  calls = 0;
  constructor(
    private readonly delayMs: number,
    private readonly hang = false,
  ) {}
  async getQuote(): Promise<ProviderQuote> {
    throw new Error('not used');
  }
  async getHistoricalPrices(): Promise<Bar[]> {
    this.calls++;
    if (this.hang) return new Promise<Bar[]>(() => {});
    await new Promise((r) => setTimeout(r, this.delayMs));
    return [{ date: '2026-10-29', open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  }
}

let db: DB;

function seed(n: number) {
  for (let i = 1; i <= n; i++) {
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(`p${i}`, `P${i}`, '2026-10-01', `2026-10-0${i}`);
    db.prepare("INSERT INTO securities (id, project_id, name, ticker, exchange, api_symbol, currency, price_source) VALUES (?, ?, 'x', ?, 'TWSE', ?, 'TWD', 'slow')").run(`s${i}`, `p${i}`, `T${i}`, `T${i}`);
  }
}

beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => db.close());

describe('PriceRefresher shutdown', () => {
  it('finishes the call in flight and skips the rest as cancelled', async () => {
    seed(3);
    const slow = new SlowProvider(40);
    const r = new PriceRefresher(db, new MarketService(db, { slow }, { minIntervalMs: 0 }));
    const run = r.start();
    expect(run.items.map((i) => i.ticker)).toEqual(['T3', 'T2', 'T1']); // most recently updated first
    await new Promise((res) => setTimeout(res, 10));
    await r.stop(1000);
    const done = r.status()!;
    expect(done.state).toBe('cancelled');
    expect(done.items.map((i) => i.status)).toEqual(['ok', 'skipped', 'skipped']);
    expect(done.items[1].message).toBe(SHUTDOWN_MESSAGE);
    expect(slow.calls).toBe(1);
    expect(() => r.start()).toThrow(/shutting down/);
  });

  it('waits at most the grace period for a call that never answers', async () => {
    seed(1);
    const r = new PriceRefresher(db, new MarketService(db, { slow: new SlowProvider(0, true) }, { minIntervalMs: 0 }));
    r.start();
    const t0 = Date.now();
    await r.stop(50);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a second start while running returns the same run; status is a copy', async () => {
    seed(2);
    const r = new PriceRefresher(db, new MarketService(db, { slow: new SlowProvider(20) }, { minIntervalMs: 0 }));
    expect(r.status()).toBeNull();
    const a = r.start();
    expect(r.start().id).toBe(a.id);
    a.items[0].status = 'failed';
    expect(r.status()!.items[0].status).not.toBe('failed');
    await r.idle();
    expect(r.status()).toMatchObject({ state: 'done', ok: 2, pending: 0 });
    // a new run after the last one finished
    expect(r.start().id).not.toBe(a.id);
    await r.idle();
  });
});
