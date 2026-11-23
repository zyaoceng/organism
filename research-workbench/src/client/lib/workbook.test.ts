import { describe, expect, it } from 'vitest';
import type { OutputCandidate, OutputMapping } from '../../domain/workbook/types';
import type { AssumptionDTO, TornadoRowDTO } from '../../shared/api';
import { applyChoice, barShare, candidateChoices, currentCalc, reloadAfter, deltaVsFile, editNum, emptyTrial, fmtNum, isPercent, orderAssumptions, parseNum, parseTrial, recalcPlan, signed, sizeText, sortTornado } from './workbook';

const a = (label: string, over: Partial<AssumptionDTO> = {}): AssumptionDTO => ({
  id: `營收模型!${label}#1`,
  sheet: '營收模型',
  label,
  section: '二、端點',
  cell: 'B15',
  value: 0.16,
  valueIsFormula: false,
  numFmt: '0.0%',
  low: 0.12,
  high: 0.2,
  basis: null,
  note: null,
  status: 'decided',
  origin: 'table',
  ...over,
});

describe('numbers as the sheet formats them', () => {
  it('follows the cell format', () => {
    expect(fmtNum(0.163, '0.0%')).toBe('16.3%');
    expect(fmtNum(6860.9793913, '#,##0.0')).toBe('6,861.0');
    expect(fmtNum(1030, '#,##0')).toBe('1,030');
    expect(fmtNum(0.9845, '0.0000')).toBe('0.9845');
    expect(fmtNum(-20, '#,##0.0;[Red]-#,##0.0')).toBe('-20.0');
    expect(fmtNum(25, null)).toBe('25.00');
    expect(fmtNum(null, '0.0%')).toBe('—');
  });

  it('a % that the format only draws does not make the value a fraction', () => {
    // 0.0"%" and 0.0\% show 18 as 18.0%: the cell holds 18, and typing 18 means 18
    for (const fmt of ['0.0"%"', '0.0\\%']) {
      expect(isPercent(fmt)).toBe(false);
      expect(fmtNum(18, fmt)).toBe('18.0');
      expect(parseNum('18', fmt)).toEqual({ ok: true, value: 18 });
      expect(editNum(18, fmt)).toBe('18');
    }
    expect(isPercent('0.0%;[Red]-0.0%')).toBe(true);
    expect(isPercent('0.0%" YoY"')).toBe(true);
  });

  it('a small number in an unformatted cell is not rounded to zero', () => {
    expect(fmtNum(0.005, null)).toBe('0.005');
    expect(fmtNum(0.18, null)).toBe('0.18');
    expect(fmtNum(-0.00125, undefined)).toBe('-0.0013');
    expect(fmtNum(0, null)).toBe('0.00');
    expect(fmtNum(0.004, '0.00')).toBe('0.00');
  });

  it('reads what was typed: percent cells in percent, full-width digits, separators', () => {
    expect(parseNum('18', '0.0%')).toEqual({ ok: true, value: 0.18 });
    expect(parseNum('18%', '0.0%')).toEqual({ ok: true, value: 0.18 });
    expect(parseNum('30', '#,##0.0')).toEqual({ ok: true, value: 30 });
    expect(parseNum('１，０３０', '#,##0')).toEqual({ ok: true, value: 1030 });
    expect(parseNum(' -20 ', '#,##0.0')).toEqual({ ok: true, value: -20 });
    expect(parseNum('', '0.0%')).toEqual({ ok: true, value: null });
    expect(parseNum('25倍', null)).toEqual({ ok: false });
    expect(parseNum('1.2.3', null)).toEqual({ ok: false });
  });

  it('gives an input the full value', () => {
    expect(editNum(0.163, '0.0%')).toBe('16.3');
    expect(editNum(0.9845, '0.0000')).toBe('0.9845');
    expect(editNum(null)).toBe('');
  });

  it('states the change against the file', () => {
    expect(deltaVsFile(205.83, 171.53)).toEqual({ abs: expect.closeTo(34.3, 6), pct: expect.closeTo(0.19996, 4) });
    expect(deltaVsFile(171.53, 171.53)).toEqual({ abs: 0, pct: 0 });
    expect(deltaVsFile(5, 0)).toEqual({ abs: 5, pct: null });
    expect(deltaVsFile(null, 1)).toBeNull();
    expect(signed(34.3, 2)).toBe('+34.30');
    expect(signed(-1234.5, 1)).toBe('−1,234.5');
    expect(sizeText(28202)).toBe('27.5 KB');
  });
});

