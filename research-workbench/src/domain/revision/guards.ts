/**
 * Changes big enough that an AI must ask the user before committing them: EPS or target price
 * moving by more than 30% (or appearing for the first time), and any number changing by 20× or
 * more (usually a unit mistake: 仟元 typed as 億).
 */
import type { CalcResult } from '../calc/engine';
import { formatValue } from '../format';
import { SCENARIO_IDS, type ModelState, type ScenarioId } from '../model/types';
import { findByRole } from '../model/tree';
import type { Unit } from '../units';
import type { ModelChange } from './diff';
import { basisPeriodId, keyOutputs } from './impact';

export interface LargeMove {
  kind: 'eps' | 'target_price' | 'value';
  /** zh-TW description. */
  text: string;
  before: number | null;
  after: number | null;
  /** Relative change (EPS, target price) or the factor between the values (value). */
  ratio: number | null;
}

export interface LargeMoveLimits {
  /** Relative change of EPS or target price that needs confirmation. */
  pct: number;
  /** Factor between an old and a new value that needs confirmation. */
  factor: number;
}

const SC_ZH: Record<ScenarioId, string> = { bear: '空頭', base: '基準', bull: '多頭' };

export function findLargeMoves(
  beforeState: ModelState,
  afterState: ModelState,
  rb: CalcResult,
  ra: CalcResult,
  changes: ModelChange[],
  limits: LargeMoveLimits = { pct: 0.3, factor: 20 },
): LargeMove[] {
  const out: LargeMove[] = [];
  const basis = basisPeriodId(afterState);
  const kb = keyOutputs(beforeState, rb, basis);
  const ka = keyOutputs(afterState, ra, basis);
  const period = afterState.periods.find((p) => p.id === basis);
  const periodText = period ? ` ${period.label}${period.status}` : '';
  const metric = (kind: 'eps' | 'target_price', label: string, unit: Unit | null, b: Record<ScenarioId, number | null>, a: Record<ScenarioId, number | null>) => {
    for (const s of SCENARIO_IDS) {
      const before = b[s];
      const after = a[s];
      const f = (v: number | null) => formatValue(v, unit);
      const name = `${label}（${SC_ZH[s]}）`;
      if (before === null && after !== null) out.push({ kind, text: `${name}首次建立：— → ${f(after)}`, before, after, ratio: null });
      else if (before !== null && after === null) out.push({ kind, text: `${name}被清空：${f(before)} → —`, before, after, ratio: null });
      else if (before !== null && after !== null) {
        const ratio = before === 0 ? (after === 0 ? 0 : Infinity) : (after - before) / Math.abs(before);
        if (Math.abs(ratio) > limits.pct) {
          const pct = Number.isFinite(ratio) ? `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%` : '從 0 開始';
          out.push({ kind, text: `${name}：${f(before)} → ${f(after)}（${pct}）`, before, after, ratio: Number.isFinite(ratio) ? ratio : null });
        }
      }
    }
  };
  metric('eps', `EPS${periodText}`, findByRole(afterState, 'eps')?.unit ?? null, kb.eps, ka.eps);
  metric('target_price', '目標價', findByRole(afterState, 'target_price')?.unit ?? null, kb.targetPrice, ka.targetPrice);

  const labels = new Map(afterState.periods.map((p) => [p.id, p.label]));
  for (const c of changes) {
    if (c.type !== 'value_changed' || c.from === null || c.to === null || c.from === 0 || c.to === 0) continue;
    const factor = Math.max(Math.abs(c.from), Math.abs(c.to)) / Math.min(Math.abs(c.from), Math.abs(c.to));
    if (factor < limits.factor) continue;
    const where = c.periodKey === '_' ? '' : ` ${labels.get(c.periodKey) ?? c.periodKey}`;
    const sc = c.scenario === 'base' ? '' : `（${SC_ZH[c.scenario]}）`;
    out.push({
      kind: 'value',
      text: `${c.name}${where}${sc}：${formatValue(c.from, c.unit)} → ${formatValue(c.to, c.unit)}（相差 ${factor >= 100 ? Math.round(factor) : factor.toFixed(1)} 倍，請確認單位）`,
      before: c.from,
      after: c.to,
      ratio: factor,
    });
  }
  return out;
}
