import { toStored } from '../formula/refs';
import { makeNode } from '../model/ops';
import { indexModel } from '../model/tree';
import { emptyValuation, type ModelNode, type ModelState, type NodeRole, type Period, type TimeMode } from '../model/types';
import type { Scale, Unit } from '../units';

export interface NodeSpec {
  name: string;
  unit?: Unit | null;
  timeMode?: TimeMode;
  role?: NodeRole;
  /** Display-form formula, resolved against the finished tree (scoped to this node). */
  formula?: string;
  notes?: string;
  children?: NodeSpec[];
}

/** Build a state from a nested spec. Formulas are written with names and converted to stable IDs. */
export function buildFromSpec(specs: NodeSpec[], periods: Period[]): ModelState {
  const nodes: ModelNode[] = [];
  const pending: { id: string; formula: string }[] = [];
  const add = (spec: NodeSpec, parentId: string | null) => {
    const node = makeNode({
      name: spec.name,
      parentId,
      unit: spec.unit ?? null,
      timeMode: spec.timeMode ?? 'series',
      role: spec.role,
      notes: spec.notes ?? '',
    });
    nodes.push(node);
    if (spec.formula) pending.push({ id: node.id, formula: spec.formula });
    spec.children?.forEach((c) => add(c, node.id));
  };
  specs.forEach((s) => add(s, null));
  const state: ModelState = { schemaVersion: 1, periods, nodes, links: [], theses: [], valuation: emptyValuation() };
  const ix = indexModel(state);
  for (const p of pending) {
    const r = toStored(p.formula, ix, p.id);
    if (!r.ok) throw new Error(`Template formula for ${ix.byId.get(p.id)?.name}: ${r.error.message}`);
    ix.byId.get(p.id)!.formula = r.stored;
  }
  return state;
}

export interface StandardTemplateOptions {
  currency?: string;
  /** Scale for amounts and share counts: 1e8 (億) for TWD, 1e6 (million) for USD. */
  scale?: Scale;
  /** Current fiscal year; periods are Y-2 and Y-1 (A), Y, Y+1 and Y+2 (E). */
  year?: number;
}

export const STANDARD_TEMPLATE_ID = 'standard';
export const STANDARD_TEMPLATE_NAME = 'Standard Equity Research Template';

export function defaultScaleFor(currency: string): Scale {
  return currency === 'TWD' || currency === 'CNY' ? 1e8 : 1e6;
}

export function standardPeriods(year: number): Period[] {
  return [
    { id: `FY${year - 2}`, label: String(year - 2), status: 'A' },
    { id: `FY${year - 1}`, label: String(year - 1), status: 'A' },
    { id: `FY${year}`, label: String(year), status: 'E' },
    { id: `FY${year + 1}`, label: String(year + 1), status: 'E' },
    { id: `FY${year + 2}`, label: String(year + 2), status: 'E' },
  ];
}