describe('assumptions', () => {
  it('lists 要 first, then the rest by step in sheet order', () => {
    const list = [a('雲端 ARR', { section: '一、基期' }), a('端點台數年增率', { status: 'needs-decision' }), a('每台單價年增率'), a('營業利益率', { section: '七、獲利', status: 'needs-decision' }), a('EV/Sales 倍數', { section: null, status: null, origin: 'output' })];
    const { needs, groups } = orderAssumptions(list);
    expect(needs.map((x) => x.label)).toEqual(['端點台數年增率', '營業利益率']);
    expect(groups.map((g) => [g.section, g.output, g.items.map((x) => x.label)])).toEqual([
      ['一、基期', false, ['雲端 ARR']],
      ['二、端點', false, ['每台單價年增率']],
      [null, true, ['EV/Sales 倍數']],
    ]);
  });

  it('turns typed text into a recalculation; file values and bad text change nothing', () => {
    const growth = a('端點台數年增率');
    const multiple = a('EV/Sales 倍數', { value: 25, numFmt: '#,##0.0', low: null, high: null, origin: 'output' });
    const price = a('Guardian 每台單價', { value: 25, numFmt: '#,##0.0', low: 20, high: 30 });
    const trial = {
      values: { [growth.id]: '16', [multiple.id]: '30', [price.id]: 'abc', gone: '5' },
      ranges: { [multiple.id]: { low: '20', high: '30' }, [growth.id]: { low: '1', high: '2' }, [price.id]: { low: '', high: '' } },
    };
    const plan = recalcPlan([growth, multiple, price], trial, 'sha');
    expect(plan.request).toEqual({ baseSha: 'sha', overrides: [{ id: multiple.id, value: 30 }], trialRanges: { [multiple.id]: { low: 20, high: 30 } } });
    expect(plan.changed).toEqual([multiple.id]);
    expect(plan.ranged).toEqual([multiple.id]);
    expect(plan.invalid).toEqual([price.id]);
    expect(recalcPlan([growth], emptyTrial(), 'sha').request).toEqual({ baseSha: 'sha', overrides: [] });
    // half a range is not a range yet
    expect(recalcPlan([multiple], { values: {}, ranges: { [multiple.id]: { low: '20', high: '' } } }, 'sha').ranged).toEqual([]);
  });

  it('reads the trial values kept in the tab, ignoring anything malformed', () => {
    expect(parseTrial(null)).toEqual(emptyTrial());
    expect(parseTrial('{not json')).toEqual(emptyTrial());
    expect(parseTrial(JSON.stringify({ values: { x: '30', y: 5 }, ranges: { x: { low: '20', high: '30' }, z: { low: 1 } } }))).toEqual({ values: { x: '30' }, ranges: { x: { low: '20', high: '30' } } });
  });
});

