import { unitLabel, type Unit } from './units';

const grouped = (v: number, digits: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function defaultDigits(unit: Unit | null | undefined, v: number): number {
  if (!unit) return Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 1 : 2;
  switch (unit.kind) {
    case 'percent':
    case 'multiple':
      return 1;
    case 'per_share':
      return 2;
    default:
      return Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 1 : 2;
  }
}

export function formatValue(
  v: number | null | undefined,
  unit: Unit | null | undefined,
  opts: { digits?: number; withUnit?: boolean } = {},
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const d = opts.digits ?? defaultDigits(unit, unit?.kind === 'percent' ? v * 100 : v);
  let s: string;
  if (unit?.kind === 'percent') s = `${grouped(v * 100, d)}%`;
  else if (unit?.kind === 'multiple') s = `${grouped(v, d)}x`;
  else s = grouped(v, d);
  if (opts.withUnit && unit && unit.kind !== 'percent' && unit.kind !== 'multiple') {
    const label = unitLabel(unit);
    if (label) s += ` ${label}`;
  }
  return s;
}

/** Raw editable text for a value (percent shown in points). */
export function editText(v: number | null | undefined, unit: Unit | null | undefined): string {
  if (v === null || v === undefined) return '';
  const x = unit?.kind === 'percent' ? v * 100 : v;
  return String(Math.round(x * 1e10) / 1e10);
}

export type ParseResult = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * Parse typed input. Accepts "1,234.5", "(12)" for negatives, "40%" and, in percent cells, "40"
 * meaning 40%. An empty string clears the cell.
 */
export function parseValueInput(text: string, unit: Unit | null | undefined): ParseResult {
  let t = text.trim().replace(/,/g, '').replace(/\s+/g, '');
  if (t === '') return { ok: true, value: null };
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  let percent = false;
  if (t.endsWith('%')) {
    percent = true;
    t = t.slice(0, -1);
  } else if (/x$/i.test(t) && unit?.kind === 'multiple') {
    t = t.slice(0, -1);
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return { ok: false, message: `"${text}" is not a number` };
  let v = Number(t);
  if (negative) v = -v;
  if (percent || unit?.kind === 'percent') v = v / 100;
  if (!Number.isFinite(v)) return { ok: false, message: `"${text}" is not a finite number` };
  return { ok: true, value: v };
}

export function pctChange(before: number | null | undefined, after: number | null | undefined): number | null {
  if (before === null || before === undefined || after === null || after === undefined) return null;
  if (before === 0) return null;
  return (after - before) / Math.abs(before);
}

/** "+3.7%" for amounts, "+1.0 pp" for percent metrics. */
export function formatDelta(before: number | null | undefined, after: number | null | undefined, unit: Unit | null | undefined): string {
  if (before === null || before === undefined || after === null || after === undefined) return '';
  if (unit?.kind === 'percent') {
    const pp = (after - before) * 100;
    return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)} pp`;
  }
  const p = pctChange(before, after);
  if (p === null) return '';
  return `${p >= 0 ? '+' : ''}${(p * 100).toFixed(1)}%`;
}

export const signed = (v: number, digits = 2) => `${v >= 0 ? '+' : ''}${grouped(v, digits)}`;
