/**
 * Notes for the Obsidian vault, rendered by the server from plain data. Used only by the server
 * (the plugin never imports this file). Output depends on nothing but the inputs: no clock, no live
 * quote. Today's date, local calendar dates and actor/client labels come in through NoteContext,
 * so this module imports neither src/server nor src/shared.
 *
 * Text the user typed in the workbench (reasons, notes, summaries) is always quoted (`> `) or
 * flattened to one line, and `<!--` / `-->` are escaped, so it can never close the generated
 * block, open a code fence or a heading at the top level, or start a `## 反思` section.
 */
import type { FrozenOutputs } from '../calc/engine';
import { findByRole } from '../model/tree';
import { SCENARIO_IDS, type ModelState, type ScenarioId } from '../model/types';
import { describeChange } from '../revision/describe';
import type { ModelChange } from '../revision/diff';
import { basisPeriodId } from '../revision/impact';
import { tradeMetrics } from '../trade/metrics';
import { frozenTargets, upside, type ScenarioValues } from '../valuation/targets';
import { INDEX_PATHS, aiSessionNotePath, companyNotePath, researchUpdateNotePath, tradeNotePath } from './filename';
import { linkToken } from './links';
import { reflectionTemplate } from './reflection';
import type { FmValue, IndexId, RenderedNote } from './types';

// ---------------------------------------------------------------- inputs

export interface NoteContext {
  /** Base URL of the workbench, e.g. http://127.0.0.1:4310 (no trailing slash needed). */
  publicUrl: string;
  /** Local calendar date (YYYY-MM-DD) of an ISO timestamp; the server passes `iso => localToday(new Date(iso))`. */
  localDate: (iso: string) => string;
  /** Display name of a stored actor ('user', 'system', 'agent:<client>'); the server passes actorLabel(a, 'zh-TW'). */
  actorLabel: (actor: string | null) => string;
  /** Display name of a bare AI client id ('claude-desktop'); the server passes CLIENT_LABEL['zh-TW'][c]. */
  clientLabel: (client: string) => string;
}

/** A company as other notes link to it. `ticker` is the primary security's ('' without one). */
export interface CompanyRef {
  id: string;
  ticker: string;
  name: string;
}

/** EPS at the basis period and target price per scenario, read from frozen outputs only. */
export interface Headline {
  basis: string | null;
  basisLabel: string | null;
  eps: ScenarioValues;
  targetPrice: ScenarioValues;
}

/** The fields of RevisionMeta the notes use, plus its frozen headline. */
export interface RevisionIn {
  id: string;
  seq: number;
  kind: string;
  title: string;
  reason: string;
  notes: string;
  asOfDate: string | null;
  committedAt: string;
  createdBy: string | null;
  excludedFromCalibration: boolean;
  /** frozenHeadline(state, computed) of this revision. */
  headline: Headline;
}

/** The price frozen with a revision (revisions.market_json). */
export interface MarketIn {
  price: number;
  currency: string | null;
  asOf: string;
}

/** The fields of TradeDTO the notes use (a TradeDTO fits). */
export interface TradeIn {
  id: string;
  projectId: string;
  side: 'long' | 'short';
  entryDate: string;
  entryPrice: number;
  quantity: number;
  entryReason: string;
  targetPriceAtEntry: number | null;
  stopAtEntry: number | null;
  atrMultiple: number | null;
  revisionId: string | null;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: string;
  fees: number;
  notes: string;
  createdBy: string | null;
  source: 'entry' | 'import' | null;
  sourceText: string | null;
}

/** The fields of ReviewDTO the notes use. */
export interface ReviewIn {
  id: string;
  subjectType: string;
  subjectId: string | null;
  title: string;
  thesisVerdict: string | null;
  executionVerdict: string | null;
  lessons: string;
  createdAt: string;
}

/** The fields of CatalystDTO the notes use. */
export interface CatalystIn {
  id: string;
  title: string;
  type: string;
  expectedDate: string | null;
  datePrecision: 'day' | 'month' | 'quarter';
  status: string;
  expectedOutcome: string;
}

