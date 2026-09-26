import { compute, type CalcResult } from '../calc/engine';
import { parseNodeFormula } from '../calc/graph';
import { walk } from '../formula/parser';
import { findByRole, indexModel } from '../model/tree';
import { SCALAR_KEY, SCENARIO_IDS, type ModelState, type ScenarioId } from '../model/types';
import { diffStates, directlyChangedNodeIds, type ModelChange } from './diff';

type PerScenario<T> = Record<ScenarioId, T>;

export interface HeadlineCell {
  scenario: ScenarioId;
  periodKey: string;
  before: number | null;
  after: number | null;
}

export interface ImpactNode {
  nodeId: string;
  name: string;
  direct: boolean;
  cells: HeadlineCell[];
}

export interface AttributionRow {
  nodeId: string;
  name: string;
  eps: PerScenario<number | null>;
  targetPrice: PerScenario<number | null>;
  note?: string;
}

export interface Impact {
  basisPeriodId: string | null;
  headline: {
    eps: HeadlineCell[];
    targetPrice: HeadlineCell[];
    targetMultiple: HeadlineCell[];
  };
  nodes: ImpactNode[];
  attribution: AttributionRow[];
  residual: { eps: PerScenario<number | null>; targetPrice: PerScenario<number | null> };
}

/** The EPS period pinned by the target-price formula (e.g. FY2028), else the last estimate period. */
export function basisPeriodId(state: ModelState): string | null {
  const tp = findByRole(state, 'target_price');
  const eps = findByRole(state, 'eps');
  if (tp?.formula && eps) {
    const p = parseNodeFormula(tp.formula);
    if (p.ok) {
      let found: string | null = null;
      walk(p.ast, (a) => {
        if (!found && a.k === 'ref' && a.target.kind === 'id' && a.target.id === eps.id && a.period) found = a.period;
      });
      if (found) return found;
    }
  }
  const lastE = [...state.periods].reverse().find((p) => p.status === 'E');
  return lastE?.id ?? state.periods.at(-1)?.id ?? null;
}

const val = (r: CalcResult, s: ScenarioId, id: string | undefined, key: string | null) =>
  id && key ? r.cells[s][id]?.[key]?.v ?? null : null;

const differs = (a: number | null, b: number | null) => {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
};

export interface KeyOutputs {
  eps: PerScenario<number | null>;
  targetPrice: PerScenario<number | null>;
  targetMultiple: PerScenario<number | null>;
}

export function keyOutputs(state: ModelState, result: CalcResult, basis = basisPeriodId(state)): KeyOutputs {
  const eps = findByRole(state, 'eps')?.id;
  const tp = findByRole(state, 'target_price')?.id;
  const tm = findByRole(state, 'target_multiple')?.id;
  const tmNode = tm ? state.nodes.find((n) => n.id === tm) : undefined;
  const tmKey = tmNode?.timeMode === 'series' ? basis : SCALAR_KEY;
  const out: KeyOutputs = { eps: { bear: null, base: null, bull: null }, targetPrice: { bear: null, base: null, bull: null }, targetMultiple: { bear: null, base: null, bull: null } };
  for (const s of SCENARIO_IDS) {
    out.eps[s] = val(result, s, eps, basis);
    out.targetPrice[s] = val(result, s, tp, SCALAR_KEY) ?? val(result, s, tp, basis);
    out.targetMultiple[s] = val(result, s, tm, tmKey);
  }
  return out;
}

export interface ImpactOptions {
  attribution?: boolean;
  changes?: ModelChange[];
  before?: CalcResult;
  after?: CalcResult;
}

