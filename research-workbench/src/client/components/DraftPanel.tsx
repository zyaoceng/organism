import { useEffect, useMemo, useState } from 'react';
import { formatValue } from '../../domain/format';
import { findByRole } from '../../domain/model/tree';
import { describeChange } from '../../domain/revision/describe';
import { changeNodeId, type ModelChange } from '../../domain/revision/diff';
import type { RevisionFull } from '../../shared/api';
import { diffOf, impactOf } from '../lib/derived';
import { KIND_ICON } from '../lib/evidence';
import { getLang, t, tm, tn, useLang } from '../lib/i18n';
import { useWorkspace } from '../lib/store';
import { cls, periodLabelFn, today } from '../lib/util';
import { ImpactView } from './ImpactView';
import { Delta, Field } from './ui';

/** Bottom panel: pending draft changes, live downstream impact and the Commit Research Update form. */
export function DraftPanel() {
  const draft = useWorkspace((s) => s.draft);
  const head = useWorkspace((s) => s.head);
  const viewing = useWorkspace((s) => s.viewing);
  const open = useWorkspace((s) => s.draftPanelOpen);
  const saveStatus = useWorkspace((s) => s.saveStatus);
  const saveError = useWorkspace((s) => s.saveError);
  const undoLen = useWorkspace((s) => s.undoStack.length);
  const redoLen = useWorkspace((s) => s.redoStack.length);
  const scenario = useWorkspace((s) => s.scenario);
  const { setDraftPanelOpen, undo, redo, discard, load, projectId } = useWorkspace.getState();
  const [committed, setCommitted] = useState<RevisionFull | null>(null);
  useLang();

  if (!draft || !head || viewing) return null;
  const changes = diffOf(head.state, draft);
  const tp = findByRole(draft, 'target_price');
  const impact = changes.length ? impactOf(head.state, draft) : null;
  const tpH = impact?.headline.targetPrice.find((h) => h.scenario === scenario);

  const saveLabel = t({ saved: 'Draft saved', pending: 'Saving…', saving: 'Saving…', error: 'Save failed', conflict: 'Changed elsewhere' }[saveStatus]);

  return (
    <div className="draftbar" data-testid="draft-panel">
      <div className="draft-strip">
        <span className="row" title={saveError ? tm(saveError) : t('Every edit is autosaved as a draft. Commit to make it part of the research record.')}>
          <span className={cls('save-dot', saveStatus)} /> <span className="small sub">{saveLabel}</span>
        </span>
        {saveStatus === 'conflict' && (
          <button className="btn sm" onClick={() => projectId && void load(projectId)}>
            {t('Reload latest')}
          </button>
        )}
        <span className="count" data-testid="draft-count">
          {changes.length === 0 ? t('No draft changes') : tn(changes.length, '{n} draft change', '{n} draft changes')}
        </span>
        {tpH && tpH.before !== tpH.after && (
          <span className="small">
            {t('Target price ({scenario}):', { scenario: t(scenario) })} <b className="num">{formatValue(tpH.before, tp?.unit)}</b> → <b className="num">{formatValue(tpH.after, tp?.unit)}</b> <Delta before={tpH.before} after={tpH.after} />
          </span>
        )}
        <span className="right row">
          <button className="btn sm ghost" disabled={!undoLen} onClick={undo} title={t('Undo (Ctrl+Z)')}>
            {t('↶ Undo')}
          </button>
          <button className="btn sm ghost" disabled={!redoLen} onClick={redo} title={t('Redo (Ctrl+Shift+Z)')}>
            {t('↷ Redo')}
          </button>
          {changes.length > 0 && (
            <button
              className="btn sm danger"
              onClick={() => {
                if (window.confirm(t('Discard all {n} draft changes and return to Research Update #{seq}?', { n: changes.length, seq: head.seq }))) void discard();
              }}
            >
              {t('Discard')}
            </button>
          )}
          <button className={cls('btn sm', !open && 'primary')} onClick={() => (setCommitted(null), setDraftPanelOpen(!open))} data-testid="toggle-draft">
            {open ? t('Close ▾') : changes.length ? t('Review & commit ▴') : t('Checkpoint ▴')}
          </button>
        </span>
      </div>
      {open && (
        <div className="draft-body">
          <div>
            {committed ? (
              <CommittedSummary rev={committed} />
            ) : changes.length === 0 ? (
              <div className="empty">
                {t('No changes since Research Update #{seq}. You can still record a', { seq: head.seq })} <b>{t('checkpoint')}</b>
                {t(': a dated note that you reviewed new information and your view did not change.')}
              </div>
            ) : (
              <>
                <h3 style={{ marginBottom: 8 }}>{t('What changed')}</h3>
                <ChangeList changes={changes} />
                <div className="divider" />
                <h3 style={{ margin: '8px 0' }}>{t('Downstream impact (preview)')}</h3>
                {impact && <ImpactView impact={impact} state={draft} initialScenario={scenario} />}
              </>
            )}
          </div>
          <div>
            <CommitForm changes={changes} onCommitted={setCommitted} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ChangeList({ changes }: { changes: ModelChange[] }) {
  const draft = useWorkspace((s) => s.draft);
  const evidence = useWorkspace((s) => s.evidence);
  const { select } = useWorkspace.getState();
  const pl = periodLabelFn(draft);
  const lang = useLang();
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; nodeId: string | null; items: ModelChange[] }>();
    for (const c of changes) {
      const nid = changeNodeId(c);
      const key = nid ?? c.type.split('_')[0];
      let g = m.get(key);
      if (!g) {
        const title = nid
          ? draft?.nodes.find((n) => n.id === nid)?.name ?? ('name' in c ? c.name : nid)
          : c.type.startsWith('period')
            ? t('Periods')
            : c.type.startsWith('thesis')
              ? t('Theses')
              : c.type.startsWith('valuation')
                ? t('Valuation context')
                : t('Structure');
        m.set(key, (g = { title, nodeId: nid, items: [] }));
      }
      g.items.push(c);
    }
    return [...m.values()];
  }, [changes, draft, lang]);
  return (
    <div data-testid="change-list">
      {groups.map((g, i) => (
        <div key={i} className="change-group">
          <div className="gh" onClick={() => g.nodeId && select(g.nodeId)}>
            {g.title} <span className="faint small">({g.items.length})</span>
          </div>
          <ul>
            {g.items.slice(0, 30).map((c, k) => (
              <li key={k}>{describeChange(c, { periodLabel: pl, evidenceTitle: (id) => evidence.find((e) => e.id === id)?.title ?? t('evidence'), lang: getLang() })}</li>
            ))}
            {g.items.length > 30 && <li className="sub">{t('…and {n} more', { n: g.items.length - 30 })}</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CommitForm({ changes, onCommitted }: { changes: ModelChange[]; onCommitted: (r: RevisionFull) => void }) {
  const evidence = useWorkspace((s) => s.evidence);
  const head = useWorkspace((s) => s.head);
  const revisions = useWorkspace((s) => s.revisions);
  const restoredFrom = useWorkspace((s) => s.restoredFrom);
  const { commit, toast, setDraftPanelOpen } = useWorkspace.getState();
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [cited, setCited] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newlyLinked = useMemo(() => [...new Set(changes.filter((c) => c.type === 'link_added').map((c) => (c as { evidenceId: string }).evidenceId))], [changes]);
  useEffect(() => {
    setCited((prev) => new Set([...prev, ...newlyLinked]));
  }, [newlyLinked]);
  const lastAsOf = [...revisions].reverse().find((r) => r.asOfDate)?.asOfDate ?? null;
  const checkpoint = changes.length === 0;
  const list = evidence.filter((e) => !filter || `${e.title} ${e.sourceName}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
  const lookAhead = evidence.filter((e) => cited.has(e.id) && e.publishedAt && e.publishedAt > asOf);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const rev = await commit({ title, reason, notes, asOfDate: asOf, evidenceIds: [...cited], kind: restoredFrom ? 'restore' : undefined });
      toast(t('Research Update #{seq} committed', { seq: rev.seq }), 'success');
      setTitle('');
      setReason('');
      setNotes('');
      setCited(new Set());
      onCommitted(rev);
    } catch (e) {
      setError(tm((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 8 }} data-testid="commit-form">
      <h3>{checkpoint ? t('Record a checkpoint') : t('Commit Research Update')}</h3>
      <div className="small sub">
        {checkpoint ? t('A dated record that you reviewed and kept your view.') : t('Becomes Research Update #{seq}. The previous state stays recoverable.', { seq: (head?.seq ?? 0) + 1 })}
        {restoredFrom && t(' This draft was restored from an earlier snapshot.')}
      </div>
      <Field label={t('Title')}>
        <input value={title} placeholder={checkpoint ? t('e.g. Q3 results reviewed — thesis intact') : t('e.g. Customer qualification confirmed; capacity guidance raised')} onChange={(e) => setTitle(e.target.value)} data-testid="commit-title" />
      </Field>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label={t('Knowledge date (what you knew as of)')}>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} data-testid="commit-asof" />
        </Field>
        {lastAsOf && <span className="tiny sub" style={{ paddingBottom: 6 }}>{t('previous: {date}', { date: lastAsOf })}</span>}
      </div>
      <Field label={t('Reason / interpretation — why the view changed')}>
        <textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('Evidence → interpretation → which assumptions and why this magnitude')} data-testid="commit-reason" />
      </Field>
      <div className="field">
        <span className="small sub">{t('Evidence behind this update ({n} selected)', { n: cited.size })}</span>
        <input type="search" placeholder={t('Filter evidence…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6, background: '#fff' }}>
          {list.length === 0 && <div className="small sub" style={{ padding: 8 }}>{t('No evidence yet. Attach sources to nodes in the inspector.')}</div>}
          {list.map((e) => (
            <label key={e.id} className="row small" style={{ padding: '4px 8px', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={cited.has(e.id)}
                onChange={(ev) => {
                  const next = new Set(cited);
                  if (ev.target.checked) next.add(e.id);
                  else next.delete(e.id);
                  setCited(next);
                }}
              />
              <span>{KIND_ICON[e.kind]}</span>
              <span className="grow ellipsis">{e.title}</span>
              {newlyLinked.includes(e.id) && <span className="badge accent">{t('linked now')}</span>}
              <span className="faint tiny nowrap">{e.publishedAt ?? ''}</span>
            </label>
          ))}
        </div>
      </div>
      {lookAhead.length > 0 && <div className="msg warn">{t('Published after the knowledge date: {titles}. Move the date or deselect it.', { titles: lookAhead.map((e) => e.title).join(', ') })}</div>}
      <Field label={t('Notes (optional)')}>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {error && <div className="msg err">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !title.trim() || !reason.trim()} onClick={() => void submit()} data-testid="commit-submit">
          {busy ? t('Committing…') : checkpoint ? t('Record checkpoint') : t('Commit Research Update')}
        </button>
        <button className="btn ghost" onClick={() => setDraftPanelOpen(false)}>
          {t('Later')}
        </button>
      </div>
    </div>
  );
}

function CommittedSummary({ rev }: { rev: RevisionFull }) {
  const projectId = useWorkspace((s) => s.projectId);
  return (
    <div className="col" style={{ gap: 10 }} data-testid="committed-summary">
      <div className="msg ok">
        {t('Research Update')} <b>#{rev.seq}</b>{' '}
        {t('“{title}” committed ({kind}, knowledge date {date}).', { title: rev.title, kind: t(rev.kind), date: rev.asOfDate })}{' '}
        {t('{n} changes.', { n: rev.changes.length })}{' '}
        <a href={`#/p/${projectId}/history/${rev.id}`}>{t('Open in History')}</a>
      </div>
      {rev.impact ? <ImpactView impact={rev.impact} state={rev.state} /> : <div className="small sub">{t('Checkpoint: no model changes.')}</div>}
    </div>
  );
}