/** The fields of AiSessionDTO the notes use. */
export interface AiSessionIn {
  id: string;
  client: string;
  startedAt: string;
  lastAt: string;
  projectIds: string[];
  actions: { at: string; kind: string; summary: string }[];
  summary: string | null;
  decisions: string | null;
  todo: string | null;
}

export interface EvidenceIn {
  id: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
}

export interface CompanyNoteInput {
  company: CompanyRef & { archived: boolean };
  security: { ticker: string; exchange: string; currency: string } | null;
  /** All of the project's revisions, any order; the highest seq is the head. */
  revisions: RevisionIn[];
  /** Price frozen with the head revision. */
  headMarket: MarketIn | null;
  /** targetPriceCurrency(head state): the currency of the target-price node, if it declares one. */
  targetCurrency: string | null;
  trades: TradeIn[];
  /** Any status; only upcoming and delayed ones are listed. */
  catalysts: CatalystIn[];
  /** Sessions that touched this company; the newest 5 are listed. */
  aiSessions: AiSessionIn[];
}

export interface ResearchUpdateNoteInput {
  company: CompanyRef;
  revision: RevisionIn & { changes: ModelChange[]; citedEvidenceIds: string[] };
  /** Frozen headline of the parent revision; null for the first one. */
  before: Headline | null;
  /** Periods of the revision's state, for change descriptions. */
  periods: { id: string; label: string }[];
  /** Evidence the changes link to or the revision cites (titles for the descriptions). */
  evidence: EvidenceIn[];
}

export interface TradeNoteInput {
  company: CompanyRef;
  /** The live trade, or the trade as it was before deletion (tombstone). */
  trade: TradeIn;
  /** The Research Update the trade was entered on. */
  revision: { id: string; seq: number; asOfDate: string | null; title: string } | null;
  /** Reviews of the project; those about this trade are listed. */
  reviews: ReviewIn[];
  /** Set for a tombstone. */
  deletedAt: string | null;
}

export interface AiSessionNoteInput {
  session: AiSessionIn;
  /** The companies in session.projectIds that still exist. */
  companies: CompanyRef[];
}

export interface CompanyIndexRow {
  company: CompanyRef;
  tpBase: number | null;
  /** Knowledge date of the head revision (or its commit date). */
  lastUpdate: string | null;
  openTrades: number;
}

export type IndexNoteInput =
  | { id: 'index-companies'; companies: CompanyIndexRow[] }
  | { id: 'index-trades'; trades: { trade: TradeIn; company: CompanyRef }[] }
  | { id: 'index-ai'; sessions: { session: AiSessionIn; companies: CompanyRef[] }[] };

// ---------------------------------------------------------------- frozen values

const finite = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** keyOutputs (revision/impact.ts) on frozen values: EPS at the basis period and the frozen targets. */
export function frozenHeadline(state: ModelState, frozen: FrozenOutputs): Headline {
  const basis = basisPeriodId(state);
  const epsNode = findByRole(state, 'eps');
  const eps: ScenarioValues = { bear: null, base: null, bull: null };
  for (const s of SCENARIO_IDS) eps[s] = basis && epsNode ? finite(frozen.values[s]?.[epsNode.id]?.[basis]) : null;
  const basisLabel = basis ? state.periods.find((p) => p.id === basis)?.label ?? basis : null;
  return { basis, basisLabel, eps, targetPrice: frozenTargets(state, frozen, basis) };
}

// ---------------------------------------------------------------- formatting

const MAX_QUOTE_LINES = 200;
const escComments = (s: string) => s.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
const toLines = (s: string) => s.replace(/\r\n?/g, '\n').split('\n');

/** User text as a blockquote: every line prefixed, comments escaped, `> —` when empty, cut after 200 lines. */
export function quote(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
  if (!t.trim()) return '> —';
  const lines = toLines(escComments(t));
  const shown = lines.slice(0, MAX_QUOTE_LINES).map((l) => (l.trim() ? `> ${l.trimEnd()}` : '>'));
  if (lines.length > MAX_QUOTE_LINES) shown.push('> …');
  return shown.join('\n');
}

/** User text on one line (lists, titles, aliases). */
export const inline = (s: string | null | undefined) => escComments((s ?? '').replace(/\s+/g, ' ').trim());

