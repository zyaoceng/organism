/**
 * Tool output for the AI, in Traditional Chinese: plain text built with the domain's own helpers
 * (compute, keyOutputs, formatValue, unitLabelZh), with a link to the page in the website.
 * Text the user (or a web page) wrote is wrapped by `untrusted`, so the model can tell data from
 * instructions; names of companies and nodes are printed as they are.
 */
import { formatValueZh, unitLabelZh } from '../domain/agent/units';
import type { CalcResult, FrozenOutputs, Issue } from '../domain/calc/engine';
import { formatDelta, formatValue } from '../domain/format';
import { toDisplay } from '../domain/formula/refs';
import { cellStatus, descendants, findByRole, indexModel, isHeading, nodePeriodKeys, visibleRows } from '../domain/model/tree';
import { SCALAR_KEY, SCENARIO_IDS, type ModelState, type ScenarioId } from '../domain/model/types';
import { basisPeriodId, keyOutputs } from '../domain/revision/impact';
import { summarizeTrades } from '../domain/trade/summary';
import type { Unit } from '../domain/units';
import { actorLabel, isAgentActor } from '../shared/actors';
import { UNTRUSTED_BEGIN, UNTRUSTED_END } from '../shared/aiInstructions';
import type {
  AiSessionDTO,
  CatalystBrief,
  CatalystDTO,
  CommitPreviewDTO,
  DashboardRowDTO,
  DraftOpsResponse,
  DraftPendingDTO,
  EvidenceDTO,
  JournalTradeDTO,
  KeyOutputsDiffDTO,
  ProjectBundleDTO,
  ProjectSummaryDTO,
  RefreshItemDTO,
  RefreshProviderDTO,
  RefreshRunDTO,
  RevisionFull,
  RevisionMeta,
  TradeDTO,
} from '../shared/api';
import { ApiErr, TokenError, ToolError, WorkbenchDownError } from './http';

// ---------------------------------------------------------------- basics

/**
 * User-written text, marked as data. Brackets inside it are replaced (⟦ → ［, ⟧ → ］), so the text
 * cannot close the block early and continue as if it were the tool speaking.
 */
export function untrusted(label: string, text: string | null | undefined): string {
  const clean = (s: string) => s.replace(/⟦/g, '［').replace(/⟧/g, '］');
  return `${UNTRUSTED_BEGIN}：${clean(label)}⟧\n${clean(text ?? '')}\n${UNTRUSTED_END}`;
}

/**
 * A list of draft changes as one data block: their texts quote what people wrote (thesis statements,
 * evidence titles, peer names, the rationale of an edit), so they are marked like any other user text.
 */
function changeList(texts: readonly string[], max: number): string {
  const shown = texts.slice(0, max).map((t) => `- ${t}`);
  if (texts.length > max) shown.push(`…還有 ${texts.length - max} 項`);
  return untrusted('修改清單', shown.join('\n'));
}

/** Indent every line of a block (for untrusted blocks under a list item). */
const indent = (block: string, prefix: string) =>
  block
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');

const zh = (a: string | null | undefined) => actorLabel(a, 'zh-TW');

export function siteUrl(port: number, projectId?: string, tab = 'model', param?: string): string {
  const base = `http://127.0.0.1:${port}/`;
  if (!projectId) return base;
  return `${base}#/p/${encodeURIComponent(projectId)}/${tab}${param ? `/${encodeURIComponent(param)}` : ''}`;
}

/** The cross-company trade log page. */
export const journalUrl = (port: number) => `${siteUrl(port)}#/journal`;

