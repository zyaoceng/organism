/** DTOs exchanged between server and client. Dates: YYYY-MM-DD; timestamps: ISO 8601 UTC. */
import type { FrozenOutputs } from '../domain/calc/engine';
import type { ModelState, Period, ScenarioId } from '../domain/model/types';
import type { ModelChange } from '../domain/revision/diff';
import type { Impact } from '../domain/revision/impact';

export interface ProjectDTO {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface SecurityDTO {
  id: string;
  projectId: string;
  name: string;
  ticker: string;
  exchange: string;
  apiSymbol: string;
  currency: string;
  priceSource: string;
  isPrimary: boolean;
}

export interface MarketContext {
  price: number;
  currency: string | null;
  asOf: string;
  provider: string;
  fetchedAt: string;
}

export type RevisionKind = 'initial' | 'update' | 'checkpoint' | 'restore';

export interface RevisionMeta {
  id: string;
  projectId: string;
  seq: number;
  parentId: string | null;
  kind: RevisionKind;
  title: string;
  reason: string;
  notes: string;
  asOfDate: string | null;
  committedAt: string;
  changes: ModelChange[];
  impact: Impact | null;
  market: MarketContext | null;
  engineVersion: string;
  citedEvidenceIds: string[];
}

export interface RevisionFull extends RevisionMeta {
  state: ModelState;
  computed: FrozenOutputs;
}

export interface DraftDTO {
  state: ModelState;
  version: number;
  baseRevisionId: string;
  updatedAt: string;
}

export interface ProjectSummaryDTO extends ProjectDTO {
  security: SecurityDTO | null;
  head: { id: string; seq: number; title: string; asOfDate: string | null; committedAt: string } | null;
  draftDirty: boolean;
  targetPrice: Record<ScenarioId, number | null> | null;
  lastPrice: MarketContext | null;
}

export interface ProjectBundleDTO {
  project: ProjectDTO;
  securities: SecurityDTO[];
  draft: DraftDTO;
  head: RevisionFull;
}

export interface AttachmentDTO {
  id: string;
  sha256: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  url: string;
}

export type EvidenceKind = 'url' | 'file' | 'image' | 'note';

export const SOURCE_TYPES = [
  { value: 'news', label: 'News article' },
  { value: 'earnings_call', label: 'Earnings call' },
  { value: 'filing', label: 'Filing / financial report' },
  { value: 'broker_report', label: 'Broker report' },
  { value: 'industry_report', label: 'Industry report' },
  { value: 'presentation', label: 'Conference / presentation' },
  { value: 'customer_announcement', label: 'Customer announcement' },
  { value: 'conversation', label: 'Conversation' },
  { value: 'expert', label: 'Expert report / call' },
  { value: 'dataset', label: 'Dataset' },
  { value: 'screenshot', label: 'Screenshot' },
  { value: 'other', label: 'Other' },
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number]['value'];

export interface EvidenceDTO {
  id: string;
  projectId: string;
  title: string;
  sourceName: string;
  sourceType: SourceType;
  url: string | null;
  publishedAt: string | null;
  addedAt: string;
  notes: string;
  verification: 'unverified' | 'verified' | 'disputed' | null;
  archivedAt: string | null;
  updatedAt: string;
  kind: EvidenceKind;
  attachments: AttachmentDTO[];
  /** Research Updates that cite or link this evidence. */
  revisionRefs: { revisionId: string; seq: number; kind: 'cited' | 'linked' }[];
}

export const CATALYST_TYPES = [
  { value: 'earnings', label: 'Earnings' },
  { value: 'investor_day', label: 'Investor day' },
  { value: 'conference', label: 'Conference (GTC, CES…)' },
  { value: 'product_launch', label: 'Product launch' },
  { value: 'customer_qualification', label: 'Customer qualification' },
  { value: 'factory_ramp', label: 'Factory ramp' },
  { value: 'regulatory', label: 'Regulatory decision' },
  { value: 'other', label: 'Other' },
] as const;

export interface CatalystDTO {
  id: string;
  projectId: string;
  title: string;
  type: string;
  expectedDate: string | null;
  datePrecision: 'day' | 'month' | 'quarter';
  actualDate: string | null;
  status: 'upcoming' | 'occurred' | 'delayed' | 'cancelled';
  expectedOutcome: string;
  actualOutcome: string;
  notes: string;
  nodeIds: string[];
  evidenceIds: string[];
  revisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradeDTO {
  id: string;
  projectId: string;
  securityId: string;
  side: 'long' | 'short';
  entryDate: string;
  entryPrice: number;
  quantity: number;
  entryReason: string;
  targetPriceAtEntry: number | null;
  stopAtEntry: number | null;
  atrAtEntry: number | null;
  atrMultiple: number | null;
  revisionId: string | null;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: string;
  fees: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDTO {
  id: string;
  projectId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export const ERROR_CATEGORIES = [
  { value: 'evidence_quality', label: 'Evidence quality' },
  { value: 'evidence_interpretation', label: 'Evidence interpretation' },
  { value: 'assumption_magnitude', label: 'Assumption magnitude' },
  { value: 'model_formula', label: 'Financial model / formula' },
  { value: 'timing_catalyst', label: 'Timing / catalyst' },
  { value: 'valuation_multiple', label: 'Valuation multiple' },
  { value: 'trading_execution', label: 'Trading execution' },
  { value: 'risk_management', label: 'Risk management' },
] as const;

export interface ReviewDTO {
  id: string;
  projectId: string;
  subjectType: 'project' | 'revision' | 'trade' | 'thesis' | 'catalyst';
  subjectId: string | null;
  title: string;
  outcome: string;
  categories: { category: string; notes: string }[];
  thesisVerdict: 'right' | 'wrong' | 'mixed' | 'unclear' | null;
  executionVerdict: 'good' | 'poor' | 'mixed' | 'n/a' | null;
  lessons: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDTO {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  createdAt: string | null;
}

/** One candidate from the symbol search (code or company name → the identifiers a provider needs). */
export interface SymbolMatchDTO {
  ticker: string;
  name: string;
  /** TWSE, TPEx, Emerging (興櫃), NASDAQ, NYSE, or the provider's exchange name. */
  exchange: string;
  board: 'listed' | 'otc' | 'emerging' | 'other';
  currency: string;
  /** Symbol to store on the security; Taiwan codes carry the Yahoo suffix (.TW / .TWO). */
  apiSymbol: string;
  /** Price source that is expected to cover this security. */
  suggestedProvider: string;
  industry?: string;
  /** Where the match came from: taiwan-directory or yahoo-search. */
  source: string;
}

export interface SymbolSearchDTO {
  query: string;
  results: SymbolMatchDTO[];
  /** Sources that failed; results from the others are still returned. */
  errors: string[];
}

export interface ProviderDTO {
  id: string;
  label: string;
  description: string;
  synthetic: boolean;
  fetches: boolean;
}

export interface QuoteResponse {
  quote: MarketContext | null;
  stale: boolean;
  error: string | null;
}

export interface BarsResponse {
  provider: string;
  bars: { date: string; open: number; high: number; low: number; close: number; volume: number; adjClose: number | null }[];
  lastFetchedAt: string | null;
  error: string | null;
}

export interface SeriesPoint {
  revisionId: string;
  seq: number;
  kind: RevisionKind;
  title: string;
  asOfDate: string | null;
  committedAt: string;
  periods: Period[];
  values: Record<string, Record<ScenarioId, Record<string, number | null>>>;
  est: Record<string, Record<string, boolean>>;
}

export interface AuditEntryDTO {
  id: number;
  entity: string;
  entityId: string;
  action: string;
  at: string;
  before: unknown;
  after: unknown;
}
