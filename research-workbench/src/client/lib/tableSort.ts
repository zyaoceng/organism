import { useState } from 'react';

export type SortDir = 'asc' | 'desc';
/** key 'default' keeps the order the rows came in. */
export interface SortState {
  key: string;
  dir: SortDir;
}
export const DEFAULT_SORT: SortState = { key: 'default', dir: 'asc' };

type SortValue = number | string | null | undefined;
const missing = (v: SortValue) => v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));

/** A sorted copy. Missing values always go last, in either direction; strings compare naturally (2 before 10). */
export function sortBy<T>(rows: readonly T[], key: (r: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const keyed = rows.map((r) => ({ r, v: key(r) }));
  keyed.sort((a, b) => {
    const ma = missing(a.v);
    const mb = missing(b.v);
    if (ma || mb) return Number(ma) - Number(mb);
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { numeric: true });
    return sign * c;
  });
  return keyed.map((x) => x.r);
}

/** A header click: first click sorts in the column's natural direction, the second reverses it, the third restores the default order. */
export function nextSort(cur: SortState, key: string, first: SortDir): SortState {
  if (cur.key !== key) return { key, dir: first };
  if (cur.dir === first) return { key, dir: first === 'asc' ? 'desc' : 'asc' };
  return DEFAULT_SORT;
}

/** The sort to apply when only some columns are on screen (basic mode hides some): a hidden column's remembered sort falls back to the default order. */
export const visibleSort = (cur: SortState, shown: readonly string[]): SortState => (cur.key === DEFAULT_SORT.key || shown.includes(cur.key) ? cur : DEFAULT_SORT);

/** aria-sort value of a header. */
export const ariaSort = (cur: SortState, key: string): 'ascending' | 'descending' | 'none' => (cur.key !== key ? 'none' : cur.dir === 'asc' ? 'ascending' : 'descending');

function readSort(storageKey: string): SortState {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? 'null') as SortState | null;
    if (v && typeof v.key === 'string' && (v.dir === 'asc' || v.dir === 'desc')) return v;
  } catch {
    // storage blocked or unreadable: default order
  }
  return DEFAULT_SORT;
}

/** Sort state remembered in this browser under storageKey. */
export function useSortState(storageKey: string): [SortState, (key: string, first: SortDir) => void] {
  const [sort, setSort] = useState(() => readSort(storageKey));
  const click = (key: string, first: SortDir) =>
    setSort((cur) => {
      const next = nextSort(cur, key, first);
      try {
        globalThis.localStorage?.setItem(storageKey, JSON.stringify(next));
      } catch {
        // not persisted; the order still applies on this page
      }
      return next;
    });
  return [sort, click];
}
