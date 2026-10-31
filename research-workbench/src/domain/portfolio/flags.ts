/**
 * Date and freshness flags for the cross-company dashboard: when a catalyst is overdue, which
 * theses are due for review, and whether a cached quote is stale. Pure; dates are YYYY-MM-DD.
 */
import type { Thesis } from '../model/types';

export type DatePrecision = 'day' | 'month' | 'quarter';

const pad = (n: number) => String(n).padStart(2, '0');

/** Last day a catalyst can still happen on time: the date, or the end of its month or calendar quarter. */
export function expectedWindowEnd(expectedDate: string, precision: DatePrecision): string {
  if (precision === 'day') return expectedDate;
  const y = Number(expectedDate.slice(0, 4));
  const m = Number(expectedDate.slice(5, 7));
  const endMonth = precision === 'month' ? m : Math.ceil(m / 3) * 3;
  // day 0 of the next month is the last day of this one
  const last = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return `${y}-${pad(endMonth)}-${pad(last)}`;
}

export type CatalystTiming = 'closed' | 'undated' | 'upcoming' | 'overdue';

/** Occurred or cancelled → closed; open without a date → undated; open past its window → overdue. */
export function catalystTiming(c: { status: string; expectedDate: string | null; datePrecision: DatePrecision }, today: string): CatalystTiming {
  if (c.status === 'occurred' || c.status === 'cancelled') return 'closed';
  if (!c.expectedDate) return 'undated';
  return expectedWindowEnd(c.expectedDate, c.datePrecision) < today ? 'overdue' : 'upcoming';
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Active theses whose review date has come. A malformed review date is skipped. */
export function thesesDue(theses: Thesis[], today: string): Thesis[] {
  return theses.filter((th) => th.status === 'active' && typeof th.reviewBy === 'string' && DAY_RE.test(th.reviewBy) && th.reviewBy <= today);
}

export interface Freshness {
  /** No quote, or fetched longer ago than staleAfterMs. */
  stale: boolean;
  /** Market date of the quote (its asOf day). */
  marketDate: string | null;
  /** Calendar days from the market date to today; a large lag on a fresh fetch hints at a suspension or a wrong symbol. */
  lagDays: number | null;
}

/** The one staleness rule: the market service and the dashboard both use it. */
export function quoteFreshness(q: { asOf: string; fetchedAt: string } | null, now: Date, today: string, staleAfterMs = 86_400_000): Freshness {
  if (!q) return { stale: true, marketDate: null, lagDays: null };
  const fetched = Date.parse(q.fetchedAt);
  const stale = !Number.isFinite(fetched) || now.getTime() - fetched > staleAfterMs;
  const marketDate = q.asOf.slice(0, 10);
  const lag = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${marketDate}T00:00:00Z`)) / 86_400_000);
  return { stale, marketDate, lagDays: Number.isFinite(lag) ? lag : null };
}