/** A table cell: one line, comments escaped, `|` escaped. */
export const cell = (s: string | null | undefined) => inline(s).replace(/\|/g, '\\|');

export function num(v: number | null | undefined, d = 4): string {
  const x = finite(v);
  return x === null ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: d });
}

/** A fraction as a signed percentage with one decimal: 0.05 → +5.0%. */
export function pct(v: number | null | undefined): string {
  const x = finite(v);
  if (x === null) return '—';
  const r = Math.round(x * 1000) / 10 || 0;
  return `${r >= 0 ? '+' : ''}${r.toFixed(1)}%`;
}

const round = (v: number | null | undefined, d: number): number | null => {
  const x = finite(v);
  return x === null ? null : Math.round(x * 10 ** d) / 10 ** d || 0;
};

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const fmDate = (s: string | null): FmValue => (s ? { date: s } : null);

const SCENARIO_LABEL: Record<ScenarioId, string> = { bear: '空頭', base: '基準', bull: '多頭' };
const SIDE_LABEL = { long: '做多', short: '做空' } as const;
const REVISION_KIND_LABEL: Record<string, string> = { initial: '初始', update: '更新', checkpoint: '檢查點', restore: '還原' };
const CATALYST_TYPE_LABEL: Record<string, string> = {
  earnings: '財報',
  investor_day: '投資人日',
  conference: '大型展會',
  product_launch: '新產品發表',
  customer_qualification: '客戶認證',
  factory_ramp: '工廠量產爬坡',
  regulatory: '監管決定',
  other: '其他',
};
const VERDICT_LABEL: Record<string, string> = {
  right: '正確',
  wrong: '錯誤',
  mixed: '好壞參半',
  unclear: '不明確',
  good: '良好',
  poor: '不佳',
  'n/a': '不適用',
};

const webUrl = (ctx: NoteContext, path: string) => `${ctx.publicUrl.replace(/\/+$/, '')}/#${path}`;
const openLink = (url: string) => `[在研究工作台開啟](<${url}>)`;

const companyAlias = (c: CompanyRef) => inline([c.ticker, c.name].filter((x) => x.trim()).join(' ')) || '未命名';
const companyLink = (c: CompanyRef, inTable = false) => linkToken(c.id, companyAlias(c), inTable);
const companyFm = (c: CompanyRef): FmValue => ({ link: c.id, alias: companyAlias(c) });

const revisionAlias = (r: { seq: number; asOfDate: string | null; title: string }) => inline(`#${r.seq} ${r.asOfDate ?? '無日期'} ${r.title}`);
const tradeAlias = (t: TradeIn) => `${t.entryDate} ${SIDE_LABEL[t.side]} ${num(t.quantity)} 股 @ ${num(t.entryPrice)}`;
const sessionAlias = (s: AiSessionIn, ctx: NoteContext) => inline(`${ctx.localDate(s.startedAt)} ${ctx.clientLabel(s.client)}`);

const isOpen = (t: TradeIn) => !t.exitDate || t.exitPrice === null;
/** Return, R and holding days of a closed trade (no bars or quote needed); null while open. */
const closedMetrics = (t: TradeIn) => (isOpen(t) ? null : tradeMetrics(t, []));

const sourceLabel = (t: TradeIn, ctx: NoteContext) =>
  t.source === 'import' ? '匯入舊日誌' : t.createdBy?.startsWith('agent:') ? `AI（${ctx.actorLabel(t.createdBy)}）` : '手動';

const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;
const byTradeDesc = (a: TradeIn, b: TradeIn) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const bySessionDesc = (a: AiSessionIn, b: AiSessionIn) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.id < b.id ? -1 : 1);

const more = (n: number, unit = '筆') => (n > 0 ? [`- …另有 ${n} ${unit}`] : []);
const change = (before: number | null | undefined, after: number | null | undefined) =>
  before === undefined ? num(after) : before === after ? num(after) : `${num(before)} → ${num(after)}`;

function catalystWhen(c: CatalystIn): string {
  if (!c.expectedDate) return '日期未定';
  if (c.datePrecision === 'month') return c.expectedDate.slice(0, 7);
  if (c.datePrecision === 'quarter') return `${c.expectedDate.slice(0, 4)} Q${Math.ceil(Number(c.expectedDate.slice(5, 7)) / 3)}`;
  return c.expectedDate;
}

