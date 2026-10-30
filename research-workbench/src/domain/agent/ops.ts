/**
 * Apply one AI draft operation (schema.ts) to a state with the domain edit functions, with the
 * rules a person applies without thinking: units are explicit, actual periods are shared by all
 * scenarios, formula cells are not overwritten by accident, formulas cannot form cycles.
 * Every result reports the cells before and after so the AI can show the user what it did.
 */
import { findCycleWith } from '../calc/graph';
import { formatPath, toDisplay, toStored } from '../formula/refs';
import { addLink, addNode, addPeer, addThesis, deleteNode, ModelOpError, moveNode, renameNode, setFormula, setNotes, setValue, updateThesis, updateValuation } from '../model/ops';
import { cellStatus, childrenOf, indexModel, isHeading, type ModelIndex } from '../model/tree';
import { SCALAR_KEY, type ModelNode, type ModelState, type Peer, type ScenarioId, type Thesis } from '../model/types';
import type { Unit } from '../units';
import { resolveNodeRef, resolvePeriodRef } from './resolve';
import type { DraftOp } from './schema';
import { formatValueZh, parseAgentValue, unitSpecToUnit } from './units';

export class AgentOpError extends Error {
  constructor(
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = 'AgentOpError';
  }
}

export interface AgentCell {
  /** Period label with its status (2026E), or 單一數值. */
  period: string;
  scenario: ScenarioId;
  before: string;
  after: string;
  beforeRaw: number | null;
  afterRaw: number | null;
  note?: string;
}

export interface AgentOpResult {
  op: DraftOp['op'];
  node?: { id: string; path: string; unit: Unit | null };
  cells?: AgentCell[];
  /** Id of a created node or thesis. */
  createdId?: string;
  warnings: string[];
}

/** Values that differ by this factor or more are probably a unit mistake. */
export const SUSPICIOUS_FACTOR = 20;

export function suspiciousRatio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || a === 0 || b === 0) return null;
  const r = Math.max(Math.abs(a), Math.abs(b)) / Math.min(Math.abs(a), Math.abs(b));
  return r >= SUSPICIOUS_FACTOR ? r : null;
}

const ZH_OP_ERRORS: [RegExp, string][] = [
  [/^A node cannot be moved inside itself$/, '節點不能移到自己底下'],
  [/^A node needs a name$/, '節點需要名稱'],
  [/^Value must be a finite number$/, '數值必須是有效數字'],
  [/^Node (.+) does not exist$/, '節點 $1 不存在'],
];

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ModelOpError) {
      const hit = ZH_OP_ERRORS.find(([re]) => re.test(e.message));
      throw new AgentOpError(hit ? e.message.replace(hit[0], hit[1]) : e.message);
    }
    throw e;
  }
}

function requireNode(ix: ModelIndex, ref: string): ModelNode {
  const r = resolveNodeRef(ix, ref);
  if (!r.ok) throw new AgentOpError(r.message, r.candidates);
  return ix.byId.get(r.id)!;
}

function nodeInfo(state: ModelState, id: string) {
  const ix = indexModel(state);
  const n = ix.byId.get(id)!;
  return { id, path: formatPath(ix, id), unit: n.unit };
}

function periodKey(state: ModelState, n: ModelNode, ref: string | undefined): { key: string; label: string } {
  if (n.timeMode === 'scalar') {
    if (ref !== undefined && ref !== SCALAR_KEY) throw new AgentOpError(`${n.name} 是單一數值，不要填 period`);
    return { key: SCALAR_KEY, label: '單一數值' };
  }
  if (ref === undefined || ref === SCALAR_KEY) throw new AgentOpError(`${n.name} 是時間序列，請指定 period（例如 ${state.periods.find((p) => p.status === 'E')?.label ?? '2026'}E）`);
  const p = resolvePeriodRef(state, ref);
  if (!p.ok) throw new AgentOpError(p.message, p.candidates);
  return { key: p.period.id, label: p.period.label };
}

/** The stored number of one scenario (bear/bull: the override only; null = inherits base). */
function storedRaw(state: ModelState, id: string, key: string, scenario: ScenarioId): number | null {
  const n = state.nodes.find((x) => x.id === id)!;
  return (scenario === 'base' ? n.values[key] : n.overrides[scenario]?.[key]) ?? null;
}

function defaultCurrency(state: ModelState): string {
  return state.nodes.find((n) => n.role === 'eps')?.unit?.currency ?? state.nodes.find((n) => n.unit?.currency)?.unit?.currency ?? 'TWD';
}