/** Local date and time of an ISO timestamp (the adapter runs on the same Mac as the server). */
export function localTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const num = (v: number | null | undefined, digits = 4) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits }));
/** A fraction as a signed percentage: 0.083 → "+8.3%". */
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const rText = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`);
/** Money in one currency, whole units (as the trade log shows it); never added across currencies. */
const money = (v: number, currency: string) => {
  const r = Math.round(v) || 0; // no "-0" for a loss under half a unit
  return `${r > 0 ? '+' : ''}${num(r, 0)} ${currency}`;
};

export const SCENARIO_ZH: Record<ScenarioId, string> = { bear: '空頭', base: '基準', bull: '多頭' };
const ROLE_ZH: Record<string, string> = {
  eps: 'EPS',
  revenue: '營收',
  gross_margin: '毛利率',
  operating_income: '營業利益',
  net_income: '淨利',
  diluted_shares: '稀釋後股數',
  eps_growth: 'EPS 成長率',
  roic: 'ROIC',
  reinvestment_roi: '再投資報酬率',
  target_multiple: '目標倍數',
  target_price: '目標價',
  rerating: '評價重估論點',
};
const THESIS_STATUS_ZH: Record<string, string> = { active: '有效', confirmed: '已證實', invalidated: '已推翻', retired: '已停用' };
const SEVERITY_ZH: Record<string, string> = { error: '錯誤', warning: '警告', info: '提示' };
const REVISION_KIND_ZH: Record<string, string> = { initial: '初始模型', update: '研究更新', checkpoint: '檢查點（數字不變）', restore: '還原' };
const CATALYST_STATUS_ZH: Record<string, string> = { upcoming: '即將發生', occurred: '已發生', delayed: '延後', cancelled: '已取消' };
const SIDE_ZH: Record<string, string> = { long: '買進（做多）', short: '放空（做空）' };
/** The same words as the website (src/client/i18n/zh). */
const ERROR_CATEGORY_ZH: Record<string, string> = {
  evidence_quality: '證據品質',
  evidence_interpretation: '證據解讀',
  assumption_magnitude: '假設幅度',
  model_formula: '財務模型／公式',
  timing_catalyst: '時點／催化劑',
  valuation_multiple: '估值倍數',
  trading_execution: '交易執行',
  risk_management: '風險管理',
};
const VERDICT_ZH: Record<string, string> = { right: '正確', wrong: '錯誤', mixed: '好壞參半', unclear: '不明確', good: '良好', poor: '不佳', 'n/a': '不適用' };
const MARK_ZH: Record<string, string> = { quote: '報價', bar: '收盤價' };

// ---------------------------------------------------------------- key outputs

const KEY_ROWS = [
  { key: 'eps', label: 'EPS', unit: 'eps' },
  { key: 'targetMultiple', label: '目標本益比', unit: 'targetMultiple' },
  { key: 'targetPrice', label: '目標價', unit: 'targetPrice' },
] as const;

/** EPS, target P/E and target price per scenario, before → after with the change. */
export function keyOutputLines(k: KeyOutputsDiffDTO, opts: { beforeLabel?: string; afterLabel?: string } = {}): string[] {
  const out: string[] = [];
  for (const row of KEY_ROWS) {
    const unit = k.units[row.unit];
    const b = k.before[row.key];
    const a = k.after[row.key];
    if (SCENARIO_IDS.every((s) => b[s] === null && a[s] === null)) continue;
    const cells = SCENARIO_IDS.map((s) => {
      const same = b[s] === a[s] || (b[s] !== null && a[s] !== null && Math.abs(b[s]! - a[s]!) <= 1e-9 * Math.max(1, Math.abs(b[s]!)));
      if (same) return `${SCENARIO_ZH[s]} ${formatValueZh(a[s], unit)}（不變）`;
      const delta = formatDelta(b[s], a[s], unit);
      return `${SCENARIO_ZH[s]} ${formatValueZh(b[s], unit)} → ${formatValueZh(a[s], unit)}${delta ? `（${delta}）` : ''}`;
    });
    const period = row.key === 'eps' && k.basisPeriodId ? `（${k.basisPeriodId}）` : '';
    out.push(`${row.label}${period}：${cells.join('｜')}`);
  }
  if (out.length && (opts.beforeLabel || opts.afterLabel)) out.unshift(`重點數字（${opts.beforeLabel ?? '之前'} → ${opts.afterLabel ?? '之後'}）：`);
  return out;
}

/** Key outputs of two states on the later state's basis period. */
export function keyOutputsBetween(before: ModelState, rb: CalcResult, after: ModelState, ra: CalcResult): KeyOutputsDiffDTO {
  const basis = basisPeriodId(after);
  return {
    basisPeriodId: basis,
    units: {
      eps: findByRole(after, 'eps')?.unit ?? null,
      targetPrice: findByRole(after, 'target_price')?.unit ?? null,
      targetMultiple: findByRole(after, 'target_multiple')?.unit ?? null,
    },
    before: keyOutputs(before, rb, basis),
    after: keyOutputs(after, ra, basis),
  };
}

// ---------------------------------------------------------------- companies

const priceText = (p: ProjectSummaryDTO['lastPrice']) => (p ? `${num(p.price)}${p.currency ? ` ${p.currency}` : ''}（${p.asOf.slice(0, 10)}，${p.provider}）` : '尚未抓取');

const PER_SHARE: Unit = { kind: 'per_share', scale: 1 };

/** A cached dashboard quote with its market date and the website's two warnings. */
function dashPriceText(p: DashboardRowDTO['price']): string {
  if (!p) return '尚未抓取（可用 refresh_prices 更新）';
  const notes = [p.marketDate, p.provider];
  if (p.synthetic) notes.push('模擬資料，不是真實股價');
  if (p.stale) notes.push(`已過期，${localTime(p.fetchedAt)} 抓取`);
  // the website's rule: a fresh fetch that brings no new prices for a week (suspended, wrong symbol)
  else if (p.lagDays > 7) notes.push(`已 ${p.lagDays} 天沒有新股價`);
  return `${num(p.value)} ${p.currency}（${notes.join('，')}）`;
}

function dashTargetText(t: DashboardRowDTO['target']): string {
  if (t.bear === null && t.base === null && t.bull === null) return '目標價 —（最近一次研究更新沒有目標價）';
  const parts = [`目標價 空頭/基準/多頭 ${SCENARIO_IDS.map((s) => formatValue(t[s], PER_SHARE)).join(' / ')}${t.currency ? ` ${t.currency}` : ''}`];
  if (t.weighted !== null) parts.push(`機率加權 ${formatValue(t.weighted, PER_SHARE)}${t.currency ? ` ${t.currency}` : ''}${Math.abs(t.weightSum - 1) > 1e-6 ? `（權重合計 ${num(t.weightSum * 100, 1)}%，已按比例換算）` : ''}`);
  if (t.currencyMismatch) parts.push('上檔空間 —（目標價和股價的幣別不同，不換算）');
  else if (t.upsideBase !== null || t.upsideWeighted !== null) {
    parts.push(`上檔空間 基準 ${pct(t.upsideBase)}${t.upsideWeighted !== null ? `、加權 ${pct(t.upsideWeighted)}` : ''}`);
  }
  return parts.join('｜');
}

/** When a catalyst is expected: the day, or its month or calendar quarter. */
function catalystWhen(c: CatalystBrief): string {
  if (c.datePrecision === 'day') return c.expectedDate;
  if (c.datePrecision === 'month') return `${c.expectedDate.slice(0, 7)}（整月）`;
  return `${c.expectedDate.slice(0, 4)} Q${Math.ceil(Number(c.expectedDate.slice(5, 7)) / 3)}`;
}

/** Positions, catalysts, theses and AI activity of one dashboard row. */
function dashFlags(r: DashboardRowDTO): string[] {
  const out: string[] = [];
  const p = r.positions;
  if (p.open) {
    const avg = p.avgR !== null ? `，平均 ${rText(p.avgR)}（${p.rCount} 筆有停損）` : '';
    const pnl = p.pnl.length ? `，未實現損益 ${p.pnl.map((x) => money(x.value, x.currency)).join('、')}` : '';
    out.push(`未平倉 ${p.open} 筆${avg}${pnl}`);
  }
  const c = r.catalysts;
  if (c.overdue) out.push(`催化劑過期 ${c.overdue} 個${c.oldestOverdue ? `（最舊「${c.oldestOverdue.title}」${catalystWhen(c.oldestOverdue)}）` : ''}`);
  if (c.next) out.push(`下一個催化劑「${c.next.title}」${catalystWhen(c.next)}${c.upcoming > 1 ? `（共 ${c.upcoming} 個）` : ''}`);
  if (c.undated) out.push(`日期未定的催化劑 ${c.undated} 個`);
  if (r.theses.reviewDue) out.push(`論點到了檢查日 ${r.theses.reviewDue} 個`);
  else if (r.theses.nextReviewBy) out.push(`下次論點檢查 ${r.theses.nextReviewBy}`);
  if (r.ai) out.push(`最近 AI 活動：${actorLabel(`agent:${r.ai.client}`, 'zh-TW')} ${localTime(r.ai.at)}`);
  return out;
}

/** The cross-company overview (list_companies), one block per company in the dashboard's order. */
export function formatCompanyList(rows: readonly DashboardRowDTO[], port: number, o: { today?: string; refreshing?: boolean } = {}): string {
  if (!rows.length) return '研究工作台裡還沒有符合的公司。';
  const lines = [`共 ${rows.length} 家公司${o.today ? `（今天 ${o.today}）` : ''}。股價是快取的最新報價；目標價和上檔空間來自最近一次研究更新，不是草稿：`];
  if (o.refreshing) lines.push('股價正在更新中：用 get_refresh_status 查進度，完成後再讀一次。');
  rows.forEach((r, i) => {
    const s = r.security;
    lines.push(`${i + 1}. ${r.name}（${s ? `${s.ticker}${s.exchange ? ` · ${s.exchange}` : ''}` : '無代號'}）id: ${r.projectId}${r.archivedAt ? '（已封存）' : ''}`);
    lines.push(`   股價 ${s ? dashPriceText(r.price) : '—（沒有股票代號）'}`);
    lines.push(`   ${dashTargetText(r.target)}`);
    const res = r.research;
    lines.push(`   最近研究更新 ${res ? `#${res.seq}「${res.title}」知情日 ${res.asOfDate}` : '還沒有（只有初始模型）'}${r.draftDirty ? '｜草稿有未提交修改' : ''}`);
    const flags = dashFlags(r);
    if (flags.length) lines.push(`   ${flags.join('｜')}`);
    lines.push(`   網站：${siteUrl(port, r.projectId)}`);
  });
  return lines.join('\n');
}

export interface CompanySummaryInput {
  summary: ProjectSummaryDTO;
  bundle: ProjectBundleDTO;
  draftCalc: CalcResult;
  headCalc: CalcResult;
  trades: TradeDTO[];
  catalysts: CatalystDTO[];
  revisions: RevisionMeta[];
  pending: DraftPendingDTO;
  sessions: AiSessionDTO[];
  evidence: EvidenceDTO[];
  port: number;
  today: string;
}

export function formatCompanySummary(x: CompanySummaryInput): string {
  const { bundle: b, summary: s, port } = x;
  const p = b.project;
  const sec = b.securities.find((v) => v.isPrimary) ?? b.securities[0];
  const lines: string[] = [];
  lines.push(`${p.name}（${sec ? `${sec.ticker}${sec.exchange ? ` · ${sec.exchange}` : ''}，${sec.currency}` : '無代號'}）id: ${p.id}${p.archivedAt ? '（已封存）' : ''}`);
  if (p.description.trim()) lines.push(untrusted('公司說明', p.description));
  lines.push(`今天 ${x.today}｜股價 ${priceText(s.lastPrice)}`);

  const head = b.head;
  lines.push('');
  lines.push(...keyOutputLines(keyOutputsBetween(head.state, x.headCalc, b.draft.state, x.draftCalc), { beforeLabel: `最近研究更新 #${head.seq}`, afterLabel: `草稿 v${b.draft.version}` }));

  lines.push('');
  const pend = x.pending.changes;
  if (!pend.length) lines.push(`草稿 v${b.draft.version}：沒有未提交的修改。`);
  else {
    const counts = Object.entries(x.pending.counts)
      .map(([a, n]) => `${a === 'before-v2' ? zh(null) : zh(a)} ${n}`)
      .join('、');
    lines.push(`草稿 v${b.draft.version}：${pend.length} 項未提交的修改（${counts}）：`);
    lines.push(changeList(pend.map((c) => `${c.text}（${zh(c.actor)}）`), 30));
  }

  const theses = b.draft.state.theses.filter((t) => t.status === 'active');
  if (theses.length) {
    lines.push('', '有效的論點：');
    for (const t of theses) {
      lines.push(`- ‹${t.id}›${t.reviewBy ? `（${t.reviewBy} 前檢查）` : ''}`);
      lines.push(indent(untrusted('論點', t.statement), '  '));
      if (t.invalidation.trim()) lines.push(indent(untrusted('推翻條件', t.invalidation), '  '));
    }
  }

  const open = x.trades.filter((t) => !t.exitDate);
  if (open.length) {
    lines.push('', '未平倉交易：');
    for (const t of open) lines.push(`- ${tradeLine(t)}`);
  }

  const upcoming = x.catalysts
    .filter((c) => c.status === 'upcoming' || c.status === 'delayed')
    .sort((a, c) => (a.expectedDate ?? '9999').localeCompare(c.expectedDate ?? '9999'))
    .slice(0, 5);
  if (upcoming.length) {
    lines.push('', '接下來的催化劑：');
    for (const c of upcoming) lines.push(`- ${c.expectedDate ?? '日期未定'}（${c.datePrecision === 'day' ? '日' : c.datePrecision === 'month' ? '月' : '季'}）${c.title}［${CATALYST_STATUS_ZH[c.status] ?? c.status}］`);
  }

  const recent = [...x.revisions].sort((a, c) => c.seq - a.seq).slice(0, 3);
  if (recent.length) {
    lines.push('', '最近的研究更新：');
    for (const r of recent) {
      lines.push(`- #${r.seq}「${r.title}」${REVISION_KIND_ZH[r.kind] ?? r.kind}，知情日 ${r.asOfDate ?? '—'}，${zh(r.createdBy)}提交${r.excludedFromCalibration ? '（已標記錯誤，校準時排除）' : ''}`);
      if (r.reason.trim()) lines.push(indent(untrusted('理由', r.reason), '  '));
    }
  }

  const ev = [...x.evidence].filter((e) => !e.archivedAt).sort((a, c) => c.addedAt.localeCompare(a.addedAt)).slice(0, 10);
  if (ev.length) {
    lines.push('', '最近的證據（preview_commit 的 evidence_ids、edit_draft 的 link_evidence 用這些 id）：');
    for (const e of ev) lines.push(`- ‹${e.id}›「${e.title}」發布日 ${e.publishedAt ?? '未填'}${e.publishedAtSource === 'agent-asserted' ? '（日期由 AI 提供）' : ''}`);
  }

  if (x.sessions.length) {
    lines.push('', '最近的 AI 對話：');
    for (const ses of x.sessions) {
      lines.push(`- ${localTime(ses.lastAt)} ${actorLabel(`agent:${ses.client}`, 'zh-TW')}：${ses.actions.length} 個動作`);
      if (ses.summary) lines.push(indent(untrusted('對話摘要', ses.summary), '  '));
      if (ses.todo) lines.push(indent(untrusted('待辦', ses.todo), '  '));
    }
  }

  lines.push('', `網站：${siteUrl(port, p.id)}`);
  lines.push(`下一步：看模型用 get_model；修改先 edit_draft(dry_run=true)；目前草稿版本 v${b.draft.version}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- model outline

export interface OutlineOptions {
  /** Company name. */
  title: string;
  /** '草稿 v57' or '研究更新 #4「…」知情日 …'. */
  source: string;
  scenario: ScenarioId | 'all';
  /** Only this node and what is under it. */
  subtreeId?: string | null;
  includeNotes?: boolean;
  /** Values frozen at commit time (a Research Update); otherwise the values of `calc`. */
  frozen?: FrozenOutputs['values'];
  draftVersion: number;
  /** Longer output is cut (default 60,000 characters). */
  maxChars?: number;
}

const IGNORED_ERRORS = new Set(['MISSING', 'UPSTREAM']);

/**
 * The model as an indented outline: each node with its unit, role, formula and id, then its values
 * per period. Markers: ƒ formula result, ✎ typed value over a formula, ⚠ error, — empty.
 */
export function formatModelOutline(state: ModelState, calc: CalcResult, o: OutlineOptions): string {
  const ix = indexModel(state);
  const plabel = (key: string) => {
    if (key === SCALAR_KEY) return '單一數值';
    const i = ix.periodIndex.get(key);
    return i === undefined ? key : ix.periods[i].label;
  };
  const scLabel = o.scenario === 'all' ? '全部（空頭、多頭只列和基準不同的格）' : SCENARIO_ZH[o.scenario];
  const periods = state.periods.map((p) => `${p.label}${p.status}`).join(' ');
  const lines: string[] = [`模型：${o.title}（${o.source}；情境：${scLabel}；期間：${periods || '（沒有）'}）`];

  let rows = visibleRows(state, new Set());
  let depth0 = 0;
  let inSubtree: Set<string> | null = null;
  if (o.subtreeId) {
    inSubtree = new Set([o.subtreeId, ...descendants(ix, o.subtreeId)]);
    rows = rows.filter((r) => inSubtree!.has(r.node.id));
    depth0 = rows[0]?.depth ?? 0;
  }

  const valueOf = (s: ScenarioId, id: string, key: string) => (o.frozen ? (o.frozen[s]?.[id]?.[key] ?? null) : (calc.cells[s][id]?.[key]?.v ?? null));

  for (const row of rows) {
    const n = row.node;
    const pad = '  '.repeat(row.depth - depth0);
    const unit = unitLabelZh(n.unit);
    const role = n.role ? `（角色：${ROLE_ZH[n.role] ?? n.role}）` : '';
    const formula = n.formula ? ` ＝ ${toDisplay(n.formula, ix, n.id)}` : '';
    lines.push(`${pad}- ${n.name}${unit ? ` 〔${unit}〕` : ''}${role}${formula}  ‹${n.id}›`);

    if (!(isHeading(n) && row.hasChildren) && (n.unit || n.formula || Object.keys(n.values).length)) {
      const keys = nodePeriodKeys(state, n);
      const cell = (s: ScenarioId, key: string) => {
        const c = calc.cells[s][n.id]?.[key];
        const v = valueOf(s, n.id, key);
        let mark = '';
        if (v === null) {
          if (c?.err && !IGNORED_ERRORS.has(c.err.code)) mark = '⚠';
        } else if (c?.src === 'formula') mark = 'ƒ';
        else if (c?.src === 'input' && n.formula) mark = '✎';
        return `${formatValue(v, n.unit)}${mark}`;
      };
      const label = (key: string) => (key === SCALAR_KEY ? '單一數值' : `${plabel(key)}${cellStatus(ix, n, key)}`);
      const main: ScenarioId = o.scenario === 'all' ? 'base' : o.scenario;
      lines.push(`${pad}    ${keys.map((k) => `${label(k)} ${cell(main, k)}`).join(' | ')}`);
      if (o.scenario === 'all') {
        for (const s of ['bear', 'bull'] as const) {
          const diff = keys.filter((k) => valueOf(s, n.id, k) !== valueOf('base', n.id, k));
          if (diff.length) lines.push(`${pad}    ${SCENARIO_ZH[s]}：${diff.map((k) => `${label(k)} ${cell(s, k)}`).join(' | ')}`);
        }
      }
    }
    if (o.includeNotes && n.notes.trim()) lines.push(indent(untrusted(`${n.name} 的筆記`, n.notes), `${pad}    `));
  }

  if (!inSubtree) {
    if (state.theses.length) {
      lines.push('', '論點（update_thesis 用 ‹id›）：');
      for (const t of state.theses) {
        const nodes = t.nodeIds.map((id) => ix.byId.get(id)?.name ?? id).join('、');
        lines.push(`- ‹${t.id}›［${THESIS_STATUS_ZH[t.status] ?? t.status}］${t.reviewBy ? `${t.reviewBy} 前檢查` : ''}${nodes ? `；相關節點：${nodes}` : ''}`);
        lines.push(indent(untrusted('論點', t.statement), '  '));
        if (t.invalidation.trim()) lines.push(indent(untrusted('推翻條件', t.invalidation), '  '));
      }
    }
    const v = state.valuation;
    const rationale = SCENARIO_IDS.filter((s) => v.rationale[s]?.trim());
    if (rationale.length || v.peers.length) {
      lines.push('', '估值：');
      for (const s of rationale) lines.push(indent(untrusted(`${SCENARIO_ZH[s]}本益比理由`, v.rationale[s]), '  '));
      for (const peer of v.peers) {
        const pct = (x?: number) => (x === undefined ? '—' : `${num(x * 100, 1)}%`);
        lines.push(
          `  同業 ${peer.name}${peer.ticker ? `（${peer.ticker}）` : ''}：本益比 ${peer.pe === undefined ? '—' : `${num(peer.pe, 1)}x`}｜EPS 成長 ${pct(peer.epsGrowth)}｜ROIC ${pct(peer.roic)}｜毛利率 ${pct(peer.grossMargin)}${peer.asOf ? `｜${peer.asOf}` : ''}`,
        );
      }
    }
    if (state.links.length) lines.push('', `證據連結：${state.links.length} 個`);
  }

  const issues = calc.issues.filter((i) => !inSubtree || inSubtree.has(i.nodeId));
  if (issues.length) {
    lines.push('', '問題：');
    for (const i of issues.slice(0, 40)) lines.push(`- ${issueLine(i, ix.byId.get(i.nodeId)?.name ?? i.nodeId, plabel)}`);
    if (issues.length > 40) lines.push(`…還有 ${issues.length - 40} 個`);
  }

  const last = `下一步：修改請先 edit_draft(dry_run=true)；目前草稿版本 v${o.draftVersion}`;
  let text = lines.join('\n');
  const max = o.maxChars ?? 60_000;
  if (text.length > max) {
    const cut = text.lastIndexOf('\n', max - 200);
    text = `${text.slice(0, cut > 0 ? cut : max - 200)}\n…（內容太長，已截斷。請用 subtree 縮小範圍）`;
  }
  return `${text}\n\n${last}`;
}

function issueLine(i: Pick<Issue, 'severity' | 'message' | 'periodKey'>, nodeName: string, plabel: (k: string) => string): string {
  return `［${SEVERITY_ZH[i.severity] ?? i.severity}］${nodeName}${i.periodKey ? ` ${plabel(i.periodKey)}` : ''}：${i.message}`;
}

// ---------------------------------------------------------------- draft ops

export function formatOpsResult(r: DraftOpsResponse, port: number): string {
  const lines: string[] = [r.dryRun ? '（預覽，尚未寫入）' : `已寫入草稿（版本 v${r.version}）`];
  const perOp = new Set<string>();
  for (const res of r.results) {
    const node = res.node ? ` ${res.node.path}${res.node.unit ? ` 〔${unitLabelZh(res.node.unit)}〕` : ''}` : '';
    lines.push(`${res.index + 1}. ${res.op}${node}${res.createdId ? `（新的 id ‹${res.createdId}›${r.dryRun ? '，正式寫入時會不同' : ''}）` : ''}`);
    for (const c of res.cells ?? []) {
      lines.push(`   ${c.period}${c.scenario === 'base' ? '' : `（${SCENARIO_ZH[c.scenario]}）`}：${c.before} → ${c.after}${c.note ? `（${c.note}）` : ''}`);
    }
    if (!res.cells?.length) for (const d of res.description) lines.push(`   ${d}`);
    if (!res.cells?.length && !res.description.length) lines.push('   （沒有改變）');
    for (const w of res.warnings) {
      perOp.add(w);
      lines.push(`   ⚠ ${w}`);
    }
  }
  const key = keyOutputLines(r.keyOutputs);
  if (key.length) lines.push('', ...key);
  const fresh = r.issues.filter((i) => i.isNew);
  if (fresh.length) {
    lines.push('', '這次新出現的問題：');
    for (const i of fresh.slice(0, 20)) lines.push(`- ${issueLine(i, i.nodeName, (k) => k)}`);
  }
  const other = r.warnings.filter((w) => !perOp.has(w));
  if (other.length) lines.push('', ...other.map((w) => `⚠ ${w}`));
  lines.push('', `網站：http://127.0.0.1:${port}${r.url}`);
  lines.push(r.dryRun ? `要正式寫入，請用同一組 ops 呼叫 edit_draft，dry_run=false、expected_version=${r.version}` : '網站會在 10 秒內更新；尚未提交研究更新');
  return lines.join('\n');
}

