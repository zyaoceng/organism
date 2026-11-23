/**
 * Routes of the assumptions panel: link a company to an Excel file in the vault folder, read it,
 * recalculate trial values, and write the user's changes back into it. Excel is the only store of
 * the assumptions; every answer is computed from the file as it is on disk. The one route that
 * writes to the file is POST …/workbook/write (write.ts).
 *
 * Linking, the result mapping, writing back and the vault folder are the user's (an AI client may
 * read and recalculate). The vault folder itself can only be set from this Mac.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import type { LabelAnchor, OutputMapping, PeriodAnchor } from '../../domain/workbook/types';
import { isAgentActor } from '../../shared/actors';
import type { VaultDirDTO, WorkbookFileDTO, WorkbookFilesDTO, WorkbookRecalcDTO, WorkbookRecalcRequest, WorkbookViewDTO, WorkbookWarningDTO } from '../../shared/api';
import { currentActor, quietRequest } from '../actor';
import type { DB } from '../db/connection';
import { getProject, primarySecurity } from '../repos/projects';
import { badRequest, conflict, forbidden, HttpError, nowIso, parseJson } from '../util';
import { defaultFileDeps, listVaultXlsx, readWorkbookFile, resolveInVault, vaultAccess, WorkbookPathError, type FileDeps } from './file';
import { assumptionDTOs, diagnosisText, evaluate, loadWorkbook, mappingWarnings, PARTY_GAP_THRESHOLD, partyTables, unknownAssumptionIds, type LoadedWorkbook, type TrialInput } from './view';
import { detectRevert, parseWriteRequest, writeBack } from './write';
import { XlsxError } from './zipRead';

export const VAULT_DIR_SETTING = 'vault_dir';
/** Parsed workbooks kept in memory, by the SHA-256 of the file. */
const CACHE_SIZE = 4;
const MAX_OVERRIDES = 500;
/** Longer than any path macOS allows (1024 bytes). */
const MAX_REL_PATH = 1024;

export interface WorkbookRouteOptions {
  db: DB;
  /** WORKBENCH_VAULT_DIR (tests, e2e): wins over the saved setting. */
  vaultDir?: string;
  /** How files are inspected (tests). */
  fileDeps?: Partial<FileDeps>;
  /** Where the copies made before each write go (<dataDir>/workbook-backups). Default: the folder of the database file. */
  dataDir?: string;
}

interface LinkRow {
  project_id: string;
  rel_path: string;
  mapping_json: string | null;
  summary_json: string | null;
  file_sha256: string | null;
}

type Params = { id: string };

const userOnly = (req: FastifyRequest, what: string) => {
  if (req.actor !== 'user') throw forbidden(`Only the browser user can ${what}`, { code: 'USER_ONLY' });
};

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function parseAnchor(v: unknown, what: string): LabelAnchor {
  if (!isObject(v) || !isText(v.sheet) || !isText(v.labelText) || !Number.isInteger(v.occurrence) || (v.occurrence as number) < 1) throw badRequest(`${what}: an anchor needs sheet, labelText and occurrence`);
  for (const k of ['columnLabel', 'subColumnLabel'] as const) if (v[k] !== undefined && !isText(v[k])) throw badRequest(`${what}: ${k} must be text`);
  return {
    sheet: v.sheet,
    labelText: v.labelText,
    occurrence: v.occurrence as number,
    ...(v.columnLabel !== undefined ? { columnLabel: v.columnLabel as string } : {}),
    ...(v.subColumnLabel !== undefined ? { subColumnLabel: v.subColumnLabel as string } : {}),
  };
}

/** A mapping as PUT …/workbook/mapping takes it; anything else is refused. */
export function parseMapping(v: unknown): OutputMapping {
  if (!isObject(v)) throw badRequest('mapping must be an object');
  const periods = (key: 'revenueQuarters' | 'eps'): PeriodAnchor[] => {
    const list = v[key];
    if (!Array.isArray(list) || list.length > 40) throw badRequest(`${key} must be a list`);
    return list.map((p, i) => {
      if (!isObject(p) || !isText(p.period, 40)) throw badRequest(`${key}[${i}] needs a period`);
      return { period: p.period, anchor: parseAnchor(p.anchor, `${key}[${i}]`) };
    });
  };
  const one = (key: 'revenueTotal' | 'targetPrice' | 'multiple' | 'shareCount' | 'netCash') => (v[key] === null || v[key] === undefined ? null : parseAnchor(v[key], key));
  return { revenueQuarters: periods('revenueQuarters'), revenueTotal: one('revenueTotal'), eps: periods('eps'), targetPrice: one('targetPrice'), multiple: one('multiple'), shareCount: one('shareCount'), netCash: one('netCash') };
}

