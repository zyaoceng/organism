/**
 * Pure edit operations on the research state. Every function returns a new state and never
 * mutates its input, so the UI can keep an undo stack and the diff engine can compare states.
 */
import { newLinkId, newNodeId, newPeerId, newThesisId } from '../ids';
import { isScaleFree, normalizeUnit, type Unit } from '../units';
import { remapIds } from '../formula/refs';
import { tokenize } from '../formula/lexer';
import { cellStatus, childrenOf, descendants, indexModel, isDescendant } from './tree';
import {
  SCALAR_KEY,
  type EvidenceLink,
  type ModelNode,
  type ModelState,
  type NodeRole,
  type OverrideScenario,
  type Peer,
  type Period,
  type PeriodStatus,
  type ScenarioId,
  type Thesis,
  type TimeMode,
  type ValuationContext,
} from './types';

export class ModelOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOpError';
  }
}

const mapNode = (state: ModelState, id: string, fn: (n: ModelNode) => ModelNode): ModelState => ({
  ...state,
  nodes: state.nodes.map((n) => (n.id === id ? fn(n) : n)),
});

function requireNode(state: ModelState, id: string): ModelNode {
  const n = state.nodes.find((x) => x.id === id);
  if (!n) throw new ModelOpError(`Node ${id} does not exist`);
  return n;
}

export function makeNode(partial: Partial<ModelNode> & { name: string }): ModelNode {
  return {
    id: partial.id ?? newNodeId(),
    name: partial.name,
    parentId: partial.parentId ?? null,
    timeMode: partial.timeMode ?? 'series',
    unit: partial.unit === undefined ? null : partial.unit ? normalizeUnit(partial.unit) : null,
    ...(partial.role ? { role: partial.role } : {}),
    ...(partial.formula ? { formula: partial.formula } : {}),
    values: partial.values ?? {},
    overrides: partial.overrides ?? {},
    cellStatus: partial.cellStatus ?? {},
    notes: partial.notes ?? '',
  };
}

/** Index in state.nodes where a new child of `parentId` should go to appear at sibling position `position`. */
function insertionIndex(state: ModelState, parentId: string | null, position: number): number {
  const ix = indexModel(state);
  const siblings = childrenOf(ix, parentId);
  if (position < siblings.length) return state.nodes.findIndex((n) => n.id === siblings[position].id);
  if (siblings.length === 0) {
    if (parentId === null) return state.nodes.length;
    const pIdx = state.nodes.findIndex((n) => n.id === parentId);
    return pIdx + 1;
  }
  // after the last sibling and all of its descendants
  const last = siblings[siblings.length - 1];
  const block = new Set([last.id, ...descendants(ix, last.id)]);
  let idx = state.nodes.findIndex((n) => n.id === last.id);
  while (idx + 1 < state.nodes.length && block.has(state.nodes[idx + 1].id)) idx++;
  return idx + 1;
}

export interface AddNodeInput {
  parentId: string | null;
  /** Sibling position; default: last. */
  position?: number;
  name?: string;
  unit?: Unit | null;
  timeMode?: TimeMode;
}

export function addNode(state: ModelState, input: AddNodeInput): { state: ModelState; id: string } {
  if (input.parentId !== null) requireNode(state, input.parentId);
  const ix = indexModel(state);
  const siblings = childrenOf(ix, input.parentId);
  const parent = input.parentId ? ix.byId.get(input.parentId) : undefined;
  const node = makeNode({
    name: input.name ?? 'New node',
    parentId: input.parentId,
    unit: input.unit !== undefined ? input.unit : parent?.unit ?? null,
    timeMode: input.timeMode ?? parent?.timeMode ?? 'series',
  });
  const position = input.position ?? siblings.length;
  const at = insertionIndex(state, input.parentId, position);
  const nodes = [...state.nodes];
  nodes.splice(at, 0, node);
  return { state: { ...state, nodes }, id: node.id };
}

export function addSiblingAfter(state: ModelState, id: string, name?: string): { state: ModelState; id: string } {
  const n = requireNode(state, id);
  const ix = indexModel(state);
  const pos = childrenOf(ix, n.parentId).findIndex((s) => s.id === id) + 1;
  return addNode(state, { parentId: n.parentId, position: pos, name, unit: n.unit, timeMode: n.timeMode });
}

export function renameNode(state: ModelState, id: string, name: string): ModelState {
  const trimmed = name.trim();
  if (!trimmed) throw new ModelOpError('A node needs a name');
  return mapNode(state, id, (n) => ({ ...n, name: trimmed }));
}

