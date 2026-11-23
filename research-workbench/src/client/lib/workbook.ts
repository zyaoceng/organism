import type { OutputCandidate, OutputKey, OutputMapping } from '../../domain/workbook/types';
import type { AssumptionDTO, TornadoRowDTO, WorkbookRecalcRequest } from '../../shared/api';

/**
 * Pure helpers of the assumptions page (the linked Excel workbook). Trial values are text the user
 * typed, kept per browser tab; nothing here writes to the file.
 */

// ------------------------------------------------------------ numbers as the sheet formats them

// a % inside quotes or behind a backslash is only drawn: 0.0"%" shows 18 as 18%, the value is not a fraction
export const isPercent = (numFmt: string | null | undefined) => !!numFmt && numFmt.replace(/"[^"]*"|\\./g, '').includes('%');

/** Decimals of an Excel number format ("#,##0.0" → 1, "0.0%" → 1); null when the format does not say. */
function decimalsOf(numFmt: string | null | undefined): number | null {
  if (!numFmt || !/[0#]/.test(numFmt)) return null;
  const m = /\.([0#]+)/.exec(numFmt.split(';')[0]);
  return m ? m[1].length : 0;
}

/** A value the way its cell shows it: percent formats as percent, the format's decimals, thousands separators. */
export function fmtNum(v: number | null | undefined, numFmt?: string | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const pct = isPercent(numFmt);
  const x = pct ? v * 100 : v;
  const fixed = decimalsOf(numFmt);
  const d = fixed ?? (Math.abs(x) >= 100 ? 1 : 2);
  // a General cell holding 0.005 must not read 0.00
  const max = fixed === null && x !== 0 && Math.abs(x) < 1 ? 4 : d;
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: max }) + (pct ? '%' : '');
}

/** The text put in an input for a value: full precision, percent formats in percent (0.16 → "16"). */
export function editNum(v: number | null | undefined, numFmt?: string | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return String(Number((isPercent(numFmt) ? v * 100 : v).toFixed(8)));
}

export type ParsedNum = { ok: true; value: number | null } | { ok: false };

/**
 * What the user typed, as a cell value. Empty is "no trial value". In a percent cell 18 and 18% both
 * mean 0.18. Full-width digits (Chinese keyboards) and thousands separators are accepted.
 */
export function parseNum(text: string, numFmt?: string | null): ParsedNum {
  // a Chinese keyboard types 。 for the decimal point and ， for the comma
  const s = text.normalize('NFKC').replace(/。/g, '.').replace(/[\s,]/g, '').replace(/^[−–—]/, '-');
  if (!s) return { ok: true, value: null };
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(s);
  if (!m) return { ok: false };
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return { ok: false };
  // 16.01 / 100 is 0.16010000000000002 in binary; the cell should get 0.1601
  return { ok: true, value: m[2] || isPercent(numFmt) ? Number((n / 100).toPrecision(15)) : n };
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Change of a result against the file's own value; null when either is missing. */
export function deltaVsFile(value: number | null, fileValue: number | null): { abs: number; pct: number | null } | null {
  if (value === null || fileValue === null) return null;
  if (same(value, fileValue)) return { abs: 0, pct: 0 };
  return { abs: value - fileValue, pct: fileValue !== 0 ? (value - fileValue) / Math.abs(fileValue) : null };
}

export function signed(v: number, digits: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function sizeText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------------------ assumptions

export interface AssumptionGroup {
  key: string;
  section: string | null;
  /** The group holds results found outside the assumption tables (the valuation multiple). */
  output: boolean;
  items: AssumptionDTO[];
}

/** Assumptions marked 要 first (sheet order), then the rest grouped by the step they sit under. */
export function orderAssumptions(assumptions: AssumptionDTO[]): { needs: AssumptionDTO[]; groups: AssumptionGroup[] } {
  const needs = assumptions.filter((a) => a.status === 'needs-decision');
  const groups: AssumptionGroup[] = [];
  for (const a of assumptions) {
    if (a.status === 'needs-decision') continue;
    const key = `${a.sheet}\n${a.section ?? ''}\n${a.origin}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, section: a.section, output: a.origin === 'output', items: [] }));
    g.items.push(a);
  }
  return { needs, groups };
}

export const hasRange = (a: Pick<AssumptionDTO, 'low' | 'high'>) => a.low !== null && a.high !== null;

// ------------------------------------------------------------ trial values (this browser tab only)

export interface TrialState {
  /** Typed trial value by assumption id. */
  values: Record<string, string>;
  /** Typed trial range by assumption id, for assumptions the sheet gives no range. */
  ranges: Record<string, { low: string; high: string }>;
}

export const emptyTrial = (): TrialState => ({ values: {}, ranges: {} });

const trialKey = (projectId: string) => `workbench.trial.${projectId}`;

export function parseTrial(raw: string | null): TrialState {
  const out = emptyTrial();
  if (!raw) return out;
  try {
    const j = JSON.parse(raw) as Partial<TrialState> | null;
    for (const [id, v] of Object.entries(j?.values ?? {})) if (typeof v === 'string') out.values[id] = v;
    for (const [id, r] of Object.entries(j?.ranges ?? {})) if (r && typeof r.low === 'string' && typeof r.high === 'string') out.ranges[id] = { low: r.low, high: r.high };
  } catch {
    // unreadable: start without trial values
  }
  return out;
}

export function loadTrial(projectId: string): TrialState {
  try {
    return parseTrial(globalThis.sessionStorage?.getItem(trialKey(projectId)) ?? null);
  } catch {
    return emptyTrial();
  }
}

export function saveTrial(projectId: string, trial: TrialState) {
  try {
    const empty = !Object.values(trial.values).some(Boolean) && !Object.values(trial.ranges).some((r) => r.low || r.high);
    if (empty) globalThis.sessionStorage?.removeItem(trialKey(projectId));
    else globalThis.sessionStorage?.setItem(trialKey(projectId), JSON.stringify(trial));
  } catch {
    // storage blocked: the values still apply until the page is left
  }
}

export interface RecalcPlan {
  request: WorkbookRecalcRequest;
  /** Assumption ids whose value differs from the file's. */
  changed: string[];
  /** Assumption ids with a complete trial range. */
  ranged: string[];
  /** Assumption ids whose typed text is not a number. */
  invalid: string[];
}

/** The recalculation a trial state asks for. Text that is not a number, or equals the file's value, changes nothing. */
export function recalcPlan(assumptions: AssumptionDTO[], trial: TrialState, baseSha: string): RecalcPlan {
  const plan: RecalcPlan = { request: { baseSha, overrides: [] }, changed: [], ranged: [], invalid: [] };
  const ranges: Record<string, { low: number; high: number }> = {};
  for (const a of assumptions) {
    const v = parseNum(trial.values[a.id] ?? '', a.numFmt);
    if (!v.ok) plan.invalid.push(a.id);
    else if (v.value !== null && !same(v.value, a.value)) {
      plan.request.overrides.push({ id: a.id, value: v.value });
      plan.changed.push(a.id);
    }
    const r = trial.ranges[a.id];
    if (!r || hasRange(a)) continue;
    const low = parseNum(r.low, a.numFmt);
    const high = parseNum(r.high, a.numFmt);
    if (!low.ok || !high.ok) {
      if (!plan.invalid.includes(a.id)) plan.invalid.push(a.id);
    } else if (low.value !== null && high.value !== null) {
      ranges[a.id] = { low: low.value, high: high.value };
      plan.ranged.push(a.id);
    }
  }
  if (plan.ranged.length) plan.request.trialRanges = ranges;
  return plan;
}

/** A recalculation answer, kept with the request it answers. */
export interface TrialCalc<T> {
  key: string;
  data: T;
}

/**
 * What to show for the request the trial values ask for now. Only the answer to this very request is
 * current; an answer to earlier trial values (a newer one is on its way, failed, or was never sent)
 * is shown as pending, never as the result of what is typed now.
 */
export function currentCalc<T>(requestKey: string, calc: TrialCalc<T> | null): { data: T | null; pending: boolean } {
  if (!requestKey) return { data: null, pending: false };
  if (calc && calc.key === requestKey) return { data: calc.data, pending: false };
  return { data: calc?.data ?? null, pending: true };
}

/** Errors that mean the page's copy of the file is out of date. */
const STALE_FILE_CODES = ['WORKBOOK_CHANGED', 'WORKBOOK_UNREADABLE', 'WORKBOOK_NOT_LINKED', 'UNKNOWN_ASSUMPTION'];

/** Read the file again after this error? Once per request: the same request failing again is shown as an error. */
export function reloadAfter(code: string | null, requestKey: string, retriedKey: string): boolean {
  return code !== null && STALE_FILE_CODES.includes(code) && retriedKey !== requestKey;
}

// ------------------------------------------------------------ sensitivity

/** Largest absolute target-price change first; rows without one last. */
export function sortTornado(rows: TornadoRowDTO[]): TornadoRowDTO[] {
  const size = (r: TornadoRowDTO) => (r.targetPrice.delta === null ? -1 : Math.abs(r.targetPrice.delta));
  return [...rows].sort((a, b) => size(b) - size(a));
}

/** Bar length in percent of the longest bar; a change that is not zero keeps a visible sliver. */
export function barShare(delta: number | null, maxAbs: number): number {
  if (delta === null || !maxAbs || !delta) return 0;
  return Math.max(1, Math.min(100, (Math.abs(delta) / maxAbs) * 100));
}

// ------------------------------------------------------------ where the results are read from

export const OUTPUT_KEYS: OutputKey[] = ['revenue', 'eps', 'targetPrice', 'multiple', 'shareCount', 'netCash'];

export interface CandidateChoice {
  id: string;
  sheet: string;
  labelText: string;
  /** First resolved cell of the choice. */
  address: string | null;
  chosen: boolean;
  items: OutputCandidate[];
}

/** The places detection found for one result. EPS has one candidate per period; they form one choice per row. */
export function candidateChoices(candidates: OutputCandidate[], key: OutputKey): CandidateChoice[] {
  const out: CandidateChoice[] = [];
  for (const c of candidates) {
    if (c.output !== key) continue;
    const a = c.anchor;
    const id = key === 'eps' ? [a.sheet, a.labelText, a.occurrence, a.subColumnLabel ?? ''].join('\n') : [a.sheet, a.labelText, a.occurrence, a.columnLabel ?? '', a.subColumnLabel ?? ''].join('\n');
    let g = out.find((x) => x.id === id);
    if (!g) out.push((g = { id, sheet: a.sheet, labelText: a.labelText, address: c.address, chosen: false, items: [] }));
    g.items.push(c);
    g.chosen = g.chosen || c.chosen;
  }
  return out;
}

/** The mapping after picking another place for one result; the other results stay where they are. */
export function applyChoice(mapping: OutputMapping, key: OutputKey, choice: CandidateChoice): OutputMapping {
  const anchor = choice.items[0].anchor;
  if (key === 'eps') return { ...mapping, eps: choice.items.map((c) => ({ period: c.anchor.columnLabel ?? '', anchor: c.anchor })) };
  if (key === 'revenue') {
    // the candidate is the four-quarter total, or a quarter when the row has no total
    const periods = mapping.revenueQuarters.map((q) => q.period);
    const isQuarter = periods.includes(anchor.columnLabel ?? '');
    return { ...mapping, revenueTotal: isQuarter ? null : anchor, revenueQuarters: periods.map((period) => ({ period, anchor: { ...anchor, columnLabel: period } })) };
  }
  return { ...mapping, [key]: anchor };
}
