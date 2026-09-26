import { cellStatus, indexModel, nodePeriodKeys, type ModelIndex } from '../model/tree';
import { SCALAR_KEY, SCENARIO_IDS, type ModelNode, type ModelState, type ScenarioId } from '../model/types';
import { calcError, evaluate, isErr, type CalcError, type EvalContext, type Value } from '../formula/evaluate';
import { declaredUnitMismatch, inferUnit } from '../formula/units';
import { buildGraph, type DepGraph } from './graph';

/** Bump when a change to the engine could change calculated numbers. Stored with every snapshot. */
export const ENGINE_VERSION = '1.0.0';

export type CellSource = 'input' | 'override' | 'formula' | 'empty';

export interface Cell {
  v: number | null;
  src: CellSource;
  /** True if this value is (or depends on) an estimate. */
  est: boolean;
  err?: CalcError;
  /** Formula result where a typed value takes precedence (reported actual or hard-coded plug). */
  check?: number | null;
}

export interface Issue {
  nodeId: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  periodKey?: string;
}

export interface CalcResult {
  cells: Record<ScenarioId, Record<string, Record<string, Cell>>>;
  graph: DepGraph;
  issues: Issue[];
  ix: ModelIndex;
}

/** Relative difference above which a reported value is flagged against its formula. */
export const CHECK_TOLERANCE = 0.005;

function periodLabel(ix: ModelIndex, node: ModelNode, key: string): string {
  if (key === SCALAR_KEY) return 'single value';
  const i = ix.periodIndex.get(key);
  if (i === undefined) return key;
  const p = ix.periods[i];
  return `${p.label}${cellStatus(ix, node, key)}`;
}

export function compute(state: ModelState): CalcResult {
  const ix = indexModel(state);
  const graph = buildGraph(state, ix);
  const cells = { bear: {}, base: {}, bull: {} } as CalcResult['cells'];

  const cycleMessage = (id: string) => {
    const cyc = graph.cycles.find((c) => c.includes(id)) ?? [id, id];
    return `Circular dependency: ${cyc.map((x) => ix.byId.get(x)?.name ?? x).join(' → ')}. A formula cannot depend on itself in the same period; use PREV() to reference an earlier period.`;
  };

  for (const scenario of SCENARIO_IDS) {
    const memo = new Map<string, Cell>();
    const inProgress = new Set<string>();

    const runFormula = (node: ModelNode, key: string): { value: Value; est: boolean } => {
      const parsed = graph.parsed.get(node.id);
      if (!parsed || !parsed.ok) return { value: calcError('PARSE', parsed && !parsed.ok ? parsed.message : 'Invalid formula', { nodeId: node.id }), est: false };
      let est = false;
      const ctx: EvalContext = {
        ix,
        nodeId: node.id,
        periodIndex: key === SCALAR_KEY ? null : ix.periodIndex.get(key)!,
        read: (id, k) => {
          const c = evalCell(id, k);
          if (c.est) est = true;
          if (c.err) {
            const root = c.err.root ?? c.err;
            return calcError('UPSTREAM', root.message, { nodeId: node.id, root });
          }
          if (c.v === null) {
            const target = ix.byId.get(id)!;
            return calcError('MISSING', `Missing input: ${target.name}, ${periodLabel(ix, target, k)}`, { nodeId: id, periodKey: k });
          }
          return c.v;
        },
        children: () => graph.childrenExpansion.get(node.id) ?? [],
        isScalar: (id) => ix.byId.get(id)?.timeMode === 'scalar',
      };
      const value = evaluate(parsed.ast, ctx);
      return { value, est };
    };

    const evalCell = (id: string, key: string): Cell => {
      const memoKey = `${id}|${key}`;
      const hit = memo.get(memoKey);
      if (hit) return hit;
      const node = ix.byId.get(id)!;
      if (inProgress.has(memoKey)) {
        return { v: null, src: 'formula', est: false, err: calcError('CYCLE', cycleMessage(id), { nodeId: id, periodKey: key }) };
      }
      const status = cellStatus(ix, node, key);
      let cell: Cell;
      const override = scenario !== 'base' && status === 'E' ? node.overrides[scenario]?.[key] : undefined;
      const base = node.values[key];
      if (override !== undefined) {
        cell = { v: override, src: 'override', est: true };
      } else if (base !== undefined) {
        cell = { v: base, src: 'input', est: status === 'E' };
        if (node.formula && graph.parsed.get(id)?.ok && !graph.inCycle.has(id)) {
          inProgress.add(memoKey);
          const r = runFormula(node, key);
          inProgress.delete(memoKey);
          cell.check = isErr(r.value) ? null : r.value;
        }
      } else if (node.formula) {
        if (graph.inCycle.has(id)) {
          cell = { v: null, src: 'formula', est: status === 'E', err: calcError('CYCLE', cycleMessage(id), { nodeId: id, periodKey: key }) };
        } else {
          inProgress.add(memoKey);
          const r = runFormula(node, key);
          inProgress.delete(memoKey);
          cell = isErr(r.value)
            ? { v: null, src: 'formula', est: status === 'E' || r.est, err: { ...r.value, nodeId: r.value.nodeId ?? id, periodKey: r.value.periodKey ?? key } }
            : { v: r.value, src: 'formula', est: status === 'E' || r.est };
        }
      } else {
        cell = { v: null, src: 'empty', est: status === 'E' };
      }
      memo.set(memoKey, cell);
      return cell;
    };

    const out: Record<string, Record<string, Cell>> = {};
    for (const n of state.nodes) {
      const row: Record<string, Cell> = {};
      for (const key of nodePeriodKeys(state, n)) row[key] = evalCell(n.id, key);
      out[n.id] = row;
    }
    cells[scenario] = out;
  }

  return { cells, graph, issues: collectIssues(state, ix, graph, cells), ix };
}

