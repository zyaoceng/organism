import { describe, expect, it } from 'vitest';
import { href, parseHash, type Route } from './router';

describe('routes', () => {
  it('round-trips every page through its address', () => {
    const routes: Route[] = [
      { page: 'projects' },
      { page: 'journal' },
      { page: 'settings' },
      { page: 'project', projectId: 'p1', tab: 'model' },
      { page: 'project', projectId: 'p 1', tab: 'trades', param: 'trade/7' },
    ];
    for (const r of routes) expect(parseHash(href(r))).toEqual(r.page === 'project' ? { param: undefined, ...r } : r);
  });

  it('opens the trade log at #/journal and keeps old and unknown addresses working', () => {
    expect(href({ page: 'journal' })).toBe('#/journal');
    expect(parseHash('#/journal')).toEqual({ page: 'journal' });
    expect(parseHash('#journal/')).toEqual({ page: 'journal' });
    expect(parseHash('')).toEqual({ page: 'projects' });
    expect(parseHash('#/nowhere')).toEqual({ page: 'projects' });
    expect(parseHash('#/p/x/market')).toEqual({ page: 'project', projectId: 'x', tab: 'trades', param: undefined });
  });
});