export function setNotes(state: ModelState, id: string, notes: string): ModelState {
  return mapNode(state, id, (n) => ({ ...n, notes }));
}

export function setRole(state: ModelState, id: string, role: NodeRole | undefined): ModelState {
  return {
    ...state,
    nodes: state.nodes.map((n) => {
      if (n.id === id) {
        const { role: _drop, ...rest } = n;
        return role ? { ...rest, role } : rest;
      }
      if (role && n.role === role) {
        const { role: _drop, ...rest } = n;
        return rest;
      }
      return n;
    }),
  };
}

/** Set (or clear with undefined) the stored-form formula. Cycle checks happen before calling this. */
export function setFormula(state: ModelState, id: string, stored: string | undefined): ModelState {
  return mapNode(state, id, (n) => {
    const { formula: _drop, ...rest } = n;
    return stored && stored.trim() ? { ...rest, formula: stored.trim() } : rest;
  });
}

export function setTimeMode(state: ModelState, id: string, mode: TimeMode): ModelState {
  return mapNode(state, id, (n) => {
    if (n.timeMode === mode) return n;
    // Values do not translate between a series and a single value; keep the last estimate as the scalar seed.
    let values: Record<string, number> = {};
    if (mode === 'scalar') {
      const last = [...state.periods].reverse().find((p) => n.values[p.id] !== undefined);
      if (last) values = { [SCALAR_KEY]: n.values[last.id] };
    } else if (n.values[SCALAR_KEY] !== undefined) {
      const lastE = [...state.periods].reverse().find((p) => p.status === 'E');
      if (lastE) values = { [lastE.id]: n.values[SCALAR_KEY] };
    }
    return { ...n, timeMode: mode, values, overrides: {}, cellStatus: {} };
  });
}

/**
 * Change a node's unit. With `convert` (default) values are rescaled so the quantity is preserved
 * when only the scale changes (e.g. 1,853 億 → 185,300 million).
 */
export function setUnit(state: ModelState, id: string, unit: Unit | null, convert = true): ModelState {
  return mapNode(state, id, (n) => {
    const next = unit ? normalizeUnit(unit) : null;
    const old = n.unit;
    let factor = 1;
    if (convert && old && next && old.kind === next.kind && !isScaleFree(next.kind) && old.scale !== next.scale) {
      factor = old.scale / next.scale;
    }
    if (factor === 1) return { ...n, unit: next };
    const scale = (rec: Record<string, number>) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v * factor]));
    const overrides: ModelNode['overrides'] = {};
    for (const s of ['bear', 'bull'] as const) if (n.overrides[s]) overrides[s] = scale(n.overrides[s]!);
    return { ...n, unit: next, values: scale(n.values), overrides };
  });
}

/**
 * Write one cell. Base scenario → shared value. Bear/Bull → override, but only on estimate cells;
 * on actual cells the shared value is written because actuals are identical across scenarios.
 * `value === null` clears the cell (inherit base / fall back to formula).
 */
export function setValue(state: ModelState, id: string, periodKey: string, scenario: ScenarioId, value: number | null): ModelState {
  const ix = indexModel(state);
  const node = requireNode(state, id);
  if (value !== null && !Number.isFinite(value)) throw new ModelOpError('Value must be a finite number');
  const status = cellStatus(ix, node, periodKey);
  const target: 'base' | OverrideScenario = scenario === 'base' || status === 'A' ? 'base' : scenario;
  return mapNode(state, id, (n) => {
    if (target === 'base') {
      const values = { ...n.values };
      if (value === null) delete values[periodKey];
      else values[periodKey] = value;
      return { ...n, values };
    }
    const rec = { ...(n.overrides[target] ?? {}) };
    if (value === null) delete rec[periodKey];
    else rec[periodKey] = value;
    const overrides = { ...n.overrides };
    if (Object.keys(rec).length) overrides[target] = rec;
    else delete overrides[target];
    return { ...n, overrides };
  });
}

/** Mark a single cell Actual/Estimate against its period default (null = follow the period). */
export function setCellStatus(state: ModelState, id: string, periodId: string, status: PeriodStatus | null): ModelState {
  const period = state.periods.find((p) => p.id === periodId);
  if (!period) throw new ModelOpError(`Period ${periodId} does not exist`);
  return mapNode(state, id, (n) => {
    const cs = { ...n.cellStatus };
    if (status === null || status === period.status) delete cs[periodId];
    else cs[periodId] = status;
    let overrides = n.overrides;
    if ((cs[periodId] ?? period.status) === 'A') overrides = dropOverrideKey(n.overrides, periodId);
    return { ...n, cellStatus: cs, overrides };
  });
}