const firstLine = (s: string | null) => (s ?? '').replace(/\r\n?/g, '\n').split('\n').find((l) => l.trim()) ?? '';

/** Lines joined with blank lines between paragraphs, so a quote never swallows the next line. */
const blocks = (...parts: (string | string[] | null | false)[]) =>
  parts
    .filter((p): p is string | string[] => !!p && (typeof p === 'string' || p.length > 0))
    .map((p) => (typeof p === 'string' ? p : p.join('\n')))
    .join('\n\n');

// ---------------------------------------------------------------- company

const MAX_COMPANY_UPDATES = 50;
const MAX_COMPANY_TRADES = 100;
const MAX_COMPANY_SESSIONS = 5;

export function renderCompanyNote(i: CompanyNoteInput, ctx: NoteContext): RenderedNote {
  const c = i.company;
  const revs = [...i.revisions].sort(bySeq);
  const head = revs.at(-1) ?? null;
  const tp = head?.headline.targetPrice ?? { bear: null, base: null, bull: null };
  const price = finite(i.headMarket?.price);
  const priceCurrency = i.headMarket?.currency ?? i.security?.currency ?? null;
  const mismatch = !!i.targetCurrency && !!priceCurrency && i.targetCurrency.toUpperCase() !== priceCurrency.toUpperCase();
  const up = mismatch ? null : upside(tp.base, price);
  const lastUpdate = head ? head.asOfDate ?? ctx.localDate(head.committedAt) : null;
  const priceDate = i.headMarket ? (isDate(i.headMarket.asOf.slice(0, 10)) ? i.headMarket.asOf.slice(0, 10) : ctx.localDate(i.headMarket.asOf)) : null;
  const openTrades = i.trades.filter(isOpen).length;
  const url = webUrl(ctx, `/p/${encodeURIComponent(c.id)}/model`);

  const frontmatter: [string, FmValue][] = [
    ['wb_id', c.id],
    ['wb_type', 'company'],
    ['wb_name', c.name],
    ['wb_ticker', i.security?.ticker ?? c.ticker ?? ''],
    ['wb_exchange', i.security?.exchange ?? null],
    ['wb_currency', i.security?.currency ?? null],
    ['wb_tp_bear', tp.bear],
    ['wb_tp_base', tp.base],
    ['wb_tp_bull', tp.bull],
    ['wb_last_update', fmDate(lastUpdate)],
    ['wb_last_update_seq', head?.seq ?? null],
    ['wb_price_at_update', price],
    ['wb_price_at_update_date', fmDate(priceDate)],
    ['wb_upside_base_at_update', round(up, 4)],
    ['wb_open_trades', openTrades],
    ['wb_archived', c.archived],
    ['wb_url', url],
  ];

  const sec = i.security;
  const summary = [
    '| 項目 | 內容 |',
    '|---|---|',
    `| 代號 | ${sec ? `${cell(sec.ticker) || '—'}（${cell(sec.exchange) || '—'}，${cell(sec.currency) || '—'}）` : '—'} |`,
    `| 目標價（空頭 / 基準 / 多頭） | ${num(tp.bear)} / ${num(tp.base)} / ${num(tp.bull)} |`,
    `| 最新研究更新 | ${head ? linkToken(head.id, revisionAlias(head), true) : '無'} |`,
    `| 研究更新時股價 | ${price === null ? '—' : `${num(price)}${priceDate ? `（${priceDate}）` : ''}`} |`,
    `| 基準上檔空間（研究更新時） | ${mismatch ? '—（目標價與股價幣別不同）' : pct(up)} |`,
  ];

  const newest = [...revs].reverse();
  const prevOf = new Map(revs.map((r, k) => [r.id, k > 0 ? revs[k - 1] : null]));
  const updates = newest.slice(0, MAX_COMPANY_UPDATES).map((r) => {
    const p = prevOf.get(r.id) ?? null;
    const h = r.headline;
    const parts = [
      linkToken(r.id, revisionAlias(r)),
      `基準 EPS${h.basisLabel ? `（${inline(h.basisLabel)}）` : ''} ${change(p ? p.headline.eps.base : undefined, h.eps.base)}`,
      `基準目標價 ${change(p ? p.headline.targetPrice.base : undefined, h.targetPrice.base)}`,
    ];
    if (r.excludedFromCalibration) parts.push('已標記錯誤');
    return `- ${parts.join(' · ')}`;
  });

  const trades = [...i.trades].sort(byTradeDesc);
  const tradeLines = trades.slice(0, MAX_COMPANY_TRADES).map((t) => {
    const m = closedMetrics(t);
    return `- ${linkToken(t.id, tradeAlias(t))} · ${m ? `已出場 ${pct(m.returnPct)}` : '持有中'}`;
  });

  const cats = i.catalysts
    .filter((x) => x.status === 'upcoming' || x.status === 'delayed')
    .sort((a, b) => {
      const da = a.expectedDate ?? '9999';
      const db = b.expectedDate ?? '9999';
      return da < db ? -1 : da > db ? 1 : a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1;
    })
    .map((x) => {
      const type = CATALYST_TYPE_LABEL[x.type] ?? inline(x.type);
      const outcome = inline(x.expectedOutcome);
      return `- ${catalystWhen(x)} · ${type} · ${inline(x.title)}${x.status === 'delayed' ? '（延後）' : ''}${outcome ? ` — 預期：${outcome}` : ''}`;
    });

  const sessions = [...i.aiSessions]
    .sort(bySessionDesc)
    .slice(0, MAX_COMPANY_SESSIONS)
    .map((s) => {
      const line = inline(firstLine(s.summary));
      return `- ${linkToken(s.id, sessionAlias(s, ctx))}${line ? ` · ${line}` : ''}`;
    });

  const block = blocks(
    `> [!info] 公司 · ${companyAlias(c)}${c.archived ? ' · 已封存' : ''} · ${openLink(url)}`,
    summary,
    '## 研究更新',
    updates.length ? [...updates, ...more(newest.length - MAX_COMPANY_UPDATES)] : '- 無',
    '## 交易',
    tradeLines.length ? [...tradeLines, ...more(trades.length - MAX_COMPANY_TRADES)] : '- 無',
    '## 即將到來的催化劑',
    cats.length ? cats : '- 無',
    '## AI 對話紀錄',
    sessions.length ? sessions : '- 無',
  );

  return {
    wbId: c.id,
    kind: 'company',
    deleted: false,
    path: companyNotePath({ ticker: i.security?.ticker ?? c.ticker, name: c.name }),
    frontmatter,
    block,
    body: reflectionTemplate(),
  };
}

