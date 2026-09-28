import type { DB } from '../db/connection';
import type { AuditEntryDTO } from '../../shared/api';
import { nowIso, parseJson } from '../util';

export function audit(db: DB, projectId: string | null, entity: string, entityId: string, action: 'update' | 'delete' | 'archive' | 'unarchive', before: unknown, after: unknown) {
  db.prepare('INSERT INTO audit_log (project_id, entity, entity_id, action, at, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    projectId,
    entity,
    entityId,
    action,
    nowIso(),
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
  );
}

export function listAudit(db: DB, projectId: string, entityId?: string): AuditEntryDTO[] {
  const rows = (
    entityId
      ? db.prepare('SELECT * FROM audit_log WHERE project_id = ? AND entity_id = ? ORDER BY id DESC').all(projectId, entityId)
      : db.prepare('SELECT * FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 500').all(projectId)
  ) as { id: number; entity: string; entity_id: string; action: string; at: string; before_json: string | null; after_json: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    entityId: r.entity_id,
    action: r.action,
    at: r.at,
    before: parseJson(r.before_json, null),
    after: parseJson(r.after_json, null),
  }));
}