function dropOverrideKey(ov: ModelNode['overrides'], key: string): ModelNode['overrides'] {
  const out: ModelNode['overrides'] = {};
  for (const s of ['bear', 'bull'] as const) {
    const rec = ov[s];
    if (!rec) continue;
    if (key in rec) {
      const { [key]: _drop, ...rest } = rec;
      if (Object.keys(rest).length) out[s] = rest;
    } else out[s] = rec;
  }
  return out;
}

export interface DeleteResult {
  state: ModelState;
  removedIds: string[];
  /** Remaining nodes whose formulas now contain deleted references. */
  brokenFormulaNodeIds: string[];
}

export function deleteNode(state: ModelState, id: string): DeleteResult {
  requireNode(state, id);
  const ix = indexModel(state);
  const removed = new Set([id, ...descendants(ix, id)]);
  const nodes = state.nodes.filter((n) => !removed.has(n.id));
  const broken = nodes
    .filter((n) => n.formula && formulaRefIds(n.formula).some((r) => removed.has(r)))
    .map((n) => n.id);
  return {
    state: {
      ...state,
      nodes,
      links: state.links.filter((l) => !removed.has(l.nodeId)),
      theses: state.theses.map((t) => ({ ...t, nodeIds: t.nodeIds.filter((x) => !removed.has(x)) })),
    },
    removedIds: [...removed],
    brokenFormulaNodeIds: broken,
  };
}

export function formulaRefIds(stored: string): string[] {
  try {
    return tokenize(stored)
      .filter((t) => t.t === 'idref')
      .map((t) => (t as { v: string }).v);
  } catch {
    return [];
  }
}

/** Nodes whose formulas reference `id` (for "used by" warnings before deleting). */
export function referencingNodes(state: ModelState, ids: string[]): ModelNode[] {
  const set = new Set(ids);
  return state.nodes.filter((n) => !set.has(n.id) && n.formula && formulaRefIds(n.formula).some((r) => set.has(r)));
}

/** Move a node (with its subtree) under a new parent at a sibling position. */
export function moveNode(state: ModelState, id: string, newParentId: string | null, position: number): ModelState {
  requireNode(state, id);
  const ix = indexModel(state);
  if (newParentId === id || (newParentId !== null && isDescendant(ix, newParentId, id))) {
    throw new ModelOpError('A node cannot be moved inside itself');
  }
  if (newParentId !== null) requireNode(state, newParentId);
  const block = new Set([id, ...descendants(ix, id)]);
  const moving = state.nodes.filter((n) => block.has(n.id)).map((n) => (n.id === id ? { ...n, parentId: newParentId } : n));
  const rest: ModelState = { ...state, nodes: state.nodes.filter((n) => !block.has(n.id)) };
  const at = insertionIndex(rest, newParentId, position);
  const nodes = [...rest.nodes];
  nodes.splice(at, 0, ...moving);
  return { ...state, nodes };
}

export function moveUp(state: ModelState, id: string): ModelState {
  const n = requireNode(state, id);
  const sibs = childrenOf(indexModel(state), n.parentId);
  const pos = sibs.findIndex((s) => s.id === id);
  return pos <= 0 ? state : moveNode(state, id, n.parentId, pos - 1);
}

export function moveDown(state: ModelState, id: string): ModelState {
  const n = requireNode(state, id);
  const sibs = childrenOf(indexModel(state), n.parentId);
  const pos = sibs.findIndex((s) => s.id === id);
  return pos < 0 || pos >= sibs.length - 1 ? state : moveNode(state, id, n.parentId, pos + 1);
}

/** Make the node the last child of its previous sibling. */
export function indent(state: ModelState, id: string): ModelState {
  const n = requireNode(state, id);
  const sibs = childrenOf(indexModel(state), n.parentId);
  const pos = sibs.findIndex((s) => s.id === id);
  if (pos <= 0) return state;
  const newParent = sibs[pos - 1];
  return moveNode(state, id, newParent.id, childrenOf(indexModel(state), newParent.id).length);
}

/** Make the node the next sibling of its parent. */
export function outdent(state: ModelState, id: string): ModelState {
  const n = requireNode(state, id);
  if (n.parentId === null) return state;
  const parent = requireNode(state, n.parentId);
  const sibs = childrenOf(indexModel(state), parent.parentId);
  const pos = sibs.findIndex((s) => s.id === parent.id);
  return moveNode(state, id, parent.parentId, pos + 1);
}

