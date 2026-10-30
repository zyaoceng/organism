import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { DraftOpsRequestSchema } from '../domain/agent/schema';
import { ModelOpError } from '../domain/model/ops';
import type { ModelState, ScenarioId } from '../domain/model/types';
import { defaultScaleFor, STANDARD_TEMPLATE_ID, STANDARD_TEMPLATE_NAME, standardTemplate, structureOnly } from '../domain/templates/standard';
import type { FrozenOutputs } from '../domain/calc/engine';
import { describeChange } from '../domain/revision/describe';
import { agentClientOf, isAgentActor, type Actor, type AgentClient } from '../shared/actors';
import type { CommitPreviewDTO, DashboardDTO, DiagnosticsDTO, DraftMetaDTO, HeartbeatDTO, ProjectBundleDTO, RefreshRunDTO, SeriesPoint, SessionDTO, TradesJournalDTO } from '../shared/api';
import { currentActor, installActorHooks, NO_ACTOR_MESSAGE, noteAiAction, quietRequest, SESSION_COOKIE } from './actor';
import { openDatabase, schemaVersion, type DB } from './db/connection';
import { CsvProvider } from './market/csv';
import { DemoProvider } from './market/demo';
import { MarketDataError, type MarketDataProvider } from './market/provider';
import { PriceRefresher } from './market/refreshAll';
import { MarketService, type MarketServiceOptions } from './market/service';
import { FinMindProvider } from './market/finmind';
import { FugleProvider } from './market/fugle';
import { loadFinMindDirectory, loadIsinDirectory, SymbolSearch } from './market/symbols';
import { YahooChartProvider } from './market/yahoo';
import { listAiClients, listAiSessions, saveSessionSummary, touchAiClient } from './repos/aiSessions';
import { addAnnotation, excludedSet, listAnnotations } from './repos/annotations';
import { listAudit } from './repos/audit';
import { draftPending, evidenceTitler, lastDraftOp, listDraftOps, pendingAttribution, periodLabeller, pruneDraftOps, recoverDraft } from './repos/draftOps';
import { barsMeta } from './repos/market';
import { dbGeneration } from './repos/meta';
import { buildDashboard, listJournalTrades } from './repos/portfolio';
import {
  createProject,
  getDraft,
  getProject,
  getRevisionRow,
  getSecurity,
  listProjectSummaries,
  listRevisionRows,
  listRevisions,
  listSecurities,
  resetDraftTo,
  revisionAsOf,
  saveDraft,
  toRevisionFull,
  toRevisionMeta,
  updateProject,
  updateSecurity,
  getDraftRow,
  primarySecurity,
} from './repos/projects';
import {
  addEvidenceAttachments,
  createCatalyst,
  createEvidence,
  createNote,
  createReview,
  createTrade,
  deleteCatalyst,
  deleteEvidence,
  deleteNote,
  deleteReview,
  deleteTemplate,
  deleteTrade,
  getEvidence,
  getSavedTemplateState,
  listCatalysts,
  listEvidence,
  listNotes,
  listReviews,
  listSavedTemplates,
  listTrades,
  saveTemplate,
  setEvidenceArchived,
  updateCatalyst,
  updateEvidence,
  updateNote,
  updateReview,
  updateTrade,
  type EvidenceInput,
} from './repos/records';
import { checkAgentProjectCreate, closeAgentTrade, findSecurities, recordAgentTrade } from './services/agentRecords';
import { BackupService } from './services/backup';
import { commitDraft, previewCommit, type CommitInput, type PreviewInput } from './services/commit';
import { CommitPreviewStore } from './services/commitPreviews';
import { applyDraftOps } from './services/draftOps';
import { AttachmentStore, INLINE_SAFE, sanitizeFilename } from './storage/attachments';
import { loadOrCreateTokens, type TokenSet } from './tokens';
import { badRequest, conflict, errorCode, forbidden, HttpError, isDate, localToday, notFound, nowIso } from './util';
import { APP_ROOT, readVersion } from './version';