// ---------------------------------------------------------------- commits

export function formatPreview(d: CommitPreviewDTO, port: number): string {
  const lines: string[] = [];
  if (d.previewId) lines.push(`提交預覽 preview_id: ${d.previewId}（到 ${localTime(d.expiresAt)} 前有效）`);
  else lines.push('提交預覽（沒有 preview_id：這次不能由 AI 提交）');
  lines.push(`今天 ${d.today}｜知情日期 ${d.asOfDate}｜類型 ${REVISION_KIND_ZH[d.kind] ?? d.kind}｜草稿版本 v${d.draftVersion}`);
  if (!d.changes.length) lines.push('草稿沒有修改（提交會是一個數字不變的檢查點）。');
  else {
    lines.push(`共 ${d.changeCount} 項修改：`);
    lines.push(changeList(d.changes.map((c) => `${c.text}（${zh(c.actor)}）`), 40));
  }
  const key = keyOutputLines(d.keyOutputs);
  if (key.length) lines.push('', ...key);
  if (d.needsConfirmation) {
    lines.push('', '需要使用者確認（變動很大）：');
    for (const m of d.largeMoves) lines.push(`- ${m.text}`);
    lines.push('先把這份預覽給使用者看，問他是否同意；使用者明確同意後，才在 commit_research_update 帶 confirmed_by_user=true。');
  }
  if (d.blocked) {
    lines.push('', `被擋下：${d.blocked}`);
    if (d.userChanges.length) lines.push(changeList(d.userChanges, 20));
  }
  const m = d.market;
  lines.push('', m ? `記錄的股價：${num(m.price)} ${m.currency ?? ''}（${m.asOf.slice(0, 10)}，${m.provider}，${m.basis === 'bar' ? '當日 K 線收盤' : '最新報價'}）` : '記錄的股價：沒有（那天沒有可用的股價）');
  if (d.citedEvidence.length) {
    lines.push('引用的證據：');
    for (const e of d.citedEvidence) lines.push(`- ‹${e.id}›「${e.title}」發布日 ${e.publishedAt ?? '未填'}`);
  }
  lines.push('', '提交後無法撤銷：研究更新永久保存，不能修改或刪除（錯了只能在網站的歷史頁標記「錯誤」）。');
  lines.push(`網站：${siteUrl(port, d.projectId, 'model')}`);
  if (d.previewId) lines.push(`使用者同意後：commit_research_update(preview_id="${d.previewId}", title, reason${d.needsConfirmation ? ', confirmed_by_user=true' : ''})`);
  return lines.join('\n');
}