function parseTrial(body: unknown): TrialInput & { baseSha: string } {
  const b = (isObject(body) ? body : {}) as Partial<WorkbookRecalcRequest>;
  if (typeof b.baseSha !== 'string' || !/^[0-9a-f]{64}$/.test(b.baseSha)) throw badRequest('baseSha is required');
  if (!Array.isArray(b.overrides) || b.overrides.length > MAX_OVERRIDES) throw badRequest('overrides must be a list');
  const seen = new Set<string>();
  for (const o of b.overrides) {
    if (!isObject(o) || !isText(o.id, 600) || typeof o.value !== 'number' || !Number.isFinite(o.value)) throw badRequest('Each override needs an assumption id and a finite number');
    if (seen.has(o.id)) throw badRequest(`Assumption overridden twice: ${o.id}`);
    seen.add(o.id);
  }
  const ranges = b.trialRanges;
  if (ranges !== undefined) {
    if (!isObject(ranges) || Object.keys(ranges).length > MAX_OVERRIDES) throw badRequest('trialRanges must be an object');
    for (const r of Object.values(ranges)) {
      if (!isObject(r) || typeof r.low !== 'number' || typeof r.high !== 'number' || !Number.isFinite(r.low) || !Number.isFinite(r.high)) throw badRequest('Each trial range needs a finite low and high');
    }
  }
  return { baseSha: b.baseSha, overrides: b.overrides.map((o) => ({ id: o.id, value: o.value })), trialRanges: ranges };
}

