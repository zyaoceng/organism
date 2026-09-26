import { toDisplay } from '../formula/refs';
import { childrenOf, indexModel, type ModelIndex } from '../model/tree';
import type { ModelNode, ModelState, PeriodStatus, ScenarioId } from '../model/types';
import { sameUnit, type Unit } from '../units';

export type ModelChange =
  | { type: 'node_added'; nodeId: string; name: string; parentName: string | null }
  | { type: 'node_removed'; nodeId: string; name: string }
  | { type: 'node_renamed'; nodeId: string; from: string; to: string }
  | { type: 'node_moved'; nodeId: string; name: string; fromParent: string | null; toParent: string | null }
  | { type: 'children_reordered'; parentId: string | null; parentName: string | null }
  | { type: 'node_unit'; nodeId: string; name: string; from: Unit | null; to: Unit | null }
  | { type: 'node_role'; nodeId: string; name: string; from: string | null; to: string | null }
  | { type: 'node_time_mode'; nodeId: string; name: string; from: string; to: string }
  | { type: 'formula_changed'; nodeId: string; name: string; from: string | null; to: string | null }
  | {
      type: 'value_changed';
      nodeId: string;
      name: string;
      periodKey: string;
      scenario: ScenarioId;
      from: number | null;
      to: number | null;
      unit: Unit | null;
    }
  | { type: 'cell_status_changed'; nodeId: string; name: string; periodKey: string; from: PeriodStatus | null; to: PeriodStatus | null }
  | { type: 'notes_changed'; nodeId: string; name: string; from: string; to: string }
  | { type: 'period_added'; periodId: string; label: string; status: PeriodStatus }
  | { type: 'period_removed'; periodId: string; label: string }
  | { type: 'period_changed'; periodId: string; field: 'label' | 'status' | 'endDate'; from: string | null; to: string | null }
  | { type: 'link_added' | 'link_removed'; linkId: string; nodeId: string; name: string; evidenceId: string; relation: string; locator?: string }
  | { type: 'link_changed'; linkId: string; nodeId: string; name: string; evidenceId: string; field: string; from: string | null; to: string | null }
  | { type: 'thesis_added' | 'thesis_removed'; thesisId: string; statement: string }
  | { type: 'thesis_changed'; thesisId: string; statement: string; field: string; from: string | null; to: string | null }
  | { type: 'valuation_changed'; path: string; label: string; from: string | number | null; to: string | number | null };

/** Node IDs whose values or formulas changed directly (used for impact and attribution). */
export function directlyChangedNodeIds(changes: ModelChange[]): Set<string> {
  const out = new Set<string>();
  for (const c of changes) {
    if (c.type === 'value_changed' || c.type === 'formula_changed' || c.type === 'node_unit' || c.type === 'node_time_mode' || c.type === 'cell_status_changed') {
      out.add(c.nodeId);
    }
  }
  return out;
}

/** Group key for UI: changes about the same node sit together. */
export function changeNodeId(c: ModelChange): string | null {
  return 'nodeId' in c ? c.nodeId : null;
}

const parentName = (ix: ModelIndex, n: ModelNode) => (n.parentId ? ix.byId.get(n.parentId)?.name ?? null : null);

function diffNumbers(
  out: ModelChange[],
  node: ModelNode,
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
  scenario: ScenarioId,
  keysInOrder: string[],
) {
  const ra = a ?? {};
  const rb = b ?? {};
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  const ordered = [...keysInOrder.filter((k) => keys.has(k)), ...[...keys].filter((k) => !keysInOrder.includes(k))];
  for (const k of ordered) {
    const from = ra[k] ?? null;
    const to = rb[k] ?? null;
    if (from !== to) out.push({ type: 'value_changed', nodeId: node.id, name: node.name, periodKey: k, scenario, from, to, unit: node.unit });
  }
}