export function computeImpact(beforeState: ModelState, afterState: ModelState, opts: ImpactOptions = {}): Impact {
  const rb = opts.before ?? compute(beforeState);
  const ra = opts.after ?? compute(afterState);
  const changes = opts.changes ?? diffStates(beforeState, afterState);
  const direct = directlyChangedNodeIds(changes);
  const basis = basisPeriodId(afterState);
  const ixA = indexModel(afterState);
  const ixB = indexModel(beforeState);

  // headline
  const epsA = findByRole(afterState, 'eps')?.id;
  const epsB = findByRole(beforeState, 'eps')?.id;
  const estimatePeriods = afterState.periods.filter((p) => p.status === 'E').map((p) => p.id);
  const eps: HeadlineCell[] = [];
  for (const pk of estimatePeriods) {
    for (const s of SCENARIO_IDS) eps.push({ scenario: s, periodKey: pk, before: val(rb, s, epsB, pk), after: val(ra, s, epsA, pk) });
  }
  const kb = keyOutputs(beforeState, rb, basis);
  const ka = keyOutputs(afterState, ra, basis);
  const targetPrice = SCENARIO_IDS.map((s) => ({ scenario: s, periodKey: SCALAR_KEY, before: kb.targetPrice[s], after: ka.targetPrice[s] }));
  const targetMultiple = SCENARIO_IDS.map((s) => ({ scenario: s, periodKey: SCALAR_KEY, before: kb.targetMultiple[s], after: ka.targetMultiple[s] }));

  // per-node changes in dependency order
  const nodes: ImpactNode[] = [];
  for (const id of ra.graph.order) {
    const n = ixA.byId.get(id)!;
    const cells: HeadlineCell[] = [];
    for (const s of SCENARIO_IDS) {
      for (const [key, c] of Object.entries(ra.cells[s][id] ?? {})) {
        const before = ixB.byId.has(id) ? rb.cells[s][id]?.[key]?.v ?? null : null;
        if (differs(before, c.v)) cells.push({ scenario: s, periodKey: key, before, after: c.v });
      }
    }
    if (cells.length) nodes.push({ nodeId: id, name: n.name, direct: direct.has(id) || !ixB.byId.has(id), cells });
  }

  // one-at-a-time marginal attribution over nodes that exist in both states
  const attribution: AttributionRow[] = [];
  const residual = {
    eps: { bear: null, base: null, bull: null } as PerScenario<number | null>,
    targetPrice: { bear: null, base: null, bull: null } as PerScenario<number | null>,
  };
  if (opts.attribution !== false) {
    const candidates = [...direct].filter((id) => ixB.byId.has(id) && ixA.byId.has(id));
    const sums = { eps: { bear: 0, base: 0, bull: 0 }, targetPrice: { bear: 0, base: 0, bull: 0 } };
    const sumValid = { eps: { bear: true, base: true, bull: true }, targetPrice: { bear: true, base: true, bull: true } };
    for (const id of candidates) {
      const replacement = ixA.byId.get(id)!;
      const trial: ModelState = {
        ...beforeState,
        nodes: beforeState.nodes.map((n) => (n.id === id ? { ...replacement, parentId: n.parentId } : n)),
      };
      const row: AttributionRow = { nodeId: id, name: replacement.name, eps: { bear: null, base: null, bull: null }, targetPrice: { bear: null, base: null, bull: null } };
      let kt: KeyOutputs | null = null;
      try {
        kt = keyOutputs(trial, compute(trial), basis);
      } catch {
        row.note = 'Could not be isolated from the other changes';
      }
      for (const s of SCENARIO_IDS) {
        for (const metric of ['eps', 'targetPrice'] as const) {
          const b = kb[metric][s];
          const t = kt?.[metric][s] ?? null;
          const effect = b !== null && t !== null ? t - b : null;
          row[metric][s] = effect;
          if (effect === null) sumValid[metric][s] = false;
          else sums[metric][s] += effect;
        }
      }
      if (!row.note && SCENARIO_IDS.every((s) => row.eps[s] === null && row.targetPrice[s] === null)) {
        row.note = 'Depends on another change in this update (e.g. a new node); effect is in the residual';
      }
      attribution.push(row);
    }
    for (const s of SCENARIO_IDS) {
      for (const metric of ['eps', 'targetPrice'] as const) {
        const b = kb[metric][s];
        const a = ka[metric][s];
        residual[metric][s] = b !== null && a !== null && sumValid[metric][s] ? a - b - sums[metric][s] : null;
      }
    }
    const order = new Map(ra.graph.order.map((id, i) => [id, i]));
    attribution.sort((x, y) => Math.abs(y.targetPrice.base ?? 0) - Math.abs(x.targetPrice.base ?? 0) || (order.get(x.nodeId)! - order.get(y.nodeId)!));
  }

  return { basisPeriodId: basis, headline: { eps, targetPrice, targetMultiple }, nodes, attribution, residual };
}
