/**
 * Numbers written by an AI assistant always carry their unit ("18.5%", "1,234 億", "25x",
 * "12.3 元", "3,000 股"). The server converts them to the node's stored scale, so the AI never has
 * to know that a node holds 億 while the filing says 百萬 or 仟元. A bare number is refused where
 * its meaning would be a guess (a percent cell given 0.4, an amount given 2345).
 */
import { formatValue } from '../format';
import { normalizeUnit, type Scale, type Unit, type UnitKind } from '../units';

export type AgentValueError = 'PERCENT_REQUIRED' | 'SCALE_REQUIRED' | 'CURRENCY_REQUIRED' | 'MULTIPLE_REQUIRED' | 'SHARES_REQUIRED' | 'WRONG_KIND' | 'CURRENCY_MISMATCH' | 'NOT_A_NUMBER';

export type AgentValue = { ok: true; value: number | null; note?: string } | { ok: false; code: AgentValueError; message: string };

export interface AgentUnitSpec {
  kind: UnitKind;
  currency?: string;
  scale?: '元' | '千' | '百萬' | '億' | '十億';
  label?: string;
}

const SCALE_ZH: Record<number, string> = { 1: '元', 1e3: '千', 1e6: '百萬', 1e8: '億', 1e9: '十億' };
const SPEC_SCALE: Record<NonNullable<AgentUnitSpec['scale']>, Scale> = { 元: 1, 千: 1e3, 百萬: 1e6, 億: 1e8, 十億: 1e9 };

/** Chinese unit label for AI-facing text: 'TWD 億', '元/股', '%', '倍', '億 股'. */
export function unitLabelZh(u: Unit | null | undefined): string {
  if (!u) return '';
  const sc = SCALE_ZH[u.scale] ?? String(u.scale);
  switch (u.kind) {
    case 'currency':
      return `${u.currency ?? ''} ${sc}`.trim();
    case 'per_share':
      return !u.currency || u.currency === 'TWD' ? '元/股' : `${u.currency}/股`;
    case 'percent':
      return '%';
    case 'multiple':
      return '倍';
    case 'shares':
      return u.scale === 1 ? '股' : `${sc} 股`;
    case 'count':
    case 'number':
      return [u.scale === 1 ? '' : sc, u.label ?? ''].filter(Boolean).join(' ');
  }
}

/** A stored value with its unit, for AI-facing text ("1,234 TWD 億", "20.0%", "25.0 倍"). */
export function formatValueZh(v: number | null | undefined, unit: Unit | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (unit?.kind === 'percent') return formatValue(v, unit);
  if (unit?.kind === 'multiple') return `${formatValue(v, null, { digits: 1 })} 倍`;
  return `${formatValue(v, unit)} ${unitLabelZh(unit)}`.trim();
}

/** The unit of a node created by an AI. */
export function unitSpecToUnit(spec: AgentUnitSpec, fallback: Unit | null, currency: string): Unit {
  const scale = spec.scale ? SPEC_SCALE[spec.scale] : fallback && fallback.kind === spec.kind ? fallback.scale : 1;
  return normalizeUnit({ kind: spec.kind, scale, currency: (spec.currency ?? fallback?.currency ?? currency).toUpperCase(), ...(spec.label ? { label: spec.label } : {}) });
}

// ---------------------------------------------------------------- parsing

/** Magnitude words, longest first so 百萬 wins over 萬. */
const SCALE_WORDS: [string, number][] = [
  ['thousand', 1e3],
  ['million', 1e6],
  ['billion', 1e9],
  ['十億', 1e9],
  ['百萬', 1e6],
  ['兆', 1e12],
  ['億', 1e8],
  ['萬', 1e4],
  ['仟', 1e3],
  ['千', 1e3],
  ['mn', 1e6],
  ['bn', 1e9],
  ['k', 1e3],
  ['m', 1e6],
  ['b', 1e9],
];

const CURRENCY_MARKERS: [string, string][] = [
  ['新台幣', 'TWD'],
  ['新臺幣', 'TWD'],
  ['台幣', 'TWD'],
  ['臺幣', 'TWD'],
  ['nt$', 'TWD'],
  ['ntd', 'TWD'],
  ['twd', 'TWD'],
  ['us$', 'USD'],
  ['usd', 'USD'],
  ['美元', 'USD'],
  ['美金', 'USD'],
  ['$', 'USD'],
  ['人民幣', 'CNY'],
  ['rmb', 'CNY'],
  ['cny', 'CNY'],
  ['日圓', 'JPY'],
  ['日元', 'JPY'],
  ['jpy', 'JPY'],
  ['円', 'JPY'],
  ['¥', 'JPY'],
  ['hk$', 'HKD'],
  ['hkd', 'HKD'],
  ['港幣', 'HKD'],
  ['eur', 'EUR'],
  ['€', 'EUR'],
  ['krw', 'KRW'],
];

