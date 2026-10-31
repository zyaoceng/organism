import { describe, expect, it } from 'vitest';
import { compute } from '../calc/engine';
import { setValue } from '../model/ops';
import { indexModel } from '../model/tree';
import { SCALAR_KEY } from '../model/types';
import { diffStates } from '../revision/diff';
import { findLargeMoves } from '../revision/guards';
import { idByName, sampleModel } from '../testing/sample';
import type { Unit } from '../units';
import { applyAgentOp, AgentOpError } from './ops';
import { resolveNodeRef, resolvePeriodRef } from './resolve';
import { DraftOpSchema } from './schema';
import { formatValueZh, parseAgentValue, unitLabelZh } from './units';

const yi: Unit = { kind: 'currency', currency: 'TWD', scale: 1e8 };
const pct: Unit = { kind: 'percent', scale: 1 };
const ok = (input: string | number | null, unit: Unit | null) => {
  const r = parseAgentValue(input, unit, 'X');
  if (!r.ok) throw new Error(r.message);
  return r.value;
};
const code = (input: string | number | null, unit: Unit | null) => {
  const r = parseAgentValue(input, unit, 'X');
  return r.ok ? 'ok' : r.code;
};

describe('AI values with units', () => {
  it('reads percents, multiples and per-share amounts only with their marker', () => {
    expect(ok('18.5%', pct)).toBe(0.185);
    expect(ok('(2.5%)', pct)).toBe(-0.025);
    expect(ok('１８％', pct)).toBe(0.18); // full-width
    expect(code(0.4, pct)).toBe('PERCENT_REQUIRED');
    expect(code('40', pct)).toBe('PERCENT_REQUIRED');
    expect(code('5 億', pct)).toBe('PERCENT_REQUIRED');
    expect(ok('25x', { kind: 'multiple', scale: 1 })).toBe(25);
    expect(ok('25 倍', { kind: 'multiple', scale: 1 })).toBe(25);
    expect(code('25', { kind: 'multiple', scale: 1 })).toBe('MULTIPLE_REQUIRED');
    const twdSh: Unit = { kind: 'per_share', currency: 'TWD', scale: 1 };
    expect(ok('12.3 元', twdSh)).toBe(12.3);
    expect(ok('NT$12.3', twdSh)).toBe(12.3);
    expect(ok('12.3 元/股', twdSh)).toBe(12.3);
    expect(code('12.3', twdSh)).toBe('CURRENCY_REQUIRED');
    expect(code('US$12.3', twdSh)).toBe('CURRENCY_MISMATCH');
    expect(ok('US$1.5', { kind: 'per_share', currency: 'USD', scale: 1 })).toBe(1.5);
  });

  it('converts amounts and share counts to the node’s scale', () => {
    expect(ok('1,234 億', yi)).toBe(1234);
    expect(ok('1,234億元', yi)).toBe(1234);
    expect(ok('2,345 百萬', yi)).toBe(23.45);
    expect(ok('12,345,678 仟元', yi)).toBe(123.45678);
    expect(ok('NT$123,400,000,000', yi)).toBe(1234);
    expect(ok('1.2 兆', yi)).toBe(12000);
    expect(ok('-50 億', yi)).toBe(-50);
    expect(ok('3.2bn TWD', { kind: 'currency', currency: 'TWD', scale: 1e6 })).toBe(3200);
    expect(ok('US$ 5 million', { kind: 'currency', currency: 'USD', scale: 1e6 })).toBe(5);
    expect(parseAgentValue('2,345 百萬', yi, 'X')).toMatchObject({ ok: true, note: '輸入「2,345 百萬」→ 存為 23.45（TWD 億）' });
    expect(parseAgentValue('12 億', yi, 'X')).not.toHaveProperty('note');
    expect(code('2345', yi)).toBe('SCALE_REQUIRED');
    expect(code(2345, yi)).toBe('SCALE_REQUIRED');
    expect(code('5 億 USD', yi)).toBe('CURRENCY_MISMATCH');
    expect(code('5%', yi)).toBe('WRONG_KIND');
    expect(code('a lot', yi)).toBe('NOT_A_NUMBER');
    expect(code('12 億 嗎', yi)).toBe('NOT_A_NUMBER');

    const shares: Unit = { kind: 'shares', scale: 1e8 };
    expect(ok('22 億股', shares)).toBe(22);
    expect(ok('2,200,000,000 股', shares)).toBe(22);
    expect(ok('220 萬張', shares)).toBe(22);
    expect(ok('3,000 股', { kind: 'shares', scale: 1 })).toBe(3000);
    expect(ok('3 張', { kind: 'shares', scale: 1 })).toBe(3000);
    expect(code('22', shares)).toBe('SHARES_REQUIRED');

    expect(ok('12', { kind: 'count', scale: 1, label: 'GW' })).toBe(12);
    expect(ok('1.5 萬', { kind: 'count', scale: 1e3 })).toBe(15);
    expect(code('15', { kind: 'count', scale: 1e3 })).toBe('SCALE_REQUIRED');
    expect(ok('7', null)).toBe(7);
    expect(ok(null, yi)).toBeNull();
    expect(ok('', yi)).toBeNull();
  });

  it('labels units in Chinese', () => {
    expect(unitLabelZh(yi)).toBe('TWD 億');
    expect(unitLabelZh({ kind: 'per_share', currency: 'TWD', scale: 1 })).toBe('元/股');
    expect(unitLabelZh({ kind: 'shares', scale: 1e8 })).toBe('億 股');
    expect(unitLabelZh(pct)).toBe('%');
    expect(formatValueZh(0.2, pct)).toBe('20.0%');
    expect(formatValueZh(25, { kind: 'multiple', scale: 1 })).toBe('25.0 倍');
    expect(formatValueZh(1234, yi)).toBe('1,234 TWD 億');
  });
});

