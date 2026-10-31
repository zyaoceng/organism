/**
 * The plugin's status reports (POST /api/vault/status, sent after every sync run) and what the
 * settings page and diagnostics show from them.
 */
import { kindOfWbId, type ConflictReason, type VaultStatusReport } from '../../domain/vault/types';
import type { VaultStatusDTO } from '../../shared/api';
import type { DB } from '../db/connection';
import { badRequest, nowIso, parseJson } from '../util';

export const CONNECTED_MS = 3 * 60_000;
const MAX_CONFLICTS = 500;
const MAX_ERRORS = 10;
const MAX_ERROR_CHARS = 500;
const MAX_PATHS = 20_000;
const REASONS = new Set<ConflictReason>(['hand-edited', 'missing-markers', 'invalid-markers', 'invalid-frontmatter', 'id-mismatch', 'duplicate-id', 'write-failed', 'unavailable']);

/** What vault_clients.report_json keeps of a report. */
export interface StoredReport {
  vaultName: string;
  protocol: number;
  pending: number;
  skippedOpen: number;
  missing: number;
  conflicts: { wbId: string; reason: ConflictReason; paths: string[] }[];
  errors: string[];
}

const count = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw badRequest(`${what} must be a whole number ≥ 0`);
  return v;
};
const shortText = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string' || v.length > max) throw badRequest(`${what} must be text of at most ${max} characters`);
  return v;
};
const pathText = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.startsWith('/') && !v.split(/[\\/]/).includes('..');

/** Check a POST /api/vault/status body; long lists are cut rather than refused. */
export function parseReport(b: unknown): VaultStatusReport {
  if (!b || typeof b !== 'object') throw badRequest('The status report must be a JSON object');
  const r = b as Record<string, unknown>;
  const vaultName = shortText(r.vaultName, 'vaultName', 200).trim();
  if (!vaultName) throw badRequest('vaultName is required');
  if (!Array.isArray(r.conflicts) || !Array.isArray(r.errors)) throw badRequest('conflicts and errors must be lists');
  const conflicts = r.conflicts.slice(0, MAX_CONFLICTS).flatMap((c) => {
    const x = c as { wbId?: unknown; reason?: unknown; paths?: unknown };
    if (!x || typeof x.wbId !== 'string' || !kindOfWbId(x.wbId) || !REASONS.has(x.reason as ConflictReason)) return [];
    const paths = Array.isArray(x.paths) ? x.paths.filter(pathText).slice(0, 20) : [];
    return [{ wbId: x.wbId, reason: x.reason as ConflictReason, paths: paths as string[] }];
  });
  const errors = r.errors.slice(0, MAX_ERRORS).map((e) => String(e).slice(0, MAX_ERROR_CHARS));
  let paths: VaultStatusReport['paths'];
  if (r.paths !== undefined && r.paths !== null) {
    const p = r.paths as { reset?: unknown; set?: unknown; removed?: unknown };
    if (typeof p !== 'object' || (p.set !== undefined && (typeof p.set !== 'object' || p.set === null || Array.isArray(p.set))) || (p.removed !== undefined && !Array.isArray(p.removed))) {
      throw badRequest('paths must be { reset, set, removed }');
    }
    const set = Object.entries((p.set ?? {}) as Record<string, unknown>).filter(([id, v]) => kindOfWbId(id) && pathText(v)) as [string, string][];
    const removed = ((p.removed ?? []) as unknown[]).filter((id): id is string => typeof id === 'string' && !!kindOfWbId(id));
    if (set.length + removed.length > MAX_PATHS) throw badRequest(`At most ${MAX_PATHS} paths per report`);
    paths = { reset: p.reset === true, set: Object.fromEntries(set), removed };
  }
  return {
    protocol: count(r.protocol, 'protocol'),
    pluginVersion: shortText(r.pluginVersion ?? '', 'pluginVersion', 40),
    vaultName,
    cursor: count(r.cursor, 'cursor'),
    pending: count(r.pending, 'pending'),
    skippedOpen: count(r.skippedOpen, 'skippedOpen'),
    missing: count(r.missing, 'missing'),
    conflicts,
    errors,
    paths,
  };
}

