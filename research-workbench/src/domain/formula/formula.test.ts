import { describe, expect, it } from 'vitest';
import { compute } from '../calc/engine';
import { addNode, renameNode, setFormula, setValue } from '../model/ops';
import { indexModel } from '../model/tree';
import { emptyState, SCALAR_KEY, type ModelState } from '../model/types';
import { FormulaSyntaxError } from './lexer';
import { parseFormula } from './parser';
import { toDisplay, toStored } from './refs';

/** Evaluate a constant expression through the real engine (scalar node with a formula). */
function evalConst(expr: string): number | string {
  let s = emptyState();
  const r = addNode(s, { parentId: null, name: 'X', timeMode: 'scalar', unit: { kind: 'number', scale: 1 } });
  s = setFormula(r.state, r.id, expr);
  const c = compute(s).cells.base[r.id][SCALAR_KEY];
  return c.err ? c.err.code : (c.v as number);
}

function withNodes(names: string[]): { state: ModelState; ids: Record<string, string> } {
  let s: ModelState = { ...emptyState(), periods: [{ id: 'FY2025', label: '2025', status: 'A' }, { id: 'FY2026', label: '2026', status: 'E' }] };
  const ids: Record<string, string> = {};
  for (const n of names) {
    const r = addNode(s, { parentId: null, name: n, unit: { kind: 'number', scale: 1 } });
    s = r.state;
    ids[n] = r.id;
  }
  return { state: s, ids };
}

