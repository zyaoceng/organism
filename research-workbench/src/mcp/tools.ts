/**
 * The MCP tools. Each one is a thin call to the workbench's HTTP API: the server checks units,
 * versions, dates, prices and confirmations (an AI cannot skip them by calling the API in another
 * way), and the tool turns the answer into zh-TW text. Input schemas are zod raw shapes; the draft
 * operations reuse the server's own schema (src/domain/agent/schema.ts).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveNodeRef } from '../domain/agent/resolve';
import { DraftOpSchema } from '../domain/agent/schema';
import { compute, type FrozenOutputs } from '../domain/calc/engine';
import { indexModel } from '../domain/model/tree';
import type { ModelState } from '../domain/model/types';
import {
  SOURCE_TYPES,
  type AiSessionDTO,
  type CatalystDTO,
  type CommitPreviewDTO,
  type DashboardDTO,
  type DraftMetaDTO,
  type DraftOpsResponse,
  type DraftPendingDTO,
  type EvidenceDTO,
  type ProjectBundleDTO,
  type RefreshRunDTO,
  type RevisionFull,
  type RevisionMeta,
  type SecurityMatchDTO,
  type SourceType,
  type SymbolSearchDTO,
  type TradeCloseResponse,
  type TradeDTO,
  type TradeRecordResponse,
  type TradesJournalDTO,
} from '../shared/api';
import { companyLabel, resolveCompany } from './company';
import {
  errorText,
  formatCommitted,
  formatCompanyList,
  formatCompanySummary,
  formatModelOutline,
  formatOpsResult,
  formatPreview,
  formatRefreshStarted,
  formatRefreshStatus,
  formatSession,
  formatTrade,
  formatTradeLog,
  siteUrl,
} from './format';
import { ToolError, type Http, type RequestOptions } from './http';

export const TOOL_NAMES = [
  'list_companies',
  'get_company',
  'get_model',
  'edit_draft',
  'add_evidence',
  'preview_commit',
  'commit_research_update',
  'record_trade',
  'close_trade',
  'save_session_summary',
  'list_trades',
  'refresh_prices',
  'get_refresh_status',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolContext {
  /** Port of the workbench, for links to the website. */
  port: number;
  /** Today's local date (YYYY-MM-DD). */
  today?: () => string;
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const companyRef = z.string().trim().min(1).max(200).describe('公司：id、股票代號（2301）或名稱');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式 YYYY-MM-DD');
const SOURCE_TYPE_VALUES = SOURCE_TYPES.map((s) => s.value) as [SourceType, ...SourceType[]];
const TRADE_STATUS_ZH = { all: '全部', open: '未平倉', closed: '已平倉' } as const;

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Every request of a tool carries its name (x-workbench-tool) for the AI activity log. */
function scoped(http: Http, tool: string): Http {
  return {
    get: <T>(p: string, o?: RequestOptions) => http.get<T>(p, { tool, ...o }),
    post: <T>(p: string, b?: unknown, o?: RequestOptions) => http.post<T>(p, b, { tool, ...o }),
    patch: <T>(p: string, b?: unknown, o?: RequestOptions) => http.patch<T>(p, b, { tool, ...o }),
  };
}

const bareTicker = (t: string) =>
  t
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/\.(TW|TWO)$/, '');