/** Record a report: one vault_clients row per vault, and the note locations it lists. */
export function saveStatus(db: DB, report: VaultStatusReport, now = nowIso()): void {
  const stored: StoredReport = {
    vaultName: report.vaultName,
    protocol: report.protocol,
    pending: report.pending,
    skippedOpen: report.skippedOpen,
    missing: report.missing,
    conflicts: report.conflicts,
    errors: report.errors,
  };
  db.transaction(() => {
    // delete and insert (not an upsert): the newest report gets the highest rowid, which breaks a
    // tie between two vaults that report within the same millisecond (latestClient)
    const client = `obsidian:${report.vaultName}`;
    db.prepare('DELETE FROM vault_clients WHERE client = ?').run(client);
    db.prepare(
      'INSERT INTO vault_clients (client, vault_name, last_seen_at, plugin_version, cursor, report_json) VALUES (@client, @vault, @now, @version, @cursor, @report)',
    ).run({ client, vault: report.vaultName, now, version: report.pluginVersion, cursor: report.cursor, report: JSON.stringify(stored) });
    const p = report.paths;
    if (!p) return;
    if (p.reset) db.prepare('DELETE FROM vault_note_paths WHERE vault_name = ?').run(report.vaultName);
    const put = db.prepare(
      'INSERT INTO vault_note_paths (vault_name, note_id, path, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(vault_name, note_id) DO UPDATE SET path = excluded.path, seen_at = excluded.seen_at',
    );
    for (const [id, path] of Object.entries(p.set)) put.run(report.vaultName, id, path, now);
    const del = db.prepare('DELETE FROM vault_note_paths WHERE vault_name = ? AND note_id = ?');
    for (const id of p.removed) del.run(report.vaultName, id);
  })();
}

interface ClientRow {
  client: string;
  vault_name: string;
  last_seen_at: string;
  plugin_version: string;
  cursor: number;
  report_json: string;
}

const latestClient = (db: DB) => db.prepare('SELECT * FROM vault_clients ORDER BY last_seen_at DESC, rowid DESC LIMIT 1').get() as ClientRow | undefined;

/** The most recently seen vault's last report. */
export function latestReport(db: DB): StoredReport | null {
  const c = latestClient(db);
  if (!c) return null;
  const r = parseJson<Partial<StoredReport>>(c.report_json, {});
  return { vaultName: c.vault_name, protocol: r.protocol ?? 0, pending: r.pending ?? 0, skippedOpen: r.skippedOpen ?? 0, missing: r.missing ?? 0, conflicts: r.conflicts ?? [], errors: r.errors ?? [] };
}

/** A readable name for a note in the conflict list. */
function noteTitle(db: DB, wbId: string): string {
  const kind = kindOfWbId(wbId);
  const company = (pid: string) => {
    const r = db.prepare('SELECT p.name, (SELECT ticker FROM securities WHERE project_id = p.id ORDER BY is_primary DESC, ticker LIMIT 1) AS ticker FROM projects p WHERE p.id = ?').get(pid) as
      | { name: string; ticker: string | null }
      | undefined;
    return r ? [r.ticker, r.name].filter(Boolean).join(' ') : pid;
  };
  if (kind === 'company') return company(wbId);
  if (kind === 'research_update') {
    const r = db.prepare('SELECT project_id, seq, title FROM revisions WHERE id = ?').get(wbId) as { project_id: string; seq: number; title: string } | undefined;
    return r ? `${company(r.project_id)} #${r.seq} ${r.title}` : wbId;
  }
  if (kind === 'trade') {
    const r = db.prepare('SELECT project_id, entry_date, side FROM trades WHERE id = ?').get(wbId) as { project_id: string; entry_date: string; side: string } | undefined;
    return r ? `${company(r.project_id)} ${r.entry_date} ${r.side === 'short' ? '做空' : '做多'}` : wbId;
  }
  if (kind === 'ai_session') {
    const r = db.prepare('SELECT started_at FROM ai_sessions WHERE id = ?').get(wbId) as { started_at: string } | undefined;
    return r ? `AI 對話 ${r.started_at.slice(0, 10)}` : wbId;
  }
  return { 'index-companies': '公司總表', 'index-trades': '交易總表', 'index-ai': 'AI 對話總表' }[wbId] ?? wbId;
}

/** GET /api/vault/status and diagnostics `vault`: null until a plugin has reported. */
export function vaultStatus(db: DB, now = Date.now()): VaultStatusDTO | null {
  const c = latestClient(db);
  if (!c) return null;
  const r = latestReport(db)!;
  const latestSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM vault_changes').get() as { m: number }).m;
  return {
    connected: now - Date.parse(c.last_seen_at) <= CONNECTED_MS,
    lastSeenAt: c.last_seen_at,
    pluginVersion: c.plugin_version,
    vaultName: c.vault_name,
    cursor: c.cursor,
    latestSeq,
    behind: Math.max(0, latestSeq - c.cursor),
    pending: r.pending,
    skippedOpen: r.skippedOpen,
    missing: r.missing,
    conflicts: r.conflicts.map((x) => ({ ...x, title: noteTitle(db, x.wbId) })),
    errors: r.errors,
  };
}