export function registerWorkbookRoutes(app: FastifyInstance, o: WorkbookRouteOptions): void {
  const { db } = o;
  const deps: FileDeps = { ...defaultFileDeps, ...o.fileDeps };
  // an in-memory database has no folder: writing back then needs `dataDir`
  const dataDir = o.dataDir ?? (db.memory ? null : path.dirname(db.name));
  const cache = new Map<string, LoadedWorkbook>();
  app.addHook('onClose', async () => {
    for (const l of cache.values()) l.engine.dispose();
    cache.clear();
  });

  // ------------------------------------------------------------ the vault folder
  const savedVaultDir = () => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(VAULT_DIR_SETTING) as { value: string } | undefined)?.value ?? null;
  const vault = (): VaultDirDTO => {
    const dir = o.vaultDir || savedVaultDir();
    if (!dir) return { dir: null, source: null, readable: false, reason: null };
    return { dir, source: o.vaultDir ? 'env' : 'settings', ...vaultAccess(dir) };
  };

  app.get('/api/settings/vault-dir', async (): Promise<VaultDirDTO> => vault());

  // Set by the installer (and later the settings page). It decides which files of the Mac this
  // server reads, so it is taken only from a request addressed to this Mac itself.
  app.put('/api/settings/vault-dir', async (req): Promise<VaultDirDTO> => {
    if (!LOOPBACK_HOST.test(req.headers.host ?? '') || !LOOPBACK_IPS.has(req.ip)) throw forbidden('The vault folder can only be set on the Mac itself', { code: 'LOCAL_ONLY' });
    userOnly(req, 'set the vault folder');
    const dir = (req.body as { dir?: unknown } | null)?.dir;
    if (dir === null) {
      db.prepare('DELETE FROM app_settings WHERE key = ?').run(VAULT_DIR_SETTING);
      return vault();
    }
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0') || dir.length > 2000) throw badRequest('dir must be an absolute folder path', { code: 'VAULT_DIR' });
    const clean = path.normalize(dir).replace(/\/+$/, '') || '/';
    // a folder macOS keeps this process out of is still saved: the answer says it cannot be read
    const access = vaultAccess(clean);
    if (!access.readable && (access.reason === 'ENOENT' || access.reason === 'ENOTDIR')) throw badRequest(`Not a folder: ${clean}`, { code: 'VAULT_DIR' });
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(VAULT_DIR_SETTING, clean, nowIso());
    return vault();
  });

  // ------------------------------------------------------------ files
  app.get<{ Querystring: { projectId?: string } }>('/api/workbook/files', async (req): Promise<WorkbookFilesDTO> => {
    const ticker = req.query.projectId ? (getProject(db, req.query.projectId), (primarySecurity(db, req.query.projectId)?.ticker ?? '').trim().toUpperCase()) : '';
    const v = vault();
    if (!v.dir || !v.readable) return { vault: v, files: [], truncated: false };
    const { files, truncated } = listVaultXlsx(v.dir, deps);
    const entries = files.map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size,
      modifiedAt: f.mtimeMs === null ? null : new Date(f.mtimeMs).toISOString(),
      dataless: f.dataless,
      matchesTicker: ticker !== '' && f.name.toUpperCase().startsWith(ticker),
    }));
    // the sort is stable: newest first within each group
    entries.sort((a, b) => Number(b.matchesTicker) - Number(a.matchesTicker));
    return { vault: v, files: entries, truncated };
  });

  // ------------------------------------------------------------ the linked file
  const linkOf = (projectId: string) => db.prepare('SELECT project_id, rel_path, mapping_json, summary_json, file_sha256 FROM project_workbooks WHERE project_id = ?').get(projectId) as LinkRow | undefined;

  const pathError = (e: unknown): never => {
    if (e instanceof WorkbookPathError) throw e.code === 'no-vault' ? conflict(e.message, { code: 'NO_VAULT' }) : badRequest(e.message, { code: 'WORKBOOK_PATH', reason: e.code });
    throw e;
  };

  function load(bytes: Buffer, sha256: string): LoadedWorkbook {
    const hit = cache.get(sha256);
    if (hit) {
      // most recently used last
      cache.delete(sha256);
      cache.set(sha256, hit);
      return hit;
    }
    const loaded = loadWorkbook(bytes, sha256);
    cache.set(sha256, loaded);
    for (const [key, old] of cache) {
      if (cache.size <= CACHE_SIZE) break;
      old.engine.dispose();
      cache.delete(key);
    }
    return loaded;
  }

  /** Reads the linked file as it is now. `loaded` is null when it cannot be read or is not a workbook. */
  async function open(req: FastifyRequest, v: VaultDirDTO, link: LinkRow): Promise<{ file: WorkbookFileDTO; loaded: LoadedWorkbook | null }> {
    const file: WorkbookFileDTO = { path: link.rel_path, name: path.posix.basename(link.rel_path), state: 'unreadable', reason: null, size: null, modifiedAt: null, sha256: null, excelOpen: false };
    if (!v.dir) return { file: { ...file, reason: 'no-vault' }, loaded: null };
    let abs: string;
    try {
      abs = resolveInVault(v.dir, link.rel_path);
    } catch (e) {
      if (e instanceof WorkbookPathError) return { file: { ...file, reason: e.code }, loaded: null };
      throw e;
    }
    const r = await readWorkbookFile(abs, deps);
    Object.assign(file, { state: r.state, reason: r.reason, size: r.size, modifiedAt: r.mtimeMs === null ? null : new Date(r.mtimeMs).toISOString(), sha256: r.sha256, excelOpen: r.excelOpen });
    if (!r.bytes || !r.sha256) return { file, loaded: null };
    try {
      return { file, loaded: load(r.bytes, r.sha256) };
    } catch (e) {
      if (!(e instanceof XlsxError)) req.log.error({ err: e }, 'the linked workbook could not be loaded');
      return { file: { ...file, state: 'unreadable', reason: e instanceof XlsxError ? e.code : 'engine' }, loaded: null };
    }
  }

  /** What the overview shows without opening the file: counts and file facts, never an assumption's value. */
  function remember(link: LinkRow, file: WorkbookFileDTO, loaded: LoadedWorkbook, needsDecision: number) {
    const summary = JSON.stringify({ assumptions: loaded.detect.assumptions.length, needsDecision, selfCheck: loaded.selfCheck.state });
    if (link.file_sha256 === file.sha256 && link.summary_json === summary) return;
    db.prepare('UPDATE project_workbooks SET summary_json = ?, file_size = ?, file_sha256 = ?, file_mtime = ?, checked_at = ? WHERE project_id = ?').run(summary, file.size, file.sha256, file.modifiedAt, nowIso(), link.project_id);
  }

  async function view(req: FastifyRequest, projectId: string): Promise<WorkbookViewDTO> {
    const v = vault();
    const empty = { vault: v, loaded: false, selfCheck: null, assumptions: [], needsDecision: 0, outputs: null, sensitivity: null, parties: [], gapThreshold: PARTY_GAP_THRESHOLD, warnings: [], mapping: null, revert: null };
    const link = linkOf(projectId);
    if (!link) return { ...empty, linked: false, file: null };
    const { file, loaded } = await open(req, v, link);
    if (!loaded) return { ...empty, linked: true, file };
    const saved = parseJson<OutputMapping | null>(link.mapping_json, null);
    const mapping = saved ?? loaded.detect.outputs;
    const assumptions = assumptionDTOs(loaded.detect);
    const needsDecision = assumptions.filter((a) => a.status === 'needs-decision').length;
    // with a saved mapping, what detection could not place no longer matters; what the mapping lost does
    const warnings: WorkbookWarningDTO[] = [
      ...loaded.detect.warnings.filter((w) => !saved || (w.code !== 'output-missing' && w.code !== 'output-ambiguous')).map((w) => ({ code: w.code, sheet: w.sheet ?? null, message: w.message })),
      ...(saved ? mappingWarnings(loaded.workbook, saved) : []),
    ];
    remember(link, file, loaded, needsDecision);
    return {
      vault: v,
      linked: true,
      file,
      loaded: true,
      selfCheck: loaded.selfCheck,
      assumptions,
      needsDecision,
      ...evaluate(loaded, mapping),
      parties: partyTables(loaded),
      gapThreshold: PARTY_GAP_THRESHOLD,
      warnings,
      mapping: { saved: saved !== null, outputs: mapping, candidates: loaded.detect.candidates },
      revert: detectRevert(db, projectId, link.rel_path, file.sha256, loaded),
    };
  }

  app.get<{ Params: Params }>('/api/projects/:id/workbook', async (req): Promise<WorkbookViewDTO> => {
    getProject(db, req.params.id);
    return view(req, req.params.id);
  });

  app.put<{ Params: Params }>('/api/projects/:id/workbook/link', async (req): Promise<WorkbookViewDTO> => {
    const id = req.params.id;
    getProject(db, id);
    userOnly(req, 'link an Excel file');
    const rel = (req.body as { path?: unknown } | null)?.path;
    if (typeof rel !== 'string' || !rel || rel.length > MAX_REL_PATH) throw badRequest('path is required', { code: 'WORKBOOK_PATH' });
    const v = vault();
    if (!v.dir) throw conflict('The vault folder is not set', { code: 'NO_VAULT' });
    const relPath = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    let abs = '';
    try {
      abs = resolveInVault(v.dir, relPath);
    } catch (e) {
      pathError(e);
    }
    // a file still in iCloud can be linked; one that is not there cannot
    const info = await readWorkbookFile(abs, { ...deps, downloadTimeoutMs: 0 });
    if (info.state === 'missing') throw new HttpError(404, 'There is no such file in the vault folder', { code: 'WORKBOOK_MISSING' });
    const now = nowIso();
    const before = linkOf(id);
    if (before && before.rel_path === relPath) {
      db.prepare('UPDATE project_workbooks SET updated_at = ? WHERE project_id = ?').run(now, id);
    } else {
      // another file: the old one's mapping and summary do not describe it
      db.prepare(
        `INSERT INTO project_workbooks (project_id, rel_path, linked_at, linked_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET rel_path = excluded.rel_path, mapping_json = NULL, summary_json = NULL, file_size = NULL, file_sha256 = NULL, file_mtime = NULL, checked_at = NULL,
           linked_at = excluded.linked_at, linked_by = excluded.linked_by, updated_at = excluded.updated_at`,
      ).run(id, relPath, now, currentActor(), now);
    }
    return view(req, id);
  });

  app.delete<{ Params: Params }>('/api/projects/:id/workbook/link', async (req) => {
    getProject(db, req.params.id);
    userOnly(req, 'unlink an Excel file');
    db.prepare('DELETE FROM project_workbooks WHERE project_id = ?').run(req.params.id);
    return { ok: true as const };
  });

  // Trial values: computed and returned, never stored and never written to the file.
  app.post<{ Params: Params }>('/api/projects/:id/workbook/recalc', async (req): Promise<WorkbookRecalcDTO> => {
    const id = req.params.id;
    getProject(db, id);
    quietRequest();
    const input = parseTrial(req.body);
    const link = linkOf(id);
    if (!link) throw new HttpError(404, 'No Excel file is linked to this company', { code: 'WORKBOOK_NOT_LINKED' });
    const { file, loaded } = await open(req, vault(), link);
    if (!loaded) throw conflict('The linked Excel file cannot be read right now', { code: 'WORKBOOK_UNREADABLE', file });
    if (file.sha256 !== input.baseSha) throw conflict('The Excel file changed after it was loaded; load it again', { code: 'WORKBOOK_CHANGED', sha256: file.sha256 });
    const unknown = unknownAssumptionIds(loaded.detect, input);
    if (unknown.length) throw badRequest(`Not an assumption of this workbook: ${unknown.slice(0, 5).join(', ')}`, { code: 'UNKNOWN_ASSUMPTION', ids: unknown });
    const saved = parseJson<OutputMapping | null>(link.mapping_json, null);
    return { baseSha: input.baseSha, ...evaluate(loaded, saved ?? loaded.detect.outputs, input) };
  });

  // The one route that changes the user's file. An AI client is refused whatever it sends: what goes
  // into the workbook is decided by the person looking at the list of cells in the browser.
  app.post<{ Params: Params }>('/api/projects/:id/workbook/write', async (req): Promise<WorkbookViewDTO> => {
    const id = req.params.id;
    getProject(db, id);
    if (isAgentActor(req.actor)) throw forbidden('An AI client cannot write to the Excel file; the user does that in the browser', { code: 'USER_ONLY' });
    userOnly(req, 'write to the Excel file');
    const input = parseWriteRequest(req.body);
    const link = linkOf(id);
    if (!link) throw new HttpError(404, 'No Excel file is linked to this company', { code: 'WORKBOOK_NOT_LINKED' });
    const v = vault();
    if (!v.dir) throw conflict('The vault folder is not set', { code: 'NO_VAULT' });
    let abs = '';
    try {
      abs = resolveInVault(v.dir, link.rel_path);
    } catch (e) {
      if (e instanceof WorkbookPathError) throw conflict('The linked Excel file cannot be read right now', { code: 'WORKBOOK_UNREADABLE', state: 'unreadable', reason: e.code });
      throw e;
    }
    if (!dataDir) throw new HttpError(500, 'The server has no data folder to keep a copy of the original in');
    await writeBack({ db, dataDir, projectId: id, relPath: link.rel_path, absPath: abs, fileDeps: deps, load }, input);
    return view(req, id);
  });

  // Where the results are, as label anchors; null goes back to detecting them on every load.
  app.put<{ Params: Params }>('/api/projects/:id/workbook/mapping', async (req): Promise<WorkbookViewDTO> => {
    const id = req.params.id;
    getProject(db, id);
    userOnly(req, 'change where the results are read from');
    if (!linkOf(id)) throw new HttpError(404, 'No Excel file is linked to this company', { code: 'WORKBOOK_NOT_LINKED' });
    const raw = (req.body as { mapping?: unknown } | null)?.mapping;
    if (raw === undefined) throw badRequest('mapping is required (null to detect again)');
    const mapping = raw === null ? null : parseMapping(raw);
    db.prepare('UPDATE project_workbooks SET mapping_json = ?, updated_at = ? WHERE project_id = ?').run(mapping ? JSON.stringify(mapping) : null, nowIso(), id);
    return view(req, id);
  });

  app.get<{ Params: Params }>('/api/projects/:id/workbook/diagnosis', async (req, reply) => {
    getProject(db, req.params.id);
    const v = vault();
    const link = linkOf(req.params.id);
    const opened = link ? await open(req, v, link) : null;
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return diagnosisText({ vaultReadable: v.readable, file: opened?.file ?? null, loaded: opened?.loaded ?? null, savedMapping: link ? parseJson<OutputMapping | null>(link.mapping_json, null) : null });
  });
}