describe('AI draft operations (domain)', () => {
  const s = sampleModel(2026);
  const ix = indexModel(s);

  it('resolves names, paths, ids and periods', () => {
    const gA = idByName(s, 'YoY Growth', 'Business A');
    expect(resolveNodeRef(ix, gA)).toEqual({ ok: true, id: gA });
    expect(resolveNodeRef(ix, 'Business A/YoY Growth')).toEqual({ ok: true, id: gA });
    expect(resolveNodeRef(ix, 'Revenue › Business A › YoY Growth')).toEqual({ ok: true, id: gA });
    expect(resolveNodeRef(ix, 'yoy growth')).toMatchObject({ ok: false, candidates: expect.arrayContaining(['EPS › Revenue › Business A › YoY Growth']) });
    expect(resolvePeriodRef(s, 'FY2026')).toMatchObject({ ok: true, period: { id: 'FY2026' } });
    expect(resolvePeriodRef(s, '2026')).toMatchObject({ ok: true, period: { id: 'FY2026' } });
    expect(resolvePeriodRef(s, '2025A')).toMatchObject({ ok: true, period: { id: 'FY2025' } });
    expect(resolvePeriodRef(s, '2030')).toMatchObject({ ok: false, message: expect.stringMatching(/FY2024（2024A）/) });
  });

  it('refuses scenario writes on actual cells and silent formula overrides', () => {
    const run = (op: unknown) => () => applyAgentOp(s, DraftOpSchema.parse(op));
    expect(run({ op: 'set_value', node: 'Gross Margin', period: '2024', scenario: 'bull', value: '25%' })).toThrow(/2024A 是實際期/);
    expect(run({ op: 'set_value', node: 'Revenue', period: '2027', value: '100 億' })).toThrow(AgentOpError);
    // a typed actual over a formula is a reported number, not an override
    const r = applyAgentOp(s, DraftOpSchema.parse({ op: 'set_value', node: 'Revenue', period: '2025', value: '1,700 億' }));
    expect(r.state.nodes.find((n) => n.name === 'Revenue')!.values.FY2025).toBe(1700);
    // clearing a bear override goes back to the base value
    const cleared = applyAgentOp(s, DraftOpSchema.parse({ op: 'set_value', node: 'Business A/YoY Growth', period: '2026', scenario: 'bear', value: null }));
    expect(cleared.result.cells![0]).toMatchObject({ before: '10.0%', after: '沿用基準', afterRaw: null });
  });

  it('warns when a formula would be hidden by typed values', () => {
    const r = applyAgentOp(s, DraftOpSchema.parse({ op: 'set_formula', node: 'Gross Margin', formula: '0.2' }));
    expect(r.result.warnings.join()).toMatch(/2026E、2027E、2028E 有手動輸入值/);
    const removed = applyAgentOp(r.state, DraftOpSchema.parse({ op: 'set_formula', node: 'Gross Margin', formula: null }));
    expect(removed.state.nodes.find((n) => n.name === 'Gross Margin')!.formula).toBeUndefined();
  });
});

describe('large moves', () => {
  it('flags EPS and target price moves over 30% and values that change 20×', () => {
    const before = sampleModel(2026);
    const pe = idByName(before, 'Target P/E');
    const small = setValue(before, pe, SCALAR_KEY, 'base', 24);
    const big = setValue(setValue(before, pe, SCALAR_KEY, 'base', 30), idByName(before, 'Non-Operating Items'), 'FY2026', 'base', 2000);
    const moves = (after: typeof before) => findLargeMoves(before, after, compute(before), compute(after), diffStates(before, after));
    expect(moves(small)).toEqual([]);
    const m = moves(big);
    expect(m.map((x) => x.kind)).toEqual(['target_price', 'value']);
    expect(m[0].text).toMatch(/^目標價（基準）：.* → .*（\+50\.0%）$/);
    expect(m[1].text).toMatch(/Non-Operating Items 2026：20\.00 → 2,000（相差 100 倍，請確認單位）/);
    // a first initiation always needs confirmation
    const empty = { ...before, nodes: before.nodes.map((n) => ({ ...n, values: {}, overrides: {} })) };
    expect(findLargeMoves(empty, before, compute(empty), compute(before), diffStates(empty, before)).filter((x) => x.text.includes('首次建立')).length).toBe(6);
  });
});