/**
 * Duplicate a node and its subtree. Formula references that point inside the copied branch are
 * remapped to the copies; references outside it are kept. Evidence links are not copied
 * (evidence for one segment is not evidence for another).
 */
export function duplicateBranch(state: ModelState, id: string): { state: ModelState; id: string } {
  const root = requireNode(state, id);
  const ix = indexModel(state);
  const ids = [id, ...descendants(ix, id)];
  const map = new Map(ids.map((old) => [old, newNodeId()]));
  const copies = state.nodes
    .filter((n) => map.has(n.id))
    .map((n) => {
      const { role: _role, ...rest } = n;
      return {
        ...rest,
        id: map.get(n.id)!,
        parentId: n.id === id ? n.parentId : map.get(n.parentId!) ?? n.parentId,
        name: n.id === id ? `${n.name} (copy)` : n.name,
        ...(n.formula ? { formula: remapIds(n.formula, map) } : {}),
        values: { ...n.values },
        overrides: JSON.parse(JSON.stringify(n.overrides)) as ModelNode['overrides'],
        cellStatus: { ...n.cellStatus },
      };
    });
  const sibs = childrenOf(ix, root.parentId);
  const pos = sibs.findIndex((s) => s.id === id) + 1;
  const at = insertionIndex(state, root.parentId, pos);
  const nodes = [...state.nodes];
  nodes.splice(at, 0, ...copies);
  return { state: { ...state, nodes }, id: map.get(id)! };
}

// ---------------------------------------------------------------- periods

export const PERIOD_ID_RE = /^[A-Za-z0-9_]+$/;

export function addPeriod(state: ModelState, period: Period, where: 'start' | 'end' = 'end'): ModelState {
  if (!PERIOD_ID_RE.test(period.id)) throw new ModelOpError('Period IDs may only contain letters, digits and _ (e.g. FY2029)');
  if (state.periods.some((p) => p.id === period.id)) throw new ModelOpError(`Period ${period.id} already exists`);
  const periods = where === 'start' ? [period, ...state.periods] : [...state.periods, period];
  return { ...state, periods };
}

/** Suggest the next fiscal-year period after the last one (FY2028 → FY2029). */
export function nextPeriodSuggestion(state: ModelState): Period {
  const last = state.periods.at(-1);
  const m = last?.id.match(/^([A-Za-z_]*)(\d{4})(.*)$/);
  if (m && !m[3]) {
    const y = Number(m[2]) + 1;
    return { id: `${m[1]}${y}`, label: String(y), status: 'E' };
  }
  const y = new Date().getFullYear() + 1;
  return { id: `FY${y}`, label: String(y), status: 'E' };
}

export function previousPeriodSuggestion(state: ModelState): Period {
  const first = state.periods[0];
  const m = first?.id.match(/^([A-Za-z_]*)(\d{4})(.*)$/);
  if (m && !m[3]) {
    const y = Number(m[2]) - 1;
    return { id: `${m[1]}${y}`, label: String(y), status: 'A' };
  }
  const y = new Date().getFullYear() - 1;
  return { id: `FY${y}`, label: String(y), status: 'A' };
}

/** Formulas that pin this period with @PERIOD. */
export function nodesReferencingPeriod(state: ModelState, periodId: string): ModelNode[] {
  return state.nodes.filter((n) => {
    if (!n.formula) return false;
    try {
      return tokenize(n.formula).some((t) => t.t === 'at' && t.v === periodId);
    } catch {
      return false;
    }
  });
}

export function removePeriod(state: ModelState, periodId: string): ModelState {
  if (!state.periods.some((p) => p.id === periodId)) throw new ModelOpError(`Period ${periodId} does not exist`);
  const users = nodesReferencingPeriod(state, periodId);
  if (users.length) {
    throw new ModelOpError(`Period ${periodId} is used by the formula of ${users.map((u) => u.name).join(', ')}. Change those formulas first.`);
  }
  const strip = (rec: Record<string, number>) => {
    const { [periodId]: _drop, ...rest } = rec;
    return rest;
  };
  return {
    ...state,
    periods: state.periods.filter((p) => p.id !== periodId),
    nodes: state.nodes.map((n) => {
      const overrides: ModelNode['overrides'] = {};
      for (const s of ['bear', 'bull'] as const) if (n.overrides[s]) overrides[s] = strip(n.overrides[s]!);
      const { [periodId]: _cs, ...cellStatusRest } = n.cellStatus;
      return { ...n, values: strip(n.values), overrides, cellStatus: cellStatusRest };
    }),
  };
}

