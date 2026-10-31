import { describe, expect, it } from 'vitest';
import { addNode, addPeriod, addThesis, deleteNode, setFormula, setValue, updatePeriod, updateThesis, updateValuation } from '../model/ops';
import { parseState } from '../model/schema';
import { indexModel } from '../model/tree';
import { SCALAR_KEY, type ModelState } from '../model/types';
import { toStored } from '../formula/refs';
import { idByName, sampleModel } from '../testing/sample';
import { rebaseChanges } from './rebase';

const base = sampleModel(2026);
const gm = idByName(base, 'Gross Margin');
const pe = base.nodes.find((n) => n.role === 'target_multiple')!.id;
const val = (s: ModelState, id: string, key = 'FY2028', scenario: 'base' | 'bear' | 'bull' = 'base') =>
  (scenario === 'base' ? s.nodes.find((n) => n.id === id)?.values[key] : s.nodes.find((n) => n.id === id)?.overrides[scenario]?.[key]) ?? null;

describe('rebaseChanges', () => {
  it('merges edits of different cells', () => {
    const local = setValue(base, gm, 'FY2028', 'base', 0.3);
    const remote = setValue(base, pe, SCALAR_KEY, 'base', 30);
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toHaveLength(1);
    expect(val(r.state, gm)).toBe(0.3);
    expect(val(r.state, pe, SCALAR_KEY)).toBe(30);
  });

  it('applies the same value written on both sides', () => {
    const local = setValue(base, gm, 'FY2028', 'base', 0.3);
    const r = rebaseChanges(base, local, setValue(base, gm, 'FY2028', 'base', 0.3));
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toHaveLength(1);
  });

  it('refuses a cell both sides changed to different values', () => {
    const local = setValue(base, gm, 'FY2028', 'base', 0.3);
    const remote = setValue(base, gm, 'FY2028', 'base', 0.25);
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].text).toContain('另一邊也改了');
    expect(val(r.state, gm)).toBe(0.25);
    expect(rebaseChanges(base, local, remote, { lang: 'en' }).conflicts[0].text).toMatch(/Gross Margin 2028E.*also changed elsewhere/);
  });

  it('copies a node added locally, with its values, while the other side edits elsewhere', () => {
    const rev = idByName(base, 'Revenue');
    const added = addNode(base, { parentId: rev, name: 'New Segment', position: 1 });
    const local = setValue(setValue(added.state, added.id, 'FY2027', 'base', 50), added.id, 'FY2028', 'bull', 80);
    const remote = setValue(base, pe, SCALAR_KEY, 'base', 30);
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts).toEqual([]);
    const n = r.state.nodes.find((x) => x.id === added.id)!;
    expect(n.parentId).toBe(rev);
    expect(n.values.FY2027).toBe(50);
    expect(n.overrides.bull?.FY2028).toBe(80);
    const ix = indexModel(r.state);
    expect(ix.children.get(rev)!.map((x) => x.id).indexOf(added.id)).toBe(1);
    expect(val(r.state, pe, SCALAR_KEY)).toBe(30);
  });

  it('refuses to delete a node the other side edited', () => {
    const cid = idByName(base, 'Business C');
    const local = deleteNode(base, cid).state;
    const remote = setValue(base, cid, 'FY2025', 'base', 999);
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts.some((c) => c.change.type === 'node_removed')).toBe(true);
    expect(r.state.nodes.some((n) => n.id === cid)).toBe(true);
    expect(parseState(r.state).ok).toBe(true);
  });

  it('refuses an edit of a node the other side deleted', () => {
    const cid = idByName(base, 'Business C');
    const local = setValue(base, cid, 'FY2025', 'base', 999);
    const remote = deleteNode(base, cid).state;
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts).toHaveLength(1);
    expect(r.state.nodes.some((n) => n.id === cid)).toBe(false);
  });

  it('refuses a formula that refers to a node the other side deleted', () => {
    const cid = idByName(base, 'Business C');
    const nopat = idByName(base, 'NOPAT');
    const f = toStored('[Operating Income] * 0.8 + [Business C]', indexModel(base), nopat);
    if (!f.ok) throw new Error(f.error.message);
    const local = setFormula(base, nopat, f.stored);
    const remote = deleteNode(base, cid).state;
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts.map((c) => c.change.type)).toEqual(['formula_changed']);
    expect(r.state.nodes.find((n) => n.id === nopat)!.formula).toBe(base.nodes.find((n) => n.id === nopat)!.formula);
  });

  it('adds a period and its values', () => {
    const local = setValue(addPeriod(base, { id: 'FY2029', label: '2029', status: 'E' }), gm, 'FY2029', 'base', 0.24);
    const remote = setValue(base, pe, SCALAR_KEY, 'base', 30);
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts).toEqual([]);
    expect(r.state.periods.at(-1)!.id).toBe('FY2029');
    expect(val(r.state, gm, 'FY2029')).toBe(0.24);
  });

  it('merges a thesis status change with a statement change on the other side', () => {
    const t = addThesis(base, { statement: 'AI power ramps' });
    const b2 = t.state;
    const local = updateThesis(b2, t.id, { status: 'confirmed' });
    const remote = updateThesis(b2, t.id, { statement: 'AI power ramps in FY27' });
    const r = rebaseChanges(b2, local, remote);
    expect(r.conflicts).toEqual([]);
    expect(r.state.theses[0]).toMatchObject({ status: 'confirmed', statement: 'AI power ramps in FY27' });
  });

  it('merges a valuation rationale', () => {
    const local = updateValuation(base, { rationale: { ...base.valuation.rationale, base: 'Peers trade at 22x' } });
    const remote = updateValuation(base, { rationale: { ...base.valuation.rationale, bull: 'AI premium' } });
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts).toEqual([]);
    expect(r.state.valuation.rationale).toMatchObject({ base: 'Peers trade at 22x', bull: 'AI premium' });
    const clash = rebaseChanges(base, local, updateValuation(base, { rationale: { ...base.valuation.rationale, base: 'other' } }));
    expect(clash.conflicts).toHaveLength(1);
  });

  it('never returns an invalid state', () => {
    // local writes a Bull override on FY2026; the other side marked FY2026 actual meanwhile
    const local = setValue(base, gm, 'FY2026', 'bull', 0.3);
    const remote = updatePeriod(base, 'FY2026', { status: 'A' });
    expect(parseState(remote).ok).toBe(true);
    const r = rebaseChanges(base, local, remote);
    expect(r.conflicts).toHaveLength(1);
    expect(parseState(r.state).ok).toBe(true);
    expect(val(r.state, gm, 'FY2026', 'bull')).toBeNull();
  });

  it('returns the remote state unchanged when nothing changed locally', () => {
    const remote = setValue(base, gm, 'FY2028', 'base', 0.5);
    expect(rebaseChanges(base, base, remote).state).toBe(remote);
  });
});
