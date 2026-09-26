import { indexModel, type ModelIndex } from '../model/tree';
import type { ModelState } from '../model/types';
import { FormulaSyntaxError } from '../formula/lexer';
import { parseFormula, type Ast } from '../formula/parser';
import { childrenForAggregate, extractRefs, type RefInfo } from '../formula/refs';

export type ParsedFormula = { ok: true; ast: Ast; refs: RefInfo } | { ok: false; message: string };

export interface DepGraph {
  parsed: Map<string, ParsedFormula>;
  /** node → nodes it reads in the same (or an absolute) period, incl. CHILDREN() expansion. */
  direct: Map<string, Set<string>>;
  /** node → nodes it reads through PREV(). */
  lagged: Map<string, Set<string>>;
  /** node → nodes whose formulas read it (direct or lagged). */
  dependents: Map<string, Set<string>>;
  /** Inputs before dependents; nodes caught in cycles come last. */
  order: string[];
  cycles: string[][];
  inCycle: Set<string>;
  /** CHILDREN() expansion per node that uses it. */
  childrenExpansion: Map<string, string[]>;
}

export function parseNodeFormula(formula: string): ParsedFormula {
  try {
    const ast = parseFormula(formula);
    return { ok: true, ast, refs: extractRefs(ast) };
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return { ok: false, message: e.message };
    throw e;
  }
}

export function buildGraph(state: ModelState, ix: ModelIndex = indexModel(state)): DepGraph {
  const parsed = new Map<string, ParsedFormula>();
  const direct = new Map<string, Set<string>>();
  const lagged = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const childrenExpansion = new Map<string, string[]>();
  /** Edges created by an absolute period reference (`[X]@FY2028`); they can point forward in time. */
  const absolute = new Map<string, Set<string>>();

  for (const n of state.nodes) {
    absolute.set(n.id, new Set());
    direct.set(n.id, new Set());
    lagged.set(n.id, new Set());
    dependents.set(n.id, new Set());
  }
  for (const n of state.nodes) {
    if (!n.formula) continue;
    const p = parseNodeFormula(n.formula);
    parsed.set(n.id, p);
    if (!p.ok) continue;
    const d = direct.get(n.id)!;
    const l = lagged.get(n.id)!;
    for (const id of p.refs.direct) if (ix.byId.has(id)) d.add(id);
    // PREV() does not shift a single-value node, so a lagged read of a scalar is a same-period read.
    for (const id of p.refs.lagged) if (ix.byId.has(id)) (ix.byId.get(id)!.timeMode === 'scalar' ? d : l).add(id);
    for (const pr of p.refs.periods) if (ix.byId.has(pr.id)) absolute.get(n.id)!.add(pr.id);
    if (p.refs.childrenDirect || p.refs.childrenLagged) {
      const kids = childrenForAggregate(ix, n.id).map((c) => c.id);
      childrenExpansion.set(n.id, kids);
      for (const k of kids) (p.refs.childrenDirect ? d : l).add(k);
    }
  }
  for (const [from, tos] of direct) for (const to of tos) dependents.get(to)?.add(from);
  for (const [from, tos] of lagged) for (const to of tos) dependents.get(to)?.add(from);

  const ids = state.nodes.map((n) => n.id);
  const inCycle = new Set<string>();
  const cycles: string[][] = [];
  const hasSelfLoop = (id: string, adj: (v: string) => Iterable<string>) => [...adj(id)].includes(id);

  // 1. Same-period (and absolute-period) edges must form a DAG.
  const directAdj = (v: string) => direct.get(v) ?? [];
  for (const comp of stronglyConnected(ids, directAdj)) {
    if (comp.length > 1 || hasSelfLoop(comp[0], directAdj)) {
      comp.forEach((c) => inCycle.add(c));
      cycles.push(findCyclePath(comp, directAdj));
    }
  }
  // 2. Lagged edges point to earlier periods, but an absolute reference can point to a later one.
  //    Any loop through lagged edges that also contains an absolute reference is treated as circular.
  const allAdj = (v: string) => [...(direct.get(v) ?? []), ...(lagged.get(v) ?? [])];
  for (const comp of stronglyConnected(ids, allAdj)) {
    if (comp.every((c) => inCycle.has(c))) continue;
    const members = new Set(comp);
    const loop = comp.length > 1 || hasSelfLoop(comp[0], allAdj);
    const viaAbsolute = comp.some((c) => [...(absolute.get(c) ?? [])].some((t) => members.has(t)));
    if (loop && viaAbsolute) {
      comp.forEach((c) => inCycle.add(c));
      cycles.push(findCyclePath(comp, allAdj));
    }
  }

  // Kahn topological order over direct edges (dependency before dependent).
  const indeg = new Map<string, number>();
  for (const n of state.nodes) indeg.set(n.id, 0);
  for (const [from, tos] of direct) {
    if (inCycle.has(from)) continue;
    let c = 0;
    for (const to of tos) if (!inCycle.has(to)) c++;
    indeg.set(from, c);
  }
  const order: string[] = [];
  const queue = state.nodes.filter((n) => !inCycle.has(n.id) && indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const v = queue.shift()!;
    order.push(v);
    for (const dep of dependents.get(v) ?? []) {
      if (inCycle.has(dep) || !direct.get(dep)?.has(v)) continue;
      const k = indeg.get(dep)! - 1;
      indeg.set(dep, k);
      if (k === 0) queue.push(dep);
    }
  }
  const placed = new Set(order);
  for (const n of state.nodes) if (!placed.has(n.id)) order.push(n.id);

  return { parsed, direct, lagged, dependents, order, cycles, inCycle, childrenExpansion };
}