export function formatCommitted(rev: RevisionFull, port: number): string {
  const tp = findByRole(rev.state, 'target_price')?.unit ?? null;
  const lines = [`已提交研究更新 #${rev.seq}「${rev.title}」（${REVISION_KIND_ZH[rev.kind] ?? rev.kind}，知情日 ${rev.asOfDate ?? '—'}，${zh(rev.createdBy)}提交）。`];
  const cells = rev.impact?.headline.targetPrice ?? [];
  if (cells.some((c) => c.before !== null || c.after !== null)) {
    lines.push(`目標價：${cells.map((c) => `${SCENARIO_ZH[c.scenario]} ${formatValueZh(c.before, tp)} → ${formatValueZh(c.after, tp)}`).join('｜')}`);
  }
  if (rev.market) lines.push(`記錄的股價：${num(rev.market.price)} ${rev.market.currency ?? ''}（${rev.market.asOf.slice(0, 10)}，${rev.market.provider}）`);
  lines.push('它已永久保存，不能修改或刪除；如果發現錯了，請使用者在網站的歷史頁標記「錯誤」（校準時排除）。');
  lines.push(`網站：${siteUrl(port, rev.projectId, 'history', rev.id)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- trades and sessions

function tradeLine(t: TradeDTO): string {
  const parts = [`‹${t.id}› ${SIDE_ZH[t.side] ?? t.side} ${t.quantity.toLocaleString('en-US')} 股 @ ${num(t.entryPrice)}（${t.entryDate}）`];
  // stop and target may be computed defaults (ATR, the model's target price): two decimals
  if (t.stopAtEntry !== null) parts.push(`停損 ${num(t.stopAtEntry, 2)}`);
  if (t.targetPriceAtEntry !== null) parts.push(`目標價 ${num(t.targetPriceAtEntry, 2)}`);
  if (t.exitDate) parts.push(`出場 ${num(t.exitPrice)}（${t.exitDate}）`);
  return parts.join('｜');
}

export function formatTrade(t: TradeDTO, warnings: readonly string[], port: number, heading?: string): string {
  const lines: string[] = [];
  if (heading) lines.push(heading);
  lines.push(`交易 ${tradeLine(t)}`);
  if (t.fees) lines.push(`手續費與稅 ${num(t.fees)}`);
  if (t.source === 'import') lines.push(`來源：匯入舊日誌（${t.externalRef ?? ''}）`);
  if (t.createdBy) lines.push(`記錄者：${zh(t.createdBy)}`);
  if (t.entryReason.trim()) lines.push(untrusted('進場理由', t.entryReason));
  if (t.exitDate && t.exitReason.trim()) lines.push(untrusted('出場理由', t.exitReason));
  if (t.notes.trim()) lines.push(untrusted('交易備註', t.notes));
  if (warnings.length) lines.push('提醒：', ...warnings.map((w) => `- ${w}`));
  lines.push(`網站：${siteUrl(port, t.projectId, 'trades')}`);
  return lines.join('\n');
}

export function formatSession(s: AiSessionDTO, port: number): string {
  const lines = [`已存對話摘要（${s.id}，${localTime(s.startedAt)} 到 ${localTime(s.lastAt)}，${s.actions.length} 個動作）。`];
  if (s.projectIds.length) lines.push(`相關公司：${s.projectIds.join('、')}`);
  lines.push('使用者可以在網站的歷史頁「AI 活動」看到它。', `網站：${siteUrl(port)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- trade log

/** The mark, result and execution numbers of one trade, in its security's currency. */
function tradeResultLine(t: JournalTradeDTO): string {
  const m = t.metrics;
  const ccy = t.security.currency;
  const parts: string[] = [];
  if (m.open) {
    parts.push(m.markPrice === null ? '未平倉，沒有可用的股價' : `未平倉，以${MARK_ZH[m.markSource ?? ''] ?? '股價'} ${num(m.markPrice)}（${m.markDate}）計`);
  }
  if (m.returnPct !== null) parts.push(`報酬 ${pct(m.returnPct)}`);
  if (m.pnl !== null) parts.push(`${m.open ? '未實現' : '已實現'}損益 ${money(m.pnl, ccy)}（含手續費）`);
  if (m.rMultiple !== null) parts.push(rText(m.rMultiple));
  if (m.holdingDays !== null) parts.push(`持有 ${m.holdingDays} 天`);
  if (!t.barsCoverEntry) parts.push('K 線沒有涵蓋進場日，沒有 MFE/MAE');
  else if (m.mfe !== null && m.mae !== null) parts.push(`MFE ${pct(m.mfe)}／MAE ${pct(m.mae)}`);
  if (m.trailingExit) parts.push(`${t.atrMultiple ?? 2}×ATR 追蹤停損會在 ${m.trailingExit.date} 以 ${num(m.trailingExit.price, 2)} 出場（${pct(m.trailingExit.returnPct)}）`);
  if (t.security.synthetic) parts.push('模擬股價');
  return parts.join('｜');
}

/** Research snapshot, reviews and who recorded it. */
function tradeContextLine(t: JournalTradeDTO): string {
  const parts: string[] = [];
  const r = t.research;
  parts.push(r ? `連結的研究更新 #${r.seq}「${r.title}」（知情日 ${r.asOfDate ?? '—'}）` : '沒有連結研究更新');
  if (t.reviews.length) {
    const one = (v: JournalTradeDTO['reviews'][number]) =>
      [
        v.thesisVerdict && `論點${VERDICT_ZH[v.thesisVerdict] ?? v.thesisVerdict}`,
        v.executionVerdict && `執行${VERDICT_ZH[v.executionVerdict] ?? v.executionVerdict}`,
        v.categories.length && `錯誤類型：${v.categories.map((c) => ERROR_CATEGORY_ZH[c] ?? c).join('、')}`,
      ]
        .filter(Boolean)
        .join('，') || '已檢討';
    parts.push(`檢討：${t.reviews.map(one).join('；')}`);
  } else if (!t.metrics.open) parts.push('還沒檢討');
  if (t.source === 'import') parts.push('從舊日誌匯入');
  if (isAgentActor(t.createdBy)) parts.push(`由 ${zh(t.createdBy)} 記錄`);
  return parts.join('｜');
}

export interface TradeLogOptions {
  /** What was asked, e.g. '未平倉｜光寶科（2301，id: …）'. */
  scope: string;
  /** Trades listed one by one (default 50, newest entry first); the summary covers all of them. */
  maxRows?: number;
}

/**
 * The trade log across companies (list_trades): a summary first, then the trades. Money stays in
 * each security's currency; the summary is summarizeTrades, which never adds across currencies.
 */
export function formatTradeLog(trades: readonly JournalTradeDTO[], port: number, o: TradeLogOptions): string {
  if (!trades.length) return `沒有符合的交易（${o.scope}）。\n網站：${journalUrl(port)}`;
  const s = summarizeTrades(trades.map((t) => ({ currency: t.security.currency, metrics: t.metrics, reviewCategories: t.reviews.flatMap((r) => r.categories) })));
  const open = trades.length - s.closed;
  const lines = [`交易紀錄（${o.scope}）：共 ${trades.length} 筆，未平倉 ${open}、已平倉 ${s.closed}。`];

  lines.push('', '摘要（金額依股票的幣別分開列，不換算，也不跨幣別加總）：');
  for (const c of s.byCurrency) {
    const closed = c.closed ? `已平倉 ${c.closed} 筆，獲利 ${c.wins} 筆${c.winRate !== null ? `（勝率 ${num(c.winRate * 100, 1)}%）` : ''}，已實現損益 ${money(c.realizedPnl, c.currency)}` : '沒有已平倉';
    const opened = c.open ? `未平倉 ${c.open} 筆${c.unrealizedPnl !== null ? `，未實現損益 ${money(c.unrealizedPnl, c.currency)}` : '，沒有股價'}` : '沒有未平倉';
    lines.push(`- ${c.currency}：${closed}；${opened}`);
  }
  // counts and R multiples carry no currency, so these may cover every trade
  if (s.byCurrency.length > 1 && s.winRate !== null) lines.push(`- 全部已平倉的勝率（筆數比例）：${num(s.winRate * 100, 1)}%`);
  if (s.rCount) lines.push(`- 平均 R（已平倉且有停損的 ${s.rCount} 筆）：${rText(s.avgR)}`);
  const unreviewed = trades.filter((t) => !t.metrics.open && !t.reviews.length).length;
  if (unreviewed) lines.push(`- 還沒檢討的已平倉交易：${unreviewed} 筆`);
  if (s.categories.length) lines.push(`- 檢討裡的錯誤類型：${s.categories.map((c) => `${ERROR_CATEGORY_ZH[c.category] ?? c.category} ${c.count}`).join('、')}`);

  const max = o.maxRows ?? 50;
  lines.push('', `明細（進場日新的在前${trades.length > max ? `，列出前 ${max} 筆` : ''}）：`);
  trades.slice(0, max).forEach((t, i) => {
    const sec = `${t.security.ticker}${t.security.exchange ? ` · ${t.security.exchange}` : ''}，${t.security.currency}`;
    lines.push(`${i + 1}. ${t.project.name}（${sec}${t.project.archived ? '，已封存' : ''}）${tradeLine(t)}`);
    const result = tradeResultLine(t);
    if (result) lines.push(`   ${result}`);
    lines.push(`   ${tradeContextLine(t)}`);
    lines.push(`   網站：${siteUrl(port, t.projectId, 'trades', t.id)}`);
  });
  if (trades.length > max) lines.push(`…還有 ${trades.length - max} 筆沒有列出（摘要已包含）。可用 company、status、from、to 縮小範圍。`);
  lines.push('', `交易日誌：${journalUrl(port)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- update all prices

const RUN_STATE_ZH: Record<RefreshRunDTO['state'], string> = { running: '進行中', done: '完成', cancelled: '中斷（伺服器關閉）' };
const PROVIDER_STATE_ZH: Record<RefreshProviderDTO['state'], string> = {
  running: '進行中',
  done: '完成',
  rate_limited: '達到請求上限，其餘的這次不更新',
  unreachable: '連不上（可能沒有網路），其餘的這次不更新',
  unavailable: '這台伺服器沒有設定這個股價來源',
};
const ITEM_STATUS_ZH: Record<RefreshItemDTO['status'], string> = { pending: '等待中', running: '更新中', ok: '成功', failed: '失敗', rate_limited: '達到請求上限', skipped: '略過' };

const runCounts = (r: RefreshRunDTO) =>
  `共 ${r.total} 檔：成功 ${r.ok}、失敗 ${r.failed}、達到請求上限 ${r.rateLimited}、略過 ${r.skipped}${r.pending ? `、還沒完成 ${r.pending}` : ''}`;

/** The answer of refresh_prices: the run was started (or one was already running); poll the status. */
export function formatRefreshStarted(run: RefreshRunDTO, alreadyRunning: boolean): string {
  if (!run.total) return '沒有要更新的股價：還沒有公司，或公司都沒有股票代號。';
  const lines = [
    alreadyRunning
      ? `已經有一次「更新全部股價」在進行中（${run.id}，${localTime(run.startedAt)} 開始），沒有重複啟動。${runCounts(run)}。`
      : `已開始更新全部股價（${run.id}）：共 ${run.total} 檔。`,
  ];
  lines.push(`股價來源：${run.providers.map((p) => `${p.label} ${p.total} 檔`).join('、')}。同一個來源一檔一檔抓（避免被限流），不同來源同時進行，可能要幾分鐘。`);
  lines.push('下一步：過幾秒呼叫 get_refresh_status 查進度，直到狀態是「完成」；不要再呼叫 refresh_prices。完成後用 list_companies 讀新的股價。');
  return lines.join('\n');
}

/** The answer of get_refresh_status. Failure messages come from the price sources, so they are marked as data. */
export function formatRefreshStatus(run: RefreshRunDTO | null, port: number): string {
  if (!run) return '還沒有「更新全部股價」的紀錄（研究工作台重新啟動後會清空）。要更新就呼叫 refresh_prices。';
  const lines = [`更新全部股價 ${run.id}：${RUN_STATE_ZH[run.state]}（${localTime(run.startedAt)} 開始${run.finishedAt ? `，${localTime(run.finishedAt)} 結束` : ''}）`];
  lines.push(`${runCounts(run)}。`);
  if (run.providers.length) {
    lines.push('股價來源：');
    for (const p of run.providers) {
      lines.push(`- ${p.label}（${p.id}）${p.total} 檔：${PROVIDER_STATE_ZH[p.state] ?? p.state}${p.retryAfterSec ? `；約 ${p.retryAfterSec} 秒後可以再試` : ''}`);
    }
  }
  const missed = run.items.filter((i) => i.status === 'failed' || i.status === 'rate_limited' || i.status === 'skipped');
  if (missed.length) {
    const shown = missed.slice(0, 30).map((i) => `- ${i.projectName}（${i.ticker}，${i.provider}）${ITEM_STATUS_ZH[i.status]}${i.message ? `：${i.message}` : ''}`);
    if (missed.length > 30) shown.push(`…還有 ${missed.length - 30} 檔`);
    lines.push(`沒有更新的股票（${missed.length} 檔）：`, untrusted('股價來源的訊息', shown.join('\n')));
  }
  if (run.state === 'running') lines.push('', '還在進行中：過幾秒再呼叫 get_refresh_status。');
  else if (run.state === 'cancelled') lines.push('', '研究工作台在更新途中關閉了；重新打開後可以再呼叫 refresh_prices。');
  else lines.push('', `已完成：用 list_companies 讀新的股價。${run.rateLimited ? '達到請求上限的來源要等一段時間再更新。' : ''}`);
  lines.push(`網站：${siteUrl(port)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- errors

type Details = Record<string, unknown> | null;

const bullets = (xs: unknown, max = 20): string[] => (Array.isArray(xs) ? xs.slice(0, max).map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`) : []);

/** The text of a failed tool call: what went wrong and what to do next, in zh. */
export function errorText(e: unknown, port: number): string {
  if (e instanceof WorkbenchDownError) {
    if (e.reason === 'timeout') return `研究工作台在 ${Math.round(e.timeoutMs / 1000)} 秒內沒有回應。這個動作可能已經完成，請先用讀取的工具（get_company、get_model）確認，再決定要不要重試。`;
    return `研究工作台沒有在執行（http://127.0.0.1:${port} 連不上）。請使用者打開「研究工作台」App 後再試。`;
  }
  if (e instanceof TokenError || e instanceof ToolError) return e.message;
  if (e instanceof ApiErr) {
    if (e.status === 401) return '研究工作台不認得這個 AI 連線（tokens.json 可能被換掉）。請重跑安裝指令。';
    const d = (e.details && typeof e.details === 'object' ? e.details : null) as Details;
    const lines = [`錯誤（${e.status}${e.code ? ` ${e.code}` : ''}）：${e.message}`];
    if (d) {
      if (Array.isArray(d.candidates) && d.candidates.length) lines.push('可能是：', ...bullets(d.candidates));
      if (Array.isArray(d.largeMoves) && d.largeMoves.length) {
        lines.push('需要使用者確認的變動：', ...(d.largeMoves as { text: string }[]).map((m) => `- ${m.text}`));
        lines.push('先在對話中問使用者；使用者同意後才帶 confirmed_by_user=true 重試（同一個 preview_id）。');
      }
      if (e.code === 'USER_CHANGES' && Array.isArray(d.changes)) lines.push('使用者還沒提交的修改：', changeList(d.changes.map(String), 20));
      if (e.code === 'PRICE_OUT_OF_RANGE' && !e.message.includes(String(d.low))) lines.push(`${String(d.date)} 的價格區間：${num(d.low as number)}–${num(d.high as number)}（${String(d.provider)}），你給的價格 ${num(d.price as number)}。確認價格無誤（例如盤後或零股成交）後才帶 confirm_price=true。`);
      if (e.code === 'VERSION_MISMATCH') {
        const since = Array.isArray(d.since) ? (d.since as { actor: string; at: string; kind: string; summary: string }[]) : [];
        if (since.length) lines.push('之後的修改：', changeList(since.slice(-10).map((x) => `${localTime(x.at)} ${zh(x.actor)}：${x.summary || x.kind}`), 10));
        lines.push(`目前草稿版本 v${String(d.currentVersion)}。請重新 get_model 再 dry_run。`);
      }
      if (Array.isArray(d.issues)) lines.push(...bullets(d.issues, 10));
      if (Array.isArray(d.errors)) lines.push(...bullets(d.errors, 10));
      if (Array.isArray(d.matches)) lines.push(...(d.matches as { projectName: string; ticker: string; projectId: string }[]).map((m) => `- ${m.projectName}（${m.ticker}，id: ${m.projectId}）`));
      if (Array.isArray(d.missing)) lines.push(...bullets(d.missing));
      if (e.code === 'IMPORT_DELETED') lines.push(`被刪除的交易：${String(d.tradeId)}（${localTime(d.deletedAt as string)}）`);
    }
    return lines.join('\n');
  }
  return `錯誤：${e instanceof Error ? e.message : String(e)}`;
}