function collectIssues(state: ModelState, ix: ModelIndex, graph: DepGraph, cells: CalcResult['cells']): Issue[] {
  const issues: Issue[] = [];
  const roles = new Map<string, string>();
  for (const n of state.nodes) {
    if (n.role) {
      if (roles.has(n.role)) issues.push({ nodeId: n.id, severity: 'warning', code: 'ROLE_DUPLICATE', message: `Role "${n.role}" is also assigned to ${ix.byId.get(roles.get(n.role)!)?.name}` });
      else roles.set(n.role, n.id);
    }
    if (n.formula) {
      const p = graph.parsed.get(n.id);
      if (p && !p.ok) {
        issues.push({ nodeId: n.id, severity: 'error', code: 'PARSE', message: p.message });
      } else if (p && p.ok) {
        const missing = [...p.refs.direct, ...p.refs.lagged].filter((id) => !ix.byId.has(id));
        if (missing.length) issues.push({ nodeId: n.id, severity: 'error', code: 'DELETED_REF', message: `Formula references ${missing.length} deleted node(s)` });
        for (const pr of p.refs.periods) {
          if (!ix.periodIndex.has(pr.period)) issues.push({ nodeId: n.id, severity: 'error', code: 'NO_PERIOD', message: `Formula references period @${pr.period}, which does not exist` });
        }
        if (graph.inCycle.has(n.id)) {
          const cyc = graph.cycles.find((c) => c.includes(n.id)) ?? [];
          issues.push({ nodeId: n.id, severity: 'error', code: 'CYCLE', message: `Circular dependency: ${cyc.map((x) => ix.byId.get(x)?.name ?? x).join(' → ')}` });
        }
        const { unit, warnings } = inferUnit(
          p.ast,
          (id) => ix.byId.get(id)?.unit,
          () => (graph.childrenExpansion.get(n.id) ?? []).map((id) => ix.byId.get(id)?.unit ?? null),
        );
        for (const w of warnings) issues.push({ nodeId: n.id, severity: 'warning', code: 'UNIT', message: w });
        const decl = declaredUnitMismatch(unit, n.unit);
        if (decl) issues.push({ nodeId: n.id, severity: 'warning', code: 'UNIT', message: decl });
      }
      for (const key of Object.keys(n.values)) {
        if (cellStatus(ix, n, key) === 'E') {
          issues.push({ nodeId: n.id, severity: 'info', code: 'HARDCODED', periodKey: key, message: `Typed value overrides the formula in ${periodLabel(ix, n, key)}` });
        }
      }
    }
    for (const sc of ['bear', 'bull'] as const) {
      for (const key of Object.keys(n.overrides[sc] ?? {})) {
        if (cellStatus(ix, n, key) === 'A') {
          issues.push({ nodeId: n.id, severity: 'warning', code: 'OVERRIDE_ON_ACTUAL', periodKey: key, message: `${sc} override on an actual cell (${periodLabel(ix, n, key)}) is ignored` });
        }
      }
    }
    const row = cells.base[n.id] ?? {};
    for (const [key, c] of Object.entries(row)) {
      if (c.src === 'input' && c.check !== undefined && c.check !== null && c.v !== null) {
        const denom = Math.max(Math.abs(c.v), 1e-9);
        const diff = (c.check - c.v) / denom;
        if (Math.abs(diff) > CHECK_TOLERANCE) {
          issues.push({
            nodeId: n.id,
            severity: 'warning',
            code: 'CHECK',
            periodKey: key,
            message: `${periodLabel(ix, n, key)}: typed value ${fmt(c.v)} differs from the formula result ${fmt(c.check)} by ${(diff * 100).toFixed(1)}%`,
          });
        }
      }
      const staticallyKnown = c.err?.code === 'CYCLE' && graph.inCycle.has(n.id);
      if (c.err && !staticallyKnown && !['UPSTREAM', 'MISSING', 'PARSE'].includes(c.err.code)) {
        issues.push({ nodeId: n.id, severity: 'error', code: c.err.code, periodKey: key, message: `${periodLabel(ix, n, key)}: ${c.err.message}` });
      }
    }
  }
  return issues;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));

/** Plain numbers of a result, for freezing into a snapshot. */
export interface FrozenOutputs {
  engineVersion: string;
  values: Record<ScenarioId, Record<string, Record<string, number | null>>>;
  est: Record<string, Record<string, boolean>>;
}

export function freeze(result: CalcResult): FrozenOutputs {
  const values = { bear: {}, base: {}, bull: {} } as FrozenOutputs['values'];
  const est: FrozenOutputs['est'] = {};
  for (const s of SCENARIO_IDS) {
    for (const [id, row] of Object.entries(result.cells[s])) {
      const out: Record<string, number | null> = {};
      for (const [k, c] of Object.entries(row)) out[k] = c.v;
      values[s][id] = out;
      if (s === 'base') {
        const e: Record<string, boolean> = {};
        for (const [k, c] of Object.entries(row)) e[k] = c.est;
        est[id] = e;
      }
    }
  }
  return { engineVersion: ENGINE_VERSION, values, est };
}

export function cellValue(result: CalcResult, scenario: ScenarioId, nodeId: string | undefined, key: string | undefined): number | null {
  if (!nodeId || !key) return null;
  return result.cells[scenario][nodeId]?.[key]?.v ?? null;
}
