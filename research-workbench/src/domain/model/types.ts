import type { Unit } from '../units';

export type ScenarioId = 'bear' | 'base' | 'bull';
export type OverrideScenario = 'bear' | 'bull';

export const SCENARIOS: { id: ScenarioId; name: string }[] = [
  { id: 'bear', name: 'Bear' },
  { id: 'base', name: 'Base' },
  { id: 'bull', name: 'Bull' },
];
export const SCENARIO_IDS: ScenarioId[] = ['bear', 'base', 'bull'];

export const scenarioName = (id: ScenarioId) => SCENARIOS.find((s) => s.id === id)?.name ?? id;

/** Key used for the single value of a scalar node. */
export const SCALAR_KEY = '_';

export type PeriodStatus = 'A' | 'E';

export interface Period {
  /** Canonical, stable ID referenced by formulas: FY2028, FY2028Q1. */
  id: string;
  label: string;
  status: PeriodStatus;
  endDate?: string;
}

export type NodeRole =
  | 'eps'
  | 'revenue'
  | 'gross_margin'
  | 'operating_income'
  | 'net_income'
  | 'diluted_shares'
  | 'eps_growth'
  | 'roic'
  | 'reinvestment_roi'
  | 'target_multiple'
  | 'target_price'
  | 'rerating';

export const NODE_ROLES: { value: NodeRole; label: string }[] = [
  { value: 'eps', label: 'EPS' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'gross_margin', label: 'Gross margin' },
  { value: 'operating_income', label: 'Operating income' },
  { value: 'net_income', label: 'Net income' },
  { value: 'diluted_shares', label: 'Diluted shares' },
  { value: 'eps_growth', label: 'EPS growth' },
  { value: 'roic', label: 'ROIC' },
  { value: 'reinvestment_roi', label: 'Reinvestment ROI' },
  { value: 'target_multiple', label: 'Target multiple (P/E)' },
  { value: 'target_price', label: 'Target price' },
  { value: 'rerating', label: 'Re-rating thesis' },
];

export type TimeMode = 'series' | 'scalar';

export interface ModelNode {
  id: string;
  name: string;
  parentId: string | null;
  timeMode: TimeMode;
  unit: Unit | null;
  role?: NodeRole;
  /** Stored form: node references are `{n_xxxxxxxx}`, optionally followed by `@PERIOD`. */
  formula?: string;
  /** Base (shared) values keyed by period ID, or SCALAR_KEY for scalar nodes. */
  values: Record<string, number>;
  /** Bear/Bull overrides of estimate cells only. */
  overrides: Partial<Record<OverrideScenario, Record<string, number>>>;
  /** Per-cell override of the period's Actual/Estimate status. */
  cellStatus: Record<string, PeriodStatus>;
  notes: string;
}

export type LinkRelation = 'supports' | 'contradicts' | 'context' | 'triggered';

export const LINK_RELATIONS: { value: LinkRelation; label: string }[] = [
  { value: 'supports', label: 'Supports' },
  { value: 'contradicts', label: 'Contradicts' },
  { value: 'context', label: 'Context' },
  { value: 'triggered', label: 'Triggered change' },
];

export interface EvidenceLink {
  id: string;
  evidenceId: string;
  nodeId: string;
  relation: LinkRelation;
  /** Page, slide or timestamp inside the source: "p.13", "slide 7", "00:34:10". */
  locator?: string;
  note?: string;
}

export type ThesisStatus = 'active' | 'confirmed' | 'invalidated' | 'retired';

export interface Thesis {
  id: string;
  statement: string;
  invalidation: string;
  nodeIds: string[];
  status: ThesisStatus;
  reviewBy?: string;
}

export interface Peer {
  id: string;
  name: string;
  ticker?: string;
  pe?: number;
  epsGrowth?: number;
  roic?: number;
  grossMargin?: number;
  basis?: string;
  source?: string;
  asOf?: string;
  note?: string;
}

export interface HistoricalPE {
  low?: number;
  median?: number;
  high?: number;
  window?: string;
  source?: string;
  asOf?: string;
  note?: string;
}

export interface ValuationContext {
  peers: Peer[];
  historicalPE: HistoricalPE;
  rationale: Record<ScenarioId, string>;
  probabilities: Record<ScenarioId, number | null>;
}

export interface ModelState {
  schemaVersion: 1;
  periods: Period[];
  nodes: ModelNode[];
  links: EvidenceLink[];
  theses: Thesis[];
  valuation: ValuationContext;
}

export function emptyValuation(): ValuationContext {
  return {
    peers: [],
    historicalPE: {},
    rationale: { bear: '', base: '', bull: '' },
    probabilities: { bear: null, base: null, bull: null },
  };
}

export function emptyState(): ModelState {
  return { schemaVersion: 1, periods: [], nodes: [], links: [], theses: [], valuation: emptyValuation() };
}
