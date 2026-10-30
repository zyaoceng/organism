import { useMemo, type ReactNode } from 'react';
import { CLIENT_LABEL } from '../../shared/actors';
import type { DashboardRowDTO, RefreshItemDTO, RefreshRunDTO } from '../../shared/api';
import { dashboardCompany, matchCompanies } from '../lib/companies';
import { getLang, t, tm } from '../lib/i18n';
import { useAdvanced } from '../lib/prefs';
import { href, navigate } from '../lib/router';
import { ariaSort, sortBy, useSortState, visibleSort, type SortDir } from '../lib/tableSort';
import { cls, pctText, timeAgo } from '../lib/util';

type Row = DashboardRowDTO;

/** Sortable columns: the sort value, and which way the first click sorts. */
const SORTS: Record<string, { value: (r: Row) => number | string | null; first: SortDir }> = {
  name: { value: (r) => r.name, first: 'asc' },
  price: { value: (r) => r.price?.value ?? null, first: 'desc' },
  target: { value: (r) => r.target.base, first: 'desc' },
  weighted: { value: (r) => r.target.upsideWeighted, first: 'desc' },
  upside: { value: (r) => r.target.upsideBase, first: 'desc' },
  // oldest research first: what needs updating
  research: { value: (r) => r.research?.asOfDate ?? null, first: 'asc' },
  draft: { value: (r) => (r.draftDirty ? 1 : 0), first: 'desc' },
  positions: { value: (r) => r.positions.open || null, first: 'desc' },
  // overdue first (oldest first), then the next window to end
  catalysts: { value: (r) => (r.catalysts.oldestOverdue ? `0 ${r.catalysts.oldestOverdue.windowEnd}` : r.catalysts.next ? `1 ${r.catalysts.next.windowEnd}` : null), first: 'asc' },
  theses: { value: (r) => r.theses.reviewDue || null, first: 'desc' },
  ai: { value: (r) => r.ai?.at ?? null, first: 'desc' },
};