export interface AppOptions {
  dataDir: string;
  /** Override providers (tests). Defaults: yahoo, finmind, fugle (when FUGLE_API_KEY is set), demo, csv. */
  providers?: MarketDataProvider[];
  /** Override the symbol search (tests). */
  symbolSearch?: SymbolSearch;
  /** Fastify logger: false, true (info) or a level such as { level: 'warn' }. */
  logger?: boolean | { level: string };
  /** Directory with the built client to serve at / (optional). */
  clientDir?: string;
  maxUploadBytes?: number;
  /** Daily and pre-migration backups. Default <dataDir>/backups. */
  backupDir?: string;
  /** Run the daily backup check at startup and every hour (main.ts). Default false. */
  startBackups?: boolean;
  /**
   * Accepted Host headers ("127.0.0.1:4310"). When set, other hosts are refused (DNS rebinding), and a
   * request with an Origin header must come from http://<allowed host> or one of allowedOrigins.
   * Unset (tests, app.inject): no check.
   */
  allowedHosts?: string[];
  /** Extra origins accepted when allowedHosts is set, e.g. 'app://obsidian.md'. */
  allowedOrigins?: string[];
  /** Where version.json lives. Default: the research-workbench directory. */
  appRoot?: string;
  /** Who-is-acting tokens. Default <dataDir>/tokens.json (created when missing). */
  tokensFile?: string;
  /** Market cache and throttle settings (tests use minIntervalMs: 0). */
  market?: MarketServiceOptions;
}

export interface AppContext {
  app: FastifyInstance;
  db: DB;
  attachments: AttachmentStore;
  market: MarketService;
  backups: BackupService;
  /** tokens.json: `tokens.tokens.user`, `tokens.tokens['claude-desktop']`, … */
  tokens: TokenSet;
  previews: CommitPreviewStore;
  /** "Update all prices" background runs. */
  refresher: PriceRefresher;
}

type Params = { id: string };

