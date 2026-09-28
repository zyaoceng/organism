import { describe, expect, it } from 'vitest';
import { compute } from '../calc/engine';
import { toDisplay } from '../formula/refs';
import { idByName, sampleModel } from '../testing/sample';
import { standardTemplate } from '../templates/standard';
import {
  addLink,
  addNode,
  deleteNode,
  duplicateBranch,
  indent,
  moveNode,
  outdent,
  removePeriod,
  setCellStatus,
  setUnit,
  setValue,
  updatePeriod,
} from './ops';
import { parseState } from './schema';
import { childrenOf, indexModel, visibleRows } from './tree';

describe('tree operations', () => {
  it('adds children and siblings in order', () => {
    const s = standardTemplate({ year: 2026 });
    const rev = idByName(s, 'Revenue');
    const r = addNode(s, { parentId: rev, name: 'Legacy Business', position: 0 });
    const kids = childrenOf(indexModel(r.state), rev).map((n) => n.name);
    expect(kids[0]).toBe('Legacy Business');
    expect(kids).toHaveLength(4);
    // new child inherits the parent's unit
    expect(r.state.nodes.find((n) => n.id === r.id)!.unit?.kind).toBe('currency');
  });

  it('moves, indents and outdents without changing numbers', () => {
    const s = sampleModel(2026);
    const before = compute(s).cells.base[idByName(s, 'EPS')].FY2028.v;
    const tax = idByName(s, 'Tax Rate');
    let s2 = moveNode(s, tax, null, 0);
    expect(indexModel(s2).byId.get(tax)!.parentId).toBeNull();
    expect(compute(s2).cells.base[idByName(s2, 'EPS')].FY2028.v).toBe(before);
    s2 = indent(s2, idByName(s2, 'P/E'));
    expect(indexModel(s2).byId.get(idByName(s2, 'P/E'))!.parentId).toBe(idByName(s2, 'EPS'));
    s2 = outdent(s2, idByName(s2, 'P/E'));
    expect(indexModel(s2).byId.get(idByName(s2, 'P/E'))!.parentId).toBeNull();
    expect(() => moveNode(s2, idByName(s2, 'EPS'), idByName(s2, 'Revenue'), 0)).toThrow(/inside itself/);
  });

  it('duplicates a branch and remaps internal formula references', () => {
    const s = sampleModel(2026);
    const a = idByName(s, 'Business A');
    const d = duplicateBranch(s, a);
    const ix = indexModel(d.state);
    const copy = ix.byId.get(d.id)!;
    expect(copy.name).toBe('Business A (copy)');
    const copyGrowth = childrenOf(ix, d.id)[0];
    expect(copyGrowth.name).toBe('YoY Growth');
    expect(copy.formula).toContain(d.id);
    expect(copy.formula).toContain(copyGrowth.id);
    expect(copy.formula).not.toContain(a);
    expect(toDisplay(copy.formula, ix, d.id)).toBe('PREV([Business A (copy)]) * (1 + [YoY Growth])');
    // Revenue picks the copy up through CHILDREN()
    const r = compute(d.state);
    expect(r.cells.base[idByName(s, 'Revenue')].FY2028.v).toBeCloseTo(2769.69375 + 1728);
  });

  it('deleting a node reports formulas that now point to it', () => {
    const s = sampleModel(2026);
    const res = deleteNode(s, idByName(s, 'Tax Rate'));
    const names = res.brokenFormulaNodeIds.map((id) => indexModel(res.state).byId.get(id)!.name).sort();
    expect(names).toEqual(['NOPAT', 'Tax']);
    const c = compute(res.state).cells.base[idByName(s, 'Tax')].FY2027;
    expect(c.err?.code).toBe('DELETED_REF');
  });

  it('visible rows respect collapse state', () => {
    const s = standardTemplate({ year: 2026 });
    const all = visibleRows(s, new Set());
    const collapsed = visibleRows(s, new Set([idByName(s, 'EPS')]));
    expect(collapsed.length).toBeLessThan(all.length);
    expect(collapsed.map((r) => r.node.name)).toEqual(['EPS', 'P/E', 'EPS Growth', 'ROIC', 'NOPAT', 'Invested Capital', 'Reinvestment ROI', 'Historical Valuation', 'Peer Comparison', 'Re-Rating Thesis', 'Target P/E', 'Target Price']);
  });
});

