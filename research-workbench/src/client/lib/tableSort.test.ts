import { describe, expect, it } from 'vitest';
import { ariaSort, DEFAULT_SORT, nextSort, sortBy, visibleSort } from './tableSort';

describe('sortBy', () => {
  const rows = [{ v: 3 }, { v: null }, { v: -1 }, { v: 10 }, { v: Number.NaN }];
  it('sorts numbers both ways and keeps missing values last', () => {
    expect(sortBy(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([-1, 3, 10, null, Number.NaN]);
    expect(sortBy(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([10, 3, -1, null, Number.NaN]);
  });

  it('compares strings naturally and treats empty strings as missing', () => {
    const names = ['Lite-On', 'item 10', '', 'item 2', 'Credo'];
    expect(sortBy(names, (s) => s, 'asc')).toEqual(['Credo', 'item 2', 'item 10', 'Lite-On', '']);
    expect(sortBy(names, (s) => s, 'desc')).toEqual(['Lite-On', 'item 10', 'item 2', 'Credo', '']);
  });

  it('is stable and does not touch the input', () => {
    const xs = [
      { k: 1, id: 'a' },
      { k: 0, id: 'b' },
      { k: 1, id: 'c' },
    ];
    expect(sortBy(xs, (x) => x.k, 'desc').map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(xs.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('header clicks', () => {
  it('cycles natural direction → reversed → default order', () => {
    const a = nextSort(DEFAULT_SORT, 'name', 'asc');
    expect(a).toEqual({ key: 'name', dir: 'asc' });
    const b = nextSort(a, 'name', 'asc');
    expect(b).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort(b, 'name', 'asc')).toEqual(DEFAULT_SORT);
    // another column starts over in its own direction
    expect(nextSort(b, 'upside', 'desc')).toEqual({ key: 'upside', dir: 'desc' });
    expect(nextSort({ key: 'upside', dir: 'desc' }, 'upside', 'desc')).toEqual({ key: 'upside', dir: 'asc' });
  });

  it('reports aria-sort', () => {
    expect(ariaSort({ key: 'name', dir: 'asc' }, 'name')).toBe('ascending');
    expect(ariaSort({ key: 'name', dir: 'desc' }, 'name')).toBe('descending');
    expect(ariaSort({ key: 'name', dir: 'desc' }, 'price')).toBe('none');
  });
});

describe('visibleSort', () => {
  it('drops a remembered sort by a column hidden in basic mode', () => {
    expect(visibleSort({ key: 'weighted', dir: 'desc' }, ['name', 'upside'])).toEqual(DEFAULT_SORT);
    expect(visibleSort({ key: 'upside', dir: 'desc' }, ['name', 'upside'])).toEqual({ key: 'upside', dir: 'desc' });
    expect(visibleSort(DEFAULT_SORT, [])).toEqual(DEFAULT_SORT);
  });
});