describe('what was typed, adversarial', () => {
  it('reads Chinese-keyboard punctuation and full-width signs', () => {
    expect(parseNum('１８。５', '#,##0.0')).toEqual({ ok: true, value: 18.5 });
    expect(parseNum('１８．５％', '0.0%')).toEqual({ ok: true, value: 0.185 });
    expect(parseNum('１，２３４。５', null)).toEqual({ ok: true, value: 1234.5 });
    expect(parseNum('－２０', null)).toEqual({ ok: true, value: -20 });
    expect(parseNum('–20', null)).toEqual({ ok: true, value: -20 });
    expect(parseNum('＋５', null)).toEqual({ ok: true, value: 5 });
    expect(parseNum('1,234,567.25', null)).toEqual({ ok: true, value: 1234567.25 });
    expect(parseNum('　30　', null)).toEqual({ ok: true, value: 30 });
    expect(parseNum('.5', null)).toEqual({ ok: true, value: 0.5 });
    expect(parseNum('18.', '0%')).toEqual({ ok: true, value: 0.18 });
  });

  it('refuses what is not one plain number instead of guessing', () => {
    for (const bad of ['1e3', '0x10', 'Infinity', 'NaN', '1。2。3', '18%%', '%', '-', '.', '5-', '1 - 2', '=1+1', '30倍', '三十', '9'.repeat(400)]) {
      expect(parseNum(bad, null), bad).toEqual({ ok: false });
    }
  });

  it('a percent typed in a plain cell is a fraction; the same text never changes meaning by position', () => {
    expect(parseNum('18%', '#,##0.0')).toEqual({ ok: true, value: 0.18 });
    expect(parseNum('0', '0.0%')).toEqual({ ok: true, value: 0 });
    expect(parseNum('-0', null).ok).toBe(true);
  });

  it('typing the file value, in any spelling, is not a change', () => {
    const growth = a('端點台數年增率');
    for (const text of ['16', '16.0', '16%', '１６', ' 16 ', '16。0']) {
      expect(recalcPlan([growth], { values: { [growth.id]: text }, ranges: {} }, 'sha').changed, text).toEqual([]);
    }
    expect(recalcPlan([growth], { values: { [growth.id]: '16.01' }, ranges: {} }, 'sha').request.overrides).toEqual([{ id: growth.id, value: 0.1601 }]);
  });

  it('one bad box does not drop the other trial values', () => {
    const growth = a('端點台數年增率');
    const price = a('單價', { value: 25, numFmt: '#,##0.0' });
    const plan = recalcPlan([growth, price], { values: { [growth.id]: '18x', [price.id]: '30' }, ranges: {} }, 'sha');
    expect(plan.invalid).toEqual([growth.id]);
    expect(plan.request.overrides).toEqual([{ id: price.id, value: 30 }]);
  });
});

describe('answers arriving late or not at all', () => {
  const key = (v: number) => JSON.stringify({ baseSha: 'sha', overrides: [{ id: 'x', value: v }] });

  it('no trial value: the file numbers, nothing pending', () => {
    expect(currentCalc('', null)).toEqual({ data: null, pending: false });
    // an old answer is not shown once everything was reset
    expect(currentCalc('', { key: key(30), data: 204.83 })).toEqual({ data: null, pending: false });
  });

  it('only the answer to the current request is current', () => {
    expect(currentCalc(key(30), { key: key(30), data: 204.83 })).toEqual({ data: 204.83, pending: false });
    // 30 was answered, 35 is typed: whether 35 is on its way, failed, or was never sent, 204.83 is not its result
    expect(currentCalc(key(35), { key: key(30), data: 204.83 })).toEqual({ data: 204.83, pending: true });
    expect(currentCalc(key(35), null)).toEqual({ data: null, pending: true });
  });

  it('an answer for the file as it was before it changed is not current', () => {
    const before = JSON.stringify({ baseSha: 'old', overrides: [{ id: 'x', value: 30 }] });
    const after = JSON.stringify({ baseSha: 'new', overrides: [{ id: 'x', value: 30 }] });
    expect(currentCalc(after, { key: before, data: 1 }).pending).toBe(true);
  });

  it('reads the file again once per request, then shows the error', () => {
    expect(reloadAfter('WORKBOOK_CHANGED', key(30), '')).toBe(true);
    expect(reloadAfter('WORKBOOK_CHANGED', key(30), key(30))).toBe(false);
    expect(reloadAfter('WORKBOOK_CHANGED', key(35), key(30))).toBe(true);
    expect(reloadAfter('UNKNOWN_ASSUMPTION', key(30), '')).toBe(true);
    expect(reloadAfter('VALIDATION', key(30), '')).toBe(false);
    expect(reloadAfter(null, key(30), '')).toBe(false);
  });
});

