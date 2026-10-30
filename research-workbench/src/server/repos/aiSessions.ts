/** AI activity: writes grouped per client into sessions, saved summaries, and client connection status. */
import { AGENT_CLIENTS, type AgentClient } from '../../shared/actors';
import type { AiActionDTO, AiClientStatusDTO, AiSessionDTO } from '../../shared/api';
import type { DB } from '../db/connection';
import { badRequest, newId, parseJson } from '../util';
import { audit } from './audit';

/** A gap longer than this between two writes of a client starts a new session. */
export const SESSION_IDLE_MS = 30 * 60_000;
const MAX_ACTIONS = 500;

interface SessionRow {
  id: string;
  client: string;
  project_ids_json: string;
  started_at: string;
  last_at: string;
  actions_json: string;
  summary_md: string | null;
  decisions_md: string | null;
  todo_md: string | null;
  summary_at: string | null;
}

const toSession = (r: SessionRow): AiSessionDTO => ({
  id: r.id,
  client: r.client as AgentClient,
  startedAt: r.started_at,
  lastAt: r.last_at,
  projectIds: parseJson<string[]>(r.project_ids_json, []),
  actions: parseJson<AiActionDTO[]>(r.actions_json, []),
  summary: r.summary_md,
  decisions: r.decisions_md,
  todo: r.todo_md,
  summaryAt: r.summary_at,
});

const latest = (db: DB, client: string) => db.prepare('SELECT * FROM ai_sessions WHERE client = ? ORDER BY last_at DESC LIMIT 1').get(client) as SessionRow | undefined;
const isOpen = (r: SessionRow | undefined, now: Date): r is SessionRow => !!r && now.getTime() - Date.parse(r.last_at) <= SESSION_IDLE_MS;
const union = (a: string[], b: (string | null | undefined)[]) => [...new Set([...a, ...b.filter((x): x is string => !!x)])];

function insertSession(db: DB, client: string, now: Date, projectIds: string[], actions: AiActionDTO[]): string {
  const id = newId('ais');
  db.prepare('INSERT INTO ai_sessions (id, client, project_ids_json, started_at, last_at, actions_json) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    client,
    JSON.stringify(projectIds),
    now.toISOString(),
    now.toISOString(),
    JSON.stringify(actions),
  );
  return id;
}

/** Append the writes of one request to the client's open session, or start a new one. */
export function recordAiActions(db: DB, client: AgentClient, actions: AiActionDTO[], now = new Date()): string {
  return db.transaction(() => {
    const last = latest(db, client);
    const ids = actions.map((a) => a.projectId);
    if (!isOpen(last, now)) return insertSession(db, client, now, union([], ids), actions.slice(-MAX_ACTIONS));
    const merged = [...parseJson<AiActionDTO[]>(last.actions_json, []), ...actions].slice(-MAX_ACTIONS);
    db.prepare('UPDATE ai_sessions SET actions_json = ?, project_ids_json = ?, last_at = ? WHERE id = ?').run(
      JSON.stringify(merged),
      JSON.stringify(union(parseJson<string[]>(last.project_ids_json, []), ids)),
      now.toISOString(),
      last.id,
    );
    return last.id;
  })();
}

export interface SessionSummaryInput {
  summary: string;
  decisions?: string | null;
  todo?: string | null;
  projectIds?: string[];
}