/** Tarjan's strongly connected components. */
function stronglyConnected(ids: string[], adj: (v: string) => Iterable<string>): string[][] {
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;
  const strong = (v: string) => {
    indexOf.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj(v)) {
      if (!indexOf.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, indexOf.get(w)!));
    }
    if (low.get(v) === indexOf.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const id of ids) if (!indexOf.has(id)) strong(id);
  return sccs;
}

function findCyclePath(comp: string[], adj: (v: string) => Iterable<string>): string[] {
  const members = new Set(comp);
  const start = comp[comp.length - 1];
  const path: string[] = [start];
  const seen = new Set<string>([start]);
  const dfs = (v: string): boolean => {
    for (const w of adj(v)) {
      if (!members.has(w)) continue;
      if (w === start) {
        path.push(start);
        return true;
      }
      if (seen.has(w)) continue;
      seen.add(w);
      path.push(w);
      if (dfs(w)) return true;
      path.pop();
    }
    return false;
  };
  dfs(start);
  return path;
}

/** All nodes that `id` depends on, transitively (direct and lagged). */
export function upstream(graph: DepGraph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const v = stack.pop()!;
    for (const w of [...(graph.direct.get(v) ?? []), ...(graph.lagged.get(v) ?? [])]) {
      if (!out.has(w) && w !== id) {
        out.add(w);
        stack.push(w);
      }
    }
  }
  return out;
}

/** All nodes that depend on `id`, transitively. */
export function downstream(graph: DepGraph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const v = stack.pop()!;
    for (const w of graph.dependents.get(v) ?? []) {
      if (!out.has(w) && w !== id) {
        out.add(w);
        stack.push(w);
      }
    }
  }
  return out;
}

/**
 * Would giving `nodeId` this stored formula create a circular dependency?
 * Returns the cycle as node IDs (first = last) or null.
 */
export function findCycleWith(state: ModelState, nodeId: string, storedFormula: string | undefined): string[] | null {
  const next: ModelState = {
    ...state,
    nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, formula: storedFormula } : n)),
  };
  const g = buildGraph(next);
  if (!g.inCycle.has(nodeId)) return null;
  return g.cycles.find((c) => c.includes(nodeId)) ?? [nodeId, nodeId];
}