export function standardTemplate(opts: StandardTemplateOptions = {}): ModelState {
  const currency = opts.currency ?? 'TWD';
  const scale = opts.scale ?? defaultScaleFor(currency);
  const year = opts.year ?? new Date().getFullYear();
  const money: Unit = { kind: 'currency', currency, scale };
  const pct: Unit = { kind: 'percent', scale: 1 };
  const perShare: Unit = { kind: 'per_share', currency, scale: 1 };
  const shares: Unit = { kind: 'shares', scale };
  const multiple: Unit = { kind: 'multiple', scale: 1 };
  const basis = `FY${year + 2}`;

  const segment = (name: string): NodeSpec => ({
    name,
    unit: money,
    formula: `PREV([${name}]) * (1 + [YoY Growth])`,
    notes: 'Business segment. Enter reported (or estimated) revenue in actual years; forecasts grow by the YoY Growth driver below. Replace the formula with your own drivers (e.g. TAM × share × ASP) when useful.',
    children: [{ name: 'YoY Growth', unit: pct, notes: 'Forecast growth rate for this segment. Set Bear/Base/Bull in the inspector.' }],
  });

  const specs: NodeSpec[] = [
    {
      name: 'EPS',
      unit: perShare,
      role: 'eps',
      formula: '[Net Income] / [Diluted Shares]',
      notes: 'Diluted EPS. In actual years you may type the reported EPS; the formula result is shown as a check.',
      children: [
        {
          name: 'Revenue',
          unit: money,
          role: 'revenue',
          formula: 'SUM(CHILDREN())',
          notes: 'Sum of the business segments below. Use your own segmentation when management reporting mixes businesses with different drivers. Type reported revenue in actual years to reconcile.',
          children: [segment('Business A'), segment('Business B'), segment('Business C')],
        },
        { name: 'Gross Margin', unit: pct, role: 'gross_margin', notes: 'Gross profit ÷ revenue. A key indicator of bargaining power.' },
        { name: 'Gross Profit', unit: money, formula: '[Revenue] * [Gross Margin]' },
        {
          name: 'Operating Expenses',
          unit: money,
          formula: '[Revenue] * [Opex % of Revenue]',
          children: [{ name: 'Opex % of Revenue', unit: pct }],
        },
        { name: 'Operating Income', unit: money, role: 'operating_income', formula: '[Gross Profit] - [Operating Expenses]' },
        { name: 'Non-Operating Items', unit: money, notes: 'Investment income, FX, interest, one-offs. Positive = income.' },
        { name: 'Pre-Tax Income', unit: money, formula: '[Operating Income] + [Non-Operating Items]' },
        {
          name: 'Tax',
          unit: money,
          formula: '[Pre-Tax Income] * [Tax Rate]',
          children: [{ name: 'Tax Rate', unit: pct, notes: 'Effective tax rate = income tax ÷ pre-tax income.' }],
        },
        { name: 'Net Income', unit: money, role: 'net_income', formula: '[Pre-Tax Income] - [Tax]', notes: 'Attributable to shareholders. Add minority interest as a child node if material.' },
        {
          name: 'Diluted Shares',
          unit: shares,
          role: 'diluted_shares',
          notes: 'Weighted diluted share count, same scale as amounts so EPS = Net Income ÷ Diluted Shares. Add child nodes for SBC or convertible dilution if relevant.',
        },
      ],
    },
    {
      name: 'P/E',
      notes: 'Evidence for the target multiple. The multiple itself is a judgment typed in Target P/E.',
      children: [
        { name: 'EPS Growth', unit: pct, role: 'eps_growth', formula: '[EPS] / PREV([EPS]) - 1' },
        {
          name: 'ROIC',
          unit: pct,
          role: 'roic',
          formula: '[NOPAT] / [Invested Capital]',
          children: [
            { name: 'NOPAT', unit: money, formula: '[Operating Income] * (1 - [Tax Rate])', notes: 'Operating income after tax. References the EPS branch: hierarchy is not calculation.' },
            { name: 'Invested Capital', unit: money, notes: 'Equity + debt + lease liabilities − excess cash (state your definition here).' },
          ],
        },
        {
          name: 'Reinvestment ROI',
          unit: pct,
          role: 'reinvestment_roi',
          formula: '([NOPAT] - PREV([NOPAT])) / ([Invested Capital] - PREV([Invested Capital]))',
          notes: 'Incremental NOPAT ÷ incremental invested capital.',
        },
        { name: 'Historical Valuation', notes: 'Historical P/E band lives in the Valuation page. Attach the source here.' },
        { name: 'Peer Comparison', notes: 'Peer table lives in the Valuation page. Attach sources here.' },
        { name: 'Re-Rating Thesis', role: 'rerating', notes: 'Why the market should pay a different multiple (business mix, growth duration, returns).' },
        {
          name: 'Target P/E',
          unit: multiple,
          timeMode: 'scalar',
          role: 'target_multiple',
          notes: 'Typed judgment for Bear / Base / Bull. Write the rationale in the Valuation page.',
        },
      ],
    },
    {
      name: 'Target Price',
      unit: perShare,
      timeMode: 'scalar',
      role: 'target_price',
      formula: `[EPS]@${basis} * [Target P/E]`,
      notes: `EPS of the basis year × target P/E. Rolling the basis year is a formula change and is recorded in history.`,
    },
  ];
  return buildFromSpec(specs, standardPeriods(year));
}

/** Strip values, overrides, links and theses: keep structure, units, formulas, roles and notes. */
export function structureOnly(state: ModelState): ModelState {
  return {
    ...state,
    nodes: state.nodes.map((n) => ({ ...n, values: {}, overrides: {}, cellStatus: {} })),
    links: [],
    theses: [],
    valuation: emptyValuation(),
  };
}
