import { randomId } from '../domain/ids';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

export const nowIso = () => new Date().toISOString();

/** Local calendar date of the server (YYYY-MM-DD). */
export function localToday(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

export const newId = (prefix: string) => randomId(prefix, 12);

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
