import { useState } from 'react';
import { CATALYST_TYPES, type CatalystDTO } from '../../shared/api';
import { Field } from '../components/ui';
import { api } from '../lib/api';
import { t, tm } from '../lib/i18n';
import { useWorkspace } from '../lib/store';
import { cls, today } from '../lib/util';

const STATUS = ['upcoming', 'occurred', 'delayed', 'cancelled'] as const;

export function CatalystsPage() {
  const catalysts = useWorkspace((s) => s.catalysts);
  const [creating, setCreating] = useState(false);
  const now = today();
  const upcoming = catalysts.filter((c) => c.status === 'upcoming' || c.status === 'delayed').sort((a, b) => (a.expectedDate ?? '9999').localeCompare(b.expectedDate ?? '9999'));
  const past = catalysts.filter((c) => c.status === 'occurred' || c.status === 'cancelled').sort((a, b) => (b.actualDate ?? b.expectedDate ?? '').localeCompare(a.actualDate ?? a.expectedDate ?? ''));
  return (
    <div className="page" data-testid="catalysts-page">
      <div className="page-head">
        <h1>{t('Catalysts')}</h1>
        <span className="sub">{t('Dated events linked to the model. Write the expected outcome before the event; edits are kept in the audit log.')}</span>
        <button className="btn primary right" onClick={() => setCreating(!creating)} data-testid="new-catalyst">
          {t('+ Catalyst')}
        </button>
      </div>
      {creating && <CatalystForm onDone={() => setCreating(false)} />}
      <TimelineStrip catalysts={upcoming} now={now} />
      <h2 style={{ margin: '16px 0 8px' }}>{t('Upcoming ({n})', { n: upcoming.length })}</h2>
      {upcoming.length === 0 && <div className="empty">{t('No upcoming catalysts.')}</div>}
      {upcoming.map((c) => (
        <CatalystCard key={c.id} c={c} overdue={!!c.expectedDate && c.expectedDate < now} />
      ))}
      <h2 style={{ margin: '16px 0 8px' }}>{t('Past ({n})', { n: past.length })}</h2>
      {past.map((c) => (
        <CatalystCard key={c.id} c={c} />
      ))}
    </div>
  );
}

