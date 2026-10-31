/**
 * `## 反思` sections read back from Obsidian. reflection_versions is append-only: every version the
 * plugin sends is kept, and an emptied section is stored as '' so the previous text stays readable
 * (blank never replaces what the user wrote; the UI shows the last non-empty version).
 */
import { reflectionHash } from '../../domain/vault/hash';
import { isReflectionKind, kindOfWbId, MAX_REFLECTION_CHARS, shouldStoreReflection, type ConflictReason, type ReflectionKind, type ReflectionUpload, type ServerReflectionState } from '../../domain/vault/types';
import type { ReflectionDTO, ReflectionVersionDTO } from '../../shared/api';
import { currentActor } from '../actor';
import type { DB } from '../db/connection';
import { audit } from '../repos/audit';
import { nowIso } from '../util';
import { latestReport } from './status';

export { MAX_REFLECTION_CHARS };
export const MAX_REFLECTION_ITEMS = 200;
export const MAX_PATH_CHARS = 1024;

interface VersionRow {
  id: number;
  note_kind: ReflectionKind;
  note_id: string;
  project_id: string;
  body_md: string;
  body_hash: string;
  source_path: string;
  file_mtime: string | null;
  received_at: string;
  actor: string | null;
}

const toVersion = (r: VersionRow): ReflectionVersionDTO => ({
  id: r.id,
  text: r.body_md,
  hash: r.body_hash,
  sourcePath: r.source_path,
  fileMtime: r.file_mtime,
  receivedAt: r.received_at,
  actor: r.actor,
});

export interface ReflectionResult {
  wbId: string;
  status: 'stored' | 'unchanged' | 'rejected';
  versionId?: number;
  error?: string;
}

/** A vault-relative path: no leading slash, no `..` segment, no NUL. */
export function validVaultPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.length || p.length > MAX_PATH_CHARS) return false;
  if (p.startsWith('/') || p.includes('\0')) return false;
  return !p.split(/[\\/]/).includes('..');
}

/** The project a reflection belongs to; a deleted trade is found through its tombstone. */
function projectOfNote(db: DB, kind: ReflectionKind, wbId: string): string | null {
  if (kind === 'company') return (db.prepare('SELECT id FROM projects WHERE id = ?').get(wbId) as { id: string } | undefined)?.id ?? null;
  if (kind === 'research_update') {
    return (db.prepare("SELECT project_id FROM revisions WHERE id = ? AND kind <> 'initial'").get(wbId) as { project_id: string } | undefined)?.project_id ?? null;
  }
  const live = db.prepare('SELECT project_id FROM trades WHERE id = ?').get(wbId) as { project_id: string } | undefined;
  if (live) return live.project_id;
  const tomb = db
    .prepare("SELECT json_extract(tombstone_json, '$.projectId') AS pid FROM vault_changes WHERE note_id = ? AND op = 'delete' ORDER BY seq DESC LIMIT 1")
    .get(wbId) as { pid: string | null } | undefined;
  const pid = tomb?.pid ?? null;
  return pid && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid) ? pid : null;
}

function stateOf(db: DB, wbId: string): ServerReflectionState | undefined {
  const latest = db.prepare('SELECT body_hash FROM reflection_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1').get(wbId) as { body_hash: string } | undefined;
  if (!latest) return undefined;
  const byPath: Record<string, string> = {};
  const rows = db
    .prepare('SELECT source_path, body_hash FROM reflection_versions WHERE id IN (SELECT MAX(id) FROM reflection_versions WHERE note_id = ? GROUP BY source_path)')
    .all(wbId) as { source_path: string; body_hash: string }[];
  for (const r of rows) byPath[r.source_path] = r.body_hash;
  return { latest: latest.body_hash, byPath };
}

/**
 * The text as stored: LF line breaks, NFC, without leading blank lines or trailing whitespace. The
 * first line's indentation is the user's (an indented code block, a nested list) and is kept.
 */
export const normalizeReflection = (t: string) =>
  t
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();

