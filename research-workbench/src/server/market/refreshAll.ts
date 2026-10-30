/**
 * "Update all prices": one background run over every company's primary security (and any security
 * with an open trade). Each provider's securities are refreshed one after another; providers run
 * side by side, so a slow or blocked source does not hold up the others. Progress is kept in
 * memory only (the per-call log is market_fetch_log); a restart forgets the last run.
 */
import type { RefreshItemDTO, RefreshProviderDTO, RefreshRunDTO, SecurityDTO } from '../../shared/api';
import { runAs } from '../actor';
import type { DB } from '../db/connection';
import { refreshTargets } from '../repos/portfolio';
import { HttpError, newId, nowIso } from '../util';
import type { MarketService, RefreshOutcome } from './service';

/** Consecutive network failures after which a provider is treated as unreachable (offline Mac). */
const MAX_NETWORK_FAILURES = 3;

export const SHUTDOWN_MESSAGE = 'Not updated: the server shut down';

interface Job {
  security: SecurityDTO;
  item: RefreshItemDTO;
}

export class PriceRefresher {
  private run: RefreshRunDTO | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
    private readonly opts: { onError?: (err: unknown) => void } = {},
  ) {}

  /** Start a run, or return the one already running. */
  start(): RefreshRunDTO {
    if (this.stopped) throw new HttpError(503, 'The server is shutting down', { code: 'SHUTTING_DOWN' });
    if (this.run?.state === 'running') return this.status()!;
    const jobs: Job[] = refreshTargets(this.db).map((s) => ({
      security: s,
      item: { securityId: s.id, projectId: s.projectId, projectName: s.projectName, ticker: s.ticker, provider: s.priceSource, status: 'pending', message: null, lastDate: null },
    }));
    const byProvider = new Map<string, Job[]>();
    for (const j of jobs) byProvider.set(j.security.priceSource, [...(byProvider.get(j.security.priceSource) ?? []), j]);
    const run: RefreshRunDTO = {
      id: newId('rfr'),
      state: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      total: jobs.length,
      ok: 0,
      failed: 0,
      rateLimited: 0,
      skipped: 0,
      pending: jobs.length,
      providers: [...byProvider].map(([id, list]) => ({ id, label: this.market.providerInfo(id)?.label ?? id, total: list.length, state: 'running', retryAfterSec: null, message: null })),
      items: jobs.map((j) => j.item),
    };
    this.run = run;
    // background work is the system's, not the requester's
    this.loop = runAs('system', () => this.execute(run, byProvider)).catch((err) => this.opts.onError?.(err));
    return this.status()!;
  }

  /** A copy of the current or last run; null before the first one. */
  status(): RefreshRunDTO | null {
    return this.run ? structuredClone(this.run) : null;
  }

  /** Resolves when no run is in progress. */
  idle(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  /** Refuse new runs and wait (at most graceMs) for the call in flight; the rest is skipped. */
  async stop(graceMs = 3000): Promise<void> {
    this.stopped = true;
    if (!this.loop) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.loop, new Promise<void>((r) => (timer = setTimeout(r, graceMs)))]);
    clearTimeout(timer);
  }

  private async execute(run: RefreshRunDTO, byProvider: Map<string, Job[]>): Promise<void> {
    try {
      await Promise.all(run.providers.map((p) => this.runProvider(run, p, byProvider.get(p.id) ?? [])));
    } finally {
      for (const item of run.items) if (item.status === 'pending' || item.status === 'running') this.finish(item, 'skipped', SHUTDOWN_MESSAGE);
      for (const p of run.providers) if (p.state === 'running') p.state = 'done';
      run.state = this.stopped ? 'cancelled' : 'done';
      run.finishedAt = nowIso();
      recount(run);
    }
  }

  private async runProvider(run: RefreshRunDTO, p: RefreshProviderDTO, jobs: Job[]): Promise<void> {
    if (!this.market.providerInfo(p.id)) {
      p.state = 'unavailable';
      p.message = `Unknown price source "${p.id}"`;
      for (const j of jobs) this.finish(j.item, 'skipped', p.message);
      recount(run);
      return;
    }
    let networkFailures = 0;
    for (let i = 0; i < jobs.length; i++) {
      if (this.stopped) return;
      const { security, item } = jobs[i];
      item.status = 'running';
      let out: RefreshOutcome;
      try {
        out = await this.market.refreshSecurity(security);
      } catch (e) {
        // e.g. the database was closed under a call that outlived the shutdown grace
        out = { status: 'failed', code: 'ERROR', message: (e as Error).message };
      }
      if (this.stopped && out.status === 'failed') out = { status: 'skipped', message: SHUTDOWN_MESSAGE };
      if (out.status === 'ok') {
        this.finish(item, 'ok', null);
        item.lastDate = out.lastDate;
      } else {
        this.finish(item, out.status, out.message);
      }
      networkFailures = out.status === 'failed' && out.code === 'NETWORK' ? networkFailures + 1 : 0;
      const rest = jobs.slice(i + 1);
      if (out.status === 'rate_limited') {
        p.state = 'rate_limited';
        p.retryAfterSec = out.retryAfterSec ?? null;
        p.message = out.message;
        for (const j of rest) this.finish(j.item, 'skipped', `Not updated: ${p.label} rate limit reached`);
      } else if (networkFailures >= MAX_NETWORK_FAILURES) {
        p.state = 'unreachable';
        p.message = out.status === 'failed' ? out.message : null;
        for (const j of rest) this.finish(j.item, 'skipped', `Not updated: ${p.label} could not be reached`);
      }
      recount(run);
      if (p.state !== 'running') return;
    }
    p.state = 'done';
  }

  private finish(item: RefreshItemDTO, status: RefreshItemDTO['status'], message: string | null) {
    item.status = status;
    item.message = message;
  }
}

function recount(run: RefreshRunDTO) {
  const n = (s: RefreshItemDTO['status']) => run.items.filter((i) => i.status === s).length;
  run.ok = n('ok');
  run.failed = n('failed');
  run.rateLimited = n('rate_limited');
  run.skipped = n('skipped');
  run.pending = n('pending') + n('running');
}