export function registerTools(server: McpServer, http: Http, ctx: ToolContext): void {
  const { port } = ctx;
  const today = ctx.today ?? (() => localDate());

  function define<S extends z.ZodRawShape>(
    name: ToolName,
    spec: { title: string; description: string; annotations: ToolAnnotations; input: S },
    fn: (args: z.output<z.ZodObject<S>>, h: Http) => Promise<string>,
  ) {
    const h = scoped(http, name);
    const cb = async (args: z.output<z.ZodObject<S>>) => {
      try {
        return { content: [{ type: 'text' as const, text: await fn(args, h) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: errorText(e, port) }] };
      }
    };
    // the SDK's callback type cannot be inferred through a generic shape; `cb` is typed from it above
    server.registerTool(name, { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: { title: spec.title, ...spec.annotations } }, cb as never);
  }

  const pid = (p: { id: string }) => encodeURIComponent(p.id);

  // ------------------------------------------------------------ reading

  define(
    'list_companies',
    {
      title: '列出公司',
      description:
        '跨公司總覽（和網站首頁相同）：每家公司的代號、股價（日期、是否過期）、最近一次研究更新（標題、知情日）和它的三情境目標價、機率加權目標價與上檔空間、草稿是否有未提交修改、未平倉部位、過期的催化劑、到了檢查日的論點，以及網站連結。股價是快取的；要抓最新股價先用 refresh_prices。',
      annotations: READ,
      input: {
        include_archived: z.boolean().optional().describe('也列出已封存的公司'),
        query: z.string().trim().max(100).optional().describe('只列名稱或代號包含這段文字的公司'),
      },
    },
    async ({ include_archived, query }, h) => {
      const dash = await h.get<DashboardDTO>('/api/dashboard');
      let rows = dash.rows;
      if (!include_archived) rows = rows.filter((r) => !r.archivedAt);
      const q = query?.normalize('NFKC').toLowerCase();
      if (q) rows = rows.filter((r) => [r.name, r.security?.name, r.security?.ticker, r.security?.apiSymbol].some((x) => x?.normalize('NFKC').toLowerCase().includes(q)));
      return formatCompanyList(rows, port, { today: dash.today, refreshing: dash.refresh?.state === 'running' });
    },
  );

  define(
    'get_company',
    {
      title: '公司概況',
      description: '一家公司的概況：重點數字（草稿對比最近一次研究更新）、草稿裡未提交的修改與是誰改的、有效的論點、未平倉交易、接下來的催化劑、最近的研究更新與證據（含 id）、最近的 AI 對話摘要。',
      annotations: READ,
      input: { company: companyRef },
    },
    async ({ company }, h) => {
      const s = await resolveCompany(h, company);
      const id = pid(s);
      const [bundle, trades, catalysts, revisions, pending, sessions, evidence] = await Promise.all([
        h.get<ProjectBundleDTO>(`/api/projects/${id}`),
        h.get<TradeDTO[]>(`/api/projects/${id}/trades`),
        h.get<CatalystDTO[]>(`/api/projects/${id}/catalysts`),
        h.get<RevisionMeta[]>(`/api/projects/${id}/revisions`),
        h.get<DraftPendingDTO>(`/api/projects/${id}/draft/pending`),
        h.get<AiSessionDTO[]>(`/api/ai/sessions?projectId=${id}&limit=3`),
        h.get<EvidenceDTO[]>(`/api/projects/${id}/evidence`),
      ]);
      return formatCompanySummary({
        summary: s,
        bundle,
        draftCalc: compute(bundle.draft.state),
        headCalc: compute(bundle.head.state),
        trades,
        catalysts,
        revisions,
        pending,
        sessions,
        evidence,
        port,
        today: today(),
      });
    },
  );

  define(
    'get_model',
    {
      title: '讀取模型',
      description:
        '以樹狀大綱讀取模型：每個節點的單位、角色、公式與 id（‹n_…›），以及每個期間的數值（ƒ 公式結果、✎ 手填值蓋過公式、⚠ 錯誤、— 空白；A 實際、E 預估）。預設讀草稿的基準情境；source="head" 讀最近一次研究更新，revision_seq 讀指定的研究更新。模型很大時用 subtree 只讀一個分支。',
      annotations: READ,
      input: {
        company: companyRef,
        source: z.enum(['draft', 'head']).default('draft').describe('draft：目前的草稿（預設）；head：最近一次研究更新'),
        revision_seq: z.number().int().min(1).optional().describe('讀第幾號研究更新（#1、#2…）'),
        subtree: z.string().trim().min(1).max(400).optional().describe('只讀這個節點和它底下的節點（名稱、路徑或 id）'),
        scenario: z.enum(['base', 'bear', 'bull', 'all']).default('base').describe('情境；all 會另外列出空頭、多頭和基準不同的格'),
        include_notes: z.boolean().optional().describe('一併列出節點的筆記'),
      },
    },
    async (a, h) => {
      const s = await resolveCompany(h, a.company);
      const id = pid(s);
      const b = await h.get<ProjectBundleDTO>(`/api/projects/${id}`);
      let state: ModelState = b.draft.state;
      let frozen: FrozenOutputs['values'] | undefined;
      let source = `草稿 v${b.draft.version}`;
      let rev: RevisionFull | null = null;
      if (a.revision_seq !== undefined) {
        const revs = await h.get<RevisionMeta[]>(`/api/projects/${id}/revisions`);
        const meta = revs.find((r) => r.seq === a.revision_seq);
        if (!meta) throw new ToolError(`沒有研究更新 #${a.revision_seq}；這家公司有 #1 到 #${revs.at(-1)?.seq ?? 0}。`);
        rev = await h.get<RevisionFull>(`/api/projects/${id}/revisions/${encodeURIComponent(meta.id)}`);
      } else if (a.source === 'head') rev = b.head;
      if (rev) {
        state = rev.state;
        frozen = rev.computed.values;
        source = `研究更新 #${rev.seq}「${rev.title}」知情日 ${rev.asOfDate ?? '—'}，提交時的數字`;
      }
      let subtreeId: string | null = null;
      if (a.subtree) {
        const r = resolveNodeRef(indexModel(state), a.subtree);
        if (!r.ok) throw new ToolError(`${r.message}${r.candidates.length ? `\n${r.candidates.map((c) => `- ${c}`).join('\n')}` : ''}`);
        subtreeId = r.id;
      }
      const text = formatModelOutline(state, compute(state), { title: s.name, source, scenario: a.scenario, subtreeId, includeNotes: a.include_notes, frozen, draftVersion: b.draft.version });
      return `${text}\n網站：${siteUrl(port, s.id, 'model')}`;
    },
  );

  // ------------------------------------------------------------ the draft

  define(
    'edit_draft',
    {
      title: '修改草稿',
      description: [
        '修改公司的草稿模型（不會提交研究更新）。ops 依序套用；任何一個失敗就全部不寫入，錯誤會說明是哪一個、可能是哪些節點。',
        '流程：先 dry_run=true 預覽（回傳每格前後的數值與單位、EPS 與目標價前後、新出現的問題），把預覽給使用者看，再用同一組 ops、dry_run=false、expected_version=預覽回傳的版本寫入。',
        '節點用名稱、路徑「父/子」或 get_model 列出的 id（‹n_…›）；期間用 FY2026、2026 或 2026E；單一數值的節點不填 period。',
        '數值一定帶單位：百分比 "18.5%"（不要寫 0.185）；金額 "1,234 億"、"2,345 百萬"、"12,345 仟元"（照原文的單位寫，伺服器會換算，不要自己換算）；倍數 "25x"；每股 "12.3 元"；股數 "3,000 股"；null 清空。',
        '實際期（A）三種情境共用，只能用 scenario=base（不填就是 base）修改；空頭 / 多頭只能改預估期（E）。由公式計算的格不能直接填數字，除非帶 allow_override_formula=true。',
        '操作：set_value、set_values（values 是 {期間: 數值}）、set_formula（用節點名稱寫，例如 "[營收] * [毛利率]"，要用前期請寫 PREV([營收])；null 移除公式）、add_node、rename_node、move_node、delete_node、set_notes、link_evidence（evidence_id 來自 add_evidence）、add_thesis、update_thesis、set_rationale、add_peer。',
      ].join('\n'),
      annotations: WRITE,
      input: {
        company: companyRef,
        ops: z.array(DraftOpSchema).min(1).max(100).describe('要套用的操作，依序執行'),
        dry_run: z.boolean().default(false).describe('true：只預覽、不寫入'),
        expected_version: z.number().int().positive().optional().describe('正式寫入時必填：dry_run 回傳的草稿版本'),
        rationale: z.string().trim().min(1).max(2000).describe('為什麼這樣改（會記在網站的草稿紀錄）'),
      },
    },
    async (a, h) => {
      if (!a.dry_run && a.expected_version === undefined) {
        throw new ToolError('正式寫入（dry_run=false）必須帶 expected_version：先用 dry_run=true 預覽同一組 ops，回傳的最後一行有版本號。');
      }
      const s = await resolveCompany(h, a.company);
      const r = await h.post<DraftOpsResponse>(`/api/projects/${pid(s)}/draft/ops`, { ops: a.ops, dryRun: a.dry_run, expectedVersion: a.expected_version, rationale: a.rationale });
      return formatOpsResult(r, port);
    },
  );

  define(
    'add_evidence',
    {
      title: '新增證據',
      description:
        '新增一份證據（新聞、財報、法說、研究報告…）。發布日期 published_at 必填、不能晚於今天，網站會標示「日期由 AI 提供」；不知道日期就先問使用者。可用 link_to 同時把它連結到草稿的節點。回傳的證據 id 可用在 edit_draft 的 link_evidence 與 preview_commit 的 evidence_ids（回溯日期的提交必須引用發布日不晚於知情日的證據）。',
      annotations: WRITE,
      input: {
        company: companyRef,
        title: z.string().trim().min(1).max(500),
        published_at: isoDate.describe('來源的發布日期 YYYY-MM-DD（必填，不能晚於今天）'),
        source_type: z.enum(SOURCE_TYPE_VALUES).describe('來源類型'),
        source_name: z.string().trim().max(200).optional().describe('來源名稱（媒體、券商、公司）'),
        url: z.string().trim().max(2000).optional().describe('網址（http:// 或 https://）'),
        notes: z.string().max(100_000).optional().describe('重點摘要或摘錄'),
        verification: z.enum(['unverified', 'verified', 'disputed']).default('unverified'),
        link_to: z
          .array(
            z.object({
              node: z.string().trim().min(1).max(400).describe('節點名稱、路徑或 id'),
              relation: z.enum(['supports', 'contradicts', 'context', 'triggered']).optional(),
              locator: z.string().max(200).optional().describe('頁碼、投影片或時間點'),
              note: z.string().max(10_000).optional(),
            }),
          )
          .max(20)
          .optional()
          .describe('同時連結到草稿的這些節點'),
      },
    },
    async (a, h) => {
      const s = await resolveCompany(h, a.company);
      const id = pid(s);
      const ev = await h.post<EvidenceDTO>(`/api/projects/${id}/evidence`, {
        title: a.title,
        publishedAt: a.published_at,
        sourceType: a.source_type,
        sourceName: a.source_name,
        url: a.url,
        notes: a.notes,
        verification: a.verification,
      });
      const lines = [`已新增證據 ‹${ev.id}›「${ev.title}」，發布日 ${ev.publishedAt ?? '—'}${ev.publishedAtSource === 'agent-asserted' ? '（網站會標示日期由 AI 提供）' : ''}。`];
      if (a.link_to?.length) {
        try {
          // read the version just before linking; a save in between is reported, not overwritten
          const meta = await h.get<DraftMetaDTO>(`/api/projects/${id}/draft/meta`);
          const r = await h.post<DraftOpsResponse>(`/api/projects/${id}/draft/ops`, {
            ops: a.link_to.map((l) => ({ op: 'link_evidence', node: l.node, evidence_id: ev.id, relation: l.relation, locator: l.locator, note: l.note })),
            expectedVersion: meta.version,
            dryRun: false,
            rationale: `連結證據「${ev.title}」`,
          });
          lines.push(`已連結到草稿（版本 v${r.version}）：`, ...r.results.flatMap((x) => x.description).map((d) => `- ${d}`));
        } catch (e) {
          lines.push(`但連結到節點失敗（證據本身已經存好，不要重複新增）：`, errorText(e, port), `可以改用 edit_draft 的 link_evidence（evidence_id="${ev.id}"）連結。`);
        }
      }
      lines.push(`網站：${siteUrl(port, s.id, 'evidence', ev.id)}`);
      return lines.join('\n');
    },
  );

  // ------------------------------------------------------------ commits

  define(
    'preview_commit',
    {
      title: '預覽提交',
      description:
        '預覽把草稿提交成研究更新的結果：修改清單（含是誰改的）、EPS 與目標價前後、要記錄的股價、是否需要使用者確認，並回傳 preview_id（15 分鐘內有效）。不會寫入任何東西。把預覽給使用者看並取得同意後，才用 commit_research_update 提交。草稿裡有使用者還沒提交的修改時會被擋下。',
      annotations: READ,
      input: {
        company: companyRef,
        as_of_date: isoDate.optional().describe('知情日期（預設今天；不能晚於今天；早於今天時必須在 evidence_ids 引用發布日不晚於那天的證據）'),
        kind: z.enum(['update', 'checkpoint']).optional().describe('update：看法有修改；checkpoint：重新檢查、數字不變'),
        evidence_ids: z.array(z.string().trim().min(1).max(100)).max(50).optional().describe('這次研究更新引用的證據 id'),
      },
    },
    async (a, h) => {
      const s = await resolveCompany(h, a.company);
      const d = await h.post<CommitPreviewDTO>(`/api/projects/${pid(s)}/revisions/preview`, { asOfDate: a.as_of_date, kind: a.kind, evidenceIds: a.evidence_ids });
      return formatPreview(d, port);
    },
  );

  define(
    'commit_research_update',
    {
      title: '提交研究更新',
      description:
        '把 preview_commit 預覽過的草稿提交成研究更新。提交後永久保存、不能修改或刪除。先把預覽給使用者看並取得同意；預覽說需要使用者確認時，先在對話裡問使用者，使用者明確同意後才帶 confirmed_by_user=true。草稿在預覽後又被改過、或預覽過期（15 分鐘），要重新 preview_commit。',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      input: {
        preview_id: z.string().trim().min(1).max(100).describe('preview_commit 回傳的 preview_id'),
        title: z.string().trim().min(1).max(200).describe('標題，例如「Q3 法說：上調 2027 年毛利率」'),
        reason: z.string().trim().min(1).max(20_000).describe('為什麼看法改變（或為什麼不變）'),
        notes: z.string().max(100_000).optional(),
        confirmed_by_user: z.boolean().optional().describe('只有預覽說需要確認、而且使用者在對話中明確同意時才帶 true'),
      },
    },
    async (a, h) => {
      const p = await h.get<{ projectId: string; expiresAt: string; needsConfirmation: boolean }>(`/api/commit-previews/${encodeURIComponent(a.preview_id)}`);
      const rev = await h.post<RevisionFull>(`/api/projects/${encodeURIComponent(p.projectId)}/revisions`, {
        previewId: a.preview_id,
        title: a.title,
        reason: a.reason,
        notes: a.notes,
        confirmedByUser: a.confirmed_by_user === true,
      });
      return formatCommitted(rev, port);
    },
  );

  // ------------------------------------------------------------ trades

  define(
    'record_trade',
    {
      title: '記錄交易',
      description: [
        '記錄一筆交易（可含出場）。用 company 指定公司，或只給 ticker：會跨公司找持有這個代號的公司。找不到時，先問使用者要不要新建公司，同意後帶 create_company={ name, confirmed_by_user: true }。',
        '數量用股數 quantity_shares；台股 1 張 = 1000 股（3 張寫 3000）。日期不能在未來。',
        '價格超出當天 K 棒高低會被拒絕；和使用者確認價格無誤後才帶 confirm_price=true。',
        '匯入舊日誌用 source="import" 並附 source_text（原文），只填原文有的數字，不要補停損或目標價；缺日期、數量或價格就問使用者。重複匯入同一段原文會回傳既有那筆；那筆被刪除過時要使用者同意才帶 allow_reimport=true。',
      ].join('\n'),
      annotations: WRITE,
      input: {
        company: companyRef.optional(),
        ticker: z.string().trim().min(1).max(40).optional().describe('股票代號（2330、2330.TW、AAPL）；沒給 company 時用它找公司'),
        side: z.enum(['long', 'short']).describe('long 買進做多；short 放空'),
        entry_date: isoDate.describe('進場日 YYYY-MM-DD'),
        entry_price: z.number().positive().describe('進場價（每股）'),
        quantity_shares: z.number().positive().describe('股數（台股 1 張 = 1000 股）'),
        entry_reason: z.string().max(10_000).optional(),
        stop: z.number().positive().optional().describe('進場時的停損價'),
        target: z.number().positive().optional().describe('進場時的目標價'),
        fees: z.number().min(0).optional().describe('手續費與稅（總額）'),
        notes: z.string().max(10_000).optional(),
        confirm_price: z.boolean().optional().describe('價格超出當天 K 棒範圍、且使用者確認無誤時才帶 true'),
        source: z.enum(['entry', 'import']).default('entry').describe('entry：現在記錄；import：從舊日誌匯入'),
        source_text: z.string().max(20_000).optional().describe('import 時必填：日誌原文'),
        exit_date: isoDate.optional(),
        exit_price: z.number().positive().optional(),
        exit_reason: z.string().max(10_000).optional(),
        allow_reimport: z.boolean().optional().describe('這段原文匯入的交易被刪除過、而使用者同意再匯入一次時才帶 true'),
        create_company: z
          .object({ name: z.string().trim().min(1).max(200).describe('公司名稱'), confirmed_by_user: z.literal(true).describe('使用者同意新建這家公司') })
          .optional()
          .describe('找不到公司、且使用者同意新建時才給'),
      },
    },
    async (a, h) => {
      let projectId: string;
      let created: string | null = null;
      if (a.company) projectId = (await resolveCompany(h, a.company)).id;
      else if (a.ticker) {
        const matches = await h.get<SecurityMatchDTO[]>(`/api/securities/lookup?ticker=${encodeURIComponent(a.ticker)}`);
        const active = matches.filter((m) => !m.archived);
        const pick = active.length ? active : matches;
        if (pick.length > 1) {
          throw new ToolError(`代號 ${a.ticker} 在 ${pick.length} 家公司裡都有：${pick.map((m) => `${m.projectName}（id: ${m.projectId}）`).join('、')}。請用 company 指定要記在哪一家。`);
        }
        if (pick.length === 1) projectId = pick[0].projectId;
        else if (!a.create_company) {
          throw new ToolError(`研究工作台裡沒有代號 ${a.ticker} 的公司。要新建公司，先問使用者，同意後帶 create_company={ name: "公司名稱", confirmed_by_user: true } 再呼叫一次。`);
        } else {
          const r = await createCompany(h, a.ticker, a.create_company.name);
          projectId = r.id;
          created = r.label;
        }
      } else throw new ToolError('請給 company（公司 id、代號或名稱）或 ticker（股票代號）。');

      const r = await h.post<TradeRecordResponse>(`/api/projects/${encodeURIComponent(projectId)}/trades`, {
        side: a.side,
        entryDate: a.entry_date,
        entryPrice: a.entry_price,
        quantityShares: a.quantity_shares,
        entryReason: a.entry_reason,
        stopAtEntry: a.stop,
        targetPriceAtEntry: a.target,
        fees: a.fees,
        notes: a.notes,
        confirmPrice: a.confirm_price,
        source: a.source,
        sourceText: a.source_text,
        exitDate: a.exit_date,
        exitPrice: a.exit_price,
        exitReason: a.exit_reason,
        allowReimport: a.allow_reimport,
      });
      if (!r.trade) return r.warnings.join('\n') || '沒有記錄交易。';
      const heading =
        r.status === 'existing'
          ? '這段日誌已存在（之前匯入過），沒有新增；這是既有的那筆：'
          : `${created ? `已新建公司 ${created}。\n` : ''}已記錄交易${r.trade.source === 'import' ? '（從舊日誌匯入）' : ''}：`;
      return formatTrade(r.trade, r.warnings, port, heading);
    },
  );

  /** A new company for a ticker nobody holds yet, after the user agreed (the server checks both). */
  async function createCompany(h: Http, ticker: string, name: string): Promise<{ id: string; label: string }> {
    const found = await h.get<SymbolSearchDTO>(`/api/symbols/search?q=${encodeURIComponent(ticker)}`);
    const t = bareTicker(ticker);
    const m = found.results.find((x) => bareTicker(x.ticker) === t || bareTicker(x.apiSymbol) === t);
    if (!m) {
      throw new ToolError(`查不到代號 ${ticker} 的股票資料${found.errors.length ? `（${found.errors.join('；')}）` : ''}，沒有建立公司。請使用者在網站手動建立。`);
    }
    const { id } = await h.post<{ id: string }>('/api/projects', {
      name,
      lang: 'zh-TW',
      confirmedByUser: true,
      security: { name: m.name, ticker: m.ticker, exchange: m.exchange, apiSymbol: m.apiSymbol, currency: m.currency || 'TWD', priceSource: m.suggestedProvider },
    });
    return { id, label: `${name}（${m.ticker} · ${m.exchange}，id: ${id}）` };
  }

  define(
    'close_trade',
    {
      title: '記錄出場',
      description: '替一筆交易填出場日、出場價與理由（只能改出場資料）。價格超出當天 K 棒高低會被拒絕；和使用者確認後才帶 confirm_price=true。交易 id 可從 get_company 的未平倉交易取得。',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: {
        trade_id: z.string().trim().min(1).max(100),
        exit_date: isoDate.describe('出場日 YYYY-MM-DD'),
        exit_price: z.number().positive().describe('出場價（每股）'),
        exit_reason: z.string().max(10_000).optional(),
        fees: z.number().min(0).optional().describe('手續費與稅（整筆交易的總額）'),
        confirm_price: z.boolean().optional(),
      },
    },
    async (a, h) => {
      const r = await h.patch<TradeCloseResponse>(`/api/trades/${encodeURIComponent(a.trade_id)}`, {
        exitDate: a.exit_date,
        exitPrice: a.exit_price,
        exitReason: a.exit_reason,
        fees: a.fees,
        confirmPrice: a.confirm_price,
      });
      return formatTrade(r.trade, r.warnings, port, '已記錄出場：');
    },
  );

  define(
    'list_trades',
    {
      title: '交易紀錄',
      description:
        '跨公司的交易日誌：每筆交易的進出場、報酬、損益、R 倍數、持有天數、MFE/MAE、追蹤停損的對照、進場時連結的研究更新與檢討，前面附摘要（各幣別的勝率與損益、平均 R、還沒檢討的交易、檢討裡的錯誤類型）。金額依股票的幣別分開列，不換算也不跨幣別加總；不要自己把不同幣別的金額加起來。可用 status、company 與 from / to（進場日）篩選。',
      annotations: READ,
      input: {
        status: z.enum(['all', 'open', 'closed']).default('all').describe('all：全部（預設）；open：未平倉；closed：已平倉'),
        company: companyRef.optional().describe('只列這家公司：id、股票代號（2301）或名稱'),
        from: isoDate.optional().describe('進場日從這天起（含）YYYY-MM-DD'),
        to: isoDate.optional().describe('進場日到這天為止（含）YYYY-MM-DD'),
      },
    },
    async (a, h) => {
      if (a.from && a.to && a.from > a.to) throw new ToolError(`from（${a.from}）不能晚於 to（${a.to}）。`);
      const company = a.company ? await resolveCompany(h, a.company) : null;
      const q = new URLSearchParams({ status: a.status });
      if (company) q.set('projectId', company.id);
      if (a.from) q.set('from', a.from);
      if (a.to) q.set('to', a.to);
      const r = await h.get<TradesJournalDTO>(`/api/trades?${q}`);
      const scope = [
        TRADE_STATUS_ZH[a.status],
        company ? companyLabel(company) : '全部公司',
        a.from || a.to ? `進場日 ${a.from ?? '最早'} 到 ${a.to ?? '最新'}` : null,
      ]
        .filter(Boolean)
        .join('｜');
      return formatTradeLog(r.trades, port, { scope });
    },
  );

  // ------------------------------------------------------------ prices

  define(
    'refresh_prices',
    {
      title: '更新全部股價',
      description:
        '在背景更新股價（和網站首頁的「更新全部股價」相同）：每家進行中公司的股票，加上有未平倉交易的股票，抓日 K 線並更新報價。會立刻回傳、不等更新完成：之後每隔幾秒用 get_refresh_status 查進度，完成後再用 list_companies 讀新的股價。已經有一次在進行中時回傳那一次，不會重複啟動。',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      input: {},
    },
    async (_a, h) => {
      // the server returns a run already in progress instead of starting another; tell the two apart
      const before = await h.get<RefreshRunDTO | null>('/api/market/refresh');
      const run = await h.post<RefreshRunDTO>('/api/market/refresh');
      return formatRefreshStarted(run, before?.state === 'running' && before.id === run.id);
    },
  );

  define(
    'get_refresh_status',
    {
      title: '股價更新進度',
      description: '查「更新全部股價」（refresh_prices 或網站首頁的按鈕）的進度與結果：成功、失敗、達到請求上限與略過的檔數，每個股價來源的狀態，以及沒有更新的股票和原因。',
      annotations: READ,
      input: {},
    },
    async (_a, h) => formatRefreshStatus(await h.get<RefreshRunDTO | null>('/api/market/refresh'), port),
  );

  // ------------------------------------------------------------ sessions

  define(
    'save_session_summary',
    {
      title: '存對話摘要',
      description:
        '把這段對話的結論存進研究工作台（網站的「AI 活動」會顯示）。做完重要的事（改模型、提交、記交易、得出結論）之後，以及使用者說要結束時呼叫。寫清楚：結論與理由、做了哪些決定、還要做什麼；用使用者的語言。',
      annotations: WRITE,
      input: {
        summary: z.string().trim().min(1).max(20_000).describe('結論摘要'),
        decisions: z.string().max(20_000).optional().describe('做了哪些決定'),
        todo: z.string().max(20_000).optional().describe('待辦'),
        companies: z.array(companyRef).max(20).optional().describe('相關的公司'),
      },
    },
    async (a, h) => {
      const projectIds: string[] = [];
      for (const c of a.companies ?? []) {
        const p = await resolveCompany(h, c);
        if (!projectIds.includes(p.id)) projectIds.push(p.id);
      }
      const s = await h.post<AiSessionDTO>('/api/ai/sessions/summary', { summary: a.summary, decisions: a.decisions, todo: a.todo, projectIds });
      return formatSession(s, port);
    },
  );
}
