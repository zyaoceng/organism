import { useSyncExternalStore } from 'react';
import type { Issue } from '../../domain/calc/engine';
import type { ProviderDTO } from '../../shared/api';

/**
 * Basic / advanced mode. Basic shows the four daily pages and the everyday tools; advanced
 * shows every page and tool. UI only: the data, the server and the model are the same in both.
 * The choice is remembered in this browser.
 */
const ADVANCED_KEY = 'workbench.advanced';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(ADVANCED_KEY) === '1';
  } catch {
    // storage blocked: basic mode
    return false;
  }
}

let current = read();

export function getAdvanced(): boolean {
  return current;
}

export function setAdvanced(on: boolean) {
  if (on === current) return;
  current = on;
  try {
    // '0' rather than removing the key, so "only set when missing" defaults (e2e) keep the choice.
    globalThis.localStorage?.setItem(ADVANCED_KEY, on ? '1' : '0');
  } catch {
    // not persisted; the choice still applies to this tab
  }
  for (const l of listeners) l();
}

/** Call fn when the mode changes; returns the unsubscribe function. */
export function subscribeAdvanced(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Re-render when the mode changes. */
export function useAdvanced(): boolean {
  return useSyncExternalStore(subscribeAdvanced, getAdvanced, getAdvanced);
}

// ------------------------------------------------------------ the basic-mode rules in one place

const HIDDEN_ISSUE_CODES = new Set(['ROLE_DUPLICATE', 'OVERRIDE_ON_ACTUAL']);

/** Basic mode hides info notes (typed over a formula) and the two structural warnings. */
export const issueVisible = (i: Pick<Issue, 'severity' | 'code'>, adv: boolean) => adv || (i.severity !== 'info' && !HIDDEN_ISSUE_CODES.has(i.code));

/** Basic mode lists only sources that fetch real prices, plus the one in use (so a select keeps its value). */
export const providerVisible = (p: ProviderDTO, adv: boolean, current?: string) => adv || (p.fetches && !p.synthetic) || p.id === current;