function setValues(state: ModelState, op: Extract<DraftOp, { op: 'set_value' | 'set_values' }>): { state: ModelState; result: AgentOpResult } {
  const ix = indexModel(state);
  const n = requireNode(ix, op.node);
  if (isHeading(n) && childrenOf(ix, n.id).length) throw new AgentOpError(`標題列不能填數值：${n.name} 底下有子項目，請改它的子項目`);
  const scenario = op.scenario ?? 'base';
  const entries: [string | undefined, string | number | null][] = op.op === 'set_value' ? [[op.period, op.value]] : Object.entries(op.values);
  if (!entries.length) throw new AgentOpError('values 是空的');
  let s = state;
  const cells: AgentCell[] = [];
  const warnings: string[] = [];
  for (const [ref, input] of entries) {
    const { key, label } = periodKey(s, n, ref);
    const status = cellStatus(ix, n, key);
    const period = key === SCALAR_KEY ? label : `${label}${status}`;
    if (status === 'A' && scenario !== 'base') throw new AgentOpError(`${period} 是實際期，三種情境共用，只能用 scenario=base 修改`);
    if (n.formula && status === 'E' && input !== null && !op.allow_override_formula) {
      throw new AgentOpError(`${n.name} 由公式計算（${toDisplay(n.formula, ix, n.id)}）；請改它的輸入，或帶 allow_override_formula=true 手動覆蓋`);
    }
    const v = parseAgentValue(input, n.unit, n.name);
    if (!v.ok) throw new AgentOpError(v.message);
    const beforeRaw = storedRaw(s, n.id, key, scenario);
    s = wrap(() => setValue(s, n.id, key, scenario, v.value));
    const afterRaw = storedRaw(s, n.id, key, scenario);
    const shown = (x: number | null) => (x === null ? (scenario === 'base' ? '空白' : '沿用基準') : formatValueZh(x, n.unit));
    cells.push({ period, scenario, before: shown(beforeRaw), after: shown(afterRaw), beforeRaw, afterRaw, ...(v.note ? { note: v.note } : {}) });
    if (suspiciousRatio(beforeRaw, afterRaw)) warnings.push(`${n.name} ${period}：數值變動超過 ${SUSPICIOUS_FACTOR} 倍（${shown(beforeRaw)} → ${shown(afterRaw)}），請確認單位`);
  }
  return { state: s, result: { op: op.op, node: nodeInfo(s, n.id), cells, warnings } };
}