export function diffStates(a: ModelState, b: ModelState): ModelChange[] {
  const out: ModelChange[] = [];
  const ixA = indexModel(a);
  const ixB = indexModel(b);
  const periodOrder = [...new Set([...b.periods.map((p) => p.id), ...a.periods.map((p) => p.id), '_'])];

  // periods
  const pa = new Map(a.periods.map((p) => [p.id, p]));
  const pb = new Map(b.periods.map((p) => [p.id, p]));
  for (const p of b.periods) {
    const old = pa.get(p.id);
    if (!old) {
      out.push({ type: 'period_added', periodId: p.id, label: p.label, status: p.status });
      continue;
    }
    if (old.label !== p.label) out.push({ type: 'period_changed', periodId: p.id, field: 'label', from: old.label, to: p.label });
    if (old.status !== p.status) out.push({ type: 'period_changed', periodId: p.id, field: 'status', from: old.status, to: p.status });
    if ((old.endDate ?? null) !== (p.endDate ?? null)) out.push({ type: 'period_changed', periodId: p.id, field: 'endDate', from: old.endDate ?? null, to: p.endDate ?? null });
  }
  for (const p of a.periods) if (!pb.has(p.id)) out.push({ type: 'period_removed', periodId: p.id, label: p.label });

  // nodes
  for (const n of b.nodes) {
    const old = ixA.byId.get(n.id);
    if (!old) {
      out.push({ type: 'node_added', nodeId: n.id, name: n.name, parentName: parentName(ixB, n) });
      if (n.formula) out.push({ type: 'formula_changed', nodeId: n.id, name: n.name, from: null, to: toDisplay(n.formula, ixB, n.id) });
      diffNumbers(out, n, undefined, n.values, 'base', periodOrder);
      diffNumbers(out, n, undefined, n.overrides.bear, 'bear', periodOrder);
      diffNumbers(out, n, undefined, n.overrides.bull, 'bull', periodOrder);
      if (n.notes) out.push({ type: 'notes_changed', nodeId: n.id, name: n.name, from: '', to: n.notes });
      continue;
    }
    if (old.name !== n.name) out.push({ type: 'node_renamed', nodeId: n.id, from: old.name, to: n.name });
    if (old.parentId !== n.parentId) {
      out.push({ type: 'node_moved', nodeId: n.id, name: n.name, fromParent: parentName(ixA, old), toParent: parentName(ixB, n) });
    }
    if (!sameUnit(old.unit, n.unit) && !(old.unit === null && n.unit === null)) {
      out.push({ type: 'node_unit', nodeId: n.id, name: n.name, from: old.unit, to: n.unit });
    }
    if ((old.role ?? null) !== (n.role ?? null)) out.push({ type: 'node_role', nodeId: n.id, name: n.name, from: old.role ?? null, to: n.role ?? null });
    if (old.timeMode !== n.timeMode) out.push({ type: 'node_time_mode', nodeId: n.id, name: n.name, from: old.timeMode, to: n.timeMode });
    if ((old.formula ?? '') !== (n.formula ?? '')) {
      out.push({
        type: 'formula_changed',
        nodeId: n.id,
        name: n.name,
        from: old.formula ? toDisplay(old.formula, ixA, n.id) : null,
        to: n.formula ? toDisplay(n.formula, ixB, n.id) : null,
      });
    }
    diffNumbers(out, n, old.values, n.values, 'base', periodOrder);
    diffNumbers(out, n, old.overrides.bear, n.overrides.bear, 'bear', periodOrder);
    diffNumbers(out, n, old.overrides.bull, n.overrides.bull, 'bull', periodOrder);
    const csKeys = new Set([...Object.keys(old.cellStatus), ...Object.keys(n.cellStatus)]);
    for (const k of csKeys) {
      const f = old.cellStatus[k] ?? null;
      const t = n.cellStatus[k] ?? null;
      if (f !== t) out.push({ type: 'cell_status_changed', nodeId: n.id, name: n.name, periodKey: k, from: f, to: t });
    }
    if (old.notes !== n.notes) out.push({ type: 'notes_changed', nodeId: n.id, name: n.name, from: old.notes, to: n.notes });
  }
  for (const n of a.nodes) if (!ixB.byId.has(n.id)) out.push({ type: 'node_removed', nodeId: n.id, name: n.name });

  // sibling order among nodes that exist in both states under the same parent
  const parents = new Set<string | null>([null, ...b.nodes.map((n) => n.id)]);
  for (const pid of parents) {
    if (pid !== null && !ixA.byId.has(pid)) continue;
    const orderA = childrenOf(ixA, pid).map((n) => n.id);
    const orderB = childrenOf(ixB, pid).map((n) => n.id);
    const common = new Set(orderA.filter((id) => orderB.includes(id)));
    const seqA = orderA.filter((id) => common.has(id));
    const seqB = orderB.filter((id) => common.has(id));
    if (seqA.join() !== seqB.join()) {
      out.push({ type: 'children_reordered', parentId: pid, parentName: pid ? ixB.byId.get(pid)?.name ?? null : null });
    }
  }

  // evidence links
  const la = new Map(a.links.map((l) => [l.id, l]));
  const lb = new Map(b.links.map((l) => [l.id, l]));
  const nodeName = (id: string) => ixB.byId.get(id)?.name ?? ixA.byId.get(id)?.name ?? id;
  for (const l of b.links) {
    const old = la.get(l.id);
    if (!old) {
      out.push({ type: 'link_added', linkId: l.id, nodeId: l.nodeId, name: nodeName(l.nodeId), evidenceId: l.evidenceId, relation: l.relation, locator: l.locator });
      continue;
    }
    for (const field of ['relation', 'locator', 'note'] as const) {
      const f = old[field] ?? null;
      const t = l[field] ?? null;
      if (f !== t) out.push({ type: 'link_changed', linkId: l.id, nodeId: l.nodeId, name: nodeName(l.nodeId), evidenceId: l.evidenceId, field, from: f, to: t });
    }
  }
  for (const l of a.links) {
    if (!lb.has(l.id)) out.push({ type: 'link_removed', linkId: l.id, nodeId: l.nodeId, name: nodeName(l.nodeId), evidenceId: l.evidenceId, relation: l.relation, locator: l.locator });
  }

  // theses
  const ta = new Map(a.theses.map((t) => [t.id, t]));
  const tb = new Map(b.theses.map((t) => [t.id, t]));
  for (const t of b.theses) {
    const old = ta.get(t.id);
    if (!old) {
      out.push({ type: 'thesis_added', thesisId: t.id, statement: t.statement });
      continue;
    }
    for (const field of ['statement', 'invalidation', 'status', 'reviewBy'] as const) {
      const f = old[field] ?? null;
      const to = t[field] ?? null;
      if (f !== to) out.push({ type: 'thesis_changed', thesisId: t.id, statement: t.statement, field, from: f, to });
    }
    if (old.nodeIds.join() !== t.nodeIds.join()) {
      out.push({
        type: 'thesis_changed',
        thesisId: t.id,
        statement: t.statement,
        field: 'nodes',
        from: old.nodeIds.map(nodeName).join(', '),
        to: t.nodeIds.map(nodeName).join(', '),
      });
    }
  }
  for (const t of a.theses) if (!tb.has(t.id)) out.push({ type: 'thesis_removed', thesisId: t.id, statement: t.statement });

  diffValuation(out, a, b);
  return out;
}