export async function buildApp(opts: AppOptions): Promise<AppContext> {
  const startedAt = Date.now();
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const dbFile = path.join(opts.dataDir, 'workbench.db');
  const backupDir = opts.backupDir ?? path.join(opts.dataDir, 'backups');
  const version = readVersion(opts.appRoot ?? APP_ROOT);
  const db = openDatabase(dbFile, { backupDir });
  const tokens = loadOrCreateTokens(opts.tokensFile ?? path.join(opts.dataDir, 'tokens.json'));
  const previews = new CommitPreviewStore();
  pruneDraftOps(db);
  const attachments = new AttachmentStore(db, path.join(opts.dataDir, 'attachments'));
  const yahoo = new YahooChartProvider();
  const finmind = new FinMindProvider();
  const fugleKey = process.env.FUGLE_API_KEY?.trim();
  const providers = opts.providers ?? [yahoo, finmind, ...(fugleKey ? [new FugleProvider(fugleKey)] : []), new DemoProvider(), new CsvProvider()];
  const symbols =
    opts.symbolSearch ??
    new SymbolSearch({
      // FinMind's list covers listed, OTC and emerging stocks; TWSE's ISIN pages are the fallback.
      taiwanDirectory: () => loadFinMindDirectory(finmind).catch(() => loadIsinDirectory()),
      yahooSearch: (q) => yahoo.search(q),
    });
  const market = new MarketService(db, Object.fromEntries(providers.map((p) => [p.id, p])), opts.market);
  const synthetic = market.syntheticIds();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  const backups = new BackupService(db, backupDir, { onError: (err) => app.log.error({ err }, 'daily backup failed') });
  const refresher = new PriceRefresher(db, market, { onError: (err) => app.log.error({ err }, 'price refresh failed') });
  await app.register(fastifyMultipart, { limits: { fileSize: opts.maxUploadBytes ?? 100 * 1024 * 1024, files: 20, fields: 50 } });

  if (opts.allowedHosts) {
    // The API has no login; only the local app (or a listed client) may call it, never another web page.
    const hosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
    const origins = new Set([...[...hosts].map((h) => `http://${h}`), ...(opts.allowedOrigins ?? []).map((o) => o.toLowerCase())]);
    app.addHook('onRequest', async (req, reply) => {
      if (!hosts.has((req.headers.host ?? '').toLowerCase())) return reply.status(403).send({ error: 'Host not allowed' });
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin.toLowerCase())) return reply.status(403).send({ error: 'Origin not allowed' });
    });
  }
  // who is acting (user, AI client or nobody known); after the Host check
  installActorHooks(app, tokens, db);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: errorCode(err), details: err.details ?? null });
    if (err instanceof ModelOpError) return reply.status(400).send({ error: err.message });
    if (err instanceof MarketDataError) return reply.status(err.code === 'NOT_FOUND' ? 404 : 502).send({ error: err.message, code: err.code });
    const e = err as { statusCode?: number; message: string; code?: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'File is too large' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    req.log.error(err);
    return reply.status(500).send({ error: `Unexpected server error: ${e.message}` });
  });

  const body = <T>(req: FastifyRequest) => (req.body ?? {}) as T;

  /** Read a multipart request: text fields + files stored as attachments. */
  async function readMultipart(req: FastifyRequest) {
    const fields: Record<string, string> = {};
    const files: { attachmentId: string; filename: string; mime: string; text?: string }[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (!buf.length) continue;
        const row = attachments.save(buf, part.filename || 'file', part.mimetype);
        files.push({ attachmentId: row.id, filename: row.original_filename, mime: row.mime_type });
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    return { fields, files };
  }

  async function readUploadedText(req: FastifyRequest): Promise<{ text: string; filename: string }> {
    for await (const part of req.parts()) {
      if (part.type === 'file') return { text: (await part.toBuffer()).toString('utf8'), filename: sanitizeFilename(part.filename || 'upload.csv') };
    }
    throw badRequest('No file uploaded');
  }

  const projectOf = (projectId: string) => getProject(db, projectId);

  /** The AI client making this request, or 403 for anyone else. */
  const agentOnly = (req: FastifyRequest): AgentClient => {
    const client = agentClientOf(req.actor);
    if (!client) throw forbidden('Only an AI client can call this', { code: 'AGENT_ONLY' });
    return client;
  };

  /** An AI may not throw away or replace draft edits the user has not committed. */
  const guardAgentDraftReset = (req: FastifyRequest, projectId: string, version: unknown) => {
    if (!isAgentActor(req.actor)) return;
    if (typeof version !== 'number') throw badRequest('AI 必須帶草稿版本 version', { code: 'EXPECTED_VERSION_REQUIRED' });
    const a = pendingAttribution(db, projectId);
    if (a.userOwned.length) {
      const periodLabel = periodLabeller(JSON.parse(a.draft.state_json));
      const evidenceTitle = evidenceTitler(db, projectId);
      const texts = a.userOwned.map((c) => describeChange(c, { lang: 'zh-TW', periodLabel, evidenceTitle }));
      throw conflict(`草稿裡有使用者還沒提交的修改（${texts.length} 項），AI 不能捨棄或取代；請使用者在網站處理`, { code: 'USER_CHANGES', changes: texts });
    }
  };

  /** A backdated commit records the close of that day's bar: fetch bars first if none are cached. */
  const ensureBars = async (projectId: string, asOfDate: unknown) => {
    if (!isDate(asOfDate) || asOfDate >= localToday()) return;
    const sec = primarySecurity(db, projectId);
    if (!sec || barsMeta(db, sec.id, sec.priceSource).count > 0) return;
    try {
      await market.bars(sec);
    } catch {
      // no price is recorded rather than a wrong one
    }
  };

  // ------------------------------------------------------------ health
  app.get('/api/health', async () => ({ ok: true, time: nowIso(), version }));

  app.get(
    '/api/diagnostics',
    async (): Promise<DiagnosticsDTO> => ({
      version,
      node: process.version,
      platform: process.platform,
      dataDir: path.resolve(opts.dataDir),
      dbFile: path.resolve(dbFile),
      schemaVersion: schemaVersion(db),
      backups: backups.status(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      // last connection of each AI client (agents only)
      clients: listAiClients(db),
    }),
  );

  // The browser's identity: an HttpOnly cookie holding the user token. Only for a page of this
  // origin, and never in answer to a request that already carries a token (an AI client, Obsidian).
  app.get('/api/session', async (req, reply): Promise<SessionDTO> => {
    if (req.headers.authorization !== undefined) {
      if (req.actor === 'unknown') throw new HttpError(401, NO_ACTOR_MESSAGE, { code: 'NO_ACTOR' }, 'NO_ACTOR');
      return { actor: req.actor, dbGeneration: dbGeneration(db) };
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw forbidden('Cross-site request refused', { code: 'CROSS_SITE' });
    reply.header('set-cookie', `${SESSION_COOKIE}=${tokens.tokens.user}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return { actor: 'user', dbGeneration: dbGeneration(db) };
  });

  // ------------------------------------------------------------ projects
  app.get('/api/projects', async () => listProjectSummaries(db));

  // all companies at a glance: price, targets, upside, research, positions, catalysts, theses, AI
  app.get('/api/dashboard', async (): Promise<DashboardDTO> => {
    const now = new Date();
    const today = localToday(now);
    return { generatedAt: now.toISOString(), today, rows: buildDashboard(db, { now, today, staleAfterMs: market.staleAfterMs, synthetic }), refresh: refresher.status() };
  });

  app.post('/api/projects', async (req) => {
    const b = body<{
      name: string;
      description?: string;
      templateId?: string;
      lang?: string;
      year?: number;
      security: { name?: string; ticker: string; exchange?: string; apiSymbol?: string; currency?: string; priceSource?: string };
    }>(req);
    if (!b.security?.ticker?.trim()) throw badRequest('Ticker is required');
    if (isAgentActor(req.actor)) checkAgentProjectCreate(db, b as typeof b & { confirmedByUser?: unknown });
    const currency = (b.security.currency || 'TWD').toUpperCase();
    let state: ModelState;
    let templateName = STANDARD_TEMPLATE_NAME;
    if (!b.templateId || b.templateId === STANDARD_TEMPLATE_ID) {
      state = standardTemplate({ currency, scale: defaultScaleFor(currency), year: b.year, lang: b.lang === 'zh-TW' ? 'zh-TW' : 'en' });
    } else {
      const t = getSavedTemplateState(db, b.templateId);
      state = t.state;
      templateName = `template “${t.name}”`;
    }
    const id = createProject(db, {
      name: b.name ?? '',
      description: b.description,
      state,
      templateName,
      security: {
        name: b.security.name ?? b.name ?? '',
        ticker: b.security.ticker,
        exchange: b.security.exchange ?? '',
        apiSymbol: b.security.apiSymbol ?? b.security.ticker,
        currency,
        priceSource: b.security.priceSource ?? 'yahoo',
      },
    });
    return { id };
  });

  const bundle = (id: string): ProjectBundleDTO => {
    const project = projectOf(id);
    const draft = getDraft(db, id);
    return { project, securities: listSecurities(db, id), draft, head: toRevisionFull(db, getRevisionRow(db, id, draft.baseRevisionId)) };
  };

  app.get<{ Params: Params }>('/api/projects/:id', async (req) => bundle(req.params.id));

  app.patch<{ Params: Params }>('/api/projects/:id', async (req) => updateProject(db, req.params.id, body(req)));

  app.patch<{ Params: Params }>('/api/securities/:id', async (req) => updateSecurity(db, req.params.id, body(req)));

  app.get<{ Params: Params }>('/api/projects/:id/export', async (req, reply) => {
    const id = req.params.id;
    const project = projectOf(id);
    const evidence = listEvidence(db, id);
    const out = {
      format: 'research-workbench/project',
      formatVersion: 1,
      exportedAt: nowIso(),
      project,
      securities: listSecurities(db, id),
      draft: getDraft(db, id),
      revisions: listRevisionRows(db, id).map((r) => toRevisionFull(db, r)),
      evidence,
      attachments: evidence.flatMap((e) => e.attachments.map((a) => ({ ...a, evidenceId: e.id }))),
      catalysts: listCatalysts(db, id),
      trades: listTrades(db, id),
      notes: listNotes(db, id),
      reviews: listReviews(db, id),
      auditLog: listAudit(db, id),
    };
    const safe = project.name.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    reply.header('Content-Disposition', `attachment; filename="project.json"; filename*=UTF-8''${encodeURIComponent(`${safe}-${nowIso().slice(0, 10)}.json`)}`);
    return out;
  });

  // ------------------------------------------------------------ draft
  app.put<{ Params: Params }>('/api/projects/:id/draft', async (req) => {
    const b = body<{ state: unknown; version: number; dbGeneration?: string }>(req);
    projectOf(req.params.id);
    // an AI edits through /draft/ops, where units, actual periods and versions are checked
    if (isAgentActor(req.actor)) throw forbidden('AI 請用 edit_draft（POST /draft/ops）修改草稿', { code: 'USE_DRAFT_OPS' });
    return saveDraft(db, req.params.id, b.state, Number(b.version), b.dbGeneration);
  });

  app.post<{ Params: Params }>('/api/projects/:id/draft/discard', async (req) => {
    const b = body<{ version?: number }>(req);
    const d = getDraftRow(db, req.params.id);
    guardAgentDraftReset(req, req.params.id, b.version);
    return resetDraftTo(db, req.params.id, d.base_revision_id, b.version, 'discard');
  });

  app.post<{ Params: Params }>('/api/projects/:id/draft/restore', async (req) => {
    const b = body<{ revisionId: string; version?: number }>(req);
    if (!b.revisionId) throw badRequest('revisionId is required');
    guardAgentDraftReset(req, req.params.id, b.version);
    return resetDraftTo(db, req.params.id, b.revisionId, b.version, 'restore');
  });

  app.post<{ Params: Params }>('/api/projects/:id/draft/recover', async (req) => {
    const b = body<{ opId?: number; version?: number }>(req);
    projectOf(req.params.id);
    if (!Number.isInteger(b.opId) || !Number.isInteger(b.version)) throw badRequest('opId and version are required');
    guardAgentDraftReset(req, req.params.id, b.version);
    return recoverDraft(db, req.params.id, b.opId!, b.version!);
  });

  app.get<{ Params: Params; Querystring: { limit?: string; beforeId?: string } }>('/api/projects/:id/draft/ops', async (req) => {
    projectOf(req.params.id);
    return listDraftOps(db, req.params.id, { limit: req.query.limit ? Number(req.query.limit) : undefined, beforeId: req.query.beforeId ? Number(req.query.beforeId) : undefined });
  });

  app.post<{ Params: Params }>('/api/projects/:id/draft/ops', async (req) => {
    projectOf(req.params.id);
    const b = DraftOpsRequestSchema.safeParse(body(req));
    if (!b.success) {
      const issues = b.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`);
      throw badRequest(`操作格式有誤：${issues.slice(0, 5).join('；')}`, { code: 'INVALID_OPS', issues });
    }
    if (b.data.dryRun) quietRequest();
    return applyDraftOps(db, req.params.id, b.data, { actor: currentActor(), dbGeneration: dbGeneration(db) });
  });

  // polled by the browser every 10 seconds: cheap, and tells it whether anything changed
  app.get<{ Params: Params }>('/api/projects/:id/draft/meta', async (req): Promise<DraftMetaDTO> => {
    projectOf(req.params.id);
    const d = getDraftRow(db, req.params.id);
    const head = getRevisionRow(db, req.params.id, d.base_revision_id);
    const auditSeq = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM audit_log WHERE project_id = ? AND action NOT IN ('draft_op','commit')").get(req.params.id) as { m: number }).m;
    const last = lastDraftOp(db, req.params.id);
    return {
      version: d.version,
      baseRevisionId: d.base_revision_id,
      updatedAt: d.updated_at,
      dbGeneration: dbGeneration(db),
      headSeq: head.seq,
      auditSeq,
      lastOp: last ? { id: last.id, actor: last.actor, kind: last.kind, at: last.at, summary: last.summary, changeCount: last.changeCount } : null,
    };
  });

  app.get<{ Params: Params }>('/api/projects/:id/draft/pending', async (req) => {
    projectOf(req.params.id);
    return draftPending(db, req.params.id);
  });

  // ------------------------------------------------------------ revisions
  app.get<{ Params: Params }>('/api/projects/:id/revisions', async (req) => {
    projectOf(req.params.id);
    return listRevisions(db, req.params.id);
  });

  app.get<{ Params: Params & { rid: string } }>('/api/projects/:id/revisions/:rid', async (req) => toRevisionFull(db, getRevisionRow(db, req.params.id, req.params.rid)));

  app.post<{ Params: Params }>('/api/projects/:id/revisions', async (req) => {
    const id = req.params.id;
    projectOf(id);
    if (!isAgentActor(req.actor)) {
      const b = body<CommitInput>(req);
      await ensureBars(id, b.asOfDate);
      return commitDraft(db, id, b);
    }
    // an AI commits exactly what it previewed (and showed the user)
    const b = body<{ previewId?: string; title?: string; reason?: string; notes?: string; confirmedByUser?: boolean }>(req);
    if (!b.previewId) throw badRequest('AI 提交前必須先 preview_commit，並帶 previewId', { code: 'PREVIEW_REQUIRED' });
    const p = previews.get(b.previewId);
    if (!p) throw conflict('預覽已過期（15 分鐘）或伺服器重新啟動過；請重新 preview_commit', { code: 'PREVIEW_EXPIRED' });
    if (p.client !== agentClientOf(req.actor)) throw forbidden('這個預覽屬於另一個 AI 連線', { code: 'PREVIEW_OTHER_CLIENT' });
    if (p.projectId !== id || p.dbGeneration !== dbGeneration(db)) throw conflict('預覽和這家公司或目前的資料不符；請重新 preview_commit', { code: 'PREVIEW_MISMATCH' });
    await ensureBars(id, p.asOfDate);
    const rev = commitDraft(
      db,
      id,
      { title: b.title ?? '', reason: b.reason ?? '', notes: b.notes, asOfDate: p.asOfDate, evidenceIds: p.evidenceIds, draftVersion: p.draftVersion, kind: p.kind },
      localToday(),
      { agent: { confirmedByUser: b.confirmedByUser === true } },
    );
    previews.delete(p.id);
    return rev;
  });

  app.post<{ Params: Params }>('/api/projects/:id/revisions/preview', async (req): Promise<CommitPreviewDTO> => {
    const id = req.params.id;
    projectOf(id);
    quietRequest();
    const b = body<PreviewInput>(req);
    if (b.evidenceIds !== undefined && (!Array.isArray(b.evidenceIds) || b.evidenceIds.some((e) => typeof e !== 'string'))) throw badRequest('evidenceIds must be a list of ids');
    const today = localToday();
    await ensureBars(id, b.asOfDate ?? today);
    const { dto } = previewCommit(db, id, b, today, req.actor as Actor);
    const client = agentClientOf(req.actor);
    if (!client || dto.blocked) return { ...dto, previewId: null, expiresAt: null };
    const p = previews.put({
      projectId: id,
      client,
      draftVersion: dto.draftVersion,
      baseRevisionId: dto.baseRevisionId,
      dbGeneration: dbGeneration(db),
      asOfDate: dto.asOfDate,
      kind: dto.kind,
      evidenceIds: dto.citedEvidence.map((e) => e.id),
      needsConfirmation: dto.needsConfirmation,
    });
    return { ...dto, previewId: p.id, expiresAt: new Date(p.expiresAt).toISOString() };
  });

  app.get<{ Params: { pid: string } }>('/api/commit-previews/:pid', async (req) => {
    const client = agentOnly(req);
    const p = previews.get(req.params.pid);
    if (!p || p.client !== client) throw new HttpError(404, '預覽已過期（15 分鐘）或伺服器重新啟動過；請重新 preview_commit', { code: 'PREVIEW_EXPIRED' });
    return { projectId: p.projectId, expiresAt: new Date(p.expiresAt).toISOString(), needsConfirmation: p.needsConfirmation };
  });

  app.get<{ Params: Params }>('/api/projects/:id/revision-annotations', async (req) => {
    projectOf(req.params.id);
    return listAnnotations(db, req.params.id);
  });

  app.post<{ Params: Params & { rid: string } }>('/api/projects/:id/revisions/:rid/annotations', async (req) => {
    projectOf(req.params.id);
    return addAnnotation(db, req.params.id, req.params.rid, body<{ kind?: string; note?: string }>(req));
  });

  app.get<{ Params: Params; Querystring: { date?: string } }>('/api/projects/:id/as-of', async (req) => {
    if (!isDate(req.query.date)) throw badRequest('date must be YYYY-MM-DD');
    const r = revisionAsOf(db, req.params.id, req.query.date);
    return r ? toRevisionMeta(db, r) : null;
  });

  app.get<{ Params: Params; Querystring: { nodeIds?: string } }>('/api/projects/:id/series', async (req) => {
    const ids = (req.query.nodeIds ?? '').split(',').filter(Boolean);
    const excluded = excludedSet(db, req.params.id);
    const points: SeriesPoint[] = listRevisionRows(db, req.params.id).map((r) => {
      const state = JSON.parse(r.state_json) as ModelState;
      const computed = JSON.parse(r.computed_json) as FrozenOutputs;
      const values: SeriesPoint['values'] = {};
      const est: SeriesPoint['est'] = {};
      for (const id of ids) {
        values[id] = {} as Record<ScenarioId, Record<string, number | null>>;
        for (const s of ['bear', 'base', 'bull'] as const) values[id][s] = computed.values[s][id] ?? {};
        est[id] = computed.est[id] ?? {};
      }
      return { revisionId: r.id, seq: r.seq, kind: r.kind, title: r.title, asOfDate: r.as_of_date, committedAt: r.committed_at, periods: state.periods, values, est, excluded: excluded.has(r.id) };
    });
    return points;
  });

  app.get<{ Params: Params; Querystring: { entityId?: string } }>('/api/projects/:id/audit', async (req) => listAudit(db, req.params.id, req.query.entityId));

  // ------------------------------------------------------------ evidence
  app.get<{ Params: Params }>('/api/projects/:id/evidence', async (req) => listEvidence(db, req.params.id));

  app.post<{ Params: Params }>('/api/projects/:id/evidence', async (req) => {
    projectOf(req.params.id);
    if (req.isMultipart()) {
      const { fields, files } = await readMultipart(req);
      const input: EvidenceInput = {
        title: fields.title || (files.length === 1 ? files[0].filename : undefined),
        sourceName: fields.sourceName,
        sourceType: fields.sourceType || (files.some((f) => f.mime.startsWith('image/')) ? 'screenshot' : undefined),
        url: fields.url || null,
        publishedAt: fields.publishedAt || null,
        notes: fields.notes,
        verification: fields.verification || null,
      };
      return createEvidence(db, req.params.id, input, files.map((f) => f.attachmentId));
    }
    return createEvidence(db, req.params.id, body<EvidenceInput>(req));
  });

  app.get<{ Params: Params }>('/api/evidence/:id', async (req) => getEvidence(db, req.params.id));
  app.patch<{ Params: Params }>('/api/evidence/:id', async (req) => updateEvidence(db, req.params.id, body(req)));
  app.post<{ Params: Params }>('/api/evidence/:id/files', async (req) => {
    getEvidence(db, req.params.id);
    const { files } = await readMultipart(req);
    if (!files.length) throw badRequest('No file uploaded');
    return addEvidenceAttachments(db, req.params.id, files.map((f) => f.attachmentId));
  });
  app.post<{ Params: Params }>('/api/evidence/:id/archive', async (req) => setEvidenceArchived(db, req.params.id, body<{ archived?: boolean }>(req).archived !== false));
  app.delete<{ Params: Params }>('/api/evidence/:id', async (req) => {
    deleteEvidence(db, req.params.id);
    return { ok: true };
  });

  app.get<{ Params: Params; Querystring: { download?: string } }>('/api/attachments/:id/content', async (req, reply) => {
    const row = attachments.get(req.params.id);
    if (!row) throw notFound('Attachment');
    if (!attachments.exists(row)) throw new HttpError(410, `The stored file for “${row.original_filename}” is missing from the data directory`);
    const inline = INLINE_SAFE.has(row.mime_type) && req.query.download !== '1';
    const ascii = row.original_filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    reply.header('Content-Type', inline ? row.mime_type : 'application/octet-stream');
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.original_filename)}`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    if (row.mime_type !== 'application/pdf') reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return reply.send(fs.createReadStream(attachments.filePath(row)));
  });

  // ------------------------------------------------------------ catalysts
  app.get<{ Params: Params }>('/api/projects/:id/catalysts', async (req) => listCatalysts(db, req.params.id));
  app.post<{ Params: Params }>('/api/projects/:id/catalysts', async (req) => {
    projectOf(req.params.id);
    return createCatalyst(db, req.params.id, body(req));
  });
  app.patch<{ Params: Params }>('/api/catalysts/:id', async (req) => updateCatalyst(db, req.params.id, body(req)));
  app.delete<{ Params: Params }>('/api/catalysts/:id', async (req) => {
    deleteCatalyst(db, req.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ trades
  app.get<{ Params: Params }>('/api/projects/:id/trades', async (req) => listTrades(db, req.params.id));
  // the trade log across companies
  app.get<{ Querystring: { status?: string; projectId?: string; from?: string; to?: string } }>('/api/trades', async (req): Promise<TradesJournalDTO> => {
    const q = req.query;
    const status = q.status || 'all';
    if (status !== 'all' && status !== 'open' && status !== 'closed') throw badRequest('status must be all, open or closed');
    for (const k of ['from', 'to'] as const) if (q[k] && !isDate(q[k])) throw badRequest(`${k} must be YYYY-MM-DD`);
    if (q.projectId) projectOf(q.projectId);
    const trades = listJournalTrades(db, { status, projectId: q.projectId || undefined, from: q.from || undefined, to: q.to || undefined }, { synthetic });
    return { generatedAt: nowIso(), trades };
  });
  app.post<{ Params: Params }>('/api/projects/:id/trades', async (req) => {
    projectOf(req.params.id);
    if (isAgentActor(req.actor)) return recordAgentTrade(db, market, req.params.id, req.body);
    return createTrade(db, req.params.id, body(req));
  });
  app.patch<{ Params: Params }>('/api/trades/:id', async (req) => {
    if (isAgentActor(req.actor)) return closeAgentTrade(db, market, req.params.id, req.body);
    return updateTrade(db, req.params.id, body(req));
  });
  app.delete<{ Params: Params }>('/api/trades/:id', async (req) => {
    deleteTrade(db, req.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ notes & reviews
  app.get<{ Params: Params }>('/api/projects/:id/notes', async (req) => listNotes(db, req.params.id));
  app.post<{ Params: Params }>('/api/projects/:id/notes', async (req) => {
    projectOf(req.params.id);
    return createNote(db, req.params.id, body<{ body: string }>(req).body ?? '');
  });
  app.patch<{ Params: Params }>('/api/notes/:id', async (req) => updateNote(db, req.params.id, body<{ body: string }>(req).body ?? ''));
  app.delete<{ Params: Params }>('/api/notes/:id', async (req) => {
    deleteNote(db, req.params.id);
    return { ok: true };
  });

  app.get<{ Params: Params }>('/api/projects/:id/reviews', async (req) => listReviews(db, req.params.id));
  app.post<{ Params: Params }>('/api/projects/:id/reviews', async (req) => {
    projectOf(req.params.id);
    return createReview(db, req.params.id, body(req));
  });
  app.patch<{ Params: Params }>('/api/reviews/:id', async (req) => updateReview(db, req.params.id, body(req)));
  app.delete<{ Params: Params }>('/api/reviews/:id', async (req) => {
    deleteReview(db, req.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ AI clients
  app.post('/api/ai/heartbeat', async (req): Promise<HeartbeatDTO> => {
    const client = agentOnly(req);
    quietRequest();
    const b = body<{ clientInfo?: { name?: string; version?: string }; adapterVersion?: string }>(req);
    touchAiClient(db, client, { clientName: b.clientInfo?.name, clientVersion: b.clientInfo?.version, adapterVersion: b.adapterVersion });
    return { ok: true, actor: `agent:${client}`, today: localToday(), dbGeneration: dbGeneration(db), serverVersion: version.commit };
  });

  app.post('/api/ai/sessions/summary', async (req) => {
    const client = agentOnly(req);
    const b = body<{ summary?: string; decisions?: string; todo?: string; projectIds?: string[] }>(req);
    if (b.projectIds !== undefined && (!Array.isArray(b.projectIds) || b.projectIds.some((x) => typeof x !== 'string'))) throw badRequest('projectIds must be a list of ids');
    const session = saveSessionSummary(db, client, { summary: b.summary ?? '', decisions: b.decisions, todo: b.todo, projectIds: b.projectIds });
    noteAiAction({ kind: 'summary', projectId: session.projectIds[0] ?? null, ref: session.id, summary: `存了對話摘要：${session.summary!.slice(0, 60)}` });
    return session;
  });

  app.get<{ Querystring: { projectId?: string; limit?: string } }>('/api/ai/sessions', async (req) =>
    listAiSessions(db, { projectId: req.query.projectId || undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }),
  );

  // ------------------------------------------------------------ templates
  app.get('/api/templates', async () => [
    { id: STANDARD_TEMPLATE_ID, name: STANDARD_TEMPLATE_NAME, description: 'EPS branch (segments → income statement → EPS), P/E branch, Target Price.', builtIn: true, createdAt: null },
    ...listSavedTemplates(db),
  ]);
  app.post('/api/templates', async (req) => {
    const b = body<{ projectId: string; name: string; description?: string; includeValues?: boolean }>(req);
    const draft = getDraft(db, b.projectId);
    const state = b.includeValues ? { ...draft.state, links: [] } : structureOnly(draft.state);
    return saveTemplate(db, b.name ?? '', b.description ?? '', state);
  });
  app.delete<{ Params: Params }>('/api/templates/:id', async (req) => {
    deleteTemplate(db, req.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ market data
  app.get('/api/market/providers', async () => market.listProviders());
  // update all prices: starts a background run (or returns the running one); poll the GET
  app.post('/api/market/refresh', async (): Promise<RefreshRunDTO> => refresher.start());
  app.get('/api/market/refresh', async (): Promise<RefreshRunDTO | null> => refresher.status());
  app.get<{ Querystring: { q?: string } }>('/api/symbols/search', async (req) => symbols.search(req.query.q ?? ''));
  app.get<{ Querystring: { ticker?: string } }>('/api/securities/lookup', async (req) => findSecurities(db, req.query.ticker ?? ''));
  app.get<{ Params: Params; Querystring: { provider?: string; refresh?: string } }>('/api/securities/:id/quote', async (req) => {
    const sec = getSecurity(db, req.params.id);
    return market.quote(sec, req.query.provider || sec.priceSource, req.query.refresh === '1');
  });
  app.get<{ Params: Params; Querystring: { provider?: string; refresh?: string } }>('/api/securities/:id/bars', async (req) => {
    const sec = getSecurity(db, req.params.id);
    return market.bars(sec, req.query.provider || sec.priceSource, req.query.refresh === '1');
  });
  app.post<{ Params: Params }>('/api/securities/:id/bars/import', async (req) => {
    const sec = getSecurity(db, req.params.id);
    const { text, filename } = await readUploadedText(req);
    try {
      return market.importCsv(sec, text, filename);
    } catch (e) {
      if (e instanceof MarketDataError) throw badRequest(e.message);
      throw e;
    }
  });

  // ------------------------------------------------------------ built client (production)
  if (opts.clientDir && fs.existsSync(path.join(opts.clientDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: path.resolve(opts.clientDir), prefix: '/' });
  }

  app.addHook('onClose', async () => {
    // a refresh call still in flight after the grace fails on the closed database and is skipped
    await refresher.stop();
    await backups.stop();
    db.close();
  });
  if (opts.startBackups) backups.start();
  return { app, db, attachments, market, backups, tokens, previews, refresher };
}
