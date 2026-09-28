import { useState } from 'react';
import { formatValue } from '../../domain/format';
import { updateThesis } from '../../domain/model/ops';
import { findByRole } from '../../domain/model/tree';
import { SCALAR_KEY, SCENARIOS, type ThesisStatus } from '../../domain/model/types';
import { basisPeriodId } from '../../domain/revision/impact';
import { Delta, InlineText } from '../components/ui';
import { api } from '../lib/api';
import { calcOf } from '../lib/derived';
import { t } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useActiveState, useWorkspace } from '../lib/store';
import { cls, download, fmtDateTime, periodLabelFn, today } from '../lib/util';

export function OverviewPage() {
  const { state, readOnly } = useActiveState();
  const project = useWorkspace((s) => s.project)!;
  const revisions = useWorkspace((s) => s.revisions);
  const catalysts = useWorkspace((s) => s.catalysts);
  const notes = useWorkspace((s) => s.notes);
  const evidence = useWorkspace((s) => s.evidence);
  const quote = useWorkspace((s) => s.quote);
  const projectId = useWorkspace((s) => s.projectId)!;
  const { edit, refresh, toast } = useWorkspace.getState();
  const [note, setNote] = useState('');
  if (!state) return null;
  const calc = calcOf(state);
  const pl = periodLabelFn(state);
  const eps = findByRole(state, 'eps');
  const tp = findByRole(state, 'target_price');
  const tmul = findByRole(state, 'target_multiple');
  const estimate = state.periods.filter((p) => p.status === 'E');
  const basis = basisPeriodId(state);
  const price = quote?.quote?.price ?? null;
  const now = today();
  const upcoming = catalysts.filter((c) => c.status === 'upcoming' && (!c.expectedDate || c.expectedDate >= now)).slice(0, 6);
  const recent = [...revisions].reverse().slice(0, 6);
  const reviewDue = state.theses.filter((th) => th.status === 'active' && th.reviewBy && th.reviewBy <= now);

  return (
    <div className="page" data-testid="overview-page">
      <div className="page-head">
        <div className="grow">
          <InlineText className="h1" value={project.name} readOnly={false} onCommit={async (v) => (await api.updateProject(projectId, { name: v }), refresh('project'))} />
          <InlineText value={project.description} placeholder={t('One-line description of the business and why you follow it')} onCommit={async (v) => (await api.updateProject(projectId, { description: v }), refresh('project'))} />
        </div>
        <button
          className="btn"
          onClick={async () => {
            const res = await fetch(`/api/projects/${projectId}/export`);
            download(`${project.name.replace(/\s+/g, '_')}-${today()}.json`, await res.text());
          }}
          data-testid="export-json"
        >
          {t('Export JSON')}
        </button>
        <button
          className="btn"
          onClick={async () => {
            const name = window.prompt(t('Template name (structure, units, formulas and notes are saved; numbers are not):'), t('{name} structure', { name: project.name }));
            if (!name) return;
            await api.saveTemplate({ projectId, name });
            toast(t('Template “{name}” saved. Use it when creating a new company.', { name }), 'success');
          }}
        >
          {t('Save as template')}
        </button>
      </div>
      {reviewDue.length > 0 && (
        <div className="msg warn" style={{ marginBottom: 12 }}>
          {t('Thesis review due: {list}', { list: reviewDue.map((th) => th.statement).join(' · ') })}
        </div>
      )}
      <div className="three" style={{ marginBottom: 14 }}>
        {SCENARIOS.map((s) => {
          const tv = tp ? calc.cells[s.id][tp.id]?.[tp.timeMode === 'scalar' ? SCALAR_KEY : basis ?? ''] : undefined;
          const m = tmul ? calc.cells[s.id][tmul.id]?.[tmul.timeMode === 'scalar' ? SCALAR_KEY : basis ?? ''] : undefined;
          return (
            <div key={s.id} className={cls('card scen-card', s.id)}>
              <div className="row">
                <span className={cls('badge', s.id)}>{t(s.name)}</span>
                <span className="small sub">{t('target P/E')} {formatValue(m?.v, tmul?.unit)}</span>
              </div>
              <div className="big">{formatValue(tv?.v, tp?.unit)}</div>
              <div className="small">{price && tv?.v ? <Delta before={price} after={tv.v} /> : <span className="sub">{t('no price')}</span>} {t('vs current price')}</div>
              <table className="grid" style={{ marginTop: 6 }}>
                <tbody>
                  {estimate.map((p) => (
                    <tr key={p.id}>
                      <td>{t('EPS')} {pl(p.id)}</td>
                      <td>{formatValue(eps ? calc.cells[s.id][eps.id]?.[p.id]?.v : null, eps?.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      <div className="two">
        <div className="col" style={{ gap: 14 }}>
          <div className="card">
            <h2>{t('Theses & invalidation conditions')}</h2>
            {state.theses.length === 0 && <div className="small sub">{t('No theses yet. Add them from a node in the Model inspector.')}</div>}
            {state.theses.map((th) => (
              <div key={th.id} className="ev-item">
                <div className="row">
                  <b className="grow">{th.statement}</b>
                  <select disabled={readOnly} value={th.status} onChange={(e) => edit((s) => updateThesis(s, th.id, { status: e.target.value as ThesisStatus }))}>
                    {['active', 'confirmed', 'invalidated', 'retired'].map((x) => (
                      <option key={x} value={x}>
                        {t(x)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="small">
                  <span className="sub">{t('Invalidated if: ')}</span>
                  {th.invalidation || '—'}
                </div>
                <div className="tiny sub">
                  {th.nodeIds.map((id) => state.nodes.find((n) => n.id === id)?.name).join(', ')}
                  {th.reviewBy ? t(' · review by {date}', { date: th.reviewBy }) : ''}
                </div>
              </div>
            ))}
            <div className="tiny sub" style={{ marginTop: 6 }}>
              {t('Thesis edits are draft changes: commit them so the history shows when your thesis or its invalidation condition changed.')}
            </div>
          </div>
          <div className="card">
            <h2>{t('Recent Research Updates')}</h2>
            {recent.map((r) => {
              const h = r.impact?.headline.targetPrice.find((x) => x.scenario === 'base');
              return (
                <div key={r.id} className="row small" style={{ padding: '4px 0', borderBottom: '1px dashed var(--line)' }}>
                  <a href={`#/p/${projectId}/history/${r.id}`}>
                    #{r.seq} {r.title}
                  </a>
                  <span className="sub nowrap">{r.asOfDate ?? ''}</span>
                  <span className="right num">{h && h.before !== null && h.after !== null ? <Delta before={h.before} after={h.after} /> : ''}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="col" style={{ gap: 14 }}>
          <div className="card">
            <div className="row">
              <h2>{t('Upcoming catalysts')}</h2>
              <a className="right small" href={`#/p/${projectId}/catalysts`}>
                {t('all →')}
              </a>
            </div>
            {upcoming.length === 0 && <div className="small sub">{t('None scheduled.')}</div>}
            {upcoming.map((c) => (
              <div key={c.id} className="row small" style={{ padding: '3px 0' }}>
                <span className="num sub" style={{ width: 90 }}>
                  {c.expectedDate ?? t('undated')}
                </span>
                <span className="grow">{c.title}</span>
              </div>
            ))}
          </div>
          <div className="card">
            <h2>{t('Research journal')}</h2>
            <textarea rows={3} style={{ width: '100%' }} placeholder={t('Dated note: meeting takeaways, open questions, to-dos…')} value={note} onChange={(e) => setNote(e.target.value)} data-testid="journal-input" />
            <div className="row" style={{ margin: '6px 0 10px' }}>
              <button
                className="btn sm primary"
                disabled={!note.trim()}
                onClick={async () => {
                  await api.createNote(projectId, note);
                  setNote('');
                  await refresh('notes');
                }}
              >
                {t('Add note')}
              </button>
            </div>
            {notes.map((n) => (
              <div key={n.id} className="hist-item">
                <div className="tiny sub">{fmtDateTime(n.createdAt)}</div>
                <InlineText multiline value={n.body} onCommit={async (v) => (await api.updateNote(n.id, v), refresh('notes'))} />
              </div>
            ))}
          </div>
          <div className="card">
            <h2>{t('Research coverage')}</h2>
            <div className="small">
              {t('{items} evidence items · {links} evidence links · {updates} Research Updates · {formulas} formulas', {
                items: evidence.filter((e) => !e.archivedAt).length,
                links: state.links.length,
                updates: revisions.length,
                formulas: state.nodes.filter((n) => n.formula).length,
              })}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => navigate({ page: 'project', projectId, tab: 'model' })}>
                {t('Open model →')}
              </button>
              <button className="btn sm" onClick={() => navigate({ page: 'project', projectId, tab: 'history', param: 'evolution' })}>
                {t('Estimate evolution →')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
