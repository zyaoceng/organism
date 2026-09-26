import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Cell } from '../../domain/calc/engine';
import { formatValue } from '../../domain/format';
import {
  addNode,
  addPeriod,
  addSiblingAfter,
  deleteNode,
  duplicateBranch,
  indent,
  moveDown,
  moveNode,
  moveUp,
  nextPeriodSuggestion,
  outdent,
  previousPeriodSuggestion,
  removePeriod,
  renameNode,
  setValue,
  updatePeriod,
} from '../../domain/model/ops';
import { childrenOf, isHeading, visibleRows } from '../../domain/model/tree';
import { NODE_ROLES, SCALAR_KEY, type ModelNode, type ScenarioId } from '../../domain/model/types';
import { toDisplay } from '../../domain/formula/refs';
import { unitLabel } from '../../domain/units';
import { calcOf, diffOf, indexOf } from '../lib/derived';
import { useActiveState, useWorkspace } from '../lib/store';
import { cls } from '../lib/util';
import { NumberField } from './ui';

type DropPos = 'before' | 'inside' | 'after';

const SCEN_COLOR: Record<ScenarioId, string> = { bear: 'var(--bear)', base: 'var(--base)', bull: 'var(--bull)' };

export function TreeCanvas() {
  const { state, readOnly } = useActiveState();
  const head = useWorkspace((s) => s.head);
  const viewing = useWorkspace((s) => s.viewing);
  const scenario = useWorkspace((s) => s.scenario);
  const selectedNodeId = useWorkspace((s) => s.selectedNodeId);
  const selectedCell = useWorkspace((s) => s.selectedCell);
  const collapsed = useWorkspace((s) => s.collapsed);
  const evidence = useWorkspace((s) => s.evidence);
  const { edit, select, toggleCollapsed, setScenario, toast } = useWorkspace.getState();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ nodeId: string; key: string; initial?: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; target: string | null; pos: DropPos | null } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => (state ? visibleRows(state, collapsed) : []), [state, collapsed]);
  if (!state) return null;
  const ix = indexOf(state);
  const calc = calcOf(state);
  const headCalc = head && !viewing ? calcOf(head.state) : null;
  const changes = head && !viewing ? diffOf(head.state, state) : [];
  const periods = state.periods;

  // cells edited directly in this draft (strong highlight)
  const direct = new Set<string>();
  const formulaChanged = new Set<string>();
  for (const c of changes) {
    if (c.type === 'value_changed' && (c.scenario === scenario || c.scenario === 'base')) direct.add(`${c.nodeId}|${c.periodKey}`);
    if (c.type === 'formula_changed' || c.type === 'node_added') formulaChanged.add(c.nodeId);
  }

  const sel = selectedNodeId ? ix.byId.get(selectedNodeId) : undefined;
  const depIn = new Set<string>(sel ? [...(calc.graph.direct.get(sel.id) ?? []), ...(calc.graph.lagged.get(sel.id) ?? [])] : []);
  const depOut = new Set<string>(sel ? [...(calc.graph.dependents.get(sel.id) ?? [])] : []);
  const issueCount = new Map<string, { err: number; warn: number; msgs: string[] }>();
  for (const i of calc.issues) {
    if (i.severity === 'info') continue;
    const e = issueCount.get(i.nodeId) ?? { err: 0, warn: 0, msgs: [] };
    if (i.severity === 'error') e.err++;
    else e.warn++;
    e.msgs.push(i.message);
    issueCount.set(i.nodeId, e);
  }
  const linkCount = new Map<string, number>();
  for (const l of state.links) linkCount.set(l.nodeId, (linkCount.get(l.nodeId) ?? 0) + 1);
  const evTitles = new Map(evidence.map((e) => [e.id, e.title]));

  const cols = `minmax(250px, 340px) 70px repeat(${periods.length}, 96px)`;
  const keysOf = (n: ModelNode) => (n.timeMode === 'scalar' ? [SCALAR_KEY] : periods.map((p) => p.id));

  // ------------------------------------------------------------ actions
  const focusTree = () => setTimeout(() => rootRef.current?.focus(), 0);
  const addChild = (parentId: string | null) => {
    let newId = '';
    const ok = edit((s) => {
      const r = addNode(s, { parentId });
      newId = r.id;
      return r.state;
    });
    if (ok) {
      if (parentId) toggleCollapsed(parentId, false);
      select(newId);
      setRenamingId(newId);
    }
  };
  const addSibling = (id: string) => {
    let newId = '';
    if (
      edit((s) => {
        const r = addSiblingAfter(s, id);
        newId = r.id;
        return r.state;
      })
    ) {
      select(newId);
      setRenamingId(newId);
    }
  };
  const remove = (id: string) => {
    const n = ix.byId.get(id);
    if (!n) return;
    let broken: string[] = [];
    let removed = 0;
    const idx = rows.findIndex((r) => r.node.id === id);
    if (
      edit((s) => {
        const r = deleteNode(s, id);
        broken = r.brokenFormulaNodeIds.map((b) => ix.byId.get(b)?.name ?? b);
        removed = r.removedIds.length;
        return r.state;
      })
    ) {
      const next = rows[idx + 1]?.node.id ?? rows[idx - 1]?.node.id ?? null;
      select(next && next !== id ? next : null);
      toast(
        `Deleted ${n.name}${removed > 1 ? ` and ${removed - 1} child node(s)` : ''}. ${broken.length ? `Formulas now referencing a deleted node: ${broken.join(', ')}. ` : ''}Ctrl+Z to undo.`,
        broken.length ? 'error' : 'info',
      );
    }
  };
  const duplicate = (id: string) => {
    let newId = '';
    if (
      edit((s) => {
        const r = duplicateBranch(s, id);
        newId = r.id;
        return r.state;
      })
    ) {
      select(newId);
      setRenamingId(newId);
    }
  };

  const moveSelection = (delta: number) => {
    const i = rows.findIndex((r) => r.node.id === selectedNodeId);
    const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + delta))];
    if (next) select(next.node.id, selectedCell ? (next.node.timeMode === 'scalar' ? SCALAR_KEY : selectedCell.periodKey === SCALAR_KEY ? periods[0]?.id : selectedCell.periodKey) : null);
  };

  const moveCell = (dx: number) => {
    if (!selectedCell) return;
    const n = ix.byId.get(selectedCell.nodeId);
    if (!n) return;
    const keys = keysOf(n);
    const i = keys.indexOf(selectedCell.periodKey);
    const j = i + dx;
    if (j < 0) select(n.id, null);
    else if (j < keys.length) select(n.id, keys[j]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || renamingId) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    if (selectedCell && !readOnly) {
      const n = ix.byId.get(selectedCell.nodeId);
      if (n && (e.key === 'Enter' || e.key === 'F2')) {
        e.preventDefault();
        setEditing({ nodeId: n.id, key: selectedCell.periodKey });
        return;
      }
      if (n && !mod && /^[0-9.\-(]$/.test(e.key)) {
        e.preventDefault();
        setEditing({ nodeId: n.id, key: selectedCell.periodKey, initial: e.key });
        return;
      }
      if (n && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        edit((s) => setValue(s, n.id, selectedCell.periodKey, scenario, null));
        return;
      }
    }
    if (selectedCell) {
      if (e.key === 'ArrowRight') return e.preventDefault(), moveCell(1);
      if (e.key === 'ArrowLeft') return e.preventDefault(), moveCell(-1);
      if (e.key === 'ArrowDown') return e.preventDefault(), moveSelection(1);
      if (e.key === 'ArrowUp') return e.preventDefault(), moveSelection(-1);
      if (e.key === 'Escape') return select(selectedCell.nodeId, null);
      return;
    }
    if (!mod && ['1', '2', '3'].includes(e.key)) {
      setScenario((['bear', 'base', 'bull'] as const)[Number(e.key) - 1]);
      return;
    }
    if (!sel) {
      if (e.key === 'ArrowDown' && rows[0]) select(rows[0].node.id);
      return;
    }
    const hasKids = childrenOf(ix, sel.id).length > 0;
    if (e.altKey && e.key === 'ArrowUp' && !readOnly) return e.preventDefault(), edit((s) => moveUp(s, sel.id));
    if (e.altKey && e.key === 'ArrowDown' && !readOnly) return e.preventDefault(), edit((s) => moveDown(s, sel.id));
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return moveSelection(1);
      case 'ArrowUp':
        e.preventDefault();
        return moveSelection(-1);
      case 'ArrowLeft':
        e.preventDefault();
        if (hasKids && !collapsed.has(sel.id)) toggleCollapsed(sel.id, true);
        else if (sel.parentId) select(sel.parentId);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (hasKids && collapsed.has(sel.id)) toggleCollapsed(sel.id, false);
        else select(sel.id, keysOf(sel)[0]);
        return;
      case 'Enter':
      case 'F2':
        if (readOnly) return;
        e.preventDefault();
        return setRenamingId(sel.id);
      case 'Tab':
        if (readOnly) return;
        e.preventDefault();
        return void edit((s) => (e.shiftKey ? outdent(s, sel.id) : indent(s, sel.id)));
      case 'Delete':
        if (readOnly) return;
        e.preventDefault();
        return remove(sel.id);
    }
    if (readOnly) return;
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      return duplicate(sel.id);
    }
    if (!mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      return addChild(sel.id);
    }
    if (!mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      return addSibling(sel.id);
    }
  };

  // ------------------------------------------------------------ drag & drop
  const dropPos = (e: DragEvent<HTMLDivElement>): DropPos => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
  };
  const onDrop = (target: ModelNode, pos: DropPos) => {
    if (!drag || drag.id === target.id) return setDrag(null);
    const dragged = drag.id;
    edit((s) => {
      const ixs = indexOf(s);
      if (pos === 'inside') return moveNode(s, dragged, target.id, childrenOf(ixs, target.id).filter((c) => c.id !== dragged).length);
      const sibs = childrenOf(ixs, target.parentId).filter((c) => c.id !== dragged);
      const i = sibs.findIndex((c) => c.id === target.id);
      return moveNode(s, dragged, target.parentId, pos === 'before' ? i : i + 1);
    });
    if (pos === 'inside') toggleCollapsed(target.id, false);
    setDrag(null);
  };

  // ------------------------------------------------------------ cells
  const cellTitle = (n: ModelNode, key: string, c: Cell | undefined): string => {
    if (!c) return '';
    const parts: string[] = [];
    if (c.err) parts.push(c.err.code === 'UPSTREAM' ? `↳ ${c.err.message}` : c.err.message);
    if (c.src === 'input') parts.push(n.formula && ix.periods.find((p) => p.id === key)?.status !== 'A' ? 'Typed value (overrides the formula)' : 'Typed value');
    if (c.src === 'override') parts.push(`${scenario} override (Base: ${formatValue(calc.cells.base[n.id]?.[key]?.v, n.unit)})`);
    if (c.src === 'formula' && n.formula) parts.push(`= ${toDisplay(n.formula, ix, n.id)}`);
    if (c.check !== undefined && c.check !== null) parts.push(`Formula gives ${formatValue(c.check, n.unit)}`);
    if (c.est) parts.push('Estimate');
    const h = headCalc?.cells[scenario][n.id]?.[key];
    if (headCalc && h && h.v !== c.v) parts.push(`Committed: ${formatValue(h.v, n.unit)}`);
    return parts.join('\n');
  };

  const renderCell = (n: ModelNode, key: string, span?: number) => {
    const c = calc.cells[scenario][n.id]?.[key];
    const status = key === SCALAR_KEY ? 'E' : n.cellStatus[key] ?? periods.find((p) => p.id === key)?.status ?? 'E';
    const h = headCalc ? (ix.byId.has(n.id) && head!.state.nodes.some((x) => x.id === n.id) ? headCalc.cells[scenario][n.id]?.[key] : undefined) : undefined;
    const changed = !!headCalc && (h ? (h.v ?? null) !== (c?.v ?? null) : c?.v !== null && c?.v !== undefined);
    const isDirect = direct.has(`${n.id}|${key}`) || (formulaChanged.has(n.id) && changed);
    const isSel = selectedCell?.nodeId === n.id && selectedCell.periodKey === key;
    const isEditing = editing?.nodeId === n.id && editing.key === key;
    const heading = isHeading(n) && !c?.v;
    const style: React.CSSProperties = span ? { gridColumn: `3 / span ${span}` } : {};
    if (c?.src === 'override') (style as Record<string, string>)['--scn'] = SCEN_COLOR[scenario];
    return (
      <div
        key={key}
        className={cls(
          'cell',
          !!span && 'scalar',
          status === 'A' && 'A',
          c?.src === 'input' && 'input',
          c?.src === 'override' && 'override',
          c?.src === 'input' && n.formula && status === 'E' && 'hardcode',
          (!c || c.v === null) && !c?.err && 'blank',
          c?.err && 'errc',
          c?.src === 'formula' && c.est && status === 'A' && 'est-derived',
          changed && 'chg',
          changed && isDirect && 'direct',
          isSel && 'selc',
        )}
        style={style}
        title={cellTitle(n, key, c)}
        data-node={n.id}
        data-period={key}
        onClick={(e) => {
          e.stopPropagation();
          select(n.id, key);
          rootRef.current?.focus();
        }}
        onDoubleClick={() => !readOnly && setEditing({ nodeId: n.id, key })}
      >
        {isEditing ? (
          <NumberField
            autoFocus
            value={(scenario !== 'base' && status === 'E' ? n.overrides[scenario]?.[key] : undefined) ?? n.values[key] ?? c?.v ?? null}
            initialText={editing?.initial}
            unit={n.unit}
            onCommit={(v) => edit((s) => setValue(s, n.id, key, scenario, v))}
            onDone={(how, shift) => {
              setEditing(null);
              focusTree();
              if (how === 'enter') moveSelection(shift ? -1 : 1);
              if (how === 'tab') moveCell(shift ? -1 : 1);
            }}
          />
        ) : heading ? null : c?.err ? (
          <span>{c.err.code === 'MISSING' || c.err.code === 'UPSTREAM' ? '—' : 'ERR'}</span>
        ) : (
          <>
            {span && <span className="scalar-tag">single value</span>}
            {formatValue(c?.v, n.unit)}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="tree" tabIndex={0} ref={rootRef} onKeyDown={onKeyDown} onClick={() => select(null)} data-testid="tree">
      <div className="tree-head" style={{ gridTemplateColumns: cols }}>
        <div>
          Research tree
          {!readOnly && (
            <button className="btn xs" style={{ marginLeft: 8 }} onClick={(e) => (e.stopPropagation(), addChild(null))} title="Add a top-level node">
              + node
            </button>
          )}
        </div>
        <div>Unit</div>
        {periods.map((p, i) => (
          <div key={p.id} className={cls('ph', p.status)} title={`${p.id} · ${p.status === 'A' ? 'Actual' : 'Estimate'}${p.endDate ? ` · ends ${p.endDate}` : ''}`}>
            {!readOnly && i === 0 && (
              <button
                className="icon-btn"
                title="Add an earlier period"
                onClick={(e) => {
                  e.stopPropagation();
                  edit((s) => addPeriod(s, previousPeriodSuggestion(s), 'start'));
                }}
              >
                +
              </button>
            )}
            <span>{p.label}</span>
            <button
              className="icon-btn stat"
              disabled={readOnly}
              title={readOnly ? '' : `Mark as ${p.status === 'A' ? 'Estimate' : 'Actual'}${p.status === 'E' ? ' (drops Bear/Bull overrides for this period)' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                edit((s) => updatePeriod(s, p.id, { status: p.status === 'A' ? 'E' : 'A' }));
              }}
            >
              {p.status}
            </button>
            {!readOnly && (
              <button
                className="icon-btn"
                title="Remove this period"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Remove period ${p.label}${p.status}? Its values are removed from the draft (undo with Ctrl+Z).`)) edit((s) => removePeriod(s, p.id));
                }}
              >
                ×
              </button>
            )}
            {!readOnly && i === periods.length - 1 && (
              <button
                className="icon-btn"
                title="Add the next period"
                onClick={(e) => {
                  e.stopPropagation();
                  edit((s) => addPeriod(s, nextPeriodSuggestion(s)));
                }}
              >
                +
              </button>
            )}
          </div>
        ))}
      </div>

      {rows.map(({ node: n, depth, hasChildren }) => {
        const issues = issueCount.get(n.id);
        const isSel = selectedNodeId === n.id;
        const role = NODE_ROLES.find((r) => r.value === n.role);
        const evN = linkCount.get(n.id) ?? 0;
        const dropping = drag?.target === n.id ? drag.pos : null;
        return (
          <div
            key={n.id}
            className={cls(
              'tree-row',
              isSel && 'sel',
              isHeading(n) && 'heading',
              depIn.has(n.id) && 'dep-in',
              depOut.has(n.id) && !depIn.has(n.id) && 'dep-out',
              dropping && `drop-${dropping}`,
            )}
            style={{ gridTemplateColumns: cols }}
            data-testid={`row-${n.name}`}
            draggable={!readOnly && renamingId !== n.id && !editing}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/x-node', n.id);
              e.dataTransfer.effectAllowed = 'move';
              setDrag({ id: n.id, target: null, pos: null });
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const pos = dropPos(e);
              if (drag.target !== n.id || drag.pos !== pos) setDrag({ ...drag, target: n.id, pos });
            }}
            onDragLeave={() => drag?.target === n.id && setDrag({ ...drag, target: null, pos: null })}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(n, dropPos(e));
            }}
            onDragEnd={() => setDrag(null)}
            onClick={(e) => {
              e.stopPropagation();
              select(n.id);
              rootRef.current?.focus();
            }}
          >
            <div className="namecell" onDoubleClick={() => !readOnly && setRenamingId(n.id)}>
              {Array.from({ length: depth }, (_, i) => (
                <span key={i} className="guide" />
              ))}
              <span
                className="chev"
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasChildren) toggleCollapsed(n.id);
                }}
              >
                {hasChildren ? (collapsed.has(n.id) ? '▸' : '▾') : ''}
              </span>
              <span className="name" title={n.notes ? n.notes.slice(0, 400) : n.name}>
                {renamingId === n.id ? (
                  <input
                    autoFocus
                    defaultValue={n.name}
                    onClick={(e) => e.stopPropagation()}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') {
                        (e.target as HTMLInputElement).value = n.name;
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== n.name) edit((s) => renameNode(s, n.id, v));
                      setRenamingId(null);
                      focusTree();
                    }}
                  />
                ) : (
                  n.name
                )}
              </span>
              <span className="marks">
                {isSel && depIn.size > 0 && <span className="mark depin" title="Rows marked blue feed this node's formula">inputs</span>}
                {depIn.has(n.id) && <span className="mark depin" title={`Input to ${sel?.name}`}>in</span>}
                {depOut.has(n.id) && <span className="mark depout" title={`Uses ${sel?.name}`}>uses</span>}
                {role && <span className="mark role">{role.label}</span>}
                {n.formula && <span className="mark fx" title={toDisplay(n.formula, ix, n.id)}>ƒ</span>}
                {evN > 0 && (
                  <span className="mark ev" title={state.links.filter((l) => l.nodeId === n.id).map((l) => `${l.relation}: ${evTitles.get(l.evidenceId) ?? 'evidence'}`).join('\n')}>
                    📎{evN}
                  </span>
                )}
                {issues && issues.err > 0 && <span className="mark err" title={issues.msgs.join('\n')}>!</span>}
                {issues && issues.err === 0 && issues.warn > 0 && <span className="mark warn" title={issues.msgs.join('\n')}>⚠</span>}
                {!readOnly && (
                  <span className="hover-actions">
                    <button className="icon-btn" title="Add child (A)" onClick={(e) => (e.stopPropagation(), addChild(n.id))}>
                      ＋
                    </button>
                    <button className="icon-btn" title="Duplicate branch (Ctrl+D)" onClick={(e) => (e.stopPropagation(), duplicate(n.id))}>
                      ⧉
                    </button>
                    <button className="icon-btn" title="Delete (Del)" onClick={(e) => (e.stopPropagation(), remove(n.id))}>
                      ✕
                    </button>
                  </span>
                )}
              </span>
            </div>
            <div className="unitcell" title={unitLabel(n.unit)}>
              {unitLabel(n.unit)}
            </div>
            {n.timeMode === 'scalar' ? renderCell(n, SCALAR_KEY, periods.length) : periods.map((p) => renderCell(n, p.id))}
          </div>
        );
      })}

      <div className="tree-foot">
        <span className="legend">
          <span>
            <i style={{ background: '#fff', borderColor: 'var(--input)' }} />
            <span style={{ color: 'var(--input)' }}>blue</span> = typed input
          </span>
          <span>black = formula</span>
          <span>
            <i style={{ background: '#f7f8fa' }} />
            actual period
          </span>
          <span>
            <i style={{ background: 'var(--draft-strong)' }} />
            edited in draft
          </span>
          <span>
            <i style={{ background: 'var(--draft)' }} />
            changed downstream
          </span>
          <span>● scenario override</span>
          <span style={{ color: '#e67e22' }}>◥ typed over a formula</span>
        </span>
        <span className="right">
          <span className="kbd">A</span> child <span className="kbd">S</span> sibling <span className="kbd">F2</span> rename <span className="kbd">Tab</span> indent <span className="kbd">Alt+↑↓</span> move{' '}
          <span className="kbd">Ctrl+D</span> duplicate <span className="kbd">Del</span> delete <span className="kbd">1 2 3</span> scenario
        </span>
      </div>
    </div>
  );
}