describe('parser and operators', () => {
  it('respects precedence and associativity', () => {
    expect(evalConst('2 + 3 * 4')).toBe(14);
    expect(evalConst('(2 + 3) * 4')).toBe(20);
    expect(evalConst('-2 ^ 2')).toBe(-4);
    expect(evalConst('2 ^ 3 ^ 2')).toBe(512);
    expect(evalConst('10 / 4 - 1')).toBe(1.5);
    expect(evalConst('2 × 3 ÷ 4')).toBe(1.5);
  });

  it('treats postfix % as divide-by-100', () => {
    expect(evalConst('40%')).toBeCloseTo(0.4);
    expect(evalConst('200 * 15%')).toBeCloseTo(30);
    expect(evalConst('1 + 5%')).toBeCloseTo(1.05);
  });

  it('supports functions', () => {
    expect(evalConst('SUM(1, 2, 3)')).toBe(6);
    expect(evalConst('MIN(4, 2, 9)')).toBe(2);
    expect(evalConst('MAX(4, 2, 9)')).toBe(9);
    expect(evalConst('AVERAGE(1, 2, 3, 4)')).toBe(2.5);
    expect(evalConst('CAGR(100, 121, 2)')).toBeCloseTo(0.1);
    expect(evalConst('IF(1 > 2, 10, 20)')).toBe(20);
    expect(evalConst('ROUND(3.14159, 2)')).toBe(3.14);
    expect(evalConst('ABS(-3)')).toBe(3);
    expect(evalConst('AND(1, 0)')).toBe(0);
    expect(evalConst('OR(1, 0)')).toBe(1);
    expect(evalConst('NOT(0)')).toBe(1);
    expect(evalConst('sum(1,1)')).toBe(2);
  });

  it('evaluates IF lazily so the untaken branch cannot fail', () => {
    expect(evalConst('IF(0 = 0, 0, 1 / 0)')).toBe(0);
    expect(evalConst('1 / 0')).toBe('DIV0');
  });

  it('reports syntax errors with positions', () => {
    const bad = ['1 +', '(1 + 2', '1 2', 'FOO(1)', 'SUM()', 'CAGR(1, 2)', 'CHILDREN()', '[unterminated', '1 $ 2', 'PREV(1, 0)'];
    for (const b of bad) expect(() => parseFormula(b), b).toThrow(FormulaSyntaxError);
    try {
      parseFormula('FOO(1)');
    } catch (e) {
      expect((e as Error).message).toMatch(/Unknown function FOO/);
    }
  });

  it('does not use eval: identifiers are node names, not JavaScript', () => {
    const { state } = withNodes(['A']);
    const r = toStored('constructor + A', indexModel(state), null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_NAME');
  });
});

describe('references: names in the UI, IDs in storage', () => {
  it('converts names to stable IDs and back', () => {
    const { state, ids } = withNodes(['Net Income', 'Diluted Shares']);
    const ix = indexModel(state);
    const r = toStored('[Net Income] / [Diluted Shares]', ix, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stored).toBe(`{${ids['Net Income']}} / {${ids['Diluted Shares']}}`);
    expect(toDisplay(r.stored, ix, null)).toBe('[Net Income] / [Diluted Shares]');
  });

  it('keeps formulas working after a rename', () => {
    const { state, ids } = withNodes(['Revenue', 'Margin']);
    const stored = toStored('Revenue * Margin', indexModel(state), null);
    if (!stored.ok) throw new Error('parse');
    let s = setFormula(state, ids.Revenue, undefined);
    const p = addNode(s, { parentId: null, name: 'Profit', unit: { kind: 'number', scale: 1 } });
    s = setFormula(p.state, p.id, stored.stored);
    s = renameNode(s, ids.Revenue, 'Sales');
    expect(toDisplay(stored.stored, indexModel(s), p.id)).toBe('[Sales] * [Margin]');
    s = setValue(s, ids.Revenue, 'FY2026', 'base', 100);
    s = setValue(s, ids.Margin, 'FY2026', 'base', 0.3);
    expect(compute(s).cells.base[p.id].FY2026.v).toBeCloseTo(30);
  });

  it('resolves duplicate names by scope and asks for a path when ambiguous', () => {
    let s: ModelState = { ...emptyState(), periods: [{ id: 'FY2026', label: '2026', status: 'E' }] };
    const a = addNode(s, { parentId: null, name: 'Business A' });
    s = a.state;
    const ga = addNode(s, { parentId: a.id, name: 'Growth' });
    s = ga.state;
    const b = addNode(s, { parentId: null, name: 'Business B' });
    s = b.state;
    const gb = addNode(s, { parentId: b.id, name: 'Growth' });
    s = gb.state;
    const ix = indexModel(s);
    // from inside Business A, [Growth] means its own child
    const inA = toStored('[Growth]', ix, a.id);
    expect(inA.ok && inA.refIds[0]).toBe(ga.id);
    // from the top level it is ambiguous
    const top = toStored('[Growth]', ix, null);
    expect(top.ok).toBe(false);
    if (!top.ok) {
      expect(top.error.code).toBe('AMBIGUOUS_NAME');
      expect(top.error.message).toMatch(/Business A › Growth/);
    }
    // a path disambiguates
    const path = toStored('[Business B/Growth]', ix, null);
    expect(path.ok && path.refIds[0]).toBe(gb.id);
    // display uses the shortest unambiguous form for the context
    const stored = `{${gb.id}}`;
    expect(toDisplay(stored, ix, b.id)).toBe('[Growth]');
    expect(toDisplay(stored, ix, null)).toBe('[Business B/Growth]');
  });

  it('prefers an exact name containing "/" over a path', () => {
    const { state, ids } = withNodes(['P/E', 'EPS']);
    const r = toStored('[EPS] * [P/E]', indexModel(state), null);
    expect(r.ok && r.refIds).toEqual([ids.EPS, ids['P/E']]);
  });

  it('rejects unknown names with suggestions and unknown periods', () => {
    const { state } = withNodes(['Gross Margin']);
    const ix = indexModel(state);
    const r = toStored('[Gross Margn]', ix, null);
    expect(r.ok).toBe(false);
    const r2 = toStored('[Gross]', ix, null);
    expect(!r2.ok && r2.error.message).toMatch(/Did you mean \[Gross Margin\]/);
    const r3 = toStored('[Gross Margin]@FY2031', ix, null);
    expect(!r3.ok && r3.error.code).toBe('NO_PERIOD');
  });

  it('shows deleted references explicitly', () => {
    const { state } = withNodes(['A']);
    const ix = indexModel(state);
    expect(toDisplay('{n_gone0000} + 1', ix, null)).toBe('[#deleted n_gone0000] + 1');
    const r = toStored('[#deleted n_gone0000] + 1', ix, null);
    expect(!r.ok && r.error.code).toBe('DELETED_REF');
  });

  it('supports CJK names', () => {
    const { state, ids } = withNodes(['營收', '毛利率']);
    const r = toStored('營收 * [毛利率]', indexModel(state), null);
    expect(r.ok && r.refIds).toEqual([ids['營收'], ids['毛利率']]);
  });
});
