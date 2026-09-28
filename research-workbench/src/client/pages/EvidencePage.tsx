import { useEffect, useMemo, useState } from 'react';
import { addLink } from '../../domain/model/ops';
import { LINK_RELATIONS, type LinkRelation } from '../../domain/model/types';
import { SOURCE_TYPES, type AuditEntryDTO, type EvidenceDTO } from '../../shared/api';
import { Field } from '../components/ui';
import { api } from '../lib/api';
import { createAndLink, KIND_ICON, namedScreenshot } from '../lib/evidence';
import { t, tm } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useWorkspace } from '../lib/store';
import { cls, fmtDateTime } from '../lib/util';

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function EvidencePage({ param }: { param?: string }) {
  const evidence = useWorkspace((s) => s.evidence);
  const projectId = useWorkspace((s) => s.projectId)!;
  const draft = useWorkspace((s) => s.draft)!;
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [archived, setArchived] = useState(false);
  const [sel, setSel] = useState<string | null>(param ?? null);
  useEffect(() => {
    if (param) setSel(param);
  }, [param]);
  const list = useMemo(
    () =>
      evidence.filter(
        (e) =>
          (archived || !e.archivedAt) &&
          (!type || e.sourceType === type) &&
          (!q || `${e.title} ${e.sourceName} ${e.notes} ${e.url ?? ''}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [evidence, q, type, archived],
  );
  const linkCount = (id: string) => draft.links.filter((l) => l.evidenceId === id).length;
  const selected = evidence.find((e) => e.id === sel);
  return (
    <div className="page" style={{ maxWidth: 1500 }}>
      <div className="page-head">
        <h1>{t('Evidence')}</h1>
        <span className="sub">{t('Sources are facts; assumptions live in the model. Link evidence to the nodes it supports or contradicts.')}</span>
        <button className="btn primary right" onClick={() => setSel(null)} data-testid="add-evidence">
          {t('+ Add evidence')}
        </button>
      </div>
      <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) 480px' }}>
        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
            <input type="search" className="grow" placeholder={t('Search title, source, notes, URL')} value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">{t('All source types')}</option>
              {SOURCE_TYPES.map((st) => (
                <option key={st.value} value={st.value}>
                  {t(st.label)}
                </option>
              ))}
            </select>
            <label className="small sub row" style={{ gap: 4 }}>
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t('archived')}
            </label>
          </div>
          {list.length === 0 && <div className="empty" style={{ margin: 12 }}>{q || type ? t('No evidence matches.') : t('No evidence yet.')}</div>}
          {list.map((e) => (
            <div key={e.id} className={cls('list-row', sel === e.id && 'sel')} onClick={() => setSel(e.id)} data-testid="evidence-row">
              <span style={{ fontSize: 16 }}>{KIND_ICON[e.kind]}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row">
                  <b className="ellipsis">{e.title}</b>
                  {e.archivedAt && <span className="badge">{t('archived')}</span>}
                  {e.verification && <span className={cls('badge', e.verification === 'verified' ? 'accent' : e.verification === 'disputed' ? 'err' : '')}>{t(e.verification)}</span>}
                </div>
                <div className="tiny sub">
                  {[t(SOURCE_TYPES.find((st) => st.value === e.sourceType)?.label ?? ''), e.sourceName, e.publishedAt && t('published {date}', { date: e.publishedAt }), t('added {date}', { date: e.addedAt.slice(0, 10) })].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
                {linkCount(e.id) > 0 && <span className="badge accent">{t('{n} node link(s)', { n: linkCount(e.id) })}</span>}
                {e.revisionRefs.some((r) => r.kind === 'cited') && <span className="badge">{t('cited in #{list}', { list: e.revisionRefs.filter((r) => r.kind === 'cited').map((r) => r.seq).join(', #') })}</span>}
              </div>
            </div>
          ))}
        </div>
        <div>{selected ? <EvidenceDetail key={selected.id} ev={selected} /> : <AddEvidence projectId={projectId} onCreated={(e) => (setSel(e.id), navigate({ page: 'project', projectId, tab: 'evidence', param: e.id }))} />}</div>
      </div>
    </div>
  );
}

function AddEvidence({ projectId, onCreated }: { projectId: string; onCreated: (e: EvidenceDTO) => void }) {
  const draft = useWorkspace((s) => s.draft)!;
  const [title, setTitle] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceType, setSourceType] = useState('news');
  const [url, setUrl] = useState('');
  const [publishedAt, setPublishedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [nodeId, setNodeId] = useState('');
  const [relation, setRelation] = useState<LinkRelation>('supports');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const fields = { title, sourceName, sourceType, url, publishedAt, notes };
    const created = await createAndLink(
      async () => {
        if (files.length) {
          const fd = new FormData();
          for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
          files.forEach((f) => fd.append('file', f.type.startsWith('image/') ? namedScreenshot(f) : f, f.name));
          return [await api.createEvidence(projectId, fd)];
        }
        return [await api.createEvidence(projectId, { ...fields, url: url || null, publishedAt: publishedAt || null })];
      },
      nodeId || null,
      relation,
    );
    setBusy(false);
    if (created[0]) onCreated(created[0]);
  };
  return (
    <div
      className="card"
      data-testid="add-evidence-form"
      onPaste={(e) => {
        const f = [...e.clipboardData.files].filter((x) => x.type.startsWith('image/'));
        if (f.length) {
          e.preventDefault();
          setFiles([...files, ...f.map(namedScreenshot)]);
          if (!title) setTitle(namedScreenshot(f[0]).name);
          setSourceType('screenshot');
        }
      }}
    >
      <h2>{t('Add evidence')}</h2>
      <div className="col">
        <Field label={t('Title')}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('e.g. Q2 earnings call — capacity guidance')} data-testid="ev-title" />
        </Field>
        <div className="two">
          <Field label={t('Source type')}>
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              {SOURCE_TYPES.map((st) => (
                <option key={st.value} value={st.value}>
                  {t(st.label)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Source / publisher / speaker')}>
            <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder={t('Company IR, DIGITIMES, broker…')} />
          </Field>
        </div>
        <div className="two">
          <Field label={t('URL')}>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" data-testid="ev-url" />
          </Field>
          <Field label={t('Publication date')}>
            <input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} data-testid="ev-published" />
          </Field>
        </div>
        <Field label={t('What it says (excerpt / notes)')}>
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="field">
          <span className="small sub">{t('Files, PDFs, screenshots (or paste an image here)')}</span>
          <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          {files.length > 0 && <div className="tiny sub">{files.map((f) => f.name).join(', ')}</div>}
        </div>
        <div className="two">
          <Field label={t('Link to node (optional)')}>
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              <option value="">{t('— none —')}</option>
              {draft.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Relation')}>
            <select value={relation} onChange={(e) => setRelation(e.target.value as LinkRelation)}>
              {LINK_RELATIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {t(r.label)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button className="btn primary" disabled={busy || (!title.trim() && !url.trim() && !files.length)} onClick={() => void submit()} data-testid="ev-save">
          {busy ? t('Saving…') : t('Add to evidence library')}
        </button>
      </div>
    </div>
  );
}

function EvidenceDetail({ ev }: { ev: EvidenceDTO }) {
  const draft = useWorkspace((s) => s.draft)!;
  const projectId = useWorkspace((s) => s.projectId)!;
  const { upsertEvidence, edit, toast, refresh, select } = useWorkspace.getState();
  const [form, setForm] = useState({ title: ev.title, sourceName: ev.sourceName, sourceType: ev.sourceType as string, url: ev.url ?? '', publishedAt: ev.publishedAt ?? '', notes: ev.notes, verification: ev.verification ?? '' });
  const [audit, setAudit] = useState<AuditEntryDTO[]>([]);
  const [linkNode, setLinkNode] = useState('');
  useEffect(() => {
    void api.audit(projectId, ev.id).then(setAudit);
  }, [projectId, ev.id, ev.updatedAt]);
  const dirty =
    form.title !== ev.title ||
    form.sourceName !== ev.sourceName ||
    form.sourceType !== ev.sourceType ||
    form.url !== (ev.url ?? '') ||
    form.publishedAt !== (ev.publishedAt ?? '') ||
    form.notes !== ev.notes ||
    form.verification !== (ev.verification ?? '');
  const links = draft.links.filter((l) => l.evidenceId === ev.id);
  const save = async () => {
    try {
      upsertEvidence(await api.updateEvidence(ev.id, { ...form, url: form.url || null, publishedAt: form.publishedAt || null, verification: form.verification || null }));
      toast(t('Evidence updated (previous version kept in the audit log)'), 'success');
    } catch (e) {
      toast(tm((e as Error).message), 'error');
    }
  };
  return (
    <div className="col" style={{ gap: 12 }} data-testid="evidence-detail">
      <div className="card">
        <div className="row">
          <span style={{ fontSize: 18 }}>{KIND_ICON[ev.kind]}</span>
          <h2 className="grow">{ev.title}</h2>
        </div>
        {ev.attachments
          .filter((a) => a.mimeType.startsWith('image/'))
          .map((a) => (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
              <img className="thumb" style={{ maxHeight: 320, margin: '8px 0' }} src={a.url} alt={a.originalFilename} />
            </a>
          ))}
        {ev.attachments.length > 0 && (
          <div className="col" style={{ gap: 3, margin: '6px 0' }}>
            {ev.attachments.map((a) => (
              <div key={a.id} className="row small">
                <a href={a.url} target="_blank" rel="noreferrer" data-testid="attachment-link">
                  {a.originalFilename}
                </a>
                <span className="faint">
                  {fmtBytes(a.sizeBytes)} · {a.mimeType} · sha256 {a.sha256.slice(0, 10)}…
                </span>
                <a className="right" href={`${a.url}?download=1`}>
                  {t('download')}
                </a>
              </div>
            ))}
          </div>
        )}
        {ev.url && (
          <div className="small" style={{ margin: '4px 0' }}>
            <a href={ev.url} target="_blank" rel="noreferrer noopener">
              {ev.url}
            </a>
          </div>
        )}
        <label className="small sub">
          {t('Add file')}{' '}
          <input
            type="file"
            multiple
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              if (!files.length) return;
              const fd = new FormData();
              files.forEach((f) => fd.append('file', f, f.name));
              upsertEvidence(await api.addEvidenceFiles(ev.id, fd));
            }}
          />
        </label>
      </div>
      <div className="card">
        <div className="col">
          <Field label={t('Title')}>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <div className="two">
            <Field label={t('Source type')}>
              <select value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value })}>
                {SOURCE_TYPES.map((st) => (
                  <option key={st.value} value={st.value}>
                    {t(st.label)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Source')}>
              <input value={form.sourceName} onChange={(e) => setForm({ ...form, sourceName: e.target.value })} />
            </Field>
          </div>
          <div className="two">
            <Field label={t('URL')}>
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </Field>
            <Field label={t('Published')}>
              <input type="date" value={form.publishedAt} onChange={(e) => setForm({ ...form, publishedAt: e.target.value })} />
            </Field>
          </div>
          <Field label={t('Notes / excerpt')}>
            <textarea rows={5} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <Field label={t('Verification (optional)')}>
            <select value={form.verification} onChange={(e) => setForm({ ...form, verification: e.target.value })}>
              <option value="">{t('not set')}</option>
              <option value="unverified">{t('unverified')}</option>
              <option value="verified">{t('verified')}</option>
              <option value="disputed">{t('disputed')}</option>
            </select>
          </Field>
          <div className="row">
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              {t('Save changes')}
            </button>
            <span className="tiny sub">{t('added {date}', { date: fmtDateTime(ev.addedAt) })}</span>
            <span className="right row">
              <button
                className="btn sm"
                onClick={async () => {
                  upsertEvidence(await api.archiveEvidence(ev.id, !ev.archivedAt));
                }}
              >
                {ev.archivedAt ? t('Unarchive') : t('Archive')}
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (!window.confirm(t('Delete this evidence permanently? Only possible if no Research Update, node or catalyst uses it.'))) return;
                  try {
                    await api.deleteEvidence(ev.id);
                    await refresh('evidence');
                    navigate({ page: 'project', projectId, tab: 'evidence' });
                  } catch (e) {
                    toast(tm((e as Error).message), 'error');
                  }
                }}
              >
                {t('Delete')}
              </button>
            </span>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>{t('Linked nodes (current draft)')}</h2>
        {links.length === 0 && <div className="small sub">{t('Not linked to any node.')}</div>}
        {links.map((l) => (
          <div key={l.id} className="row small" style={{ padding: '3px 0' }}>
            <span className={cls('rel', l.relation)}>{t(l.relation)}</span>
            <a
              style={{ cursor: 'pointer' }}
              onClick={() => {
                select(l.nodeId);
                navigate({ page: 'project', projectId, tab: 'model' });
              }}
            >
              {draft.nodes.find((n) => n.id === l.nodeId)?.name}
            </a>
            {l.locator && <span className="sub">{t('at {locator}', { locator: l.locator })}</span>}
          </div>
        ))}
        <div className="row" style={{ marginTop: 6 }}>
          <select className="grow" value={linkNode} onChange={(e) => setLinkNode(e.target.value)}>
            <option value="">{t('Link to node…')}</option>
            {draft.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!linkNode} onClick={() => (edit((s) => addLink(s, { evidenceId: ev.id, nodeId: linkNode, relation: 'supports' }).state), setLinkNode(''))}>
            {t('Link (draft)')}
          </button>
        </div>
        <h3 style={{ marginTop: 12 }}>{t('Research Updates')}</h3>
        {ev.revisionRefs.length === 0 && <div className="small sub">{t('Not part of any committed update yet.')}</div>}
        {ev.revisionRefs.map((r) => (
          <div key={`${r.revisionId}${r.kind}`} className="small">
            <a href={`#/p/${projectId}/history/${r.revisionId}`}>#{r.seq}</a> — {r.kind === 'cited' ? t('cited as a reason for the update') : t('linked to a node in that snapshot')}
          </div>
        ))}
      </div>
      {audit.length > 0 && (
        <div className="card">
          <h2>{t('Edit history')}</h2>
          {audit.map((a) => (
            <details key={a.id}>
              <summary>
                {fmtDateTime(a.at)} — {t(a.action)}
              </summary>
              <pre className="tiny" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.before, null, 1)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