function TimelineStrip({ catalysts, now }: { catalysts: CatalystDTO[]; now: string }) {
  const dated = catalysts.filter((c) => c.expectedDate);
  if (!dated.length) return null;
  const start = Date.parse(now);
  const end = Math.max(start + 90 * 86400000, ...dated.map((c) => Date.parse(c.expectedDate!))) + 7 * 86400000;
  const x = (d: string) => `${Math.max(0, Math.min(100, ((Date.parse(d) - start) / (end - start)) * 100))}%`;
  const months: string[] = [];
  for (let d = new Date(start); d.getTime() < end; d.setMonth(d.getMonth() + 1)) months.push(new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10));
  return (
    <div className="card" style={{ position: 'relative', height: 92, padding: '10px 16px' }}>
      <div style={{ position: 'absolute', left: 16, right: 16, top: 46, height: 2, background: 'var(--line2)' }} />
      <div style={{ position: 'absolute', left: 16, right: 16, top: 0, bottom: 0 }}>
        {months.map((m) => (
          <div key={m} className="tiny sub" style={{ position: 'absolute', left: x(m), top: 56 }}>
            {m.slice(0, 7)}
          </div>
        ))}
        {dated.map((c, i) => (
          <div key={c.id} title={`${c.expectedDate} ${c.title}\n${t('Expected: {outcome}', { outcome: c.expectedOutcome })}`} style={{ position: 'absolute', left: x(c.expectedDate!), top: i % 2 ? 26 : 8, transform: 'translateX(-4px)' }}>
            <div style={{ width: 9, height: 9, borderRadius: 5, background: c.expectedDate! < now ? 'var(--warn)' : 'var(--accent)', margin: '0 0 2px' }} />
            <div className="tiny nowrap" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.title}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CatalystCard({ c, overdue }: { c: CatalystDTO; overdue?: boolean }) {
  const [open, setOpen] = useState(false);
  const draft = useWorkspace((s) => s.draft)!;
  const revisions = useWorkspace((s) => s.revisions);
  const nodes = c.nodeIds.map((id) => draft.nodes.find((n) => n.id === id)?.name).filter(Boolean);
  const rev = revisions.find((r) => r.id === c.revisionId);
  if (open) return <CatalystForm existing={c} onDone={() => setOpen(false)} />;
  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={() => setOpen(true)} data-testid="catalyst-card">
      <div className="row">
        <span className="num sub nowrap" style={{ width: 96 }}>
          {c.actualDate ?? c.expectedDate ?? t('undated')}
          {c.datePrecision !== 'day' && !c.actualDate ? ` (${t(c.datePrecision)})` : ''}
        </span>
        <b className="grow">{c.title}</b>
        <span className="badge">{t(CATALYST_TYPES.find((ct) => ct.value === c.type)?.label ?? c.type)}</span>
        <span className={cls('badge', c.status === 'occurred' ? 'accent' : c.status === 'upcoming' ? '' : 'warn')}>{t(c.status)}</span>
        {overdue && <span className="badge warn">{t('date passed — update status')}</span>}
      </div>
      <div className="small" style={{ marginTop: 4 }}>
        <span className="sub">{t('Expected: ')}</span>
        {c.expectedOutcome || '—'}
      </div>
      {c.actualOutcome && (
        <div className="small">
          <span className="sub">{t('Actual: ')}</span>
          {c.actualOutcome}
        </div>
      )}
      <div className="tiny sub" style={{ marginTop: 4 }}>
        {nodes.length ? t('Nodes: {list}', { list: nodes.join(', ') }) : t('No linked nodes')}
        {c.evidenceIds.length ? ` · ${t('{n} evidence', { n: c.evidenceIds.length })}` : ''}
        {rev ? ` · ${t('model impact: Research Update #{seq}', { seq: rev.seq })}` : ''}
      </div>
    </div>
  );
}

function CatalystForm({ existing, onDone }: { existing?: CatalystDTO; onDone: () => void }) {
  const projectId = useWorkspace((s) => s.projectId)!;
  const draft = useWorkspace((s) => s.draft)!;
  const evidence = useWorkspace((s) => s.evidence);
  const revisions = useWorkspace((s) => s.revisions);
  const { refresh, toast } = useWorkspace.getState();
  const [f, setF] = useState<Partial<CatalystDTO>>(existing ?? { title: '', type: 'earnings', datePrecision: 'day', status: 'upcoming', expectedOutcome: '', actualOutcome: '', notes: '', nodeIds: [], evidenceIds: [], revisionId: null });
  const save = async () => {
    try {
      if (existing) await api.updateCatalyst(existing.id, f);
      else await api.createCatalyst(projectId, f);
      await refresh('catalysts');
      onDone();
    } catch (e) {
      toast(tm((e as Error).message), 'error');
    }
  };
  const toggle = (k: 'nodeIds' | 'evidenceIds', id: string) => setF({ ...f, [k]: (f[k] ?? []).includes(id) ? (f[k] ?? []).filter((x) => x !== id) : [...(f[k] ?? []), id] });
  return (
    <div className="card" data-testid="catalyst-form">
      <h2>{existing ? t('Edit catalyst') : t('New catalyst')}</h2>
      <div className="col">
        <div className="three">
          <Field label={t('Title')}>
            <input value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} data-testid="cat-title" />
          </Field>
          <Field label={t('Type')}>
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              {CATALYST_TYPES.map((ct) => (
                <option key={ct.value} value={ct.value}>
                  {t(ct.label)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Status')}>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as CatalystDTO['status'] })}>
              {STATUS.map((s) => (
                <option key={s} value={s}>
                  {t(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Expected date')}>
            <input type="date" value={f.expectedDate ?? ''} onChange={(e) => setF({ ...f, expectedDate: e.target.value || null })} data-testid="cat-date" />
          </Field>
          <Field label={t('Date precision')}>
            <select value={f.datePrecision} onChange={(e) => setF({ ...f, datePrecision: e.target.value as CatalystDTO['datePrecision'] })}>
              <option value="day">{t('day')}</option>
              <option value="month">{t('month')}</option>
              <option value="quarter">{t('quarter')}</option>
            </select>
          </Field>
          <Field label={t('Actual date')}>
            <input type="date" value={f.actualDate ?? ''} onChange={(e) => setF({ ...f, actualDate: e.target.value || null })} />
          </Field>
        </div>
        <div className="two">
          <Field label={t('Expected outcome (write before the event)')}>
            <textarea rows={3} value={f.expectedOutcome ?? ''} onChange={(e) => setF({ ...f, expectedOutcome: e.target.value })} data-testid="cat-expected" />
          </Field>
          <Field label={t('Actual outcome')}>
            <textarea rows={3} value={f.actualOutcome ?? ''} onChange={(e) => setF({ ...f, actualOutcome: e.target.value })} />
          </Field>
        </div>
        <Field label={t('Notes')}>
          <textarea rows={2} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <div className="field">
          <span className="small sub">{t('Related nodes')}</span>
          <div className="chips">
            {draft.nodes
              .filter((n) => n.unit)
              .map((n) => (
                <span key={n.id} className={cls('chip', f.nodeIds?.includes(n.id) && 'in')} style={f.nodeIds?.includes(n.id) ? { background: 'var(--accent-bg)' } : undefined} onClick={() => toggle('nodeIds', n.id)}>
                  {n.name}
                </span>
              ))}
          </div>
        </div>
        {evidence.length > 0 && (
          <div className="field">
            <span className="small sub">{t('Related evidence')}</span>
            <div className="chips">
              {evidence.map((e) => (
                <span key={e.id} className="chip" style={f.evidenceIds?.includes(e.id) ? { background: 'var(--accent-bg)' } : undefined} onClick={() => toggle('evidenceIds', e.id)}>
                  {e.title}
                </span>
              ))}
            </div>
          </div>
        )}
        <Field label={t('Model impact (the Research Update this catalyst caused)')}>
          <select value={f.revisionId ?? ''} onChange={(e) => setF({ ...f, revisionId: e.target.value || null })}>
            <option value="">—</option>
            {revisions.map((r) => (
              <option key={r.id} value={r.id}>
                #{r.seq} {r.title}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <button className="btn primary" disabled={!f.title?.trim()} onClick={() => void save()} data-testid="cat-save">
            {t('Save')}
          </button>
          <button className="btn ghost" onClick={onDone}>
            {t('Cancel')}
          </button>
          {existing && (
            <button
              className="btn danger right"
              onClick={async () => {
                if (!window.confirm(t('Delete this catalyst? (kept in the audit log)'))) return;
                await api.deleteCatalyst(existing.id);
                await refresh('catalysts');
                onDone();
              }}
            >
              {t('Delete')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