/** Apply one operation. Throws AgentOpError with a message for the AI (zh-TW). */
export function applyAgentOp(state: ModelState, op: DraftOp): { state: ModelState; result: AgentOpResult } {
  const ix = indexModel(state);
  const warnings: string[] = [];
  switch (op.op) {
    case 'set_value':
    case 'set_values':
      return setValues(state, op);

    case 'set_formula': {
      const n = requireNode(ix, op.node);
      if (!op.formula || !op.formula.trim()) {
        const s = setFormula(state, n.id, undefined);
        return { state: s, result: { op: op.op, node: nodeInfo(s, n.id), warnings } };
      }
      const r = toStored(op.formula, ix, n.id);
      if (!r.ok) throw new AgentOpError(`公式錯誤：${r.error.message}`);
      const cycle = findCycleWith(state, n.id, r.stored);
      if (cycle) throw new AgentOpError(`循環參照：${cycle.map((id) => ix.byId.get(id)?.name ?? id).join(' → ')}，請用 PREV() 參照前一期`);
      const s = setFormula(state, n.id, r.stored);
      const typed = Object.keys(n.values).filter((k) => cellStatus(ix, n, k) === 'E');
      if (typed.length) {
        const labels = typed.map((k) => (k === SCALAR_KEY ? '單一數值' : `${state.periods.find((p) => p.id === k)?.label ?? k}E`));
        warnings.push(`${n.name} 在 ${labels.join('、')} 有手動輸入值，會蓋過公式結果；要讓公式生效，請用 set_value 把它們設為 null`);
      }
      return { state: s, result: { op: op.op, node: nodeInfo(s, n.id), warnings } };
    }

    case 'add_node': {
      const parent = op.parent === null ? null : requireNode(ix, op.parent);
      const unit = op.unit === undefined ? undefined : op.unit === null ? null : unitSpecToUnit(op.unit, parent?.unit ?? null, defaultCurrency(state));
      const r = wrap(() => addNode(state, { parentId: parent?.id ?? null, name: op.name, unit, timeMode: op.time_mode, position: op.position }));
      return { state: r.state, result: { op: op.op, node: nodeInfo(r.state, r.id), createdId: r.id, warnings } };
    }

    case 'rename_node': {
      const n = requireNode(ix, op.node);
      const s = wrap(() => renameNode(state, n.id, op.name));
      return { state: s, result: { op: op.op, node: nodeInfo(s, n.id), warnings } };
    }

    case 'move_node': {
      const n = requireNode(ix, op.node);
      const parent = op.parent === null ? null : requireNode(ix, op.parent);
      const position = op.position ?? childrenOf(ix, parent?.id ?? null).filter((c) => c.id !== n.id).length;
      const s = wrap(() => moveNode(state, n.id, parent?.id ?? null, position));
      return { state: s, result: { op: op.op, node: nodeInfo(s, n.id), warnings } };
    }

    case 'delete_node': {
      const n = requireNode(ix, op.node);
      const path = formatPath(ix, n.id);
      const r = wrap(() => deleteNode(state, n.id));
      if (r.removedIds.length > 1) warnings.push(`連同 ${r.removedIds.length - 1} 個子項目一起刪除`);
      if (r.brokenFormulaNodeIds.length) {
        warnings.push(`${r.brokenFormulaNodeIds.length} 個公式參照了被刪的節點：${r.brokenFormulaNodeIds.map((id) => ix.byId.get(id)?.name ?? id).join('、')}`);
      }
      return { state: r.state, result: { op: op.op, node: { id: n.id, path, unit: n.unit }, warnings } };
    }

    case 'set_notes': {
      const n = requireNode(ix, op.node);
      const s = setNotes(state, n.id, op.notes);
      return { state: s, result: { op: op.op, node: nodeInfo(s, n.id), warnings } };
    }

    case 'link_evidence': {
      const n = requireNode(ix, op.node);
      const r = wrap(() => addLink(state, { evidenceId: op.evidence_id, nodeId: n.id, relation: op.relation ?? 'supports', locator: op.locator, note: op.note }));
      return { state: r.state, result: { op: op.op, node: nodeInfo(r.state, n.id), warnings } };
    }

    case 'add_thesis': {
      const nodeIds = (op.nodes ?? []).map((ref) => requireNode(ix, ref).id);
      const r = addThesis(state, { statement: op.statement, invalidation: op.invalidation ?? '', nodeIds, ...(op.review_by ? { reviewBy: op.review_by } : {}) });
      return { state: r.state, result: { op: op.op, createdId: r.id, warnings } };
    }

    case 'update_thesis': {
      if (!state.theses.some((t) => t.id === op.thesis_id)) {
        throw new AgentOpError(`找不到論點 ${op.thesis_id}`, state.theses.map((t) => t.id));
      }
      const patch: Partial<Omit<Thesis, 'id'>> = {};
      if (op.statement !== undefined) {
        if (!op.statement.trim()) throw new AgentOpError('論點內容不能是空白');
        patch.statement = op.statement;
      }
      if (op.invalidation !== undefined) patch.invalidation = op.invalidation;
      if (op.status !== undefined) patch.status = op.status;
      if (op.review_by !== undefined) patch.reviewBy = op.review_by ?? undefined;
      if (op.nodes !== undefined) patch.nodeIds = op.nodes.map((ref) => requireNode(ix, ref).id);
      return { state: updateThesis(state, op.thesis_id, patch), result: { op: op.op, warnings } };
    }

    case 'set_rationale':
      return { state: updateValuation(state, { rationale: { ...state.valuation.rationale, [op.scenario]: op.text } }), result: { op: op.op, warnings } };

    case 'add_peer': {
      const num = (input: string | number | null | undefined, unit: Unit, what: string): number | undefined => {
        if (input === undefined || input === null) return undefined;
        const v = parseAgentValue(input, unit, `${op.name} 的${what}`);
        if (!v.ok) throw new AgentOpError(v.message);
        return v.value ?? undefined;
      };
      const pct: Unit = { kind: 'percent', scale: 1 };
      const peer: Partial<Peer> & { name: string } = {
        name: op.name,
        ticker: op.ticker,
        pe: num(op.pe, { kind: 'multiple', scale: 1 }, '本益比'),
        epsGrowth: num(op.eps_growth, pct, 'EPS 成長率'),
        roic: num(op.roic, pct, 'ROIC'),
        grossMargin: num(op.gross_margin, pct, '毛利率'),
        basis: op.basis,
        source: op.source,
        asOf: op.as_of,
        note: op.note,
      };
      for (const k of Object.keys(peer) as (keyof Peer)[]) if (peer[k] === undefined || peer[k] === '') delete peer[k];
      return { state: addPeer(state, peer), result: { op: op.op, warnings } };
    }
  }
}
