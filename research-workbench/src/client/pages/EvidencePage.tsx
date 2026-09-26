import { useEffect, useMemo, useState } from 'react';
import { addLink } from '../../domain/model/ops';
import { LINK_RELATIONS, type LinkRelation } from '../../domain/model/types';
import { SOURCE_TYPES, type AuditEntryDTO, type EvidenceDTO } from '../../shared/api';
import { Field } from '../components/ui';
import { api } from '../lib/api';
import { createAndLink, KIND_ICON, namedScreenshot } from '../lib/evidence';
import { navigate } from '../lib/router';
import { useWorkspace } from '../lib/store';
import { cls, fmtDateTime } from '../lib/util';

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
        <h1>Evidence</h1>
        <span className="sub">Sources are facts; assumptions live in the model. Link evidence to the nodes it supports or contradicts.</span>
        <button className="btn primary right" onClick={() => setSel(null)} data-testid="add-evidence">
          + Add evidence
        </button>
      </div>
      <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) 480px' }}>
        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
            <input type="search" className="grow" placeholder="Search title, source, notes, URL" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All source types</option>
              {SOURCE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <label className="small sub row" style={{ gap: 4 }}>
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> archived
            </label>
          </div>
          {list.length === 0 && <div className="empty" style={{ margin: 12 }}>No evidence{q || type ? ' matches' : ' yet'}.</div>}
          {list.map((e) => (
            <div key={e.id} className={cls('list-row', sel === e.id && 'sel')} onClick={() => setSel(e.id)} data-testid="evidence-row">
              <span style={{ fontSize: 16 }}>{KIND_ICON[e.kind]}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row">
                  <b className="ellipsis">{e.title}</b>
                  {e.archivedAt && <span className="badge">archived</span>}
                  {e.verification && <span className={cls('badge', e.verification === 'verified' ? 'accent' : e.verification === 'disputed' ? 'err' : '')}>{e.verification}</span>}
                </div>
                <div className="tiny sub">
                  {[SOURCE_TYPES.find((t) => t.value === e.sourceType)?.label, e.sourceName, e.publishedAt && `published ${e.publishedAt}`, `added ${e.addedAt.slice(0, 10)}`].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
                {linkCount(e.id) > 0 && <span className="badge accent">{linkCount(e.id)} node link(s)</span>}
                {e.revisionRefs.some((r) => r.kind === 'cited') && <span className="badge">cited in #{e.revisionRefs.filter((r) => r.kind === 'cited').map((r) => r.seq).join(', #')}</span>}
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
      <h2>Add evidence</h2>
      <div className="col">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Q2 earnings call — capacity guidance" data-testid="ev-title" />
        </Field>
        <div className="two">
          <Field label="Source type">
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              {SOURCE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Source / publisher / speaker">
            <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="Company IR, DIGITIMES, broker…" />
          </Field>
        </div>
        <div className="two">
          <Field label="URL">
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" data-testid="ev-url" />
          </Field>
          <Field label="Publication date">
            <input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} data-testid="ev-published" />
          </Field>
        </div>
        <Field label="What it says (excerpt / notes)">
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="field">
          <span className="small sub">Files, PDFs, screenshots (or paste an image here)</span>
          <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          {files.length > 0 && <div className="tiny sub">{files.map((f) => f.name).join(', ')}</div>}
        </div>
        <div className="two">
          <Field label="Link to node (optional)">
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              <option value="">— none —</option>
              {draft.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Relation">
            <select value={relation} onChange={(e) => setRelation(e.target.value as LinkRelation)}>
              {LINK_RELATIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button className="btn primary" disabled={busy || (!title.trim() && !url.trim() && !files.length)} onClick={() => void submit()} data-testid="ev-save">
          {busy ? 'Saving…' : 'Add to evidence library'}
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
      toast('Evidence updated (previous version kept in the audit log)', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
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
                  {(a.sizeBytes / 1024).toFixed(0)} KB · {a.mimeType} · sha256 {a.sha256.slice(0, 10)}…
                </span>
                <a className="right" href={`${a.url}?download=1`}>
                  download
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
          Add file{' '}
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
          <Field label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <div className="two">
            <Field label="Source type">
              <select value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value })}>
                {SOURCE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Source">
              <input value={form.sourceName} onChange={(e) => setForm({ ...form, sourceName: e.target.value })} />
            </Field>
          </div>
          <div className="two">
            <Field label="URL">
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </Field>
            <Field label="Published">
              <input type="date" value={form.publishedAt} onChange={(e) => setForm({ ...form, publishedAt: e.target.value })} />
            </Field>
          </div>
          <Field label="Notes / excerpt">
            <textarea rows={5} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <Field label="Verification (optional)">
            <select value={form.verification} onChange={(e) => setForm({ ...form, verification: e.target.value })}>
              <option value="">not set</option>
              <option value="unverified">unverified</option>
              <option value="verified">verified</option>
              <option value="disputed">disputed</option>
            </select>
          </Field>
          <div className="row">
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              Save changes
            </button>
            <span className="tiny sub">added {fmtDateTime(ev.addedAt)}</span>
            <span className="right row">
              <button
                className="btn sm"
                onClick={async () => {
                  upsertEvidence(await api.archiveEvidence(ev.id, !ev.archivedAt));
                }}
              >
                {ev.archivedAt ? 'Unarchive' : 'Archive'}
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (!window.confirm('Delete this evidence permanently? Only possible if no Research Update, node or catalyst uses it.')) return;
                  try {
                    await api.deleteEvidence(ev.id);
                    await refresh('evidence');
                    navigate({ page: 'project', projectId, tab: 'evidence' });
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                Delete
              </button>
            </span>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Linked nodes (current draft)</h2>
        {links.length === 0 && <div className="small sub">Not linked to any node.</div>}
        {links.map((l) => (
          <div key={l.id} className="row small" style={{ padding: '3px 0' }}>
            <span className={cls('rel', l.relation)}>{l.relation}</span>
            <a
              style={{ cursor: 'pointer' }}
              onClick={() => {
                select(l.nodeId);
                navigate({ page: 'project', projectId, tab: 'model' });
              }}
            >
              {draft.nodes.find((n) => n.id === l.nodeId)?.name}
            </a>
            {l.locator && <span className="sub">at {l.locator}</span>}
          </div>
        ))}
        <div className="row" style={{ marginTop: 6 }}>
          <select className="grow" value={linkNode} onChange={(e) => setLinkNode(e.target.value)}>
            <option value="">Link to node…</option>
            {draft.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!linkNode} onClick={() => (edit((s) => addLink(s, { evidenceId: ev.id, nodeId: linkNode, relation: 'supports' }).state), setLinkNode(''))}>
            Link (draft)
          </button>
        </div>
        <h3 style={{ marginTop: 12 }}>Research Updates</h3>
        {ev.revisionRefs.length === 0 && <div className="small sub">Not part of any committed update yet.</div>}
        {ev.revisionRefs.map((r) => (
          <div key={`${r.revisionId}${r.kind}`} className="small">
            <a href={`#/p/${projectId}/history/${r.revisionId}`}>#{r.seq}</a> — {r.kind === 'cited' ? 'cited as a reason for the update' : 'linked to a node in that snapshot'}
          </div>
        ))}
      </div>
      {audit.length > 0 && (
        <div className="card">
          <h2>Edit history</h2>
          {audit.map((a) => (
            <details key={a.id}>
              <summary>
                {fmtDateTime(a.at)} — {a.action}
              </summary>
              <pre className="tiny" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.before, null, 1)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
