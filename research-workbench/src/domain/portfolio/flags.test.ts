import { describe, expect, it } from 'vitest';
import type { Thesis } from '../model/types';
import { catalystTiming, expectedWindowEnd, quoteFreshness, thesesDue } from './flags';

const thesis = (id: string, status: Thesis['status'], reviewBy?: string): Thesis => ({ id, statement: id, invalidation: '', nodeIds: [], status, reviewBy });

describe('portfolio flags', () => {
  it('expected window end by precision', () => {
    expect(expectedWindowEnd('2028-02-10', 'day')).toBe('2028-02-10');
    expect(expectedWindowEnd('2028-02-10', 'month')).toBe('2028-02-29');
    expect(expectedWindowEnd('2027-02-01', 'month')).toBe('2027-02-28');
    expect(expectedWindowEnd('2026-02-15', 'quarter')).toBe('2026-03-31');
    expect(expectedWindowEnd('2026-04-01', 'quarter')).toBe('2026-06-30');
    expect(expectedWindowEnd('2026-11-30', 'quarter')).toBe('2026-12-31');
  });

  it('catalyst timing', () => {
    // month precision in the current month: still on time
    expect(catalystTiming({ status: 'upcoming', expectedDate: '2026-10-01', datePrecision: 'month' }, '2026-10-30')).toBe('upcoming');
    expect(catalystTiming({ status: 'upcoming', expectedDate: '2026-10-01', datePrecision: 'day' }, '2026-10-30')).toBe('overdue');
    expect(catalystTiming({ status: 'delayed', expectedDate: '2026-06-01', datePrecision: 'quarter' }, '2026-10-30')).toBe('overdue');
    expect(catalystTiming({ status: 'delayed', expectedDate: null, datePrecision: 'day' }, '2026-10-30')).toBe('undated');
    expect(catalystTiming({ status: 'occurred', expectedDate: '2020-01-01', datePrecision: 'day' }, '2026-10-30')).toBe('closed');
    expect(catalystTiming({ status: 'cancelled', expectedDate: null, datePrecision: 'day' }, '2026-10-30')).toBe('closed');
    expect(catalystTiming({ status: 'upcoming', expectedDate: '2026-10-30', datePrecision: 'day' }, '2026-10-30')).toBe('upcoming');
  });

  it('theses due for review', () => {
    const due = thesesDue(
      [thesis('a', 'active', '2026-10-01'), thesis('b', 'retired', '2026-10-01'), thesis('c', 'active', '2026-10'), thesis('d', 'active', '2026-11-01'), thesis('e', 'active'), thesis('f', 'active', '2026-10-30')],
      '2026-10-30',
    );
    expect(due.map((t) => t.id)).toEqual(['a', 'f']);
  });

  it('quote freshness', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    expect(quoteFreshness(null, now, '2026-10-30')).toEqual({ stale: true, marketDate: null, lagDays: null });
    const old = quoteFreshness({ asOf: '2026-10-29T05:30:00.000Z', fetchedAt: '2026-10-29T11:00:00.000Z' }, now, '2026-10-30');
    expect(old).toEqual({ stale: true, marketDate: '2026-10-29', lagDays: 1 });
    const fresh = quoteFreshness({ asOf: '2026-10-15T05:30:00.000Z', fetchedAt: '2026-10-30T11:00:00.000Z' }, now, '2026-10-30');
    expect(fresh).toEqual({ stale: false, marketDate: '2026-10-15', lagDays: 15 });
    expect(quoteFreshness({ asOf: '2026-10-30', fetchedAt: '2026-10-30T11:00:00.000Z' }, now, '2026-10-30', 1000).stale).toBe(true);
  });
});