describe('sensitivity', () => {
  const row = (id: string, delta: number | null): TornadoRowDTO => ({ id, label: id, section: null, low: 0, high: 1, rangeSource: 'sheet', targetPrice: { atLow: 0, atHigh: delta, delta }, revenue: { atLow: 0, atHigh: 0, delta: 0 }, eps: { atLow: 0, atHigh: 0, delta: 0 } });

  it('orders by the size of the target-price change, whatever its sign', () => {
    expect(sortTornado([row('a', 1.4), row('none', null), row('b', -66.6), row('c', 3.4)]).map((r) => r.id)).toEqual(['b', 'c', 'a', 'none']);
  });

  it('sizes bars against the longest', () => {
    expect(barShare(-66.6, 66.6)).toBe(100);
    expect(barShare(33.3, 66.6)).toBe(50);
    expect(barShare(0.01, 66.6)).toBe(1);
    expect(barShare(0, 66.6)).toBe(0);
    expect(barShare(null, 66.6)).toBe(0);
    expect(barShare(1, 0)).toBe(0);
  });
});

describe('where the results are read from', () => {
  const anchor = (sheet: string, labelText: string, columnLabel?: string, subColumnLabel?: string) => ({ sheet, labelText, occurrence: 1, ...(columnLabel ? { columnLabel } : {}), ...(subColumnLabel ? { subColumnLabel } : {}) });
  const mapping: OutputMapping = {
    revenueQuarters: ['3Q27', '4Q27'].map((period) => ({ period, anchor: anchor('營收模型', '總營收', period) })),
    revenueTotal: anchor('營收模型', '總營收', '四季合計'),
    eps: [{ period: 'FY27', anchor: anchor('主表', '調整後 EPS', 'FY27', '我的預估') }],
    targetPrice: anchor('營收模型', '目標價（美元）'),
    multiple: null,
    shareCount: null,
    netCash: null,
  };
  const cand = (output: OutputCandidate['output'], an: OutputCandidate['anchor'], address: string, chosen: boolean): OutputCandidate => ({ output, anchor: an, address, cached: 1, chosen });
  const candidates = [
    cand('targetPrice', anchor('營收模型', '目標價（美元）'), 'B86', true),
    cand('targetPrice', anchor('營收模型', '目標價對股價'), 'B88', false),
    cand('revenue', anchor('營收模型', '總營收', '四季合計'), 'F67', true),
    cand('revenue', anchor('未來四季營收', '總營收', '四季合計', '我的預估'), 'Z7', false),
    cand('eps', anchor('主表', '調整後 EPS', '3Q27', '我的預估'), 'I14', true),
    cand('eps', anchor('主表', '調整後 EPS', 'FY27', '我的預估'), 'U14', true),
    cand('eps', anchor('主表', 'EPS（公認會計）', 'FY27', '我的預估'), 'U20', false),
  ];

  it('offers one choice per place; the periods of an EPS row are one choice', () => {
    expect(candidateChoices(candidates, 'targetPrice').map((c) => [c.labelText, c.address, c.chosen])).toEqual([
      ['目標價（美元）', 'B86', true],
      ['目標價對股價', 'B88', false],
    ]);
    expect(candidateChoices(candidates, 'eps').map((c) => [c.labelText, c.items.length, c.chosen])).toEqual([
      ['調整後 EPS', 2, true],
      ['EPS（公認會計）', 1, false],
    ]);
    expect(candidateChoices(candidates, 'multiple')).toEqual([]);
  });

  it('moves one result and leaves the others', () => {
    const tp = applyChoice(mapping, 'targetPrice', candidateChoices(candidates, 'targetPrice')[1]);
    expect(tp.targetPrice).toEqual(anchor('營收模型', '目標價對股價'));
    expect(tp.revenueTotal).toBe(mapping.revenueTotal);

    const rev = applyChoice(mapping, 'revenue', candidateChoices(candidates, 'revenue')[1]);
    expect(rev.revenueTotal).toEqual(anchor('未來四季營收', '總營收', '四季合計', '我的預估'));
    expect(rev.revenueQuarters).toEqual(['3Q27', '4Q27'].map((period) => ({ period, anchor: anchor('未來四季營收', '總營收', period, '我的預估') })));
    expect(rev.targetPrice).toBe(mapping.targetPrice);

    const eps = applyChoice(mapping, 'eps', candidateChoices(candidates, 'eps')[0]);
    expect(eps.eps.map((e) => e.period)).toEqual(['3Q27', 'FY27']);
  });
});
