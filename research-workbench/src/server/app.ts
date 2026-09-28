import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { ModelOpError } from '../domain/model/ops';
import type { ModelState, ScenarioId } from '../domain/model/types';
import { defaultScaleFor, STANDARD_TEMPLATE_ID, STANDARD_TEMPLATE_NAME, standardTemplate, structureOnly } from '../domain/templates/standard';
import type { FrozenOutputs } from '../domain/calc/engine';
import type { ProjectBundleDTO, SeriesPoint } from '../shared/api';
import { openDatabase, type DB } from './db/connection';
import { CsvProvider } from './market/csv';
import { DemoProvider } from './market/demo';
import { MarketDataError, type MarketDataProvider } from './market/provider';
import { MarketService } from './market/service';
import { YahooChartProvider } from './market/yahoo';
import { listAudit } from './repos/audit';
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
import { commitDraft } from './services/commit';
import { AttachmentStore, INLINE_SAFE, sanitizeFilename } from './storage/attachments';
import { badRequest, HttpError, isDate, notFound, nowIso } from './util';

export interface AppOptions {
  dataDir: string;
  /** Override providers (tests). Defaults: yahoo, demo, csv. */
  providers?: MarketDataProvider[];
  logger?: boolean;
  /** Directory with the built client to serve at / (optional). */
  clientDir?: string;
  maxUploadBytes?: number;
}

export interface AppContext {
  app: FastifyInstance;
  db: DB;
  attachments: AttachmentStore;
  market: MarketService;
}

type Params = { id: string };

export async function buildApp(opts: AppOptions): Promise<AppContext> {
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const db = openDatabase(path.join(opts.dataDir, 'workbench.db'));
  const attachments = new AttachmentStore(db, path.join(opts.dataDir, 'attachments'));
  const providers = opts.providers ?? [new YahooChartProvider(), new DemoProvider(), new CsvProvider()];
  const market = new MarketService(db, Object.fromEntries(providers.map((p) => [p.id, p])));
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  await app.register(fastifyMultipart, { limits: { fileSize: opts.maxUploadBytes ?? 100 * 1024 * 1024, files: 20, fields: 50 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details ?? null });
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

  // ------------------------------------------------------------ health
  app.get('/api/health', async () => ({ ok: true, time: nowIso() }));

  // ------------------------------------------------------------ projects
  app.get('/api/projects', async () => listProjectSummaries(db));

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
    const b = body<{ state: unknown; version: number }>(req);
    projectOf(req.params.id);
    return saveDraft(db, req.params.id, b.state, Number(b.version));
  });

  app.post<{ Params: Params }>('/api/projects/:id/draft/discard', async (req) => {
    const b = body<{ version?: number }>(req);
    const d = getDraftRow(db, req.params.id);
    return resetDraftTo(db, req.params.id, d.base_revision_id, b.version);
  });

  app.post<{ Params: Params }>('/api/projects/:id/draft/restore', async (req) => {
    const b = body<{ revisionId: string; version?: number }>(req);
    if (!b.revisionId) throw badRequest('revisionId is required');
    return resetDraftTo(db, req.params.id, b.revisionId, b.version);
  });

  // ------------------------------------------------------------ revisions
  app.get<{ Params: Params }>('/api/projects/:id/revisions', async (req) => {
    projectOf(req.params.id);
    return listRevisions(db, req.params.id);
  });

  app.get<{ Params: Params & { rid: string } }>('/api/projects/:id/revisions/:rid', async (req) => toRevisionFull(db, getRevisionRow(db, req.params.id, req.params.rid)));

  app.post<{ Params: Params }>('/api/projects/:id/revisions', async (req) => {
    projectOf(req.params.id);
    return commitDraft(db, req.params.id, body(req));
  });

  app.get<{ Params: Params; Querystring: { date?: string } }>('/api/projects/:id/as-of', async (req) => {
    if (!isDate(req.query.date)) throw badRequest('date must be YYYY-MM-DD');
    const r = revisionAsOf(db, req.params.id, req.query.date);
    return r ? toRevisionMeta(db, r) : null;
  });

  app.get<{ Params: Params; Querystring: { nodeIds?: string } }>('/api/projects/:id/series', async (req) => {
    const ids = (req.query.nodeIds ?? '').split(',').filter(Boolean);
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
      return { revisionId: r.id, seq: r.seq, kind: r.kind, title: r.title, asOfDate: r.as_of_date, committedAt: r.committed_at, periods: state.periods, values, est };
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
  app.post<{ Params: Params }>('/api/projects/:id/trades', async (req) => {
    projectOf(req.params.id);
    return createTrade(db, req.params.id, body(req));
  });
  app.patch<{ Params: Params }>('/api/trades/:id', async (req) => updateTrade(db, req.params.id, body(req)));
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

  app.addHook('onClose', async () => db.close());
  return { app, db, attachments, market };
}
