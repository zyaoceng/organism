import { useMemo, useState } from 'react';
import type { CalcResult } from '../../domain/calc/engine';
import { upstream } from '../../domain/calc/graph';
import { describeChange } from '../../domain/revision/describe';
import { formatValue } from '../../domain/format';
import { formatPath } from '../../domain/formula/refs';
import {
  addLink,
  addThesis,
  removeLink,
  setCellStatus,
  setNotes,
  setRole,
  setTimeMode,
  setUnit,
  setValue,
  updateLink,
  updateThesis,
  renameNode,
} from '../../domain/model/ops';
import { cellStatus, childrenOf, isHeading } from '../../domain/model/tree';
import { LINK_RELATIONS, NODE_ROLES, SCALAR_KEY, SCENARIOS, type LinkRelation, type ModelNode, type ModelState, type NodeRole, type ScenarioId, type ThesisStatus } from '../../domain/model/types';
import { CURRENCIES, SCALES, UNIT_KINDS, hasCurrency, isScaleFree, type Scale, type Unit, type UnitKind } from '../../domain/units';
import { api } from '../lib/api';
import { calcOf, indexOf } from '../lib/derived';
import { createAndLink, KIND_ICON, namedScreenshot, uploadEvidenceFiles } from '../lib/evidence';
import { useActiveState, useWorkspace } from '../lib/store';
import { cls, fmtDateTime, periodLabelFn } from '../lib/util';
import { FormulaEditor } from './FormulaEditor';
import { InlineText, NumberField, Section } from './ui';

export function Inspector() {
  const { state, readOnly } = useActiveState();
  const selectedNodeId = useWorkspace((s) => s.selectedNodeId);
  if (!state) return null;
  const node = selectedNodeId ? state.nodes.find((n) => n.id === selectedNodeId) : undefined;
  if (!node) return <ModelChecks state={state} />;
  return <NodeInspector key={node.id} node={node} state={state} readOnly={readOnly} />;
}

function NodeInspector({ node, state, readOnly }: { node: ModelNode; state: ModelState; readOnly: boolean }) {
  const ix = indexOf(state);
  const calc = calcOf(state);
  const { edit } = useWorkspace.getState();
  const path = formatPath(ix, node.id).split(' › ').slice(0, -1).join(' › ');
  const issues = calc.issues.filter((i) => i.nodeId === node.id);
  return (
    <div data-testid="inspector">
      <div className="insp-head">
        <div className="path">{path || 'Top level'}</div>
        <input
          className="title"
          key={node.name}
          defaultValue={node.name}
          readOnly={readOnly}
          aria-label="Node name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== node.name) edit((s) => renameNode(s, node.id, v));
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <UnitEditor node={node} readOnly={readOnly} />
      </div>
      {issues.length > 0 && (
        <div className="section col" style={{ gap: 4 }}>
          {issues.map((i, k) => (
            <div key={k} className={cls('msg', i.severity === 'error' ? 'err' : i.severity === 'warning' ? 'warn' : 'info')}>
              {i.message}
            </div>
          ))}
        </div>
      )}
      <Section title={node.timeMode === 'scalar' ? 'Value by scenario' : 'Values'}>
        <ValuesMatrix node={node} state={state} calc={calc} readOnly={readOnly} />
      </Section>
      <Section title="Formula">
        <FormulaEditor node={node} state={state} readOnly={readOnly} />
      </Section>
      <Dependencies node={node} state={state} calc={calc} />
      <Section title="Notes · why this assumption">
        <InlineText
          multiline
          rows={6}
          readOnly={readOnly}
          value={node.notes}
          placeholder="Interpretation, reasoning, definitions… (click to write)"
          onCommit={(v) => edit((s) => setNotes(s, node.id, v))}
        />
      </Section>
      <NodeEvidence node={node} state={state} readOnly={readOnly} />
      <NodeTheses node={node} state={state} readOnly={readOnly} />
      <NodeCatalysts node={node} readOnly={readOnly} />
      <NodeHistory node={node} state={state} />
    </div>
  );
}

// ------------------------------------------------------------ unit / role