// ---------------------------------------------------------------- research update

const MAX_CHANGES = 100;

const safeUrl = (u: string | null) => (u && /^https?:\/\/[^\s<>]+$/i.test(u) ? u : null);
const linkText = (s: string) => inline(s).replace(/([[\]])/g, '\\$1');

export function renderResearchUpdateNote(i: ResearchUpdateNoteInput, ctx: NoteContext): RenderedNote {
  const r = i.revision;
  const c = i.company;
  const url = webUrl(ctx, `/p/${encodeURIComponent(c.id)}/history/${encodeURIComponent(r.id)}`);
  const committed = ctx.localDate(r.committedAt);
  const b = i.before;
  const a = r.headline;

  const frontmatter: [string, FmValue][] = [
    ['wb_id', r.id],
    ['wb_type', 'research_update'],
    ['wb_company', companyFm(c)],
    ['wb_ticker', c.ticker],
    ['wb_seq', r.seq],
    ['wb_kind', r.kind],
    ['wb_title', r.title],
    ['wb_as_of_date', fmDate(r.asOfDate)],
    ['wb_committed_at', r.committedAt],
    ['wb_eps_period', a.basisLabel],
    ['wb_eps_base_before', b?.eps.base ?? null],
    ['wb_eps_base_after', a.eps.base],
    ['wb_tp_base_before', b?.targetPrice.base ?? null],
    ['wb_tp_base_after', a.targetPrice.base],
    ['wb_created_by', r.createdBy],
    ['wb_flagged_error', r.excludedFromCalibration],
    ['wb_url', url],
  ];

  const periodLabel = new Map(i.periods.map((p) => [p.id, p.label]));
  const evidence = new Map(i.evidence.map((e) => [e.id, e]));
  const changes = r.changes.slice(0, MAX_CHANGES).map(
    (ch) =>
      `- ${inline(
        describeChange(ch, {
          lang: 'zh-TW',
          periodLabel: (k) => periodLabel.get(k) ?? k,
          evidenceTitle: (id) => evidence.get(id)?.title ?? '證據',
        }),
      )}`,
  );

  const impact = [
    `| 情境 | EPS 前 | EPS 後 | 目標價 前 | 目標價 後 |`,
    '|---|---|---|---|---|',
    ...SCENARIO_IDS.map(
      (s) => `| ${SCENARIO_LABEL[s]} | ${b ? num(b.eps[s]) : '—'} | ${num(a.eps[s])} | ${b ? num(b.targetPrice[s]) : '—'} | ${num(a.targetPrice[s])} |`,
    ),
  ];

  const cited = r.citedEvidenceIds.map((id) => {
    const e = evidence.get(id);
    if (!e) return '- （證據已刪除）';
    const u = safeUrl(e.url);
    const title = linkText(e.title) || '未命名';
    return `- ${u ? `[${title}](<${u}>)` : title}${e.publishedAt ? `（發布 ${e.publishedAt.slice(0, 10)}）` : ''}`;
  });

  const head = [
    `研究更新 #${r.seq}`,
    REVISION_KIND_LABEL[r.kind] ?? inline(r.kind),
    `知情日期 ${r.asOfDate ?? '無'}`,
    `提交 ${committed}`,
    companyLink(c),
    openLink(url),
  ];
  const block = blocks(
    `> [!info] ${head.join(' · ')}`,
    r.excludedFromCalibration ? '> [!warning] 這次研究更新已標記為錯誤，不列入校準。' : null,
    `**${inline(r.title) || '（無標題）'}**`,
    '**理由**',
    quote(r.reason),
    r.notes.trim() ? '**備註**' : null,
    r.notes.trim() ? quote(r.notes) : null,
    '**變動**',
    changes.length ? [...changes, ...more(r.changes.length - MAX_CHANGES, '項')] : '- 無',
    `**影響**（${a.basisLabel ? `${inline(a.basisLabel)} ` : ''}EPS 與目標價，凍結值）`,
    impact,
    '**引用證據**',
    cited.length ? cited : '- 無',
  );

  return {
    wbId: r.id,
    kind: 'research_update',
    deleted: false,
    path: researchUpdateNotePath({ ticker: c.ticker, asOfDate: r.asOfDate, seq: r.seq, title: r.title }),
    frontmatter,
    block,
    body: reflectionTemplate(),
  };
}

