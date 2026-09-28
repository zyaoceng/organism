import { useEffect, useMemo, useState } from 'react';
import { formatValue } from '../../domain/format';
import { findByRole } from '../../domain/model/tree';
import { SCALAR_KEY, SCENARIOS, type ScenarioId } from '../../domain/model/types';
import { basisPeriodId, computeImpact } from '../../domain/revision/impact';
import { describeChange } from '../../domain/revision/describe';
import { diffStates } from '../../domain/revision/diff';
import { ERROR_CATEGORIES, type ReviewDTO, type RevisionFull, type SeriesPoint } from '../../shared/api';
import { ImpactView } from '../components/ImpactView';
import { LineChart } from '../components/LineChart';
import { Delta, Field } from '../components/ui';
import { api } from '../lib/api';
import { getLang, t, tm, tn } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useWorkspace } from '../lib/store';
import { cls, fmtDateTime, periodLabelFn } from '../lib/util';

type View = 'updates' | 'evolution' | 'reviews';

export function HistoryPage({ param }: { param?: string }) {
  const [view, setView] = useState<View>(param === 'evolution' || param === 'reviews' ? param : 'updates');
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('History')}</h1>
        <div className="seg">
          {(
            [
              ['updates', 'Research updates'],
              ['evolution', 'Estimate evolution & calibration'],
              ['reviews', 'Reviews'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={cls(view === v && 'on plain')} onClick={() => setView(v)} data-testid={`hist-${v}`}>
              {t(l)}
            </button>
          ))}
        </div>
      </div>
      {view === 'updates' && <Updates selectedId={param && param !== 'evolution' && param !== 'reviews' ? param : undefined} />}
      {view === 'evolution' && <Evolution />}
      {view === 'reviews' && <Reviews />}
    </div>
  );
}

// ------------------------------------------------------------ updates timeline

