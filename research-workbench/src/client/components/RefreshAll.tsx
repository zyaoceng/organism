import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefreshRunDTO } from '../../shared/api';
import { api } from '../lib/api';
import { t, tm } from '../lib/i18n';
import { useWorkspace } from '../lib/store';
import { fmtDateTime, today } from '../lib/util';

const POLL_MS = 1000;

export interface RefreshRun {
  run: RefreshRunDTO | null;
  running: boolean;
  start: () => Promise<void>;
}

/** The time of today's run; date and time of an older one (the server keeps the last run until it restarts). */
function when(iso: string): string {
  const s = fmtDateTime(iso);
  return s.slice(0, 10) === today() ? s.slice(11) : s;
}

const summaryText = (r: RefreshRunDTO) =>
  t('Prices updated {time}: {ok} ok, {failed} failed, {skipped} skipped', { time: when(r.finishedAt ?? r.startedAt), ok: r.ok, failed: r.failed + r.rateLimited, skipped: r.skipped });

/**
 * "Update all prices": the server refreshes every company in the background; this polls its
 * progress once a second until the run ends. A run started elsewhere (another window, or before a
 * reload) is picked up from `initial`. A restarted server forgets its runs (GET returns null).
 */
export function useRefreshRun(initial: RefreshRunDTO | null | undefined, onFinished: () => void): RefreshRun {
  const [run, setRun] = useState<RefreshRunDTO | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const end = useCallback((r: RefreshRunDTO | null) => {
    finished.current();
    if (r) useWorkspace.getState().toast(summaryText(r), r.failed + r.rateLimited > 0 || r.state === 'cancelled' ? 'error' : 'success');
  }, []);

  const poll = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      let r: RefreshRunDTO | null;
      try {
        r = await api.refreshStatus();
      } catch (e) {
        if (!alive.current) return;
        // the server went away: stop polling; the next page load shows whatever it finished
        setRun(null);
        useWorkspace.getState().toast(tm((e as Error).message), 'error');
        return;
      }
      if (!alive.current) return;
      setRun(r);
      if (r?.state === 'running') poll();
      else end(r);
    }, POLL_MS);
  }, [end]);

  useEffect(() => {
    if (!initial) return;
    if (initial.state === 'running') {
      if (!timer.current) {
        setRun(initial);
        poll();
      }
    } else setRun((cur) => (cur?.state === 'running' ? cur : initial));
  }, [initial, poll]);

  const start = async () => {
    try {
      const r = await api.startRefresh();
      setRun(r);
      if (r.state === 'running') poll();
      else end(r);
    } catch (e) {
      useWorkspace.getState().toast(tm((e as Error).message), 'error');
    }
  };

  return { run, running: run?.state === 'running', start };
}

export function RefreshAllButton({ refresh }: { refresh: RefreshRun }) {
  return (
    <button className="btn" disabled={refresh.running} onClick={() => void refresh.start()} data-testid="refresh-all" title={t('Fetch the latest daily prices for every company')}>
      {refresh.running ? t('Updating…') : t('Update all prices')}
    </button>
  );
}

/** Progress, then the result: counts, why a source stopped, and the securities that were not updated. */
export function RefreshStatus({ run }: { run: RefreshRunDTO | null }) {
  if (!run) return <div data-testid="refresh-status" data-state="none" />;
  const notUpdated = run.items.filter((i) => i.status === 'failed' || i.status === 'rate_limited' || i.status === 'skipped');
  const providerLines = run.providers.flatMap((p) => {
    const n = run.items.filter((i) => i.provider === p.id && i.status !== 'ok').length;
    const provider = t(p.label);
    if (p.state === 'rate_limited')
      return [
        p.retryAfterSec
          ? t('{provider} rate limit reached; {n} not updated. Try again in about {sec} s.', { provider, n, sec: p.retryAfterSec })
          : t('{provider} rate limit reached; {n} not updated. Try again later.', { provider, n }),
      ];
    if (p.state === 'unreachable') return [t('{provider} could not be reached; {n} not updated.', { provider, n })];
    return [];
  });
  return (
    <div className="refresh-status small" data-testid="refresh-status" data-state={run.state}>
      {run.state === 'running' ? (
        <span className="sub">{t('Updating prices {done}/{total}…', { done: run.total - run.pending, total: run.total })}</span>
      ) : (
        <span className="sub">{summaryText(run)}</span>
      )}
      {run.state === 'cancelled' && <span className="msg warn">{t('The update stopped because the server shut down.')}</span>}
      {providerLines.map((l) => (
        <span key={l} className="msg warn">
          {l}
        </span>
      ))}
      {run.state !== 'running' && notUpdated.length > 0 && (
        <details>
          <summary>{t('Show failures')}</summary>
          <ul className="refresh-failures">
            {notUpdated.map((i) => (
              <li key={i.securityId}>
                <b>{i.projectName}</b> {i.ticker}
                {i.message && ` · ${tm(i.message)}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