describe('values, units and periods', () => {
  it('writes Bear/Bull edits on actual cells to the shared value', () => {
    const s = sampleModel(2026);
    const a = idByName(s, 'Business A');
    const s2 = setValue(s, a, 'FY2025', 'bear', 999);
    const n = s2.nodes.find((x) => x.id === a)!;
    expect(n.values.FY2025).toBe(999);
    expect(n.overrides.bear?.FY2025).toBeUndefined();
  });

  it('converts values when the scale changes, but only where no formula depends on it', () => {
    let s = sampleModel(2026);
    const lone = addNode(s, { parentId: null, name: 'Backlog', unit: { kind: 'currency', currency: 'TWD', scale: 1e8 } });
    s = setValue(lone.state, lone.id, 'FY2025', 'base', 12);
    const s2 = setUnit(s, lone.id, { kind: 'currency', currency: 'TWD', scale: 1e6 });
    expect(s2.nodes.find((x) => x.id === lone.id)!.values.FY2025).toBeCloseTo(1200);
    // read by Revenue's formula, and has its own formula: converting would corrupt results
    const a = idByName(s, 'Business A');
    expect(() => setUnit(s, a, { kind: 'currency', currency: 'TWD', scale: 1e6 })).toThrow(/formulas do not convert scales/);
    expect(() => setUnit(s, idByName(s, 'Non-Operating Items'), { kind: 'currency', currency: 'TWD', scale: 1e6 })).toThrow(/Pre-Tax Income/);
    // relabelling without conversion is allowed (fixing a wrongly declared unit)
    const s3 = setUnit(s, a, { kind: 'currency', currency: 'TWD', scale: 1e6 }, false);
    expect(s3.nodes.find((x) => x.id === a)!.values.FY2025).toBe(1000);
  });

  it('marking a period Actual drops scenario overrides for it', () => {
    const s = sampleModel(2026);
    const g = idByName(s, 'YoY Growth', 'Business A');
    expect(s.nodes.find((n) => n.id === g)!.overrides.bear?.FY2026).toBe(0.1);
    const s2 = updatePeriod(s, 'FY2026', { status: 'A' });
    expect(s2.nodes.find((n) => n.id === g)!.overrides.bear?.FY2026).toBeUndefined();
    expect(s2.nodes.find((n) => n.id === g)!.overrides.bear?.FY2027).toBe(0.05);
  });

  it('a custom segment can be an estimate inside an actual year', () => {
    const s = sampleModel(2026);
    const a = idByName(s, 'Business A');
    const s2 = setCellStatus(s, a, 'FY2025', 'E');
    const r = compute(s2);
    expect(r.cells.base[a].FY2025.est).toBe(true);
    expect(r.cells.base[idByName(s, 'Revenue')].FY2025.est).toBe(true);
  });

  it('refuses to remove a period pinned by a formula', () => {
    const s = sampleModel(2026);
    expect(() => removePeriod(s, 'FY2028')).toThrow(/Target Price/);
    const s2 = removePeriod(s, 'FY2024');
    expect(s2.periods.map((p) => p.id)).not.toContain('FY2024');
    expect(parseState(s2).ok).toBe(true);
  });

  it('evidence links are unique per node and evidence', () => {
    const s = sampleModel(2026);
    const node = idByName(s, 'Gross Margin');
    const a = addLink(s, { evidenceId: 'ev_1', nodeId: node, relation: 'supports' });
    const b = addLink(a.state, { evidenceId: 'ev_1', nodeId: node, relation: 'contradicts', locator: 'p.3' });
    expect(b.state.links).toHaveLength(1);
    expect(b.state.links[0].relation).toBe('contradicts');
    expect(b.state.links[0].locator).toBe('p.3');
  });
});

describe('schema', () => {
  it('accepts the template and the sample', () => {
    expect(parseState(standardTemplate({ year: 2026 })).ok).toBe(true);
    expect(parseState(sampleModel(2026)).ok).toBe(true);
  });

  it('rejects broken states', () => {
    const s = sampleModel(2026);
    const bad = { ...s, nodes: s.nodes.map((n, i) => (i === 1 ? { ...n, parentId: 'n_missing' } : n)) };
    const r = parseState(bad);
    expect(r.ok).toBe(false);
    const bad2 = JSON.parse(JSON.stringify(s));
    bad2.nodes[0].values.FY2026 = 'abc';
    expect(parseState(bad2).ok).toBe(false);
    const bad3 = JSON.parse(JSON.stringify(s));
    bad3.nodes.find((n: { name: string }) => n.name === 'Business A').overrides = { bear: { FY2025: 1 } };
    const r3 = parseState(bad3);
    expect(!r3.ok && r3.errors.join()).toMatch(/override on actual period/);
  });
});
