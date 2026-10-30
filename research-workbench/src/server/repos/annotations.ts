/**
 * Marks on committed Research Updates. A commit cannot be changed or deleted; marking it
 * "wrong, exclude from calibration" only takes it out of the estimate history and calibration.
 * Insert-only: the latest excluded/included row decides, so a mark can be undone with another row.
 */
import type { AnnotationKind, RevisionAnnotationDTO } from '../../shared/api';
import { currentActor } from '../actor';
import type { DB } from '../db/connection';
import { badRequest, nowIso } from '../util';
import { audit } from './audit';
import { getRevisionRow } from './projects';

interface AnnotationRow {
  id: number;
  revision_id: string;
  project_id: string;
  kind: AnnotationKind;
  note: string;
  actor: string;
  at: string;
}

const toDTO = (r: AnnotationRow): RevisionAnnotationDTO => ({ id: r.id, revisionId: r.revision_id, projectId: r.project_id, kind: r.kind, note: r.note, actor: r.actor, at: r.at });

const KINDS = new Set<AnnotationKind>(['excluded', 'included', 'note']);

export function addAnnotation(db: DB, projectId: string, revisionId: string, input: { kind?: string; note?: string }): RevisionAnnotationDTO {
  const rev = getRevisionRow(db, projectId, revisionId);
  const kind = input.kind as AnnotationKind;
  if (!KINDS.has(kind)) throw badRequest('Annotation kind must be excluded, included or note');
  const note = (input.note ?? '').trim();
  if (kind === 'note' && !note) throw badRequest('The note is empty');
  if (note.length > 10_000) throw badRequest('The note is too long');
  if (rev.kind === 'initial' && kind === 'excluded') throw badRequest('The starting snapshot has no estimates to exclude');
  return db.transaction(() => {
    const id = Number(
      db.prepare('INSERT INTO revision_annotations (revision_id, project_id, kind, note, actor, at) VALUES (?, ?, ?, ?, ?, ?)').run(revisionId, projectId, kind, note, currentActor(), nowIso()).lastInsertRowid,
    );
    const dto = toDTO(db.prepare('SELECT * FROM revision_annotations WHERE id = ?').get(id) as AnnotationRow);
    audit(db, projectId, 'revision_annotation', String(id), 'create', null, dto);
    return dto;
  })();
}

export function listAnnotations(db: DB, projectId: string): RevisionAnnotationDTO[] {
  return (db.prepare('SELECT * FROM revision_annotations WHERE project_id = ? ORDER BY id').all(projectId) as AnnotationRow[]).map(toDTO);
}

/** Revisions currently marked wrong (excluded from history charts and calibration). */
export function excludedSet(db: DB, projectId: string): Set<string> {
  const latest = new Map<string, AnnotationKind>();
  for (const a of listAnnotations(db, projectId)) if (a.kind !== 'note') latest.set(a.revisionId, a.kind);
  return new Set([...latest].filter(([, k]) => k === 'excluded').map(([id]) => id));
}
