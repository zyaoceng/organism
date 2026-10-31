/**
 * Memoized derivations keyed by state object identity. States are immutable, so a WeakMap cache
 * gives "compute once per edit" without threading memo hooks through every component.
 */
import { compute, type CalcResult } from '../../domain/calc/engine';
import type { ModelState } from '../../domain/model/types';
import { diffStates, type ModelChange } from '../../domain/revision/diff';
import { computeImpact, type Impact } from '../../domain/revision/impact';
import { indexModel, type ModelIndex } from '../../domain/model/tree';

const calcCache = new WeakMap<ModelState, CalcResult>();
export function calcOf(state: ModelState): CalcResult {
  let r = calcCache.get(state);
  if (!r) {
    r = compute(state);
    calcCache.set(state, r);
  }
  return r;
}

const ixCache = new WeakMap<ModelState, ModelIndex>();
export function indexOf(state: ModelState): ModelIndex {
  let r = ixCache.get(state);
  if (!r) {
    r = indexModel(state);
    ixCache.set(state, r);
  }
  return r;
}

const diffCache = new WeakMap<ModelState, WeakMap<ModelState, ModelChange[]>>();
export function diffOf(before: ModelState, after: ModelState): ModelChange[] {
  let inner = diffCache.get(before);
  if (!inner) diffCache.set(before, (inner = new WeakMap()));
  let r = inner.get(after);
  if (!r) {
    r = diffStates(before, after);
    inner.set(after, r);
  }
  return r;
}

const impactCache = new WeakMap<ModelState, WeakMap<ModelState, Impact>>();
export function impactOf(before: ModelState, after: ModelState): Impact {
  let inner = impactCache.get(before);
  if (!inner) impactCache.set(before, (inner = new WeakMap()));
  let r = inner.get(after);
  if (!r) {
    r = computeImpact(before, after, { before: calcOf(before), after: calcOf(after), changes: diffOf(before, after) });
    inner.set(after, r);
  }
  return r;
}