interface Parsed {
  n: number;
  currency: string | null;
  mult: number | null;
  /** 元 or 元/股: an amount in plain currency units. */
  yuan: boolean;
  perShare: boolean;
  percent: boolean;
  multiple: boolean;
  shares: boolean;
  /** 張: 1,000 shares. */
  lots: boolean;
  /** Text after the number that matched nothing. */
  rest: string;
}

const PREFIX_RE = /^(nt\$|us\$|hk\$|\$|¥|€|ntd|twd|usd|rmb|cny|jpy|hkd)/;

function parse(raw: string): Parsed | null {
  let t = raw.normalize('NFKC').replace(/[−–]/g, '-').replace(/[,\s]/g, '').toLowerCase();
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith('-') && PREFIX_RE.test(t.slice(1))) {
    negative = !negative;
    t = t.slice(1);
  }
  const p: Parsed = { n: 0, currency: null, mult: null, yuan: false, perShare: false, percent: false, multiple: false, shares: false, lots: false, rest: '' };
  const pre = PREFIX_RE.exec(t);
  if (pre) {
    p.currency = CURRENCY_MARKERS.find(([m]) => m === pre[1])?.[1] ?? null;
    t = t.slice(pre[1].length);
  }
  const m = /^([-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?)(.*)$/.exec(t);
  if (!m) return null;
  p.n = Number(m[1]) * (negative ? -1 : 1);
  if (!Number.isFinite(p.n)) return null;
  let rest = m[4];
  // suffix tokens in any order: magnitude, currency, 元, /股, %, x/倍, 股/張/shares
  for (let guard = 0; rest && guard < 6; guard++) {
    const before = rest;
    if (rest.startsWith('%')) {
      p.percent = true;
      rest = rest.slice(1);
    } else if (rest === 'x' || rest === '×' || rest.startsWith('倍')) {
      p.multiple = true;
      rest = rest.slice(1);
    } else if (/^(\/股|\/sh|pershare|每股)/.test(rest)) {
      p.perShare = true;
      rest = rest.replace(/^(\/股|\/sh|pershare|每股)/, '');
    } else if (/^(股|shares|share|sh)/.test(rest)) {
      p.shares = true;
      rest = rest.replace(/^(股|shares|share|sh)/, '');
    } else if (rest.startsWith('張')) {
      p.lots = true;
      rest = rest.slice(1);
    } else {
      const cur = !p.currency ? CURRENCY_MARKERS.find(([mk]) => rest.startsWith(mk)) : undefined;
      if (cur) {
        p.currency = cur[1];
        rest = rest.slice(cur[0].length);
      } else if (rest.startsWith('元')) {
        p.yuan = true;
        rest = rest.slice(1);
      } else if (p.mult === null) {
        const sc = SCALE_WORDS.find(([w]) => rest.startsWith(w));
        if (sc) {
          p.mult = sc[1];
          rest = rest.slice(sc[0].length);
        }
      }
    }
    if (rest === before) break;
  }
  p.rest = rest;
  return p;
}

const round12 = (x: number) => Number(x.toPrecision(12));

/**
 * Convert an AI-written value for a node with `unit` into the stored number.
 * A number argument goes through the same rules: 0.4 for a percent cell is an error, not 0.4%.
 */
