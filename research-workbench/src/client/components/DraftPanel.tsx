import { useEffect, useMemo, useState } from 'react';
import { formatValue } from '../../domain/format';
import { findByRole } from '../../domain/model/tree';
import { describeChange } from '../../domain/revision/describe';
import { changeNodeId, type ModelChange } from '../../domain/revision/diff';
import { actorLabel } from '../../shared/actors';
import type { DraftOpRowDTO, RevisionFull } from '../../shared/api';
import { api } from '../lib/api';
import { diffOf, impactOf } from '../lib/derived';
import { KIND_ICON } from '../lib/evidence';
import { getLang, t, tm, tn, useLang } from '../lib/i18n';
import { useAdvanced } from '../lib/prefs';
import { useWorkspace } from '../lib/store';
import { cls, fmtDateTime, periodLabelFn, today } from '../lib/util';
import { ImpactView } from './ImpactView';
import { Advanced, Delta, Field } from './ui';

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
  const conflict = useWorkspace((s) => s.conflict);
  const hasOps = useWorkspace((s) => !!s.lastOp);
  const { setDraftPanelOpen, undo, redo, discard, load, projectId } = useWorkspace.getState();
  const [committed, setCommitted] = useState<RevisionFull | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
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
        {saveStatus === 'conflict' && !conflict && (
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
          {hasOps && (
            <button className={cls('btn sm ghost', historyOpen && 'on')} onClick={() => setHistoryOpen(!historyOpen)} title={t('Every write to this draft, by whom; recover an earlier draft')} data-testid="draft-history">
              {t('Draft history')}
            </button>
          )}
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
      {conflict && <ConflictBox />}
      {historyOpen && <DraftHistory onClose={() => setHistoryOpen(false)} />}
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
  const adv = useAdvanced();
  const lang = useLang();
  const draft = useWorkspace((s) => s.draft);
  const evidence = useWorkspace((s) => s.evidence);
  const head = useWorkspace((s) => s.head);
  const revisions = useWorkspace((s) => s.revisions);
  const restoredFrom = useWorkspace((s) => s.restoredFrom);
  const { commit, toast, setDraftPanelOpen } = useWorkspace.getState();
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
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
  // Prefilled title from the first real change ("{first} etc. ({n} changes)"); typing replaces it.
  const autoTitle = useMemo(() => {
    if (!changes.length) return '';
    const main = changes.find((c) => !c.type.startsWith('link_') && c.type !== 'notes_changed') ?? changes[0];
    const first = describeChange(main, { periodLabel: periodLabelFn(draft), evidenceTitle: (id) => evidence.find((e) => e.id === id)?.title ?? t('evidence'), lang: getLang() }).slice(0, 100);
    return changes.length > 1 ? t('{first} etc. ({n} changes)', { first, n: changes.length }) : first;
  }, [changes, draft, evidence, lang]);
  const effectiveTitle = titleTouched ? title : autoTitle;
  const lastAsOf = [...revisions].reverse().find((r) => r.asOfDate)?.asOfDate ?? null;
  const checkpoint = changes.length === 0;
  const list = evidence.filter((e) => !filter || `${e.title} ${e.sourceName}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
  const citedIds = adv ? [...cited] : newlyLinked;
  const lookAhead = evidence.filter((e) => citedIds.includes(e.id) && e.publishedAt && e.publishedAt > asOf);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      // Basic mode has no checklist: cite exactly the evidence linked in this draft.
      const rev = await commit({ title: effectiveTitle, reason, notes, asOfDate: asOf, evidenceIds: citedIds, kind: restoredFrom ? 'restore' : undefined });
      toast(t('Research Update #{seq} committed', { seq: rev.seq }), 'success');
      setTitle('');
      setTitleTouched(false);
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
        <input
          value={effectiveTitle}
          placeholder={checkpoint ? t('e.g. Q3 results reviewed — thesis intact') : t('e.g. Customer qualification confirmed; capacity guidance raised')}
          onChange={(e) => (setTitle(e.target.value), setTitleTouched(true))}
          data-testid="commit-title"
        />
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
      <Advanced>
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
      </Advanced>
      {lookAhead.length > 0 && <div className="msg warn">{t('Published after the knowledge date: {titles}. Move the date or deselect it.', { titles: lookAhead.map((e) => e.title).join(', ') })}</div>}
      <Advanced>
        <Field label={t('Notes (optional)')}>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </Advanced>
      {error && <div className="msg err">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !effectiveTitle.trim() || !reason.trim()} onClick={() => void submit()} data-testid="commit-submit">
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

/** The draft was changed elsewhere and some of this tab's edits could not be re-applied: choose a version. */
function ConflictBox() {
  const conflict = useWorkspace((s) => s.conflict)!;
  const { resolveConflict, downloadMine } = useWorkspace.getState();
  return (
    <div className="draft-conflict" data-testid="draft-conflict">
      <div className="msg warn">
        <b>{t('The draft was changed elsewhere while you were editing.')}</b> {t('{applied} of your edits were re-applied; {n} conflict:', { applied: conflict.applied, n: conflict.failed.length })}
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {conflict.failed.slice(0, 20).map((f, i) => (
            <li key={i}>{f}</li>
          ))}
          {conflict.failed.length > 20 && <li>{t('…and {n} more', { n: conflict.failed.length - 20 })}</li>}
        </ul>
      </div>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <button className="btn sm primary" onClick={() => resolveConflict('rebased')} data-testid="conflict-rebased">
          {t('Use the latest version and re-apply the edits that fit')}
        </button>
        <button
          className="btn sm"
          onClick={() => {
            if (window.confirm(t('Drop your conflicting edits and use the latest version? Download your version first if you may need it.'))) resolveConflict('theirs');
          }}
          data-testid="conflict-theirs"
        >
          {t('Drop my edits')}
        </button>
        <button className="btn sm ghost" onClick={downloadMine} data-testid="conflict-download">
          {t('Download my version')}
        </button>
        <span className="small sub">{t('Editing is paused until you choose.')}</span>
      </div>
    </div>
  );
}

const OP_LABEL: Record<DraftOpRowDTO['kind'], string> = {
  save: 'Edited in the browser',
  ops: 'Edited by AI tools',
  discard: 'Discarded the draft',
  restore: 'Restored an earlier Research Update into the draft',
  recover: 'Recovered an earlier draft',
  commit: 'Committed a Research Update',
};

/** Every write to the draft (who, what), with "go back to before this step" where the earlier draft is kept. */
function DraftHistory({ onClose }: { onClose: () => void }) {
  const projectId = useWorkspace((s) => s.projectId);
  const draftVersion = useWorkspace((s) => s.draftVersion);
  const { recover, toast } = useWorkspace.getState();
  const [rows, setRows] = useState<DraftOpRowDTO[] | null>(null);
  const lang = useLang();
  useEffect(() => {
    if (!projectId) return;
    api
      .draftOps(projectId, { limit: 20 })
      .then(setRows)
      .catch((e) => toast(tm((e as Error).message), 'error'));
  }, [projectId, draftVersion]);
  return (
    <div className="draft-history" data-testid="draft-history-list">
      <div className="row">
        <b className="small">{t('Draft history')}</b>
        <span className="tiny sub">{t('newest first')}</span>
        <button className="btn xs ghost right" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
      {rows === null && <div className="small sub">{t('Loading…')}</div>}
      {rows?.length === 0 && <div className="small sub">{t('No draft history yet.')}</div>}
      <table className="grid" style={{ marginTop: 4 }}>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id} data-testid="draft-op">
              <td className="l nowrap small sub">{fmtDateTime(r.at)}</td>
              <td className="l nowrap small">{actorLabel(r.actor, lang)}</td>
              <td className="l small">
                {t(OP_LABEL[r.kind])}
                {(r.kind === 'save' || r.kind === 'ops') && ` · ${tn(r.changeCount, '{n} change', '{n} changes')}`}
                {r.kind === 'ops' && r.summary && <span className="sub"> · {r.summary}</span>}
              </td>
              <td className="r nowrap">
                {r.hasBefore && (
                  <button
                    className="btn xs"
                    onClick={async () => {
                      if (!window.confirm(t('Replace the current draft with the draft as it was before this step? The current draft stays in this history.'))) return;
                      await recover(r.id);
                    }}
                    data-testid="recover-op"
                  >
                    {r.kind === 'discard' ? t('Recover the discarded draft') : t('Go back to before this step')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