// ---------------------------------------------------------------- trade

export function renderTradeNote(i: TradeNoteInput, ctx: NoteContext): RenderedNote {
  const t = i.trade;
  const c = i.company;
  const deleted = i.deletedAt !== null;
  const url = deleted ? null : webUrl(ctx, `/p/${encodeURIComponent(t.projectId)}/trades/${encodeURIComponent(t.id)}`);
  const m = closedMetrics(t);
  const status = deleted ? 'deleted' : m ? 'closed' : 'open';

  const frontmatter: [string, FmValue][] = [
    ['wb_id', t.id],
    ['wb_type', 'trade'],
    ['wb_company', companyFm(c)],
    ['wb_ticker', c.ticker],
    ['wb_side', t.side],
    ['wb_entry_date', fmDate(t.entryDate)],
    ['wb_entry_price', t.entryPrice],
    ['wb_quantity', t.quantity],
    ['wb_stop_at_entry', t.stopAtEntry],
    ['wb_target_at_entry', t.targetPriceAtEntry],
    ['wb_research_update', i.revision ? { link: i.revision.id, alias: revisionAlias(i.revision) } : null],
    ['wb_exit_date', fmDate(t.exitDate)],
    ['wb_exit_price', t.exitPrice],
    ['wb_fees', t.fees],
    // a fraction (0.05 = +5%), like wb_upside_base_at_update
    ['wb_return_pct', round(m?.returnPct, 4)],
    ['wb_r_multiple', round(m?.rMultiple, 2)],
    ['wb_holding_days', m?.holdingDays ?? null],
    ['wb_status', status],
    ['wb_source', t.source],
    ['wb_created_by', t.createdBy],
    ['wb_url', url],
  ];

  const result = m
    ? `${pct(m.returnPct)}（${[m.rMultiple === null ? null : `R ${num(m.rMultiple, 2)}`, m.holdingDays === null ? null : `持有 ${m.holdingDays} 天`].filter(Boolean).join('，')}）`.replace('（）', '')
    : null;
  const table = [
    '| 項目 | 內容 |',
    '|---|---|',
    `| 方向 | ${SIDE_LABEL[t.side]} |`,
    `| 進場 | ${t.entryDate} @ ${num(t.entryPrice)}（${num(t.quantity)} 股） |`,
    `| 停損（進場時） | ${num(t.stopAtEntry)} |`,
    `| 目標價（進場時） | ${num(t.targetPriceAtEntry)} |`,
    `| 進場依據的研究 | ${i.revision ? linkToken(i.revision.id, revisionAlias(i.revision), true) : '無'} |`,
    `| 出場 | ${m ? `${t.exitDate} @ ${num(t.exitPrice)}` : '持有中'} |`,
    ...(result ? [`| 報酬 | ${result} |`] : []),
    ...(t.fees ? [`| 費用 | ${num(t.fees)} |`] : []),
    `| 來源 | ${cell(sourceLabel(t, ctx))} |`,
  ];

  const reviews = i.reviews
    .filter((rv) => rv.subjectType === 'trade' && rv.subjectId === t.id)
    .sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.id < y.id ? -1 : 1))
    .map((rv) => {
      const parts = [
        rv.title.trim() ? inline(rv.title) : null,
        rv.thesisVerdict ? `論點：${VERDICT_LABEL[rv.thesisVerdict] ?? inline(rv.thesisVerdict)}` : null,
        rv.executionVerdict ? `執行：${VERDICT_LABEL[rv.executionVerdict] ?? inline(rv.executionVerdict)}` : null,
        rv.lessons.trim() ? `教訓：${inline(rv.lessons)}` : null,
      ].filter(Boolean);
      return `- ${parts.join(' · ') || '（空白檢討）'}`;
    });

  const callout = `> [!info] 交易 · ${companyLink(c)}${url ? ` · ${openLink(url)}` : ''}`;
  const block = blocks(
    deleted ? `> [!warning] 這筆交易已在研究工作台刪除（${ctx.localDate(i.deletedAt!)}），以下是刪除前的紀錄。` : null,
    callout,
    table,
    '**進場理由**',
    quote(t.entryReason),
    m || t.exitReason.trim() ? '**出場理由**' : null,
    m || t.exitReason.trim() ? quote(t.exitReason) : null,
    t.notes.trim() ? '**備註**' : null,
    t.notes.trim() ? quote(t.notes) : null,
    reviews.length ? '**網站上的檢討**' : null,
    reviews,
    t.source === 'import' ? '**原始日誌**' : null,
    t.source === 'import' ? quote(t.sourceText) : null,
  );

  return {
    wbId: t.id,
    kind: 'trade',
    deleted,
    path: tradeNotePath({ ticker: c.ticker, entryDate: t.entryDate, side: t.side, id: t.id }),
    frontmatter,
    block,
    body: reflectionTemplate(),
  };
}