/** Attach a conversation summary to the client's latest session (or a new one after 30 idle minutes). */
export function saveSessionSummary(db: DB, client: AgentClient, input: SessionSummaryInput, now = new Date()): AiSessionDTO {
  const summary = (input.summary ?? '').trim();
  if (!summary) throw badRequest('摘要是空的', { code: 'INVALID_INPUT' });
  if (summary.length > 20_000) throw badRequest('摘要太長（最多 20,000 字）', { code: 'INVALID_INPUT' });
  const projectIds = [...new Set(input.projectIds ?? [])];
  for (const id of projectIds) if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw badRequest(`找不到公司 ${id}`, { code: 'INVALID_INPUT' });
  return db.transaction(() => {
    const last = latest(db, client);
    const id = isOpen(last, now) ? last.id : insertSession(db, client, now, [], []);
    const before = toSession(db.prepare('SELECT * FROM ai_sessions WHERE id = ?').get(id) as SessionRow);
    db.prepare('UPDATE ai_sessions SET summary_md = ?, decisions_md = ?, todo_md = ?, summary_at = ?, project_ids_json = ?, last_at = ? WHERE id = ?').run(
      summary,
      input.decisions?.trim() || null,
      input.todo?.trim() || null,
      now.toISOString(),
      JSON.stringify(union(before.projectIds, projectIds)),
      now.toISOString(),
      id,
    );
    const after = toSession(db.prepare('SELECT * FROM ai_sessions WHERE id = ?').get(id) as SessionRow);
    audit(db, after.projectIds[0] ?? null, 'ai_session', id, 'update', before, after);
    return after;
  })();
}

export function listAiSessions(db: DB, o: { projectId?: string; client?: string; limit?: number } = {}): AiSessionDTO[] {
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 20) || 20, 1), 200);
  const where: string[] = [];
  const args: unknown[] = [];
  if (o.projectId) {
    where.push('EXISTS (SELECT 1 FROM json_each(ai_sessions.project_ids_json) WHERE value = ?)');
    args.push(o.projectId);
  }
  if (o.client) {
    where.push('client = ?');
    args.push(o.client);
  }
  const sql = `SELECT * FROM ai_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, limit) as SessionRow[]).map(toSession);
}

export interface Heartbeat {
  clientName?: string | null;
  clientVersion?: string | null;
  adapterVersion?: string | null;
}

/** Note that a client connected (every authenticated request, throttled) or sent a heartbeat. */
export function touchAiClient(db: DB, client: AgentClient, hb?: Heartbeat, now = new Date()): void {
  const t = now.toISOString();
  const cut = (s: string | null | undefined) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 120) : null);
  db.prepare(
    `INSERT INTO ai_clients (client, first_seen_at, last_seen_at, last_heartbeat_at, client_name, client_version, adapter_version)
     VALUES (@client, @t, @t, @hb, @name, @version, @adapter)
     ON CONFLICT(client) DO UPDATE SET last_seen_at = @t,
       last_heartbeat_at = COALESCE(@hb, last_heartbeat_at),
       client_name = CASE WHEN @hb IS NULL THEN client_name ELSE @name END,
       client_version = CASE WHEN @hb IS NULL THEN client_version ELSE @version END,
       adapter_version = CASE WHEN @hb IS NULL THEN adapter_version ELSE @adapter END`,
  ).run({ client, t, hb: hb ? t : null, name: cut(hb?.clientName), version: cut(hb?.clientVersion), adapter: cut(hb?.adapterVersion) });
}

/** Connection status of every AI client, in a fixed order (diagnostics and the settings page). */
export function listAiClients(db: DB): AiClientStatusDTO[] {
  return AGENT_CLIENTS.map((client) => {
    const r = db.prepare('SELECT * FROM ai_clients WHERE client = ?').get(client) as
      | { last_seen_at: string; last_heartbeat_at: string | null; client_name: string | null; client_version: string | null; adapter_version: string | null }
      | undefined;
    const w = db.prepare('SELECT MAX(last_at) AS m FROM ai_sessions WHERE client = ?').get(client) as { m: string | null };
    return {
      client,
      lastSeenAt: r?.last_seen_at ?? null,
      lastHeartbeatAt: r?.last_heartbeat_at ?? null,
      clientName: r?.client_name ?? null,
      clientVersion: r?.client_version ?? null,
      adapterVersion: r?.adapter_version ?? null,
      lastWriteAt: w.m,
    };
  });
}