/** Store the reflections that changed, in one transaction (the caller validated the list's shape). */
export function storeReflections(db: DB, items: ReflectionUpload[]): ReflectionResult[] {
  return db.transaction(() =>
    items.map((item): ReflectionResult => {
      const wbId = typeof item?.wbId === 'string' ? item.wbId : '';
      const kind = kindOfWbId(wbId);
      if (!isReflectionKind(kind)) return { wbId, status: 'rejected', error: 'not a note with a reflection' };
      if (typeof item.text !== 'string') return { wbId, status: 'rejected', error: 'text must be a string' };
      if (item.text.length > MAX_REFLECTION_CHARS) return { wbId, status: 'rejected', error: `text is longer than ${MAX_REFLECTION_CHARS} characters` };
      if (!validVaultPath(item.path)) return { wbId, status: 'rejected', error: 'invalid path' };
      const projectId = projectOfNote(db, kind, wbId);
      if (!projectId) return { wbId, status: 'rejected', error: 'unknown note' };
      const text = normalizeReflection(item.text);
      const hash = reflectionHash(text);
      if (!shouldStoreReflection(hash, text === '', item.path, stateOf(db, wbId))) return { wbId, status: 'unchanged' };
      const mtime = typeof item.mtime === 'number' && Number.isFinite(item.mtime) && Math.abs(item.mtime) < 8.64e15 ? new Date(item.mtime).toISOString() : null;
      const versionId = Number(
        db
          .prepare(
            'INSERT INTO reflection_versions (note_kind, note_id, project_id, body_md, body_hash, source_path, file_mtime, received_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(kind, wbId, projectId, text, hash, item.path, mtime, nowIso(), currentActor()).lastInsertRowid,
      );
      const duplicates = Array.isArray(item.duplicatePaths) ? item.duplicatePaths.filter(validVaultPath).slice(0, 20) : [];
      audit(db, projectId, 'reflection', wbId, 'create', null, {
        versionId,
        sourcePath: item.path,
        chars: text.length,
        cleared: text === '',
        ...(duplicates.length ? { duplicatePaths: duplicates } : {}),
      });
      return { wbId, status: 'stored', versionId };
    }),
  )();
}

/** What the server holds per note (GET /api/vault/reflections/hashes): latest hash and latest per path. */
export function reflectionStates(db: DB): Record<string, ServerReflectionState> {
  const out: Record<string, ServerReflectionState> = {};
  const latest = db.prepare('SELECT note_id, body_hash FROM reflection_versions WHERE id IN (SELECT MAX(id) FROM reflection_versions GROUP BY note_id)').all() as {
    note_id: string;
    body_hash: string;
  }[];
  for (const r of latest) out[r.note_id] = { latest: r.body_hash, byPath: {} };
  const byPath = db
    .prepare('SELECT note_id, source_path, body_hash FROM reflection_versions WHERE id IN (SELECT MAX(id) FROM reflection_versions GROUP BY note_id, source_path)')
    .all() as { note_id: string; source_path: string; body_hash: string }[];
  for (const r of byPath) out[r.note_id].byPath[r.source_path] = r.body_hash;
  return out;
}

export function reflectionVersions(db: DB, noteId: string): ReflectionVersionDTO[] {
  return (db.prepare('SELECT * FROM reflection_versions WHERE note_id = ? ORDER BY id DESC').all(noteId) as VersionRow[]).map(toVersion);
}

/** Every version of a project's reflections, oldest first (project export). */
export function projectReflectionVersions(db: DB, projectId: string): (ReflectionVersionDTO & { noteId: string; kind: ReflectionKind })[] {
  return (db.prepare('SELECT * FROM reflection_versions WHERE project_id = ? ORDER BY id').all(projectId) as VersionRow[]).map((r) => ({
    noteId: r.note_id,
    kind: r.note_kind,
    ...toVersion(r),
  }));
}

export const obsidianUrl = (vault: string, path: string) => `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;

/** The newest reported location of a note: [vault, path]. */
function notePaths(db: DB, noteIds: string[]): Map<string, { vault: string; path: string }> {
  const out = new Map<string, { vault: string; path: string }>();
  if (!noteIds.length) return out;
  const rows = db
    .prepare('SELECT vault_name, note_id, path FROM vault_note_paths WHERE note_id IN (SELECT value FROM json_each(?)) ORDER BY seen_at, vault_name')
    .all(JSON.stringify(noteIds)) as { vault_name: string; note_id: string; path: string }[];
  for (const r of rows) out.set(r.note_id, { vault: r.vault_name, path: r.path }); // later (newer) rows win
  return out;
}

/**
 * The reflections of a company's notes: the company itself, its Research Updates and its trades
 * (also deleted ones that have a reflection). Notes with neither a reflection nor a known path in
 * the vault are left out.
 */
export function projectReflections(db: DB, projectId: string): ReflectionDTO[] {
  const notes: { id: string; kind: ReflectionKind }[] = [
    { id: projectId, kind: 'company' },
    ...(db.prepare("SELECT id FROM revisions WHERE project_id = ? AND kind <> 'initial' ORDER BY seq").all(projectId) as { id: string }[]).map((r) => ({
      id: r.id,
      kind: 'research_update' as const,
    })),
    ...(db.prepare('SELECT id FROM trades WHERE project_id = ? ORDER BY entry_date, created_at, id').all(projectId) as { id: string }[]).map((r) => ({ id: r.id, kind: 'trade' as const })),
  ];
  const known = new Set(notes.map((n) => n.id));
  for (const r of db.prepare("SELECT DISTINCT note_id FROM reflection_versions WHERE project_id = ? AND note_kind = 'trade' ORDER BY note_id").all(projectId) as { note_id: string }[]) {
    if (!known.has(r.note_id)) notes.push({ id: r.note_id, kind: 'trade' });
  }
  const versions = new Map<string, VersionRow[]>();
  for (const r of db.prepare('SELECT * FROM reflection_versions WHERE project_id = ? ORDER BY id').all(projectId) as VersionRow[]) {
    versions.set(r.note_id, [...(versions.get(r.note_id) ?? []), r]);
  }
  const paths = notePaths(db, notes.map((n) => n.id));
  const report = latestReport(db);
  const conflicts = new Map((report?.conflicts ?? []).map((c) => [c.wbId, c.reason] as const));

  return notes.flatMap(({ id, kind }): ReflectionDTO[] => {
    const vs = versions.get(id) ?? [];
    const located = paths.get(id) ?? null;
    if (!vs.length && !located) return [];
    const newest = vs.at(-1) ?? null;
    const shown = [...vs].reverse().find((v) => v.body_md !== '') ?? null;
    const where = located ?? (newest && report ? { vault: report.vaultName, path: newest.source_path } : null);
    return [
      {
        noteId: id,
        kind,
        projectId,
        text: shown?.body_md ?? '',
        receivedAt: shown?.received_at ?? null,
        versionCount: vs.length,
        cleared: newest && newest.body_md === '' ? { at: newest.received_at } : null,
        obsidianUrl: where ? obsidianUrl(where.vault, where.path) : null,
        conflict: (conflicts.get(id) as ConflictReason | undefined) ?? null,
      },
    ];
  });
}

export const EXCERPT_CHARS = 1000;

/** The latest non-empty reflection of each trade (trade log). */
export function latestExcerpts(db: DB, tradeIds: string[]): Map<string, { excerpt: string; receivedAt: string; cleared: boolean }> {
  const out = new Map<string, { excerpt: string; receivedAt: string; cleared: boolean }>();
  if (!tradeIds.length) return out;
  const ids = JSON.stringify(tradeIds);
  const shown = db
    .prepare(
      `SELECT note_id, body_md, received_at FROM reflection_versions WHERE id IN (
         SELECT MAX(id) FROM reflection_versions WHERE body_md <> '' AND note_id IN (SELECT value FROM json_each(?)) GROUP BY note_id)`,
    )
    .all(ids) as { note_id: string; body_md: string; received_at: string }[];
  const newest = new Map(
    (
      db
        .prepare('SELECT note_id, body_md FROM reflection_versions WHERE id IN (SELECT MAX(id) FROM reflection_versions WHERE note_id IN (SELECT value FROM json_each(?)) GROUP BY note_id)')
        .all(ids) as { note_id: string; body_md: string }[]
    ).map((r) => [r.note_id, r.body_md]),
  );
  for (const r of shown) {
    const chars = [...r.body_md];
    const excerpt = chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('')}…` : r.body_md;
    out.set(r.note_id, { excerpt, receivedAt: r.received_at, cleared: newest.get(r.note_id) === '' });
  }
  return out;
}
