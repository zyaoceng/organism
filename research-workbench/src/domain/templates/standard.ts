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
  /** Language of node names and notes. Formulas store node IDs, so names can be anything. */
  lang?: 'en' | 'zh-TW';
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
  const state = buildFromSpec(specs, standardPeriods(year));
  return opts.lang === 'zh-TW' ? localizeTemplate(state) : state;
}

const ZH_NAMES: Record<string, string> = {
  EPS: 'EPS',
  Revenue: '營收',
  'Business A': '業務 A',
  'Business B': '業務 B',
  'Business C': '業務 C',
  'YoY Growth': '年成長率',
  'Gross Margin': '毛利率',
  'Gross Profit': '毛利',
  'Operating Expenses': '營業費用',
  'Opex % of Revenue': '營業費用率',
  'Operating Income': '營業利益',
  'Non-Operating Items': '業外損益',
  'Pre-Tax Income': '稅前淨利',
  Tax: '所得稅',
  'Tax Rate': '稅率',
  'Net Income': '稅後淨利',
  'Diluted Shares': '稀釋後股數',
  'P/E': '本益比',
  'EPS Growth': 'EPS 成長率',
  ROIC: 'ROIC',
  NOPAT: '稅後營業利益',
  'Invested Capital': '投入資本',
  'Reinvestment ROI': '再投資報酬率',
  'Historical Valuation': '歷史估值',
  'Peer Comparison': '同業比較',
  'Re-Rating Thesis': '評價重估論點',
  'Target P/E': '目標本益比',
  'Target Price': '目標價',
};

const ZH_NOTES: Record<string, string> = {
  'Business segment. Enter reported (or estimated) revenue in actual years; forecasts grow by the YoY Growth driver below. Replace the formula with your own drivers (e.g. TAM × share × ASP) when useful.':
    '業務分類。實際年度填公司公布的營收；預估年度用下面的年成長率推算。需要時可以把公式換成自己的驅動因子（例如 TAM × 市占率 × 平均單價）。',
  'Forecast growth rate for this segment. Set Bear/Base/Bull in the inspector.': '這個業務的預估成長率。在右側面板設定空頭、基準、多頭。',
  'Diluted EPS. In actual years you may type the reported EPS; the formula result is shown as a check.': '稀釋後 EPS。實際年度可以直接填公布的 EPS，公式結果會一起顯示用來核對。',
  'Sum of the business segments below. Use your own segmentation when management reporting mixes businesses with different drivers. Type reported revenue in actual years to reconcile.':
    '下面各業務的加總。公司公布的分類如果混了驅動因子不同的業務，請用自己的分類。實際年度可填公布的營收來核對。',
  'Gross profit ÷ revenue. A key indicator of bargaining power.': '毛利 ÷ 營收，是看議價能力的重要指標。',
  'Investment income, FX, interest, one-offs. Positive = income.': '投資收益、匯兌、利息、一次性損益。正數代表收益。',
  'Effective tax rate = income tax ÷ pre-tax income.': '有效稅率 = 所得稅 ÷ 稅前淨利。',
  'Attributable to shareholders. Add minority interest as a child node if material.': '歸屬母公司股東。少數股權金額大時，可以加一個子節點。',
  'Weighted diluted share count, same scale as amounts so EPS = Net Income ÷ Diluted Shares. Add child nodes for SBC or convertible dilution if relevant.':
    '加權平均稀釋後股數，數量級和金額相同，這樣 EPS = 稅後淨利 ÷ 稀釋後股數。員工認股或可轉債稀釋可以加子節點。',
  'Evidence for the target multiple. The multiple itself is a judgment typed in Target P/E.': '支持目標倍數的依據。倍數本身是判斷，填在「目標本益比」。',
  'Operating income after tax. References the EPS branch: hierarchy is not calculation.': '稅後的營業利益。它引用 EPS 分支的數字：樹狀位置和計算關係是分開的。',
  'Equity + debt + lease liabilities − excess cash (state your definition here).': '股東權益 + 負債 + 租賃負債 − 多餘現金（請在這裡寫下你的定義）。',
  'Incremental NOPAT ÷ incremental invested capital.': '新增的稅後營業利益 ÷ 新增的投入資本。',
  'Historical P/E band lives in the Valuation page. Attach the source here.': '歷史本益比區間在「估值」頁，來源附在這裡。',
  'Peer table lives in the Valuation page. Attach sources here.': '同業比較表在「估值」頁，來源附在這裡。',
  'Why the market should pay a different multiple (business mix, growth duration, returns).': '市場為什麼應該給不同的倍數（業務組合、成長能持續多久、報酬率）。',
  'Typed judgment for Bear / Base / Bull. Write the rationale in the Valuation page.': '空頭、基準、多頭各自手動填入的判斷。理由寫在「估值」頁。',
  'EPS of the basis year × target P/E. Rolling the basis year is a formula change and is recorded in history.': '基準年度的 EPS × 目標本益比。換基準年度等於改公式，會記錄在歷史裡。',
};

function localizeTemplate(state: ModelState): ModelState {
  return {
    ...state,
    nodes: state.nodes.map((n) => ({ ...n, name: ZH_NAMES[n.name] ?? n.name, notes: ZH_NOTES[n.notes] ?? n.notes })),
  };
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