const mmdd = (d: string | null | undefined) => (d ? d.slice(5) : '');
const money = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Every company in one table: price, targets, upside, research, draft, positions, catalysts, theses, AI. A row opens the model. */
export function DashboardTable({ rows, run, query }: { rows: Row[]; run: RefreshRunDTO | null; query: string }) {
  const adv = useAdvanced();
  const lang = getLang();
  const [savedSort, clickSort] = useSortState('wb.dash.sort');
  // a sort by the Weighted column, remembered from advanced mode, does not apply while the column is hidden
  const sort = visibleSort(savedSort, adv ? Object.keys(SORTS) : Object.keys(SORTS).filter((k) => k !== 'weighted'));

  const shown = useMemo(() => {
    let out = rows;
    if (query.trim()) {
      const hit = new Set(matchCompanies(rows.map(dashboardCompany), query, { limit: Infinity }).map((c) => c.id));
      out = rows.filter((r) => hit.has(r.projectId));
    }
    const s = SORTS[sort.key];
    return s ? sortBy(out, s.value, sort.dir) : out;
  }, [rows, query, sort]);

  // progress of a running "Update all prices", per security
  const items = useMemo(() => new Map<string, RefreshItemDTO>((run?.items ?? []).map((i) => [i.securityId, i])), [run]);

  const th = (key: string, label: string, className?: string) => (
    <th className={cls('sortable', className)} data-testid={`dash-sort-${key}`} aria-sort={ariaSort(sort, key)} onClick={() => clickSort(key, SORTS[key].first)}>
      {label}
    </th>
  );

  if (rows.length && !shown.length) return <div className="empty">{t('No companies match “{q}”.', { q: query.trim() })}</div>;
  return (
    <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
      <table className="grid dash" data-testid="dash-table">
        <thead>
          <tr>
            {th('name', t('Company'), 'l')}
            {th('price', t('Last price'))}
            {th('target', t('Target (base)'))}
            {adv && th('weighted', t('Weighted target'))}
            {th('upside', t('Upside'))}
            {th('research', t('Last research'), 'l')}
            {th('draft', t('Draft'), 'l')}
            {th('positions', t('Positions'), 'l')}
            {th('catalysts', t('Catalysts'), 'l')}
            {th('theses', t('Theses'), 'l')}
            {th('ai', t('AI'), 'l')}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const open = () => navigate({ page: 'project', projectId: r.projectId, tab: 'model' });
            const item = r.security ? items.get(r.security.id) : undefined;
            return (
              <tr key={r.projectId} className="clickable" data-testid="project-card" data-project-id={r.projectId} onClick={open}>
                <td className="l">
                  <a href={href({ page: 'project', projectId: r.projectId, tab: 'model' })} onClick={(e) => e.stopPropagation()}>
                    <b>{r.name}</b>
                  </a>{' '}
                  {r.archivedAt && <span className="badge">{t('archived')}</span>}
                  {r.price?.synthetic && <span className="badge synthetic">{t('SYNTHETIC')}</span>}
                  <div className="tiny sub">{r.security ? `${r.security.ticker} · ${r.security.exchange || '—'}` : ''}</div>
                </td>
                <td>
                  <PriceCell r={r} item={item} />
                </td>
                <td>
                  <span className="num">{r.target.base !== null ? r.target.base.toFixed(1) : '—'}</span>
                  {adv && (r.target.bear !== null || r.target.bull !== null) && (
                    <div className="tiny sub">{[r.target.bear, r.target.base, r.target.bull].map((v) => (v === null ? '—' : v.toFixed(1))).join(' / ')}</div>
                  )}
                </td>
                {adv && (
                  <td title={r.target.weightSum > 0 ? t('Weights sum to {pct}%', { pct: (r.target.weightSum * 100).toFixed(0) }) : undefined}>
                    <span className="num">{r.target.weighted !== null ? r.target.weighted.toFixed(1) : '—'}</span>
                    {r.target.upsideWeighted !== null && (
                      <div className={cls('tiny', r.target.upsideWeighted >= 0 ? 'pos' : 'neg')} title={t('Weighted upside')}>
                        {pctText(r.target.upsideWeighted)}
                      </div>
                    )}
                  </td>
                )}
                <td title={r.target.currencyMismatch ? t('Target and price are in different currencies') : undefined}>
                  {r.target.currencyMismatch ? (
                    <span className="sub">—</span>
                  ) : (
                    <b className={cls('num', r.target.upsideBase !== null && (r.target.upsideBase >= 0 ? 'pos' : 'neg'))}>{pctText(r.target.upsideBase)}</b>
                  )}
                </td>
                <td className="l">
                  {r.research ? (
                    <>
                      {r.research.asOfDate}
                      <div className="tiny sub ellipsis" style={{ maxWidth: 220 }} title={r.research.title}>
                        #{r.research.seq} {r.research.title}
                      </div>
                    </>
                  ) : (
                    <span className="sub small">{t('no research yet')}</span>
                  )}
                </td>
                <td className="l">{r.draftDirty && <span className="badge warn">{t('uncommitted')}</span>}</td>
                <td className="l" title={positionsTitle(r)}>
                  {r.positions.open > 0 && (
                    <>
                      {t('{n} open', { n: r.positions.open })}
                      {r.positions.avgR !== null && <span className="sub"> · {t('avg {r}R', { r: r.positions.avgR.toFixed(2) })}</span>}
                      {r.positions.pnl.length > 0 && (
                        <div className="tiny">
                          {r.positions.pnl.map((p) => (
                            <span key={p.currency} className={cls(p.value >= 0 ? 'pos' : 'neg')} style={{ marginRight: 6 }}>
                              {p.value >= 0 ? '+' : ''}
                              {Math.round(p.value).toLocaleString('en-US')} {p.currency}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </td>
                <td className="l">
                  <Catalysts r={r} />
                </td>
                <td className="l">
                  {r.theses.reviewDue > 0 ? (
                    <span className="badge warn">{t('{n} to review', { n: r.theses.reviewDue })}</span>
                  ) : (
                    r.theses.nextReviewBy && <span className="tiny sub">{r.theses.nextReviewBy}</span>
                  )}
                </td>
                <td className="l small" title={r.ai?.summary ?? undefined}>
                  {r.ai && (
                    <>
                      <span className="badge ai">{CLIENT_LABEL[lang][r.ai.client]}</span> <span className="sub">{timeAgo(r.ai.at)}</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PriceCell({ r, item }: { r: Row; item?: RefreshItemDTO }) {
  // a running "Update all prices": … while this security waits, ! when it failed
  let mark: ReactNode = null;
  if (item?.status === 'pending' || item?.status === 'running') mark = <span className="sub">… </span>;
  else if (item?.status === 'failed' || item?.status === 'rate_limited')
    mark = (
      <span className="neg" title={item.message ? tm(item.message) : undefined}>
        !{' '}
      </span>
    );
  if (!r.price)
    return (
      <>
        {mark}
        <span className="sub">—</span>
        <div className="tiny sub">{t('no price')}</div>
      </>
    );
  const p = r.price;
  return (
    <>
      {mark}
      <b className="num">{money(p.value)}</b> <span className="tiny sub">{p.currency}</span>
      <div className="tiny sub">
        {mmdd(p.marketDate)}{' '}
        {p.stale ? (
          <span className="badge warn" title={t('Fetched {ago}', { ago: timeAgo(p.fetchedAt) })}>
            {t('stale')}
          </span>
        ) : (
          p.lagDays > 7 && <span className="badge warn">{t('no new prices for {n} days', { n: p.lagDays })}</span>
        )}
      </div>
    </>
  );
}

function Catalysts({ r }: { r: Row }) {
  const c = r.catalysts;
  return (
    <>
      {c.overdue > 0 && (
        <span className="badge err" title={c.oldestOverdue ? `${c.oldestOverdue.expectedDate} ${c.oldestOverdue.title}` : undefined}>
          {t('{n} overdue', { n: c.overdue })}
        </span>
      )}{' '}
      {c.next && (
        <span className="small" title={`${c.next.expectedDate} ${c.next.title}`}>
          {mmdd(c.next.windowEnd)}{' '}
          <span className="sub ellipsis" style={{ display: 'inline-block', maxWidth: 140, verticalAlign: 'bottom' }}>
            {c.next.title}
          </span>
        </span>
      )}
    </>
  );
}

function positionsTitle(r: Row): string | undefined {
  if (!r.positions.items.length) return undefined;
  return r.positions.items
    .map(
      (i) => `${t(i.side)} ${i.quantity} @ ${i.entryPrice} (${i.entryDate})${i.rMultiple !== null ? ` · ${i.rMultiple.toFixed(2)}R` : ''}${i.returnPct !== null ? ` · ${pctText(i.returnPct)}` : ''}`,
    )
    .join('\n');
}