// ---------------------------------------------------------------- AI session

const MAX_ACTIONS = 50;

export function renderAiSessionNote(i: AiSessionNoteInput, ctx: NoteContext): RenderedNote {
  const s = i.session;
  const start = ctx.localDate(s.startedAt);
  const end = ctx.localDate(s.lastAt);
  const label = ctx.clientLabel(s.client);
  const companies = [...i.companies].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : a.id < b.id ? -1 : 1));

  const frontmatter: [string, FmValue][] = [
    ['wb_id', s.id],
    ['wb_type', 'ai_session'],
    ['wb_client', s.client],
    ['wb_started_at', s.startedAt],
    ['wb_last_at', s.lastAt],
  ];
  const actions = s.actions.slice(0, MAX_ACTIONS).map((x) => `- ${ctx.localDate(x.at)} · ${inline(x.kind)} · ${inline(x.summary) || '—'}`);
  const block = blocks(
    `> [!info] AI 對話 · ${inline(label)} · ${start === end ? start : `${start} – ${end}`}`,
    `公司：${companies.length ? companies.map((c) => companyLink(c)).join('、') : '無'}`,
    '**摘要**',
    quote(s.summary),
    s.decisions?.trim() ? '**決定**' : null,
    s.decisions?.trim() ? quote(s.decisions) : null,
    s.todo?.trim() ? '**待辦**' : null,
    s.todo?.trim() ? quote(s.todo) : null,
    `**動作**（共 ${s.actions.length} 筆）`,
    actions.length ? [...actions, ...more(s.actions.length - MAX_ACTIONS)] : '- 無',
  );
  return {
    wbId: s.id,
    kind: 'ai_session',
    deleted: false,
    path: aiSessionNotePath({ date: start, clientLabel: label, id: s.id }),
    frontmatter,
    block,
    body: '',
  };
}

