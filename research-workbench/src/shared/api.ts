/** DTOs exchanged between server and client. Dates: YYYY-MM-DD; timestamps: ISO 8601 UTC. */
import type { FrozenOutputs, Issue } from '../domain/calc/engine';
import type { ModelState, Period, ScenarioId } from '../domain/model/types';
import type { ModelChange } from '../domain/revision/diff';
import type { Impact, KeyOutputs } from '../domain/revision/impact';
import type { TradeMetrics } from '../domain/trade/metrics';
import type { Unit } from '../domain/units';
import type { Actor, AgentClient } from './actors';

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
  /** 'bar': the close of the daily bar on a backdated knowledge date; 'quote': the latest quote. Unset before v2. */
  basis?: 'quote' | 'bar';
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
  /** Actor that committed it (user, system, agent:<client>); null before v2. */
  createdBy: string | null;
  /** Who made the draft edits it contains, with change counts; null before v2. */
  contributors: ContributorDTO[] | null;
  /** Marked "wrong, exclude from calibration" (latest annotation decides). */
  excludedFromCalibration: boolean;
}

export interface ContributorDTO {
  /** Stored actor; null for edits made before v2. */
  actor: string | null;
  changes: number;
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
  /** Who gave the publication date: the user, or an AI (shown with a badge). Null without a date or before v2. */
  publishedAtSource: 'user' | 'agent-asserted' | null;
  archivedAt: string | null;
  updatedAt: string;
  createdBy: string | null;
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
  createdBy: string | null;
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
  createdBy: string | null;
  /** 'entry': recorded when it happened; 'import': copied from an old journal. Null before v2. */
  source: 'entry' | 'import' | null;
  /** jrnl:<hash> of the journal excerpt an imported trade came from. */
  externalRef: string | null;
  /** The (normalised) journal excerpt of an imported trade. */
  sourceText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDTO {
  id: string;
  projectId: string;
  body: string;
  createdBy: string | null;
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
  createdBy: string | null;
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
  /** Marked "wrong, exclude from calibration". */
  excluded: boolean;
}

export interface AuditEntryDTO {
  id: number;
  entity: string;
  entityId: string;
  action: string;
  at: string;
  /** null before v2. */
  actor: string | null;
  before: unknown;
  after: unknown;
}

// ---------------------------------------------------------------- AI connection (v2)

/** GET /api/session: sets the browser's session cookie; AI clients get their actor back. */
export interface SessionDTO {
  actor: Actor;
  dbGeneration: string;
}

export type DraftOpKind = 'save' | 'ops' | 'discard' | 'restore' | 'recover' | 'commit';

/** GET /api/projects/:id/draft/meta (polled by the browser every 10 s). */
export interface DraftMetaDTO {
  version: number;
  baseRevisionId: string;
  updatedAt: string;
  /** Changes when the whole database is replaced; the page reloads. */
  dbGeneration: string;
  headSeq: number;
  /** Latest audit id of the project, excluding draft and commit rows; a rise means records changed. */
  auditSeq: number;
  lastOp: { id: number; actor: string; kind: DraftOpKind; at: string; summary: string; changeCount: number } | null;
}

/** GET /api/projects/:id/draft/ops: the draft's write history (newest first). */
export interface DraftOpRowDTO {
  id: number;
  at: string;
  actor: string;
  kind: DraftOpKind;
  summary: string;
  changeCount: number;
  versionAfter: number;
  baseRevisionId: string;
  /** The state before this write is kept, so it can be recovered. */
  hasBefore: boolean;
}

/** GET /api/projects/:id/draft/pending: uncommitted changes and who made each. */
export interface DraftPendingDTO {
  version: number;
  changes: { text: string; actor: string | null }[];
  /** Change count per stored actor; edits made before v2 count under 'before-v2'. */
  counts: Record<string, number>;
}

export interface DraftOpCellDTO {
  period: string;
  scenario: ScenarioId;
  before: string;
  after: string;
  beforeRaw: number | null;
  afterRaw: number | null;
  note?: string;
}

export interface DraftOpResultDTO {
  index: number;
  op: string;
  node?: { id: string; path: string; unit: Unit | null };
  cells?: DraftOpCellDTO[];
  createdId?: string;
  /** describeChange (zh-TW) of what this op changed. */
  description: string[];
  warnings: string[];
}

export interface DraftIssueDTO {
  severity: Issue['severity'];
  code: string;
  message: string;
  nodeId: string;
  nodeName: string;
  periodKey?: string;
  /** Not present before these ops. */
  isNew: boolean;
}

/** POST /api/projects/:id/draft/ops */
export interface DraftOpsResponse {
  dryRun: boolean;
  /** Draft version after the write (dry run: the current version, to pass as expectedVersion). */
  version: number;
  baseRevisionId: string;
  previewHash?: string;
  draftOpId?: number;
  results: DraftOpResultDTO[];
  keyOutputs: KeyOutputsDiffDTO;
  issues: DraftIssueDTO[];
  warnings: string[];
  url: string;
}

export interface KeyOutputsDiffDTO {
  basisPeriodId: string | null;
  units: { eps: Unit | null; targetPrice: Unit | null; targetMultiple: Unit | null };
  before: KeyOutputs;
  after: KeyOutputs;
}

/** A change big enough that an AI must ask the user before committing it. */
export interface LargeMoveDTO {
  kind: 'eps' | 'target_price' | 'value';
  /** zh-TW description. */
  text: string;
  before: number | null;
  after: number | null;
  ratio: number | null;
}

/** POST /api/projects/:id/revisions/preview */
export interface CommitPreviewDTO {
  /** Pass to the commit; null when the commit is blocked. */
  previewId: string | null;
  expiresAt: string | null;
  projectId: string;
  draftVersion: number;
  baseRevisionId: string;
  asOfDate: string;
  kind: 'update' | 'checkpoint';
  today: string;
  changes: { text: string; actor: string | null }[];
  changeCount: number;
  keyOutputs: KeyOutputsDiffDTO;
  largeMoves: LargeMoveDTO[];
  needsConfirmation: boolean;
  /** Uncommitted changes made by the user; an AI may not commit them. */
  userChanges: string[];
  blocked: string | null;
  market: MarketContext | null;
  citedEvidence: { id: string; title: string; publishedAt: string | null }[];
}

export type AnnotationKind = 'excluded' | 'included' | 'note';

export interface RevisionAnnotationDTO {
  id: number;
  revisionId: string;
  projectId: string;
  kind: AnnotationKind;
  note: string;
  actor: string;
  at: string;
}

export type AiActionKind = 'draft_ops' | 'commit' | 'evidence' | 'trade' | 'trade_close' | 'project' | 'note' | 'summary' | 'other';

export interface AiActionDTO {
  at: string;
  /** MCP tool that made the request, if known. */
  tool: string | null;
  kind: AiActionKind;
  projectId: string | null;
  ref: string | null;
  summary: string;
}

/** Writes of one AI client, grouped until it is idle for 30 minutes, with an optional saved summary. */
export interface AiSessionDTO {
  id: string;
  client: AgentClient;
  startedAt: string;
  lastAt: string;
  projectIds: string[];
  actions: AiActionDTO[];
  summary: string | null;
  decisions: string | null;
  todo: string | null;
  summaryAt: string | null;
}

/** Connection status of one AI client (GET /api/diagnostics `clients`; AI clients only). */
export interface AiClientStatusDTO {
  client: AgentClient;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
  clientName: string | null;
  clientVersion: string | null;
  adapterVersion: string | null;
  lastWriteAt: string | null;
}

/** POST /api/ai/heartbeat */
export interface HeartbeatDTO {
  ok: true;
  actor: Actor;
  /** The server's local date: the latest allowed knowledge date. */
  today: string;
  dbGeneration: string;
  serverVersion: string;
}

/** GET /api/diagnostics */
export interface DiagnosticsDTO {
  version: { commit: string; installedAt?: string };
  node: string;
  platform: string;
  dataDir: string;
  dbFile: string;
  schemaVersion: number;
  backups: { lastBackupAt: string | null; count: number; dir: string; lastError: string | null };
  uptimeSec: number;
  clients: AiClientStatusDTO[];
}

/** GET /api/securities/lookup?ticker= : the same security across all companies. */
export interface SecurityMatchDTO {
  securityId: string;
  projectId: string;
  projectName: string;
  ticker: string;
  exchange: string;
  apiSymbol: string;
  currency: string;
  archived: boolean;
}

/** POST /api/projects/:id/trades by an AI client. */
export interface TradeRecordResponse {
  /** 'existing': this journal excerpt was imported before; that trade is returned unchanged. */
  status: 'created' | 'existing' | 'would-create';
  trade: TradeDTO | null;
  warnings: string[];
}

/** PATCH /api/trades/:id by an AI client (close_trade). */
export interface TradeCloseResponse {
  trade: TradeDTO;
  warnings: string[];
}

// ---------------------------------------------------------------- dashboard, trade log, refresh all prices

/** An open catalyst; windowEnd is the last day of its month or quarter for imprecise dates. */
export interface CatalystBrief {
  id: string;
  title: string;
  expectedDate: string;
  datePrecision: 'day' | 'month' | 'quarter';
  windowEnd: string;
}

/** One company on the dashboard (GET /api/dashboard). Targets come from the committed head, theses from the draft. */
export interface DashboardRowDTO {
  projectId: string;
  name: string;
  archivedAt: string | null;
  updatedAt: string;
  /** The primary security (`name` is the security's own name, e.g. "Lite-On Technology"). */
  security: { id: string; name: string; ticker: string; exchange: string; apiSymbol: string; currency: string; priceSource: string } | null;
  /** Cached quote of the primary security from its own price source; null when none was fetched. */
  price: {
    value: number;
    currency: string;
    asOf: string;
    fetchedAt: string;
    provider: string;
    synthetic: boolean;
    /** Fetched more than 24 h ago. */
    stale: boolean;
    marketDate: string;
    /** Calendar days from marketDate to today. */
    lagDays: number;
  } | null;
  target: {
    /** Currency of the target-price node's unit. */
    currency: string | null;
    bear: number | null;
    base: number | null;
    bull: number | null;
    /** Probability-weighted target (null when a weighted scenario has no target). */
    weighted: number | null;
    weightSum: number;
    upsideBase: number | null;
    upsideWeighted: number | null;
    /** Target and price are in different currencies: the upsides are null. */
    currencyMismatch: boolean;
  };
  /** Latest Research Update with a knowledge date; null when there is only the starting snapshot. */
  research: { revisionId: string; seq: number; kind: RevisionKind; title: string; asOfDate: string; committedAt: string } | null;
  draftDirty: boolean;
  draftUpdatedAt: string | null;
  positions: {
    open: number;
    /** Mean R of the open trades that have a stop and a quote. */
    avgR: number | null;
    rCount: number;
    /** Unrealised P&L per security currency (never added across currencies). */
    pnl: { currency: string; value: number }[];
    items: {
      tradeId: string;
      side: 'long' | 'short';
      entryDate: string;
      entryPrice: number;
      quantity: number;
      rMultiple: number | null;
      returnPct: number | null;
      markSource: TradeMetrics['markSource'];
    }[];
  };
  catalysts: { upcoming: number; undated: number; overdue: number; next: CatalystBrief | null; oldestOverdue: CatalystBrief | null };
  /** reviewDue: active theses whose review date has come; nextReviewBy: the earliest review date still ahead. */
  theses: { reviewDue: number; nextReviewBy: string | null };
  /** Latest AI activity on this company (ai_sessions or the audit log); summary is the session summary's first line. */
  ai: { client: AgentClient; at: string; summary: string | null } | null;
}

/** GET /api/dashboard */
export interface DashboardDTO {
  generatedAt: string;
  /** The server's local date that the flags were computed for. */
  today: string;
  rows: DashboardRowDTO[];
  refresh: RefreshRunDTO | null;
}

/** One trade in the cross-company trade log (GET /api/trades). */
export interface JournalTradeDTO extends TradeDTO {
  project: { id: string; name: string; archived: boolean };
  security: { ticker: string; exchange: string; name: string; currency: string; priceSource: string; synthetic: boolean };
  /** Marked with the exit, else the newer of the cached quote and the last cached bar. */
  metrics: TradeMetrics;
  /** Cached bars start on or before the entry date (otherwise MFE/MAE and the trailing stop are null). */
  barsCoverEntry: boolean;
  /** The research snapshot the trade was linked to. */
  research: { revisionId: string; seq: number; title: string; asOfDate: string | null; kind: RevisionKind } | null;
  reviews: {
    id: string;
    title: string;
    thesisVerdict: ReviewDTO['thesisVerdict'];
    executionVerdict: ReviewDTO['executionVerdict'];
    categories: string[];
    createdAt: string;
  }[];
}

/** GET /api/trades?status=&projectId=&from=&to= */
export interface TradesJournalDTO {
  generatedAt: string;
  trades: JournalTradeDTO[];
}

export type RefreshItemStatus = 'pending' | 'running' | 'ok' | 'failed' | 'rate_limited' | 'skipped';

export interface RefreshItemDTO {
  securityId: string;
  projectId: string;
  projectName: string;
  ticker: string;
  provider: string;
  status: RefreshItemStatus;
  /** Why it failed or was skipped (English; the client translates it). */
  message: string | null;
  /** Last cached bar after an ok refresh. */
  lastDate: string | null;
}

export interface RefreshProviderDTO {
  id: string;
  label: string;
  total: number;
  /** unavailable: not configured on this server (e.g. Fugle without a key). */
  state: 'running' | 'done' | 'rate_limited' | 'unreachable' | 'unavailable';
  retryAfterSec: number | null;
  message: string | null;
}

/** POST /api/market/refresh starts one (or returns the running one); GET returns the last one (null after a restart). */
export interface RefreshRunDTO {
  id: string;
  state: 'running' | 'done' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  ok: number;
  failed: number;
  rateLimited: number;
  skipped: number;
  /** Not finished yet (pending or running). */
  pending: number;
  providers: RefreshProviderDTO[];
  items: RefreshItemDTO[];
}
