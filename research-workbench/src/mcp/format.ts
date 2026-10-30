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
import type { Unit } from '../domain/units';
import { actorLabel } from '../shared/actors';
import { UNTRUSTED_BEGIN, UNTRUSTED_END } from '../shared/aiInstructions';
import type {
  AiSessionDTO,
  CatalystDTO,
  CommitPreviewDTO,
  DraftOpsResponse,
  DraftPendingDTO,
  EvidenceDTO,
  KeyOutputsDiffDTO,
  ProjectBundleDTO,
  ProjectSummaryDTO,
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

/** Local date and time of an ISO timestamp (the adapter runs on the same Mac as the server). */
export function localTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const num = (v: number | null | undefined, digits = 4) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits }));

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

export function formatCompanyList(list: readonly ProjectSummaryDTO[], port: number): string {
  if (!list.length) return '研究工作台裡還沒有符合的公司。';
  const lines = [`共 ${list.length} 家公司：`];
  list.forEach((p, i) => {
    const s = p.security;
    const perShare: Unit = { kind: 'per_share', scale: 1, currency: s?.currency || 'TWD' };
    const tp = p.targetPrice ? SCENARIO_IDS.map((sc) => formatValue(p.targetPrice![sc], perShare)).join(' / ') : '—';
    const head = p.head ? `#${p.head.seq}「${p.head.title}」知情日 ${p.head.asOfDate ?? '—'}` : '—';
    lines.push(`${i + 1}. ${p.name}（${s ? `${s.ticker}${s.exchange ? ` · ${s.exchange}` : ''}` : '無代號'}）id: ${p.id}${p.archivedAt ? '（已封存）' : ''}`);
    lines.push(`   股價 ${priceText(p.lastPrice)}｜目標價 空頭/基準/多頭 ${tp}｜最近研究更新 ${head}${p.draftDirty ? '｜草稿有未提交修改' : ''}`);
    lines.push(`   網站：${siteUrl(port, p.id)}`);
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
