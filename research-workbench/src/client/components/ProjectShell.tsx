import { useEffect, useMemo, useState } from 'react';
import { formatValue } from '../../domain/format';
import { findByRole } from '../../domain/model/tree';
import { SCALAR_KEY } from '../../domain/model/types';
import { basisPeriodId } from '../../domain/revision/impact';
import { api } from '../lib/api';
import { calcOf, diffOf } from '../lib/derived';
import { href, navigate, TABS, type Tab } from '../lib/router';
import { useActiveState, useWorkspace } from '../lib/store';
import { cls, isTypingTarget, periodLabelFn, timeAgo } from '../lib/util';
import { CatalystsPage } from '../pages/CatalystsPage';
import { EvidencePage } from '../pages/EvidencePage';
import { HistoryPage } from '../pages/HistoryPage';
import { MarketPage } from '../pages/MarketPage';
import { ModelPage } from '../pages/ModelPage';
import { OverviewPage } from '../pages/OverviewPage';
import { TradesPage } from '../pages/TradesPage';
import { ValuationPage } from '../pages/ValuationPage';
import { SearchPalette } from './SearchPalette';
import { ScenarioSwitch } from './ui';

export function ProjectShell({ projectId, tab, param }: { projectId: string; tab: Tab; param?: string }) {
  const load = useWorkspace((s) => s.load);
  const project = useWorkspace((s) => s.project);
  const loadedId = useWorkspace((s) => s.projectId);
  const loading = useWorkspace((s) => s.loading);
  const loadError = useWorkspace((s) => s.loadError);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    void load(projectId);
  }, [projectId, load]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useWorkspace.getState().redo();
        else useWorkspace.getState().undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useWorkspace.getState().redo();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  if (loadError) {
    return (
      <div className="projects">
        <div className="msg err">Could not open the project: {loadError}</div>
        <p>
          <a href="#/">← All companies</a>
        </p>
      </div>
    );
  }
  const ready = project && loadedId === projectId && !loading;
  return (
    <div className="app">
      <Sidebar projectId={projectId} tab={tab} />
      <div className="main">
        {ready ? (
          <>
            <TopBar onSearch={() => setSearchOpen(true)} />
            <ViewingBanner />
            <div className="content" style={tab === 'model' ? { overflow: 'hidden' } : undefined}>
              {tab === 'overview' && <OverviewPage />}
              {tab === 'model' && <ModelPage param={param} />}
              {tab === 'evidence' && <EvidencePage param={param} />}
              {tab === 'valuation' && <ValuationPage />}
              {tab === 'catalysts' && <CatalystsPage />}
              {tab === 'market' && <MarketPage />}
              {tab === 'trades' && <TradesPage />}
              {tab === 'history' && <HistoryPage param={param} />}
            </div>
          </>
        ) : (
          <div className="page sub">Loading…</div>
        )}
      </div>
      {searchOpen && ready && <SearchPalette onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

function Sidebar({ projectId, tab }: { projectId: string; tab: Tab }) {
  const project = useWorkspace((s) => s.project);
  const securities = useWorkspace((s) => s.securities);
  const evidence = useWorkspace((s) => s.evidence);
  const catalysts = useWorkspace((s) => s.catalysts);
  const trades = useWorkspace((s) => s.trades);
  const revisions = useWorkspace((s) => s.revisions);
  const draft = useWorkspace((s) => s.draft);
  const head = useWorkspace((s) => s.head);
  const drafts = draft && head ? diffOf(head.state, draft).length : 0;
  const sec = securities[0];
  const counts: Partial<Record<Tab, string>> = {
    model: drafts ? `${drafts} draft` : '',
    evidence: String(evidence.filter((e) => !e.archivedAt).length || ''),
    catalysts: String(catalysts.filter((c) => c.status === 'upcoming').length || ''),
    trades: String(trades.length || ''),
    history: String(revisions.length || ''),
  };
  return (
    <aside className="sidebar">
      <div className="brand">
        <a href="#/" style={{ color: '#fff' }}>
          Research Workbench
        </a>
        <small>evidence → assumptions → EPS → value</small>
      </div>
      <div className="company">
        <b>{project?.name ?? '…'}</b>
        {sec && (
          <span className="small" style={{ color: '#8b97a5' }}>
            {sec.ticker} · {sec.exchange || '—'} · {sec.currency}
          </span>
        )}
      </div>
      <nav>
        {TABS.map((t) => (
          <a key={t.id} href={href({ page: 'project', projectId, tab: t.id })} className={cls(tab === t.id && 'on')} data-testid={`nav-${t.id}`}>
            {t.label}
            {counts[t.id] && <span className="count">{counts[t.id]}</span>}
          </a>
        ))}
      </nav>
      <div className="foot">
        <a href="#/">← All companies</a>
        <div style={{ marginTop: 6 }}>
          <span className="kbd">Ctrl+K</span> search
        </div>
      </div>
    </aside>
  );
}

function TopBar({ onSearch }: { onSearch: () => void }) {
  const { state } = useActiveState();
  const scenario = useWorkspace((s) => s.scenario);
  const setScenario = useWorkspace((s) => s.setScenario);
  const quote = useWorkspace((s) => s.quote);
  const securities = useWorkspace((s) => s.securities);
  const [refreshing, setRefreshing] = useState(false);
  const kpi = useMemo(() => {
    if (!state) return null;
    const calc = calcOf(state);
    const basis = basisPeriodId(state);
    const eps = findByRole(state, 'eps');
    const pe = findByRole(state, 'target_multiple');
    const tp = findByRole(state, 'target_price');
    const v = (id: string | undefined, key: string | null) => (id && key ? calc.cells[scenario][id]?.[key]?.v ?? null : null);
    return {
      basis,
      eps: { v: v(eps?.id, basis), unit: eps?.unit },
      pe: { v: v(pe?.id, pe?.timeMode === 'scalar' ? SCALAR_KEY : basis), unit: pe?.unit },
      tp: { v: v(tp?.id, tp?.timeMode === 'scalar' ? SCALAR_KEY : basis), unit: tp?.unit },
    };
  }, [state, scenario]);
  const price = quote?.quote?.price ?? null;
  const upside = price && kpi?.tp.v ? kpi.tp.v / price - 1 : null;
  const sec = securities[0];
  const pl = periodLabelFn(state);
  return (
    <div className="topbar" data-testid="topbar">
      <ScenarioSwitch value={scenario} onChange={setScenario} />
      {kpi && (
        <div className="kpis">
          <div className="kpi">
            <span>EPS {kpi.basis ? pl(kpi.basis) : ''}</span>
            <b data-testid="kpi-eps">{formatValue(kpi.eps.v, kpi.eps.unit)}</b>
          </div>
          <div className="kpi">
            <span>Target P/E</span>
            <b>{formatValue(kpi.pe.v, kpi.pe.unit)}</b>
          </div>
          <div className="kpi">
            <span>Target price</span>
            <b data-testid="kpi-tp">{formatValue(kpi.tp.v, kpi.tp.unit)}</b>
          </div>
          <div className="kpi">
            <span>Upside</span>
            <b className={cls(upside !== null && (upside >= 0 ? 'pos' : 'neg'))}>{upside === null ? '—' : `${upside >= 0 ? '+' : ''}${(upside * 100).toFixed(1)}%`}</b>
          </div>
        </div>
      )}
      <div className="right row">
        <div className="kpi" style={{ textAlign: 'right' }} title={quote?.error ?? (quote?.quote ? `Provider ${quote.quote.provider}, market time ${quote.quote.asOf}, fetched ${quote.quote.fetchedAt}` : '')}>
          <span>
            {sec?.ticker} price {quote?.quote?.provider === 'demo' && <span className="badge synthetic">SYNTHETIC</span>}
            {quote?.stale && <span className="badge warn">stale</span>}
          </span>
          <b data-testid="kpi-price">
            {price === null ? '—' : price.toLocaleString('en-US', { maximumFractionDigits: 2 })} <span className="small sub">{quote?.quote?.currency ?? sec?.currency}</span>
          </b>
          <span className="tiny" style={{ textTransform: 'none' }}>
            {quote?.quote ? `${quote.quote.provider} · ${timeAgo(quote.quote.fetchedAt)}` : quote?.error ? 'unavailable' : ''}
          </span>
        </div>
        <button
          className="btn sm"
          disabled={refreshing || !sec}
          title="Refresh the quote from the provider"
          onClick={async () => {
            setRefreshing(true);
            try {
              const q = await api.quote(sec.id, undefined, true);
              useWorkspace.setState({ quote: q });
              if (q.error) useWorkspace.getState().toast(q.error, 'error');
            } finally {
              setRefreshing(false);
            }
          }}
        >
          ↻
        </button>
        <button className="btn sm ghost" onClick={onSearch}>
          Search <span className="kbd">Ctrl+K</span>
        </button>
      </div>
    </div>
  );
}

function ViewingBanner() {
  const viewing = useWorkspace((s) => s.viewing);
  const head = useWorkspace((s) => s.head);
  const { view, restore, toast } = useWorkspace.getState();
  const projectId = useWorkspace((s) => s.projectId);
  if (!viewing) return null;
  return (
    <div className="banner" data-testid="viewing-banner">
      <b>
        Viewing Research Update #{viewing.seq} “{viewing.title}”
      </b>
      <span className="small">
        knowledge date {viewing.asOfDate ?? '—'} · committed {viewing.committedAt.slice(0, 10)} · read-only snapshot
        {head && viewing.id === head.id ? ' (latest)' : ''}
      </span>
      <span className="right row">
        <button
          className="btn sm"
          onClick={async () => {
            if (!window.confirm(`Replace the current draft with the state of Research Update #${viewing.seq}? History is not rewritten; commit afterwards to record the restore.`)) return;
            await restore(viewing.id);
            toast(`Draft restored from #${viewing.seq}. Review the changes and commit.`, 'success');
            navigate({ page: 'project', projectId: projectId!, tab: 'model' });
          }}
        >
          Restore into draft
        </button>
        <button className="btn sm primary" onClick={() => void view(null)} data-testid="back-to-draft">
          Back to draft
        </button>
      </span>
    </div>
  );
}
