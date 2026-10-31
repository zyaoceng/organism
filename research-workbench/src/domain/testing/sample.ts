/**
 * A small, fully populated example built from the Standard template. Used by tests and by the
 * offline demo seed. Numbers are illustrative, not research.
 */
import { setValue } from '../model/ops';
import type { ModelState, ScenarioId } from '../model/types';
import { SCALAR_KEY } from '../model/types';
import { standardTemplate } from '../templates/standard';

export function idByName(state: ModelState, name: string, parentName?: string): string {
  const matches = state.nodes.filter((n) => n.name === name);
  const hit = parentName
    ? matches.find((n) => state.nodes.find((p) => p.id === n.parentId)?.name === parentName)
    : matches.length === 1
      ? matches[0]
      : undefined;
  if (!hit) throw new Error(`Node ${parentName ? `${parentName}/` : ''}${name} not found or ambiguous`);
  return hit.id;
}

export function fill(state: ModelState, id: string, values: Record<string, number>, scenario: ScenarioId = 'base'): ModelState {
  let s = state;
  for (const [k, v] of Object.entries(values)) s = setValue(s, id, k, scenario, v);
  return s;
}

export function sampleModel(year = 2026): ModelState {
  let s = standardTemplate({ year, currency: 'TWD' });
  const y = (d: number) => `FY${year + d}`;
  const A = [y(-2), y(-1)];
  const E = [y(0), y(1), y(2)];
  const series = (a: [number, number], e: [number, number, number]) => ({ [A[0]]: a[0], [A[1]]: a[1], [E[0]]: e[0], [E[1]]: e[1], [E[2]]: e[2] });
  const actual = (a: [number, number]) => ({ [A[0]]: a[0], [A[1]]: a[1] });
  const est = (e: [number, number, number]) => ({ [E[0]]: e[0], [E[1]]: e[1], [E[2]]: e[2] });

  s = fill(s, idByName(s, 'Business A'), actual([800, 1000]));
  s = fill(s, idByName(s, 'YoY Growth', 'Business A'), est([0.2, 0.2, 0.2]));
  s = fill(s, idByName(s, 'Business B'), actual([500, 550]));
  s = fill(s, idByName(s, 'YoY Growth', 'Business B'), est([0.05, 0.05, 0.05]));
  s = fill(s, idByName(s, 'Business C'), actual([100, 120]));
  s = fill(s, idByName(s, 'YoY Growth', 'Business C'), est([0.5, 0.5, 0.5]));
  s = fill(s, idByName(s, 'Gross Margin'), series([0.19, 0.2], [0.21, 0.21, 0.21]));
  s = fill(s, idByName(s, 'Opex % of Revenue'), series([0.08, 0.08], [0.08, 0.08, 0.08]));
  s = fill(s, idByName(s, 'Non-Operating Items'), series([20, 20], [20, 20, 20]));
  s = fill(s, idByName(s, 'Tax Rate'), series([0.2, 0.2], [0.2, 0.2, 0.2]));
  s = fill(s, idByName(s, 'Diluted Shares'), series([22, 22], [22, 22, 22]));
  s = fill(s, idByName(s, 'Invested Capital'), series([500, 550], [600, 650, 700]));

  const pe = idByName(s, 'Target P/E');
  s = setValue(s, pe, SCALAR_KEY, 'base', 20);
  s = setValue(s, pe, SCALAR_KEY, 'bear', 14);
  s = setValue(s, pe, SCALAR_KEY, 'bull', 26);
  // Bear/Bull growth overrides for Business A
  const gA = idByName(s, 'YoY Growth', 'Business A');
  s = fill(s, gA, est([0.1, 0.05, 0.0]), 'bear');
  s = fill(s, gA, est([0.3, 0.35, 0.4]), 'bull');
  return s;
}