/**
 * Update a period's label or status. Marking a period Actual drops Bear/Bull overrides on its
 * estimate cells, because actuals are shared across scenarios.
 */
export function updatePeriod(state: ModelState, periodId: string, patch: { label?: string; status?: PeriodStatus; endDate?: string }): ModelState {
  const period = state.periods.find((p) => p.id === periodId);
  if (!period) throw new ModelOpError(`Period ${periodId} does not exist`);
  const next = { ...period, ...patch };
  let nodes = state.nodes;
  if (patch.status === 'A' && period.status !== 'A') {
    nodes = nodes.map((n) => ((n.cellStatus[periodId] ?? 'A') === 'A' ? { ...n, overrides: dropOverrideKey(n.overrides, periodId) } : n));
  }
  return { ...state, periods: state.periods.map((p) => (p.id === periodId ? next : p)), nodes };
}

// ---------------------------------------------------------------- evidence links

export function addLink(state: ModelState, link: Omit<EvidenceLink, 'id'> & { id?: string }): { state: ModelState; id: string } {
  requireNode(state, link.nodeId);
  const existing = state.links.find((l) => l.nodeId === link.nodeId && l.evidenceId === link.evidenceId);
  if (existing) return { state: updateLink(state, existing.id, { relation: link.relation, locator: link.locator, note: link.note }), id: existing.id };
  const full: EvidenceLink = { id: link.id ?? newLinkId(), evidenceId: link.evidenceId, nodeId: link.nodeId, relation: link.relation };
  if (link.locator) full.locator = link.locator;
  if (link.note) full.note = link.note;
  return { state: { ...state, links: [...state.links, full] }, id: full.id };
}

export function updateLink(state: ModelState, id: string, patch: Partial<Omit<EvidenceLink, 'id' | 'evidenceId' | 'nodeId'>>): ModelState {
  return {
    ...state,
    links: state.links.map((l) => {
      if (l.id !== id) return l;
      const next: EvidenceLink = { ...l, ...patch };
      if (!next.locator) delete next.locator;
      if (!next.note) delete next.note;
      return next;
    }),
  };
}

export function removeLink(state: ModelState, id: string): ModelState {
  return { ...state, links: state.links.filter((l) => l.id !== id) };
}

// ---------------------------------------------------------------- theses

export function addThesis(state: ModelState, t: Partial<Thesis> & { statement: string }): { state: ModelState; id: string } {
  const thesis: Thesis = {
    id: t.id ?? newThesisId(),
    statement: t.statement,
    invalidation: t.invalidation ?? '',
    nodeIds: t.nodeIds ?? [],
    status: t.status ?? 'active',
    ...(t.reviewBy ? { reviewBy: t.reviewBy } : {}),
  };
  return { state: { ...state, theses: [...state.theses, thesis] }, id: thesis.id };
}

export function updateThesis(state: ModelState, id: string, patch: Partial<Omit<Thesis, 'id'>>): ModelState {
  return {
    ...state,
    theses: state.theses.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      if (!next.reviewBy) delete next.reviewBy;
      return next;
    }),
  };
}

export function removeThesis(state: ModelState, id: string): ModelState {
  return { ...state, theses: state.theses.filter((t) => t.id !== id) };
}

// ---------------------------------------------------------------- valuation context

export function updateValuation(state: ModelState, patch: Partial<ValuationContext>): ModelState {
  return { ...state, valuation: { ...state.valuation, ...patch } };
}

export function addPeer(state: ModelState, peer: Partial<Peer> & { name: string }): ModelState {
  return updateValuation(state, { peers: [...state.valuation.peers, { ...peer, id: peer.id ?? newPeerId() }] });
}

export function updatePeer(state: ModelState, id: string, patch: Partial<Omit<Peer, 'id'>>): ModelState {
  return updateValuation(state, {
    peers: state.valuation.peers.map((p) => {
      if (p.id !== id) return p;
      const next: Peer = { ...p, ...patch };
      for (const k of Object.keys(next) as (keyof Peer)[]) if (next[k] === undefined || next[k] === '') delete next[k];
      return next;
    }),
  });
}

export function removePeer(state: ModelState, id: string): ModelState {
  return updateValuation(state, { peers: state.valuation.peers.filter((p) => p.id !== id) });
}