function diffValuation(out: ModelChange[], a: ModelState, b: ModelState) {
  const va = a.valuation;
  const vb = b.valuation;
  const val = (x: unknown) => (x === undefined || x === '' ? null : (x as string | number));
  const peersA = new Map(va.peers.map((p) => [p.id, p]));
  const peersB = new Map(vb.peers.map((p) => [p.id, p]));
  for (const p of vb.peers) {
    const old = peersA.get(p.id);
    if (!old) {
      out.push({ type: 'valuation_changed', path: `peers.${p.id}`, label: `Peer added: ${p.name}`, from: null, to: p.name });
      continue;
    }
    for (const field of ['name', 'ticker', 'pe', 'epsGrowth', 'roic', 'grossMargin', 'basis', 'source', 'asOf', 'note'] as const) {
      if (val(old[field]) !== val(p[field])) {
        out.push({ type: 'valuation_changed', path: `peers.${p.id}.${field}`, label: `Peer ${p.name}: ${field}`, from: val(old[field]), to: val(p[field]) });
      }
    }
  }
  for (const p of va.peers) {
    if (!peersB.has(p.id)) out.push({ type: 'valuation_changed', path: `peers.${p.id}`, label: `Peer removed: ${p.name}`, from: p.name, to: null });
  }
  for (const field of ['low', 'median', 'high', 'window', 'source', 'asOf', 'note'] as const) {
    if (val(va.historicalPE[field]) !== val(vb.historicalPE[field])) {
      out.push({ type: 'valuation_changed', path: `historicalPE.${field}`, label: `Historical P/E ${field}`, from: val(va.historicalPE[field]), to: val(vb.historicalPE[field]) });
    }
  }
  for (const s of ['bear', 'base', 'bull'] as const) {
    if (va.rationale[s] !== vb.rationale[s]) {
      out.push({ type: 'valuation_changed', path: `rationale.${s}`, label: `${s[0].toUpperCase()}${s.slice(1)} P/E rationale`, from: val(va.rationale[s]), to: val(vb.rationale[s]) });
    }
    if (va.probabilities[s] !== vb.probabilities[s]) {
      out.push({ type: 'valuation_changed', path: `probabilities.${s}`, label: `${s[0].toUpperCase()}${s.slice(1)} probability`, from: va.probabilities[s], to: vb.probabilities[s] });
    }
  }
}
