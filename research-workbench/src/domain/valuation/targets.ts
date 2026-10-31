/**
 * Target prices read from a frozen snapshot, their probability-weighted mean and the upside to a
 * price. Shared by the valuation page, the cross-company dashboard and trades.
 *
 * STABLE: `frozenTargets` and `upside` are consumed by the Obsidian notes (M5); keep their
 * signatures and null rules.
 */
import type { FrozenOutputs } from '../calc/engine';
import { findByRole } from '../model/tree';
import { SCALAR_KEY, SCENARIO_IDS, type ModelState, type ScenarioId } from '../model/types';
import { basisPeriodId } from '../revision/impact';

export type ScenarioValues = Record<ScenarioId, number | null>;

const finite = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Frozen TP per scenario: scalar value, else basis-period value (same rule as keyOutputs). */
export function frozenTargets(state: ModelState, frozen: FrozenOutputs, basis = basisPeriodId(state)): ScenarioValues {
  const out: ScenarioValues = { bear: null, base: null, bull: null };
  const tp = findByRole(state, 'target_price');
  if (!tp) return out;
  for (const s of SCENARIO_IDS) {
    const row = frozen.values[s]?.[tp.id];
    out[s] = finite(row?.[SCALAR_KEY]) ?? (basis ? finite(row?.[basis]) : null);
  }
  return out;
}

/** Currency of the target-price node's unit, if it declares one. */
export function targetPriceCurrency(state: ModelState): string | null {
  return findByRole(state, 'target_price')?.unit?.currency ?? null;
}

export interface WeightedTarget {
  value: number | null;
  /** Sum of the positive weights used. */
  weightSum: number;
  /** True when the weights do not add up to 1 and were rescaled. */
  normalized: boolean;
  /** Weighted scenarios that have no target (the value is then null). */
  missing: ScenarioId[];
}

/**
 * Σp·TP / Σp over the scenarios with a positive weight. A weighted scenario without a target makes
 * the result null instead of counting as 0; zero, negative and empty weights are ignored.
 */
export function probabilityWeightedTarget(targets: ScenarioValues, probs: Record<ScenarioId, number | null>): WeightedTarget {
  let weightSum = 0;
  let sum = 0;
  const missing: ScenarioId[] = [];
  for (const s of SCENARIO_IDS) {
    const p = finite(probs[s]);
    if (p === null || p <= 0) continue;
    weightSum += p;
    const tp = finite(targets[s]);
    if (tp === null) missing.push(s);
    else sum += p * tp;
  }
  const value = weightSum > 0 && !missing.length ? sum / weightSum : null;
  return { value, weightSum, normalized: weightSum > 0 && Math.abs(weightSum - 1) > 1e-6, missing };
}

/** target / price − 1; null unless both are finite and the price is positive. */
export function upside(target: number | null, price: number | null): number | null {
  const t = finite(target);
  const p = finite(price);
  if (t === null || p === null || p <= 0) return null;
  return t / p - 1;
}