// ---------------------------------------------------------------- indexes

const MAX_INDEX_TRADES = 2000;

export function renderIndexNote(i: IndexNoteInput, ctx: NoteContext): RenderedNote {
  let block: string;
  if (i.id === 'index-companies') {
    const rows = [...i.companies].sort((a, b) => {
      const ka = `${a.company.ticker}\u0000${a.company.name}\u0000${a.company.id}`;
      const kb = `${b.company.ticker}\u0000${b.company.name}\u0000${b.company.id}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    block = blocks(
      `> [!info] 公司總表（共 ${rows.length} 家）`,
      [
        '| 公司 | 代號 | 基準目標價 | 最新研究更新 | 持有中交易 |',
        '|---|---|---|---|---|',
        ...rows.map((r) => `| ${companyLink(r.company, true)} | ${cell(r.company.ticker) || '—'} | ${num(r.tpBase)} | ${r.lastUpdate ?? '—'} | ${r.openTrades} |`),
      ],
    );
  } else if (i.id === 'index-trades') {
    const rows = [...i.trades].sort((a, b) => byTradeDesc(a.trade, b.trade));
    block = blocks(
      `> [!info] 交易總表（共 ${rows.length} 筆）`,
      [
        '| 進場日 | 公司 | 方向 | 數量 | 進場價 | 出場 | 報酬 | 狀態 | 筆記 |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows.slice(0, MAX_INDEX_TRADES).map(({ trade: t, company }) => {
          const m = closedMetrics(t);
          return `| ${t.entryDate} | ${companyLink(company, true)} | ${SIDE_LABEL[t.side]} | ${num(t.quantity)} | ${num(t.entryPrice)} | ${m ? `${t.exitDate} @ ${num(t.exitPrice)}` : '—'} | ${m ? pct(m.returnPct) : '—'} | ${m ? '已出場' : '持有中'} | ${linkToken(t.id, '開啟', true)} |`;
        }),
      ],
      more(rows.length - MAX_INDEX_TRADES),
    );
  } else {
    const rows = [...i.sessions].sort((a, b) => bySessionDesc(a.session, b.session));
    block = blocks(
      `> [!info] AI 對話總表（共 ${rows.length} 次）`,
      [
        '| 開始 | 用戶端 | 公司 | 動作數 | 摘要 | 筆記 |',
        '|---|---|---|---|---|---|',
        ...rows.map(({ session: s, companies }) => {
          const cs = companies.length ? companies.map((c) => companyLink(c, true)).join('、') : '—';
          return `| ${ctx.localDate(s.startedAt)} | ${cell(ctx.clientLabel(s.client))} | ${cs} | ${s.actions.length} | ${cell(firstLine(s.summary)) || '—'} | ${linkToken(s.id, '開啟', true)} |`;
        }),
      ],
    );
  }
  const id: IndexId = i.id;
  return {
    wbId: id,
    kind: 'index',
    deleted: false,
    path: INDEX_PATHS[id],
    frontmatter: [
      ['wb_id', id],
      ['wb_type', 'index'],
    ],
    block,
    body: '',
  };
}
