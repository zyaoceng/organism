/**
 * Answers "which assumption decides the result": each assumption is set to its low end and to its
 * high end, one at a time, and the workbook recalculated. The range is the sheet's 下緣／上緣, or a
 * trial range supplied for this what-if only (e.g. for the multiple, which has none in the sheet).
 */
import type { CellOverride, CellRef, DetectedAssumption, FormulaEngine, SensitivityEffect, SensitivityOutputs, SensitivityResult, TornadoRow, TrialRange } from './types';

export interface SensitivityInput {
  assumptions: Pick<DetectedAssumption, 'id' | 'label' | 'section' | 'sheet' | 'valueCell' | 'low' | 'high'>[];
  outputs: SensitivityOutputs;
  /** By assumption id. Takes the place of the sheet's range when both exist. */
  trialRanges?: Record<string, TrialRange>;
  /** The trial values already entered: every recalculation keeps them, except on the assumption being moved. */
  baseOverrides?: CellOverride[];
}

/** Leaves the engine holding `baseOverrides` again. */
export function computeSensitivity(engine: FormulaEngine, input: SensitivityInput): SensitivityResult {
  const base = input.baseOverrides ?? [];
  const keys = ['targetPrice', 'revenue', 'eps'] as const;
  const cells = keys.map((k) => input.outputs[k]);
  const read = (overrides: CellOverride[]): (number | null)[] => {
    engine.set(overrides);
    const present = cells.filter((c): c is CellRef => c !== null);
    const values = engine.get(present);
    return cells.map((c) => {
      const v = c ? values[present.indexOf(c)] : null;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    });
  };
  const effect = (low: number | null, high: number | null): SensitivityEffect => ({ atLow: low, atHigh: high, delta: low !== null && high !== null ? high - low : null });

  const [targetPrice, revenue, eps] = read(base);
  const rows: TornadoRow[] = [];
  const withoutRange: string[] = [];
  for (const a of input.assumptions) {
    const trial = input.trialRanges?.[a.id];
    const low = trial ? trial.low : a.low;
    const high = trial ? trial.high : a.high;
    if (low === null || high === null || !Number.isFinite(low) || !Number.isFinite(high)) {
      withoutRange.push(a.id);
      continue;
    }
    const others = base.filter((o) => o.sheet !== a.sheet || o.address !== a.valueCell);
    const atLow = read([...others, { sheet: a.sheet, address: a.valueCell, value: low }]);
    const atHigh = read([...others, { sheet: a.sheet, address: a.valueCell, value: high }]);
    rows.push({
      id: a.id,
      label: a.label,
      section: a.section,
      low,
      high,
      rangeSource: trial ? 'trial' : 'sheet',
      targetPrice: effect(atLow[0], atHigh[0]),
      revenue: effect(atLow[1], atHigh[1]),
      eps: effect(atLow[2], atHigh[2]),
    });
  }
  engine.set(base);
  // rows that could not be computed go last
  const size = (r: TornadoRow) => (r.targetPrice.delta === null ? -1 : Math.abs(r.targetPrice.delta));
  rows.sort((a, b) => size(b) - size(a));
  return { base: { targetPrice, revenue, eps }, rows, withoutRange };
}
