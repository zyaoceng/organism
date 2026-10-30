import { useEffect, useMemo, useState } from 'react';
import { summarizeTrades } from '../../domain/trade/summary';
import { actorLabel } from '../../shared/actors';
import { ERROR_CATEGORIES, type JournalTradeDTO } from '../../shared/api';
import { CompanySwitcher } from '../components/CompanySwitcher';
import { Advanced, AiBadge, AdvancedToggle } from '../components/ui';
import { api } from '../lib/api';
import { norm } from '../lib/companies';
import { useModK } from '../lib/hotkeys';
import { getLang, t, tm, useLang } from '../lib/i18n';
import { useAdvanced } from '../lib/prefs';
import { href, navigate } from '../lib/router';
import { ariaSort, sortBy, useSortState, type SortDir } from '../lib/tableSort';
import { cls, pctText } from '../lib/util';

type Trade = JournalTradeDTO;
type Status = 'all' | 'open' | 'closed';

const SORTS: Record<string, { value: (r: Trade) => number | string | null; first: SortDir }> = {
  entry: { value: (r) => r.entryDate, first: 'desc' },
  company: { value: (r) => r.project.name, first: 'asc' },
  side: { value: (r) => r.side, first: 'asc' },
  size: { value: (r) => r.quantity, first: 'desc' },
  price: { value: (r) => r.entryPrice, first: 'desc' },
  exit: { value: (r) => r.exitDate, first: 'desc' },
  return: { value: (r) => r.metrics.returnPct, first: 'desc' },
  r: { value: (r) => r.metrics.rMultiple, first: 'desc' },
  pnl: { value: (r) => r.metrics.pnl, first: 'desc' },
  days: { value: (r) => r.metrics.holdingDays, first: 'desc' },
  research: { value: (r) => r.research?.asOfDate ?? null, first: 'desc' },
  review: { value: (r) => r.reviews.length || null, first: 'desc' },
};

const money = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 0 }));
const categoryLabel = (c: string) => t(ERROR_CATEGORIES.find((x) => x.value === c)?.label ?? c);