export function parseAgentValue(input: string | number | null, unit: Unit | null, nodeName: string): AgentValue {
  if (input === null) return { ok: true, value: null };
  const text = String(input).trim();
  if (text === '') return { ok: true, value: null };
  const p = parse(text);
  const label = unitLabelZh(unit);
  const example = exampleFor(unit);
  const fail = (code: AgentValueError, message: string): AgentValue => ({ ok: false, code, message });
  if (!p || p.rest) return fail('NOT_A_NUMBER', `${nodeName}：看不懂「${text}」。請寫數字加單位，例如 "${example}"`);
  const kind = unit?.kind ?? null;
  // the AI should see when its number was rescaled ("2,345 百萬" stored as 23.45 億)
  const scaled = (value: number, mult: number): AgentValue =>
    unit && mult !== unit.scale ? { ok: true, value, note: `輸入「${text}」→ 存為 ${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}（${label}）` } : { ok: true, value };

  if (kind === 'percent') {
    if (!p.percent) return fail('PERCENT_REQUIRED', `${nodeName} 是百分比格，請寫成 "${example}"（不要寫成小數 0.185）`);
    if (p.currency || p.mult !== null || p.multiple || p.shares || p.yuan) return fail('WRONG_KIND', `${nodeName} 是百分比格，「${text}」不是百分比`);
    return { ok: true, value: round12(p.n / 100) };
  }
  if (p.percent) {
    if (kind === null) return { ok: true, value: round12(p.n / 100) };
    return fail('WRONG_KIND', `${nodeName} 的單位是 ${label}，不是百分比；請寫成 "${example}"`);
  }
  if (kind === 'multiple') {
    if (!p.multiple) return fail('MULTIPLE_REQUIRED', `${nodeName} 是倍數格，請寫成 "${example}" 或 "25 倍"`);
    if (p.currency || p.mult !== null || p.shares || p.yuan) return fail('WRONG_KIND', `${nodeName} 是倍數格，「${text}」不是倍數`);
    return { ok: true, value: p.n };
  }
  if (p.multiple) {
    if (kind === null) return { ok: true, value: p.n };
    return fail('WRONG_KIND', `${nodeName} 的單位是 ${label}，不是倍數；請寫成 "${example}"`);
  }
  if (kind === 'per_share') {
    if (p.currency && p.currency !== unit!.currency) return fail('CURRENCY_MISMATCH', `${nodeName} 的幣別是 ${unit!.currency}，「${text}」是 ${p.currency}`);
    if (p.mult !== null || p.shares || p.lots) return fail('WRONG_KIND', `${nodeName} 是每股金額（${label}），請寫成 "${example}"`);
    if (!p.currency && !p.yuan && !p.perShare) return fail('CURRENCY_REQUIRED', `${nodeName} 是每股金額（${label}），請寫成 "${example}"`);
    return { ok: true, value: p.n };
  }
  if (kind === 'currency') {
    if (p.currency && p.currency !== unit!.currency) return fail('CURRENCY_MISMATCH', `${nodeName} 的幣別是 ${unit!.currency}，「${text}」是 ${p.currency}；請照原文幣別換算後再寫`);
    if (p.shares || p.lots || p.perShare) return fail('WRONG_KIND', `${nodeName} 是金額（${label}），「${text}」不是金額`);
    if (p.mult === null && !p.currency && !p.yuan) return fail('SCALE_REQUIRED', `${nodeName} 是金額，單位 ${label}；請寫出單位，例如 "${example}"、"2,345 百萬" 或 "12,345 仟元"`);
    const mult = p.mult ?? 1;
    const value = round12((p.n * mult) / unit!.scale);
    return scaled(value, mult);
  }
  if (kind === 'shares') {
    if (p.currency || p.yuan || p.perShare) return fail('WRONG_KIND', `${nodeName} 是股數（${label}），「${text}」不是股數`);
    if (p.mult === null && !p.shares && !p.lots) return fail('SHARES_REQUIRED', `${nodeName} 是股數（${label}），請寫成 "${example}" 或 "3,000 股"（1 張 = 1000 股）`);
    const mult = (p.mult ?? 1) * (p.lots ? 1000 : 1);
    const value = round12((p.n * mult) / unit!.scale);
    return scaled(value, mult);
  }
  if (kind === 'count' || kind === 'number') {
    if (p.currency || p.yuan || p.perShare || p.shares || p.lots) return fail('WRONG_KIND', `${nodeName} 的單位是 ${label || '數值'}，「${text}」的單位不同`);
    if (unit!.scale !== 1 && p.mult === null) return fail('SCALE_REQUIRED', `${nodeName} 的單位是 ${label}；請寫出數量級，例如 "${example}"`);
    const mult = p.mult ?? 1;
    const value = round12((p.n * mult) / unit!.scale);
    return scaled(value, mult);
  }
  // no unit: a plain number
  if (p.currency || p.yuan || p.perShare || p.shares || p.lots || p.mult !== null) return fail('WRONG_KIND', `${nodeName} 沒有設定單位，請只寫數字，或先設定它的單位`);
  return { ok: true, value: p.n };
}

function exampleFor(unit: Unit | null): string {
  switch (unit?.kind) {
    case 'percent':
      return '18.5%';
    case 'multiple':
      return '25x';
    case 'per_share':
      return unit.currency === 'USD' ? 'US$12.3' : '12.3 元';
    case 'currency':
      return `1,234 ${SCALE_ZH[unit.scale] === '元' ? '元' : SCALE_ZH[unit.scale] ?? '億'}`;
    case 'shares':
      return unit.scale === 1 ? '3,000 股' : `22 ${SCALE_ZH[unit.scale]}股`;
    case 'count':
    case 'number':
      return unit.scale === 1 ? '12' : `12 ${SCALE_ZH[unit.scale]}`;
    default:
      return '12';
  }
}