function Updates({ selectedId }: { selectedId?: string }) {
  const revisions = useWorkspace((s) => s.revisions);
  const projectId = useWorkspace((s) => s.projectId)!;
  const sorted = [...revisions].reverse();
  const [sel, setSel] = useState<string | undefined>(selectedId ?? sorted[0]?.id);
  useEffect(() => {
    if (selectedId) setSel(selectedId);
  }, [selectedId]);
  const draft = useWorkspace((s) => s.draft);
  const tp = draft ? findByRole(draft, 'target_price') : undefined;
  return (
    <div className="split" style={{ gridTemplateColumns: '380px minmax(0, 1fr)' }}>
      <div className="timeline" data-testid="timeline">
        {sorted.map((r) => {
          const h = r.impact?.headline.targetPrice.find((x) => x.scenario === 'base');
          return (
            <div key={r.id} className={cls('tl-item', r.kind, sel === r.id && 'sel')} onClick={() => setSel(r.id)}>
              <div className="tl-card">
                <div className="row">
                  <b>#{r.seq}</b>
                  <span className="ellipsis grow">{r.title}</span>
                  {r.kind !== 'update' && <span className="badge">{t(r.kind)}</span>}
                </div>
                <div className="tiny sub">
                  {r.asOfDate ? t('as of {date}', { date: r.asOfDate }) : t('no knowledge date')} · {tn(r.changes.length, '{n} change', '{n} changes')}
                </div>
                {h && h.before !== null && h.after !== null && h.before !== h.after && (
                  <div className="small num">
                    {t('Base TP')} {formatValue(h.before, tp?.unit)} → <b>{formatValue(h.after, tp?.unit)}</b> <Delta before={h.before} after={h.after} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div>{sel ? <RevisionDetail key={sel} projectId={projectId} revisionId={sel} /> : <div className="empty">{t('No Research Updates yet.')}</div>}</div>
    </div>
  );
}

function RevisionDetail({ projectId, revisionId }: { projectId: string; revisionId: string }) {
  const [rev, setRev] = useState<RevisionFull | null>(null);
  const [compareTo, setCompareTo] = useState<string>('');
  const [other, setOther] = useState<RevisionFull | null>(null);
  const revisions = useWorkspace((s) => s.revisions);
  const evidence = useWorkspace((s) => s.evidence);
  const { view, restore, toast } = useWorkspace.getState();
  useEffect(() => {
    void api.revision(projectId, revisionId).then(setRev);
  }, [projectId, revisionId]);
  useEffect(() => {
    if (compareTo) void api.revision(projectId, compareTo).then(setOther);
    else setOther(null);
  }, [projectId, compareTo]);
  const comparison = useMemo(() => {
    if (!rev || !other) return null;
    const [a, b] = other.seq < rev.seq ? [other, rev] : [rev, other];
    const changes = diffStates(a.state, b.state);
    return { a, b, changes, impact: computeImpact(a.state, b.state, { changes }) };
  }, [rev, other]);
  if (!rev) return <div className="sub">{t('Loading…')}</div>;
  const pl = periodLabelFn(rev.state);
  const evTitle = (id: string) => evidence.find((e) => e.id === id)?.title ?? t('evidence');
  const cited = evidence.filter((e) => rev.citedEvidenceIds.includes(e.id));
  return (
    <div className="col" style={{ gap: 14 }} data-testid="revision-detail">
      <div className="card">
        <div className="row">
          <h2>
            #{rev.seq} {rev.title}
          </h2>
          <span className="badge">{t(rev.kind)}</span>
          <span className="right row">
            <button
              className="btn sm"
              onClick={async () => {
                await view(rev.id);
                navigate({ page: 'project', projectId, tab: 'model' });
              }}
              data-testid="view-snapshot"
            >
              {t('View snapshot')}
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                if (!window.confirm(t('Replace the current draft with the state of #{seq}? Nothing in history is rewritten.', { seq: rev.seq }))) return;
                await restore(rev.id);
                toast(t('Draft restored from #{seq}. Review and commit it.', { seq: rev.seq }), 'success');
                navigate({ page: 'project', projectId, tab: 'model' });
              }}
            >
              {t('Restore into draft')}
            </button>
          </span>
        </div>
        <div className="small sub" style={{ margin: '4px 0 8px' }}>
          {t('Knowledge date')} <b>{rev.asOfDate ?? '—'}</b> · {t('committed {time}', { time: fmtDateTime(rev.committedAt) })} · {t('engine {version}', { version: rev.engineVersion })}
          {rev.market && (
            <>
              {' '}
              · {t('price then')} <b>{rev.market.price.toFixed(2)}</b> ({rev.market.provider}
              {rev.market.provider === 'demo' ? t(', synthetic') : ''}, {rev.market.asOf.slice(0, 10)})
            </>
          )}
        </div>
        <div style={{ whiteSpace: 'pre-wrap' }}>
          <b>{t('Reason / interpretation: ')}</b>
          {rev.reason}
        </div>
        {rev.notes && <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{rev.notes}</div>}
        {cited.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <b className="small">{t('Evidence cited')}</b>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              {cited.map((e) => (
                <li key={e.id} className="small">
                  <a href={`#/p/${projectId}/evidence/${e.id}`}>{e.title}</a> <span className="sub">{[e.sourceName, e.publishedAt].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {rev.impact && (
        <div className="card">
          <h2>{t('Impact')}</h2>
          <ImpactView impact={rev.impact} state={rev.state} />
        </div>
      )}
      <div className="card">
        <h2>{t('Changes ({n})', { n: rev.changes.length })}</h2>
        {rev.changes.length === 0 && <div className="small sub">{rev.kind === 'initial' ? t('Starting structure from the template.') : t('Checkpoint: the view was reviewed and kept.')}</div>}
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {rev.changes.slice(0, 300).map((c, i) => (
            <li key={i} className="small" style={{ lineHeight: 1.6 }}>
              {describeChange(c, { periodLabel: pl, evidenceTitle: evTitle, lang: getLang() })}
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        <div className="row">
          <h2>{t('Compare with another snapshot')}</h2>
          <select value={compareTo} onChange={(e) => setCompareTo(e.target.value)} data-testid="compare-select">
            <option value="">{t('choose…')}</option>
            {revisions
              .filter((r) => r.id !== rev.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.seq} {r.title}
                </option>
              ))}
          </select>
        </div>
        {comparison && (
          <div className="col" style={{ gap: 10, marginTop: 10 }}>
            <div className="small sub">
              {tn(comparison.changes.length, 'From #{a} ({aDate}) to #{b} ({bDate}): {n} change', 'From #{a} ({aDate}) to #{b} ({bDate}): {n} changes', { a: comparison.a.seq, aDate: comparison.a.asOfDate ?? '—', b: comparison.b.seq, bDate: comparison.b.asOfDate ?? '—' })}
            </div>
            <ImpactView impact={comparison.impact} state={comparison.b.state} compact />
            <details>
              <summary>{t('All changes')}</summary>
              <ul style={{ paddingLeft: 18 }}>
                {comparison.changes.map((c, i) => (
                  <li key={i} className="small">
                    {describeChange(c, { periodLabel: periodLabelFn(comparison.b.state), evidenceTitle: evTitle, lang: getLang() })}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ estimate evolution

function Evolution() {
  const draft = useWorkspace((s) => s.draft)!;
  const head = useWorkspace((s) => s.head)!;
  const projectId = useWorkspace((s) => s.projectId)!;
  const eps = findByRole(draft, 'eps');
  const [nodeId, setNodeId] = useState(eps?.id ?? draft.nodes[0]?.id);
  const node = draft.nodes.find((n) => n.id === nodeId);
  const basis = basisPeriodId(draft);
  const [periodKey, setPeriodKey] = useState<string>(node?.timeMode === 'scalar' ? SCALAR_KEY : basis ?? draft.periods.at(-1)?.id ?? SCALAR_KEY);
  const [points, setPoints] = useState<SeriesPoint[] | null>(null);
  useEffect(() => {
    if (!nodeId) return;
    void api.series(projectId, [nodeId]).then(setPoints);
  }, [projectId, nodeId]);
  useEffect(() => {
    if (node?.timeMode === 'scalar') setPeriodKey(SCALAR_KEY);
    else if (periodKey === SCALAR_KEY) setPeriodKey(basis ?? draft.periods.at(-1)?.id ?? SCALAR_KEY);
  }, [node?.timeMode]);
  const pl = periodLabelFn(draft);
  const knowledge = (points ?? []).filter((p) => p.asOfDate);
  // "Actual" = the committed value once the period is marked actual in the latest snapshot.
  const latestPeriod = head.state.periods.find((p) => p.id === periodKey);
  const actual = latestPeriod?.status === 'A' && nodeId ? head.computed.values.base[nodeId]?.[periodKey] ?? null : null;
  const colors: Record<ScenarioId, string> = { bear: '#b5473a', base: '#35598f', bull: '#2f7d4f' };
  const series = SCENARIOS.map((s) => ({
    name: t(s.name),
    color: colors[s.id],
    step: true,
    points: knowledge.map((p) => ({ x: Date.parse(p.asOfDate!), y: p.values[nodeId!]?.[s.id]?.[periodKey] ?? null, label: `#${p.seq} ${p.title}` })),
  }));
  const shortcuts = (['eps', 'target_price', 'target_multiple', 'revenue', 'gross_margin'] as const).map((r) => findByRole(draft, r)).filter(Boolean);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card">
        <div className="row wrap">
          <Field label={t('Metric')}>
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} data-testid="evo-node">
              {draft.nodes
                .filter((n) => n.unit)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
            </select>
          </Field>
          {node?.timeMode === 'series' && (
            <Field label={t('Fiscal period')}>
              <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} data-testid="evo-period">
                {draft.periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {pl(p.id)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="row wrap" style={{ alignSelf: 'flex-end' }}>
            {shortcuts.map((n) => (
              <button key={n!.id} className={cls('btn sm', n!.id === nodeId && 'primary')} onClick={() => setNodeId(n!.id)}>
                {n!.name}
              </button>
            ))}
          </div>
        </div>
        <div className="small sub" style={{ marginTop: 8 }}>
          {t('Each point is the frozen value in a Research Update, plotted on its knowledge date. The line steps when you changed your view. Later market data never changes these values.')}
        </div>
        <div style={{ marginTop: 10 }}>
          {points && (
            <LineChart
              series={series}
              yFormat={(v) => formatValue(v, node?.unit)}
              hLines={actual !== null ? [{ y: actual, label: t('Actual {value}', { value: formatValue(actual, node?.unit) }), color: '#111' }] : []}
            />
          )}
        </div>
      </div>
      <div className="card">
        <h2>
          {t('{metric} {period} by Research Update', { metric: node?.name, period: periodKey !== SCALAR_KEY ? pl(periodKey) : '' })}
        </h2>
        <table className="grid" data-testid="evo-table">
          <thead>
            <tr>
              <th>{t('Update')}</th>
              <th className="l">{t('Knowledge date')}</th>
              {SCENARIOS.map((s) => (
                <th key={s.id}>{t(s.name)}</th>
              ))}
              <th>{t('Δ Base')}</th>
              {actual !== null && <th>{t('Base vs actual')}</th>}
            </tr>
          </thead>
          <tbody>
            {knowledge.map((p, i) => {
              const base = p.values[nodeId!]?.base?.[periodKey] ?? null;
              const prev = i > 0 ? knowledge[i - 1].values[nodeId!]?.base?.[periodKey] ?? null : null;
              const periodThen = p.periods.find((x) => x.id === periodKey);
              return (
                <tr key={p.revisionId}>
                  <td className="l">
                    <a href={`#/p/${projectId}/history/${p.revisionId}`}>
                      #{p.seq} {p.title}
                    </a>
                    {periodThen && <span className="faint small"> ({periodThen.status === 'A' ? t('actual then') : t('estimate then')})</span>}
                  </td>
                  <td className="l">{p.asOfDate}</td>
                  {SCENARIOS.map((s) => (
                    <td key={s.id}>{formatValue(p.values[nodeId!]?.[s.id]?.[periodKey], node?.unit)}</td>
                  ))}
                  <td>{i > 0 ? <Delta before={prev} after={base} unit={node?.unit} /> : ''}</td>
                  {actual !== null && <td>{base !== null && actual ? <Delta before={actual} after={base} unit={node?.unit} /> : '—'}</td>}
                </tr>
              );
            })}
            {knowledge.length === 0 && (
              <tr>
                <td colSpan={7} className="l sub">
                  {t('No knowledge-dated Research Updates yet.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {actual !== null && (
          <div className="small sub" style={{ marginTop: 6 }}>
            {t('“Base vs actual” is the estimate error: positive means the estimate was above what was reported.')}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ reviews (post-mortems)

function Reviews() {
  const reviews = useWorkspace((s) => s.reviews);
  const revisions = useWorkspace((s) => s.revisions);
  const trades = useWorkspace((s) => s.trades);
  const projectId = useWorkspace((s) => s.projectId)!;
  const [editing, setEditing] = useState<Partial<ReviewDTO> | null>(null);
  const save = async () => {
    if (!editing) return;
    try {
      if (editing.id) await api.updateReview(editing.id, editing);
      else await api.createReview(projectId, editing);
      setEditing(null);
      await useWorkspace.getState().refresh('reviews');
    } catch (e) {
      useWorkspace.getState().toast(tm((e as Error).message), 'error');
    }
  };
  const catLabel = (c: string) => t(ERROR_CATEGORIES.find((x) => x.value === c)?.label ?? c);
  return (
    <div className="split">
      <div className="col">
        <div className="row">
          <div className="small sub grow">{t('Post-mortems: you decide which part of the process failed. Nothing is classified automatically.')}</div>
          <button className="btn primary" onClick={() => setEditing({ subjectType: 'project', categories: [], title: '' })} data-testid="new-review">
            {t('+ Review')}
          </button>
        </div>
        {reviews.length === 0 && <div className="empty">{t('No reviews yet. Write one after an outcome is known (earnings, exit, thesis invalidated).')}</div>}
        {reviews.map((r) => (
          <div key={r.id} className="card" style={{ cursor: 'pointer' }} onClick={() => setEditing(r)}>
            <div className="row">
              <b>{r.title}</b>
              <span className="badge">{t(r.subjectType)}</span>
              <span className="right tiny sub">{r.createdAt.slice(0, 10)}</span>
            </div>
            <div className="row wrap" style={{ marginTop: 4 }}>
              {r.thesisVerdict && <span className="badge">{t('thesis: {verdict}', { verdict: t(r.thesisVerdict) })}</span>}
              {r.executionVerdict && <span className="badge">{t('execution: {verdict}', { verdict: t(r.executionVerdict) })}</span>}
              {r.categories.map((c) => (
                <span key={c.category} className="badge warn" title={c.notes}>
                  {catLabel(c.category)}
                </span>
              ))}
            </div>
            {r.outcome && <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{r.outcome}</div>}
            {r.lessons && <div className="small sub" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{t('Lesson: {text}', { text: r.lessons })}</div>}
          </div>
        ))}
        {reviews.length > 0 && (
          <div className="card">
            <h2>{t('Error pattern')}</h2>
            <table className="grid">
              <tbody>
                {ERROR_CATEGORIES.map((c) => {
                  const n = reviews.filter((r) => r.categories.some((x) => x.category === c.value)).length;
                  return (
                    <tr key={c.value}>
                      <td>{t(c.label)}</td>
                      <td>{n}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <div className="card" data-testid="review-form">
          <h2>{editing.id ? t('Edit review') : t('New review')}</h2>
          <div className="col">
            <Field label={t('Title')}>
              <input value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} data-testid="review-title" />
            </Field>
            <div className="two">
              <Field label={t('About')}>
                <select value={editing.subjectType} onChange={(e) => setEditing({ ...editing, subjectType: e.target.value as ReviewDTO['subjectType'], subjectId: null })}>
                  <option value="project">{t('The whole idea')}</option>
                  <option value="revision">{t('A Research Update')}</option>
                  <option value="trade">{t('A trade')}</option>
                </select>
              </Field>
              {editing.subjectType === 'revision' && (
                <Field label={t('Research Update')}>
                  <select value={editing.subjectId ?? ''} onChange={(e) => setEditing({ ...editing, subjectId: e.target.value || null })}>
                    <option value="">—</option>
                    {revisions.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.seq} {r.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {editing.subjectType === 'trade' && (
                <Field label={t('Trade')}>
                  <select value={editing.subjectId ?? ''} onChange={(e) => setEditing({ ...editing, subjectId: e.target.value || null })}>
                    <option value="">—</option>
                    {trades.map((tr) => (
                      <option key={tr.id} value={tr.id}>
                        {tr.entryDate} {t(tr.side)} @ {tr.entryPrice}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <Field label={t('What actually happened')}>
              <textarea rows={3} value={editing.outcome ?? ''} onChange={(e) => setEditing({ ...editing, outcome: e.target.value })} />
            </Field>
            <div className="two">
              <Field label={t('Was the thesis right?')}>
                <select value={editing.thesisVerdict ?? ''} onChange={(e) => setEditing({ ...editing, thesisVerdict: (e.target.value || null) as ReviewDTO['thesisVerdict'] })}>
                  <option value="">—</option>
                  {['right', 'wrong', 'mixed', 'unclear'].map((v) => (
                    <option key={v} value={v}>{t(v)}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('Was the execution good?')}>
                <select value={editing.executionVerdict ?? ''} onChange={(e) => setEditing({ ...editing, executionVerdict: (e.target.value || null) as ReviewDTO['executionVerdict'] })}>
                  <option value="">—</option>
                  {['good', 'poor', 'mixed', 'n/a'].map((v) => (
                    <option key={v} value={v}>{t(v)}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="field">
              <span className="small sub">{t('Where was the error? (your judgment)')}</span>
              {ERROR_CATEGORIES.map((c) => {
                const cur = editing.categories?.find((x) => x.category === c.value);
                return (
                  <div key={c.value} className="col" style={{ gap: 2 }}>
                    <label className="row small" style={{ gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={!!cur}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            categories: e.target.checked ? [...(editing.categories ?? []), { category: c.value, notes: '' }] : (editing.categories ?? []).filter((x) => x.category !== c.value),
                          })
                        }
                      />
                      {t(c.label)}
                    </label>
                    {cur && (
                      <input
                        placeholder={t('What exactly went wrong?')}
                        value={cur.notes}
                        onChange={(e) => setEditing({ ...editing, categories: (editing.categories ?? []).map((x) => (x.category === c.value ? { ...x, notes: e.target.value } : x)) })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <Field label={t('Lesson for the process')}>
              <textarea rows={2} value={editing.lessons ?? ''} onChange={(e) => setEditing({ ...editing, lessons: e.target.value })} />
            </Field>
            <div className="row">
              <button className="btn primary" disabled={!editing.title?.trim()} onClick={() => void save()} data-testid="review-save">
                {t('Save review')}
              </button>
              <button className="btn ghost" onClick={() => setEditing(null)}>
                {t('Cancel')}
              </button>
              {editing.id && (
                <button
                  className="btn danger right"
                  onClick={async () => {
                    if (!window.confirm(t('Delete this review?'))) return;
                    await api.deleteReview(editing.id!);
                    setEditing(null);
                    await useWorkspace.getState().refresh('reviews');
                  }}
                >
                  {t('Delete')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