/** Every trade across companies (#/journal): R, P&L in each security's own currency, research snapshot, reviews. */
export function JournalPage() {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('all');
  const [projectId, setProjectId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [unreviewed, setUnreviewed] = useState(false);
  const [q, setQ] = useState('');
  const [switching, setSwitching] = useState(false);
  const [sort, clickSort] = useSortState('wb.journal.sort');
  const adv = useAdvanced();
  const lang = useLang();
  useModK(() => setSwitching(true));

  useEffect(() => {
    api
      .allTrades()
      .then((r) => setTrades(r.trades))
      .catch((e) => setError((e as Error).message));
  }, []);

  const companies = useMemo(() => {
    const m = new Map<string, string>();
    for (const tr of trades ?? []) m.set(tr.project.id, tr.project.name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [trades]);

  // filtered on the client, so the summary always describes exactly the rows shown
  const visible = useMemo(() => {
    const query = norm(q);
    const rows = (trades ?? []).filter(
      (tr) =>
        (status === 'all' || (status === 'open') === tr.metrics.open) &&
        (!projectId || tr.project.id === projectId) &&
        (!from || tr.entryDate >= from) &&
        (!to || tr.entryDate <= to) &&
        (!unreviewed || tr.reviews.length === 0) &&
        (!query || [tr.project.name, tr.security.ticker, tr.entryReason].some((x) => norm(x).includes(query))),
    );
    const s = SORTS[sort.key];
    return s ? sortBy(rows, s.value, sort.dir) : rows;
  }, [trades, status, projectId, from, to, unreviewed, q, sort]);

  const summary = useMemo(() => summarizeTrades(visible.map((tr) => ({ currency: tr.security.currency, metrics: tr.metrics, reviewCategories: tr.reviews.flatMap((r) => r.categories) }))), [visible]);

  const th = (key: string, label: string, className?: string) => (
    <th className={cls('sortable', className)} aria-sort={ariaSort(sort, key)} onClick={() => clickSort(key, SORTS[key].first)} data-testid={`journal-sort-${key}`}>
      {label}
    </th>
  );
  const cols = adv ? 14 : 12;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }} lang={lang}>
      <div className="projects wide" data-testid="journal-page">
        <div className="page-head">
          <div>
            <a href="#/">{t('← All companies')}</a>
            <h1>{t('Trade log')}</h1>
            <div className="sub">{t("All trades across companies. Profit and loss stays in each security's currency; nothing is converted or added across currencies.")}</div>
          </div>
          <span className="right row">
            <span className="small sub">
              <span className="kbd">Ctrl+K</span> {t('switch company')}
            </span>
            <AdvancedToggle />
          </span>
        </div>
        {error && <div className="msg err">{tm(error)}</div>}
        {trades && trades.length === 0 && <div className="empty">{t("No trades yet. Record them on each company's Trades page.")}</div>}
        {trades && trades.length > 0 && (
          <>
            <div className="journal-summary" data-testid="journal-summary">
              {summary.byCurrency.map((c) => (
                <div key={c.currency} className="card" data-testid={`journal-summary-${c.currency}`}>
                  <div className="tiny sub">{c.currency}</div>
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <span className="small sub">{t('Realized P&L')}</span>
                    <b className={cls('num', c.realizedPnl > 0 ? 'pos' : c.realizedPnl < 0 && 'neg')}>{money(c.realizedPnl)}</b>
                  </div>
                  <div className="tiny sub">{t('{n} closed · win rate {pct}', { n: c.closed, pct: c.winRate === null ? '—' : `${(c.winRate * 100).toFixed(0)}%` })}</div>
                  <div className="row" style={{ alignItems: 'baseline', marginTop: 4 }}>
                    <span className="small sub">{t('Unrealized P&L')}</span>
                    <b className={cls('num', c.unrealizedPnl !== null && (c.unrealizedPnl >= 0 ? 'pos' : 'neg'))}>{money(c.unrealizedPnl)}</b>
                  </div>
                  <div className="tiny sub">{t('{n} open', { n: c.open })}</div>
                </div>
              ))}
              {(summary.avgR !== null || summary.categories.length > 0) && (
                <div className="card grow">
                  {summary.avgR !== null && <div className="small">{t('Average R (closed, with a stop): {r} over {n} trades', { r: summary.avgR.toFixed(2), n: summary.rCount })}</div>}
                  {summary.categories.length > 0 && (
                    <div className="small" style={{ marginTop: 4 }}>
                      <span className="sub">{t('Error categories in reviews')}: </span>
                      {summary.categories.map((c) => (
                        <span key={c.category} className="badge" style={{ marginRight: 4 }}>
                          {categoryLabel(c.category)} × {c.count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="dash-tools">
              <div className="seg" data-testid="journal-status">
                {(
                  [
                    ['all', t('All')],
                    ['open', t('Open')],
                    ['closed', t('Closed')],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} className={cls(status === id && 'on plain')} onClick={() => setStatus(id)}>
                    {label}
                  </button>
                ))}
              </div>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="journal-company">
                <option value="">{t('All companies')}</option>
                {companies.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <label className="small sub row" style={{ gap: 4 }}>
                {t('Entry from')} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                {t('to')} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <label className="small sub row" style={{ gap: 4 }}>
                <input type="checkbox" checked={unreviewed} onChange={(e) => setUnreviewed(e.target.checked)} /> {t('Not reviewed only')}
              </label>
              <input className="dash-search" placeholder={t('Search company, code or reason')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="journal-search" />
            </div>
            <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
              <table className="grid" data-testid="journal-table">
                <thead>
                  <tr>
                    {th('entry', t('Entry'), 'l')}
                    {th('company', t('Company'), 'l')}
                    {th('side', t('Side'))}
                    {th('size', t('Size'))}
                    {th('price', t('Price'))}
                    {th('exit', t('Exit'), 'l')}
                    {th('return', t('Return'))}
                    {th('r', 'R')}
                    {th('pnl', 'P&L')}
                    {th('days', t('Days held'))}
                    {th('research', t('Research snapshot'), 'l')}
                    {th('review', t('Review'), 'l')}
                    {adv && <th>MFE / MAE</th>}
                    {adv && <th className="l">{t('Trail-stop exit')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={cols} className="l sub">
                        {t('No trades match.')}
                      </td>
                    </tr>
                  )}
                  {visible.map((tr) => (
                    <JournalRow key={tr.id} tr={tr} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {switching && <CompanySwitcher onClose={() => setSwitching(false)} />}
    </div>
  );
}

function JournalRow({ tr }: { tr: Trade }) {
  const m = tr.metrics;
  const pid = tr.project.id;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const noBars = !tr.barsCoverEntry ? t('Price history starts after the entry date') : undefined;
  return (
    <tr className="clickable" data-testid="journal-row" data-trade-id={tr.id} onClick={() => navigate({ page: 'project', projectId: pid, tab: 'trades', param: tr.id })}>
      <td className="l">
        {tr.entryDate} <AiBadge actor={tr.createdBy} label={t('recorded by {who}', { who: actorLabel(tr.createdBy, getLang()) })} />
        {tr.source === 'import' && (
          <span className="badge" title={t('Copied from an old trade journal')}>
            {t('imported')}
          </span>
        )}
      </td>
      <td className="l">
        <b>{tr.project.name}</b> <span className="small sub">{tr.security.ticker}</span>
        {tr.project.archived && <span className="badge">{t('archived')}</span>}
        {tr.security.synthetic && <span className="badge synthetic">{t('SYNTHETIC')}</span>}
      </td>
      <td>{t(tr.side)}</td>
      <td>{tr.quantity.toLocaleString('en-US')}</td>
      <td>{tr.entryPrice}</td>
      <td className="l">{tr.exitDate ? `${tr.exitDate} @ ${tr.exitPrice}` : <span className="badge accent">{t('open')}</span>}</td>
      <td className={cls(m.returnPct !== null && (m.returnPct >= 0 ? 'pos' : 'neg'))}>{pctText(m.returnPct)}</td>
      <td>{m.rMultiple === null ? '—' : m.rMultiple.toFixed(2)}</td>
      <td className={cls(m.pnl !== null && (m.pnl >= 0 ? 'pos' : 'neg'))}>
        {money(m.pnl)} <span className="tiny sub">{tr.security.currency}</span>
      </td>
      <td>{m.holdingDays ?? '—'}</td>
      <td className="l">
        {tr.research ? (
          <a href={href({ page: 'project', projectId: pid, tab: 'history', param: tr.research.revisionId })} onClick={stop}>
            #{tr.research.seq} ({tr.research.asOfDate ?? '—'})
          </a>
        ) : (
          <span className="sub">{t('none before entry')}</span>
        )}
      </td>
      <td className="l">
        {tr.reviews.length ? (
          tr.reviews.map((r) => (
            <span key={r.id} title={r.title} style={{ marginRight: 4 }}>
              {r.thesisVerdict && <span className={cls('badge', r.thesisVerdict === 'right' ? 'accent' : r.thesisVerdict === 'wrong' && 'err')}>{t(r.thesisVerdict)}</span>}
              {r.executionVerdict && <span className={cls('badge', r.executionVerdict === 'good' ? 'accent' : r.executionVerdict === 'poor' && 'err')}>{t(r.executionVerdict)}</span>}
              {!r.thesisVerdict && !r.executionVerdict && <span className="badge">{r.title}</span>}
            </span>
          ))
        ) : (
          <span className="small">
            <span className="sub">{t('not reviewed')}</span> ·{' '}
            <a href={href({ page: 'project', projectId: pid, tab: 'history', param: 'reviews' })} onClick={stop}>
              {t('write review')}
            </a>
          </span>
        )}
      </td>
      <Advanced>
        <td title={noBars}>{tr.barsCoverEntry ? `${pctText(m.mfe)} / ${pctText(m.mae)}` : '—'}</td>
        <td className="l small" title={noBars}>
          {!tr.barsCoverEntry ? '—' : m.trailingExit ? `${m.trailingExit.date} @ ${m.trailingExit.price.toFixed(2)} (${pctText(m.trailingExit.returnPct)})` : m.open ? t('not hit') : '—'}
        </td>
      </Advanced>
    </tr>
  );
}
