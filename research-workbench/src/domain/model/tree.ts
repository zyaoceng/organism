import type { ModelNode, ModelState, Period, PeriodStatus } from './types';
import { SCALAR_KEY } from './types';

export interface ModelIndex {
  byId: Map<string, ModelNode>;
  /** Children in sibling order; key null = top level. */
  children: Map<string | null, ModelNode[]>;
  periodIndex: Map<string, number>;
  periods: Period[];
}

export function indexModel(state: ModelState): ModelIndex {
  const byId = new Map<string, ModelNode>();
  const children = new Map<string | null, ModelNode[]>();
  for (const n of state.nodes) byId.set(n.id, n);
  for (const n of state.nodes) {
    const key = n.parentId !== null && byId.has(n.parentId) ? n.parentId : null;
    let list = children.get(key);
    if (!list) children.set(key, (list = []));
    list.push(n);
  }
  const periodIndex = new Map<string, number>();
  state.periods.forEach((p, i) => periodIndex.set(p.id, i));
  return { byId, children, periodIndex, periods: state.periods };
}

export function childrenOf(ix: ModelIndex, id: string | null): ModelNode[] {
  return ix.children.get(id) ?? [];
}

/** Ancestors from the top level down to (excluding) the node. */
export function ancestors(ix: ModelIndex, id: string): ModelNode[] {
  const out: ModelNode[] = [];
  let cur = ix.byId.get(id);
  const seen = new Set<string>();
  while (cur && cur.parentId !== null && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const p = ix.byId.get(cur.parentId);
    if (!p) break;
    out.unshift(p);
    cur = p;
  }
  return out;
}

export function pathNames(ix: ModelIndex, id: string): string[] {
  const n = ix.byId.get(id);
  if (!n) return [];
  return [...ancestors(ix, id).map((a) => a.name), n.name];
}

export function descendants(ix: ModelIndex, id: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    for (const c of childrenOf(ix, pid)) {
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

export function isDescendant(ix: ModelIndex, maybeDescendant: string, of: string): boolean {
  return ancestors(ix, maybeDescendant).some((a) => a.id === of);
}

export interface TreeRow {
  node: ModelNode;
  depth: number;
  hasChildren: boolean;
}

/** Pre-order rows, skipping children of collapsed nodes. */
export function visibleRows(state: ModelState, collapsed: ReadonlySet<string>): TreeRow[] {
  const ix = indexModel(state);
  const rows: TreeRow[] = [];
  const walk = (pid: string | null, depth: number) => {
    for (const n of childrenOf(ix, pid)) {
      const kids = childrenOf(ix, n.id);
      rows.push({ node: n, depth, hasChildren: kids.length > 0 });
      if (kids.length && !collapsed.has(n.id)) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** Period keys a node holds values for. */
export function nodePeriodKeys(state: ModelState, node: ModelNode): string[] {
  return node.timeMode === 'scalar' ? [SCALAR_KEY] : state.periods.map((p) => p.id);
}

/** Actual/Estimate status of a cell (scalar cells are always estimates/assumptions). */
export function cellStatus(ix: ModelIndex, node: ModelNode, periodKey: string): PeriodStatus {
  if (periodKey === SCALAR_KEY) return 'E';
  const override = node.cellStatus[periodKey];
  if (override) return override;
  const i = ix.periodIndex.get(periodKey);
  return i === undefined ? 'E' : ix.periods[i].status;
}

/** A node with no unit, formula or values is a heading (pure structure). */
export function isHeading(node: ModelNode): boolean {
  return !node.unit && !node.formula && Object.keys(node.values).length === 0;
}

export function findByRole(state: ModelState, role: string): ModelNode | undefined {
  return state.nodes.find((n) => n.role === role);
}