function UnitEditor({ node, readOnly }: { node: ModelNode; readOnly: boolean }) {
  const { edit } = useWorkspace.getState();
  const [convert, setConvert] = useState(true);
  const u = node.unit;
  const update = (next: Unit | null) => edit((s) => setUnit(s, node.id, next, convert));
  return (
    <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
      <select
        disabled={readOnly}
        value={u?.kind ?? ''}
        aria-label="Unit kind"
        onChange={(e) => {
          const kind = e.target.value as UnitKind | '';
          if (!kind) return update(null);
          update({ kind, scale: isScaleFree(kind) ? 1 : u?.scale ?? 1, currency: hasCurrency(kind) ? u?.currency ?? 'TWD' : undefined });
        }}
      >
        <option value="">No unit (heading)</option>
        {UNIT_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      {u && hasCurrency(u.kind) && (
        <select disabled={readOnly} value={u.currency} aria-label="Currency" onChange={(e) => update({ ...u, currency: e.target.value })}>
          {[...new Set([u.currency ?? 'TWD', ...CURRENCIES])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      )}
      {u && !isScaleFree(u.kind) && (
        <select disabled={readOnly} value={u.scale} aria-label="Scale" onChange={(e) => update({ ...u, scale: Number(e.target.value) as Scale })}>
          {SCALES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      )}
      {u && (u.kind === 'count' || u.kind === 'number') && (
        <input
          style={{ width: 90 }}
          disabled={readOnly}
          placeholder="label"
          defaultValue={u.label ?? ''}
          onBlur={(e) => e.target.value !== (u.label ?? '') && update({ ...u, label: e.target.value || undefined })}
        />
      )}
      <select
        disabled={readOnly}
        value={node.timeMode}
        aria-label="Time mode"
        title="A time series has a value per period; a single value (e.g. target P/E) has one per scenario"
        onChange={(e) => edit((s) => setTimeMode(s, node.id, e.target.value as 'series' | 'scalar'))}
      >
        <option value="series">Time series</option>
        <option value="scalar">Single value</option>
      </select>
      <select
        disabled={readOnly}
        value={node.role ?? ''}
        aria-label="Role"
        title="Roles tell workspaces (valuation, headline KPIs) which node is EPS, target P/E, etc."
        onChange={(e) => edit((s) => setRole(s, node.id, (e.target.value || undefined) as NodeRole | undefined))}
      >
        <option value="">No role</option>
        {NODE_ROLES.map((r) => (
          <option key={r.value} value={r.value}>
            Role: {r.label}
          </option>
        ))}
      </select>
      {!readOnly && u && !isScaleFree(u.kind) && (
        <label className="small sub row" style={{ gap: 4 }} title="When the scale changes, convert stored numbers so the quantity stays the same">
          <input type="checkbox" checked={convert} onChange={(e) => setConvert(e.target.checked)} /> convert values on scale change
        </label>
      )}
    </div>
  );
}

// ------------------------------------------------------------ values matrix

function ValuesMatrix({ node, state, calc, readOnly }: { node: ModelNode; state: ModelState; calc: CalcResult; readOnly: boolean }) {
  const ix = indexOf(state);
  const head = useWorkspace((s) => s.head);
  const viewing = useWorkspace((s) => s.viewing);
  const { edit } = useWorkspace.getState();
  const [editing, setEditing] = useState<string | null>(null);
  const headCalc = head && !viewing ? calcOf(head.state) : null;
  const keys = node.timeMode === 'scalar' ? [SCALAR_KEY] : state.periods.map((p) => p.id);
  const label = (k: string) => (k === SCALAR_KEY ? 'Value' : `${ix.periods[ix.periodIndex.get(k)!].label}${cellStatus(ix, node, k)}`);
  const showYoY = node.timeMode === 'series' && node.unit && ['currency', 'per_share', 'shares', 'count', 'number'].includes(node.unit.kind);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="matrix" data-testid="values-matrix">
        <thead>
          <tr>
            <th />
            {keys.map((k) => (
              <th key={k}>{label(k)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SCENARIOS.map((sc) => (
            <tr key={sc.id}>
              <td>
                <span className={cls('badge', sc.id)}>{sc.name}</span>
              </td>
              {keys.map((k) => {
                const status = cellStatus(ix, node, k);
                const c = calc.cells[sc.id][node.id]?.[k];
                const own = sc.id === 'base' ? node.values[k] : node.overrides[sc.id]?.[k];
                const shared = sc.id !== 'base' && status === 'A';
                const cellKey = `${sc.id}|${k}`;
                const h = headCalc?.cells[sc.id][node.id]?.[k];
                const changed = !!headCalc && (h?.v ?? null) !== (c?.v ?? null);
                const editable = !readOnly && !shared;
                return (
                  <td
                    key={k}
                    className={cls('v', status === 'A' && 'A', changed && 'chg')}
                    title={shared ? 'Actuals are shared across scenarios' : c?.err ? c.err.message : sc.id !== 'base' && own === undefined ? 'Inherits Base — type to override' : ''}
                    data-testid={`mx-${sc.id}-${k}`}
                  >
                    {editing === cellKey ? (
                      <NumberField
                        autoFocus
                        value={own ?? c?.v ?? null}
                        unit={node.unit}
                        onCommit={(v) => edit((s) => setValue(s, node.id, k, sc.id as ScenarioId, v))}
                        onDone={() => setEditing(null)}
                      />
                    ) : (
                      <div
                        className={cls('val', own !== undefined && 'input', own === undefined && sc.id !== 'base' && !shared && c?.src !== 'formula' && 'inherit', c?.err && 'errc')}
                        onClick={() => editable && setEditing(cellKey)}
                      >
                        {c?.err ? (c.err.code === 'MISSING' || c.err.code === 'UPSTREAM' ? '—' : 'ERR') : formatValue(c?.v, node.unit)}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {showYoY && (
            <tr className="derived">
              <td>YoY (base)</td>
              {keys.map((k, i) => {
                const cur = calc.cells.base[node.id]?.[k]?.v;
                const prev = i > 0 ? calc.cells.base[node.id]?.[keys[i - 1]]?.v : null;
                const g = cur !== null && cur !== undefined && prev ? cur / prev - 1 : null;
                return (
                  <td key={k} className="num">
                    {g === null ? '' : `${(g * 100).toFixed(1)}%`}
                  </td>
                );
              })}
            </tr>
          )}
          {node.timeMode === 'series' && (
            <tr className="derived">
              <td title="Actual or estimate for this node. Mark a custom segment's value in an actual year as an estimate when management does not disclose it.">A / E</td>
              {keys.map((k) => {
                const st = cellStatus(ix, node, k);
                const periodStatus = ix.periods[ix.periodIndex.get(k)!].status;
                return (
                  <td key={k}>
                    <button
                      className={cls('btn xs', st !== periodStatus && 'primary')}
                      disabled={readOnly}
                      title={st !== periodStatus ? `Overridden (period is ${periodStatus})` : 'Follows the period'}
                      onClick={() => edit((s) => setCellStatus(s, node.id, k, st === periodStatus ? (st === 'A' ? 'E' : 'A') : null))}
                    >
                      {st}
                    </button>
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
      <div className="tiny sub" style={{ marginTop: 4 }}>
        Base holds shared values; Bear/Bull store only overrides (grey = inherited). Actual cells are shared. Clear a cell to inherit / fall back to the formula.
      </div>
    </div>
  );
}

// ------------------------------------------------------------ dependencies

function Dependencies({ node, state, calc }: { node: ModelNode; state: ModelState; calc: CalcResult }) {
  const ix = indexOf(state);
  const { select } = useWorkspace.getState();
  const scenario = useWorkspace((s) => s.scenario);
  const [trace, setTrace] = useState(false);
  const inputs = [...(calc.graph.direct.get(node.id) ?? [])];
  const lagged = [...(calc.graph.lagged.get(node.id) ?? [])].filter((id) => !inputs.includes(id));
  const usedBy = [...(calc.graph.dependents.get(node.id) ?? [])];
  const chain = useMemo(() => (trace ? [...upstream(calc.graph, node.id)] : []), [trace, calc.graph, node.id]);
  const lastKey = node.timeMode === 'scalar' ? SCALAR_KEY : state.periods.at(-1)?.id;
  const val = (id: string) => {
    const n = ix.byId.get(id);
    if (!n) return '';
    const k = n.timeMode === 'scalar' ? SCALAR_KEY : lastKey === SCALAR_KEY ? state.periods.at(-1)?.id : lastKey;
    return k ? formatValue(calc.cells[scenario][id]?.[k]?.v, n.unit) : '';
  };
  const expansion = calc.graph.childrenExpansion.get(node.id);
  if (!inputs.length && !lagged.length && !usedBy.length) {
    return (
      <Section title="Calculation links">
        <div className="small sub">No formula links. {isHeading(node) ? 'Headings only structure the reasoning.' : 'Typed values only.'}</div>
      </Section>
    );
  }
  const chip = (id: string, kind: 'in' | 'out', extra = '') => (
    <span key={id + kind + extra} className={cls('chip', kind)} title={formatPath(ix, id)} onClick={() => select(id)}>
      {ix.byId.get(id)?.name}
      {extra && <span className="faint"> {extra}</span>} <span className="faint num">{val(id)}</span>
    </span>
  );
  return (
    <Section title="Calculation links" right={inputs.length + lagged.length > 0 && <button className="btn xs" onClick={() => setTrace(!trace)}>{trace ? 'Hide' : 'Trace'} upstream</button>}>
      <div className="col" style={{ gap: 6 }}>
        {(inputs.length > 0 || lagged.length > 0) && (
          <div className="chips">
            <span className="small sub" style={{ color: 'var(--dep-in)' }}>
              Depends on
            </span>
            {inputs.map((id) => chip(id, 'in'))}
            {lagged.map((id) => chip(id, 'in', '(prev)'))}
          </div>
        )}
        {expansion && <div className="tiny sub">CHILDREN() = {expansion.map((id) => ix.byId.get(id)?.name).join(', ') || 'no matching children'}</div>}
        {usedBy.length > 0 && (
          <div className="chips">
            <span className="small sub" style={{ color: 'var(--dep-out)' }}>
              Used by
            </span>
            {usedBy.map((id) => chip(id, 'out'))}
          </div>
        )}
        {trace && (
          <div className="chips">
            <span className="small sub">Full upstream ({chain.length})</span>
            {chain.map((id) => chip(id, 'in'))}
          </div>
        )}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------ evidence

function NodeEvidence({ node, state, readOnly }: { node: ModelNode; state: ModelState; readOnly: boolean }) {
  const evidence = useWorkspace((s) => s.evidence);
  const projectId = useWorkspace((s) => s.projectId)!;
  const { edit } = useWorkspace.getState();
  const [relation, setRelation] = useState<LinkRelation>('supports');
  const [url, setUrl] = useState('');
  const [over, setOver] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const links = state.links.filter((l) => l.nodeId === node.id);
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const linkable = evidence.filter((e) => !e.archivedAt && !links.some((l) => l.evidenceId === e.id));

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const addFiles = (files: File[]) =>
    run(() => createAndLink(() => uploadEvidenceFiles(projectId, files.map((f) => (f.type.startsWith('image/') ? namedScreenshot(f) : f))), node.id, relation));

  return (
    <Section title={`Evidence (${links.length})`}>
      {links.length === 0 && <div className="small sub" style={{ marginBottom: 6 }}>No evidence linked. Attach the source that justifies this assumption.</div>}
      {links.map((l) => {
        const e = byId.get(l.evidenceId);
        const img = e?.attachments.find((a) => a.mimeType.startsWith('image/'));
        return (
          <div key={l.id} className="ev-item" data-testid="ev-link">
            <div className="row">
              <span>{e ? KIND_ICON[e.kind] : '❔'}</span>
              <a className="t grow ellipsis" href={`#/p/${projectId}/evidence/${l.evidenceId}`} title={e?.title}>
                {e?.title ?? 'Evidence not loaded'}
              </a>
              <span className={cls('rel', l.relation)}>{LINK_RELATIONS.find((r) => r.value === l.relation)?.label}</span>
              {!readOnly && (
                <button className="icon-btn" title="Unlink from this node (the evidence stays in the library)" onClick={() => edit((s) => removeLink(s, l.id))}>
                  ✕
                </button>
              )}
            </div>
            {e && (
              <div className="tiny sub">
                {[e.sourceName, e.publishedAt && `published ${e.publishedAt}`, `added ${e.addedAt.slice(0, 10)}`].filter(Boolean).join(' · ')}
                {e.url && (
                  <>
                    {' · '}
                    <a href={e.url} target="_blank" rel="noreferrer noopener">
                      open link
                    </a>
                  </>
                )}
                {e.attachments.map((a) => (
                  <span key={a.id}>
                    {' · '}
                    <a href={a.url} target="_blank" rel="noreferrer">
                      {a.originalFilename}
                    </a>
                  </span>
                ))}
              </div>
            )}
            {img && <img className="thumb" src={img.url} alt={img.originalFilename} />}
            {e?.notes && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{e.notes.length > 300 ? `${e.notes.slice(0, 300)}…` : e.notes}</div>}
            {!readOnly && (
              <div className="row" style={{ gap: 6 }}>
                <select value={l.relation} onChange={(ev) => edit((s) => updateLink(s, l.id, { relation: ev.target.value as LinkRelation }))} aria-label="Relation">
                  {LINK_RELATIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <input
                  className="grow"
                  placeholder="page / slide / time (e.g. p.13)"
                  defaultValue={l.locator ?? ''}
                  onBlur={(ev) => ev.target.value !== (l.locator ?? '') && edit((s) => updateLink(s, l.id, { locator: ev.target.value || undefined }))}
                />
              </div>
            )}
            {readOnly && l.locator && <div className="tiny sub">at {l.locator}</div>}
          </div>
        );
      })}
      {!readOnly && (
        <div className="col" style={{ marginTop: 10, gap: 6 }}>
          <div className="row">
            <span className="small sub">Link new evidence as</span>
            <select value={relation} onChange={(e) => setRelation(e.target.value as LinkRelation)} aria-label="New link relation">
              {LINK_RELATIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <input
              className="grow"
              type="url"
              placeholder="Paste a URL and press Enter"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && url.trim()) {
                  const u = url.trim();
                  setUrl('');
                  void run(() => createAndLink(async () => [await api.createEvidence(projectId, { url: u, sourceType: 'news' })], node.id, relation));
                }
              }}
            />
          </div>
          <div
            className={cls('dropzone', over && 'over')}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const files = [...e.dataTransfer.files];
              if (files.length) void addFiles(files);
            }}
          >
            {busy ? 'Uploading…' : 'Drop files or screenshots here · paste an image with Ctrl+V · '}
            <label style={{ color: 'var(--accent)', cursor: 'pointer' }}>
              choose files
              <input type="file" multiple hidden data-testid="ev-file-input" onChange={(e) => e.target.files && void addFiles([...e.target.files])} />
            </label>
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => setNoteOpen(!noteOpen)}>
              📝 Note
            </button>
            {linkable.length > 0 && (
              <select
                className="grow"
                value=""
                aria-label="Link existing evidence"
                onChange={(e) => e.target.value && edit((s) => addLink(s, { evidenceId: e.target.value, nodeId: node.id, relation }).state)}
              >
                <option value="">Link existing evidence…</option>
                {linkable.map((e) => (
                  <option key={e.id} value={e.id}>
                    {KIND_ICON[e.kind]} {e.title}
                  </option>
                ))}
              </select>
            )}
          </div>
          {noteOpen && (
            <div className="col" style={{ gap: 4 }}>
              <input placeholder="Title (e.g. Channel check with supplier)" value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <textarea rows={3} placeholder="What was said / observed" value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <div className="row">
                <button
                  className="btn sm primary"
                  disabled={!noteTitle.trim() && !noteText.trim()}
                  onClick={() => {
                    const title = noteTitle.trim() || noteText.trim().slice(0, 60);
                    const notes = noteText;
                    setNoteTitle('');
                    setNoteText('');
                    setNoteOpen(false);
                    void run(() => createAndLink(async () => [await api.createEvidence(projectId, { title, notes, sourceType: 'conversation' })], node.id, relation));
                  }}
                >
                  Add note evidence
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------ theses

function NodeTheses({ node, state, readOnly }: { node: ModelNode; state: ModelState; readOnly: boolean }) {
  const { edit } = useWorkspace.getState();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [invalidation, setInvalidation] = useState('');
  const theses = state.theses.filter((t) => t.nodeIds.includes(node.id));
  const others = state.theses.filter((t) => !t.nodeIds.includes(node.id));
  return (
    <Section title={`Theses & invalidation (${theses.length})`} right={!readOnly && <button className="btn xs" onClick={() => setOpen(!open)}>+ thesis</button>}>
      {theses.length === 0 && !open && <div className="small sub">Optional: state the thesis behind this assumption and what would prove it wrong.</div>}
      {theses.map((t) => (
        <div key={t.id} className="ev-item">
          <div className="row">
            <InlineText className="t grow" value={t.statement} readOnly={readOnly} onCommit={(v) => edit((s) => updateThesis(s, t.id, { statement: v }))} />
            <select disabled={readOnly} value={t.status} aria-label="Thesis status" onChange={(e) => edit((s) => updateThesis(s, t.id, { status: e.target.value as ThesisStatus }))}>
              {['active', 'confirmed', 'invalidated', 'retired'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div className="small">
            <span className="sub">Invalidated if: </span>
            <InlineText value={t.invalidation} readOnly={readOnly} multiline rows={2} placeholder="(no invalidation condition yet)" onCommit={(v) => edit((s) => updateThesis(s, t.id, { invalidation: v }))} />
          </div>
          <div className="row small sub">
            Review by
            <input type="date" disabled={readOnly} defaultValue={t.reviewBy ?? ''} onBlur={(e) => e.target.value !== (t.reviewBy ?? '') && edit((s) => updateThesis(s, t.id, { reviewBy: e.target.value || undefined }))} />
            {!readOnly && (
              <button className="btn xs ghost right" onClick={() => edit((s) => updateThesis(s, t.id, { nodeIds: t.nodeIds.filter((x) => x !== node.id) }))}>
                detach
              </button>
            )}
          </div>
        </div>
      ))}
      {open && !readOnly && (
        <div className="col" style={{ gap: 4, marginTop: 6 }}>
          <input placeholder="Thesis, e.g. 800V adoption begins during FY27" value={statement} onChange={(e) => setStatement(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <textarea rows={2} placeholder="Invalidation: e.g. no hyperscaler qualification by Q2 FY27, or production delay > 12 months" value={invalidation} onChange={(e) => setInvalidation(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <div className="row">
            <button
              className="btn sm primary"
              disabled={!statement.trim()}
              onClick={() => {
                edit((s) => addThesis(s, { statement: statement.trim(), invalidation, nodeIds: [node.id] }).state);
                setStatement('');
                setInvalidation('');
                setOpen(false);
              }}
            >
              Add thesis
            </button>
            {others.length > 0 && (
              <select value="" onChange={(e) => e.target.value && edit((s) => updateThesis(s, e.target.value, { nodeIds: [...(s.theses.find((t) => t.id === e.target.value)?.nodeIds ?? []), node.id] }))}>
                <option value="">or attach an existing thesis…</option>
                {others.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.statement}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------ catalysts

function NodeCatalysts({ node, readOnly }: { node: ModelNode; readOnly: boolean }) {
  const catalysts = useWorkspace((s) => s.catalysts);
  const projectId = useWorkspace((s) => s.projectId)!;
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const list = catalysts.filter((c) => c.nodeIds.includes(node.id));
  const add = async () => {
    try {
      await api.createCatalyst(projectId, { title: title.trim(), expectedDate: date || null, nodeIds: [node.id], type: 'other' });
      setTitle('');
      setDate('');
      await useWorkspace.getState().refresh('catalysts');
    } catch (e) {
      useWorkspace.getState().toast((e as Error).message, 'error');
    }
  };
  return (
    <Section title={`Catalysts (${list.length})`}>
      {list.map((c) => (
        <div key={c.id} className="row small" style={{ padding: '3px 0' }}>
          <span className="num sub nowrap">{c.actualDate ?? c.expectedDate ?? 'undated'}</span>
          <a className="grow ellipsis" href={`#/p/${projectId}/catalysts`}>
            {c.title}
          </a>
          <span className="badge">{c.status}</span>
        </div>
      ))}
      {!readOnly && (
        <div className="row" style={{ marginTop: 4 }}>
          <input className="grow" placeholder="Quick add: e.g. Q3 earnings" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && title.trim() && void add())} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn sm" disabled={!title.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------ history

function NodeHistory({ node, state }: { node: ModelNode; state: ModelState }) {
  const revisions = useWorkspace((s) => s.revisions);
  const evidence = useWorkspace((s) => s.evidence);
  const projectId = useWorkspace((s) => s.projectId);
  const pl = periodLabelFn(state);
  const evTitle = (id: string) => evidence.find((e) => e.id === id)?.title ?? 'evidence';
  const items = [...revisions]
    .reverse()
    .map((r) => ({ r, changes: r.changes.filter((c) => 'nodeId' in c && c.nodeId === node.id) }))
    .filter((x) => x.changes.length > 0);
  return (
    <Section title={`Change history (${items.length})`}>
      {items.length === 0 && <div className="small sub">No committed changes to this node yet.</div>}
      {items.map(({ r, changes }) => (
        <div key={r.id} className="hist-item">
          <div className="row">
            <a href={`#/p/${projectId}/history/${r.id}`}>
              <b>#{r.seq}</b> {r.title}
            </a>
            <span className="right tiny sub nowrap">{r.asOfDate ?? fmtDateTime(r.committedAt).slice(0, 10)}</span>
          </div>
          <div className="small sub" style={{ whiteSpace: 'pre-wrap' }}>
            {r.reason}
          </div>
          <ul style={{ margin: '3px 0 0', paddingLeft: 16 }}>
            {changes.slice(0, 12).map((c, i) => (
              <li key={i} className="small">
                {describeChange(c, { periodLabel: pl, evidenceTitle: evTitle })}
              </li>
            ))}
            {changes.length > 12 && <li className="small sub">…and {changes.length - 12} more</li>}
          </ul>
          {r.citedEvidenceIds.length > 0 && <div className="tiny sub">Evidence cited: {r.citedEvidenceIds.map(evTitle).join('; ')}</div>}
        </div>
      ))}
    </Section>
  );
}

// ------------------------------------------------------------ model checks (no selection)

function ModelChecks({ state }: { state: ModelState }) {
  const calc = calcOf(state);
  const ix = indexOf(state);
  const { select } = useWorkspace.getState();
  const issues = calc.issues.filter((i) => i.severity !== 'info');
  const info = calc.issues.filter((i) => i.severity === 'info');
  const unlinked = state.nodes.filter((n) => !isHeading(n) && !n.formula && Object.keys(n.values).length > 0 && !state.links.some((l) => l.nodeId === n.id));
  return (
    <div data-testid="model-checks">
      <div className="insp-head">
        <h2>Model checks</h2>
        <div className="small sub">Select a node to inspect it. These checks update as you type.</div>
      </div>
      <Section title={`Errors & warnings (${issues.length})`}>
        {issues.length === 0 && <div className="msg ok">No formula, unit or reconciliation problems.</div>}
        {issues.map((i, k) => (
          <div key={k} className={cls('msg', i.severity === 'error' ? 'err' : 'warn')} style={{ marginBottom: 4, cursor: 'pointer' }} onClick={() => select(i.nodeId)}>
            <b>{ix.byId.get(i.nodeId)?.name}</b>: {i.message}
          </div>
        ))}
      </Section>
      {info.length > 0 && (
        <Section title={`Typed values over formulas (${info.length})`}>
          {info.slice(0, 20).map((i, k) => (
            <div key={k} className="small" style={{ cursor: 'pointer', padding: '2px 0' }} onClick={() => select(i.nodeId)}>
              <b>{ix.byId.get(i.nodeId)?.name}</b>: {i.message}
            </div>
          ))}
        </Section>
      )}
      <Section title={`Assumptions without evidence (${unlinked.length})`}>
        {unlinked.length === 0 ? (
          <div className="small sub">{state.nodes.some((n) => Object.keys(n.values).length) ? 'Every typed assumption has at least one evidence link.' : 'No typed assumptions yet. Start by entering reported actuals.'}</div>
        ) : (
          <div className="chips">
            {unlinked.map((n) => (
              <span key={n.id} className="chip" onClick={() => select(n.id)} title={formatPath(ix, n.id)}>
                {n.name}
              </span>
            ))}
          </div>
        )}
      </Section>
      <Section title="Tips">
        <div className="small col" style={{ gap: 4 }}>
          <div>
            Click a row to select it; <span className="kbd">A</span> adds a child, <span className="kbd">S</span> a sibling, <span className="kbd">F2</span> renames, drag rows to move them.
          </div>
          <div>Click a value cell and type to edit it. In Bear/Bull, edits create overrides of estimate cells.</div>
          <div>Paste a screenshot (Ctrl+V) to attach it as evidence to the selected node.</div>
          <div>All edits are autosaved as a draft. Commit them as a Research Update from the bar below.</div>
          <div>
            <span className="kbd">Ctrl+K</span> search · <span className="kbd">Ctrl+Z</span> undo · <span className="kbd">1 2 3</span> scenario
          </div>
        </div>
      </Section>
      <Section title="Structure">
        <div className="small sub">
          {state.nodes.length} nodes · {state.periods.length} periods · {state.links.length} evidence links · {state.theses.length} theses · top level:{' '}
          {childrenOf(ix, null)
            .map((n) => n.name)
            .join(', ')}
        </div>
        <div className="small sub" style={{ marginTop: 4 }}>
          Formulas: {state.nodes.filter((n) => n.formula).length}
        </div>
      </Section>
    </div>
  );
}

