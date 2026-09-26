import { compute, freeze } from '../../domain/calc/engine';
import { parseState } from '../../domain/model/schema';
import type { ModelState } from '../../domain/model/types';
import { diffStates } from '../../domain/revision/diff';
import { computeImpact } from '../../domain/revision/impact';
import type { RevisionFull, RevisionKind } from '../../shared/api';
import type { DB } from '../db/connection';
import { assertLinksBelong, getDraftRow, getRevisionRow, insertRevision, primarySecurity, toRevisionFull } from '../repos/projects';
import { getQuote } from '../repos/market';
import { addDays, badRequest, conflict, isDate, localToday, nowIso } from '../util';

export interface CommitInput {
  title: string;
  reason: string;
  notes?: string;
  /** Knowledge date: the date the analyst knew what this update reflects. */
  asOfDate: string;
  evidenceIds?: string[];
  draftVersion: number;
  kind?: RevisionKind;
}

/**
 * Commit the draft as an immutable Research Update:
 * validate → diff → compute before/after → impact + attribution → freeze outputs → insert → rebase draft.
 * Runs in one transaction.
 */
export function commitDraft(db: DB, projectId: string, input: CommitInput, today = localToday()): RevisionFull {
  const title = (input.title ?? '').trim();
  const reason = (input.reason ?? '').trim();
  if (!title) throw badRequest('A Research Update needs a title');
  if (!reason) throw badRequest('Explain the reason / interpretation: why did your view change (or why is it unchanged)?');
  if (!isDate(input.asOfDate)) throw badRequest('Knowledge date must be YYYY-MM-DD');
  if (input.asOfDate > addDays(today, 1)) throw badRequest(`Knowledge date ${input.asOfDate} is in the future`);

  return db.transaction(() => {
    const draft = getDraftRow(db, projectId);
    if (draft.version !== input.draftVersion) {
      throw conflict('The draft changed since you reviewed it. Review the changes again before committing.', { currentVersion: draft.version });
    }
    const head = getRevisionRow(db, projectId, draft.base_revision_id);
    const latest = db
      .prepare('SELECT seq, as_of_date FROM revisions WHERE project_id = ? AND as_of_date IS NOT NULL ORDER BY seq DESC LIMIT 1')
      .get(projectId) as { seq: number; as_of_date: string } | undefined;
    if (latest && input.asOfDate < latest.as_of_date) {
      throw badRequest(
        `Knowledge date ${input.asOfDate} is earlier than Research Update #${latest.seq} (${latest.as_of_date}). Updates must be in chronological order so that point-in-time history has no look-ahead.`,
      );
    }

    const evidenceIds = [...new Set(input.evidenceIds ?? [])];
    for (const id of evidenceIds) {
      const ev = db.prepare('SELECT title, published_at FROM evidence WHERE id = ? AND project_id = ?').get(id, projectId) as { title: string; published_at: string | null } | undefined;
      if (!ev) throw badRequest(`Evidence ${id} not found in this project`);
      if (ev.published_at && ev.published_at > input.asOfDate) {
        throw badRequest(`“${ev.title}” was published ${ev.published_at}, after this update’s knowledge date ${input.asOfDate}. Citing it would be look-ahead.`);
      }
    }

    const parsedAfter = parseState(JSON.parse(draft.state_json));
    if (!parsedAfter.ok) throw badRequest('The draft model is invalid', parsedAfter.errors);
    const after = parsedAfter.state;
    assertLinksBelong(db, projectId, after);
    const linked = [...new Set(after.links.map((l) => l.evidenceId))];
    if (linked.length) {
      const late = db
        .prepare(`SELECT title, published_at FROM evidence WHERE project_id = ? AND published_at > ? AND id IN (${linked.map(() => '?').join(',')})`)
        .all(projectId, input.asOfDate, ...linked) as { title: string; published_at: string }[];
      if (late.length) {
        throw badRequest(
          `Linked evidence was published after the knowledge date ${input.asOfDate}: ${late.map((e) => `“${e.title}” (${e.published_at})`).join(', ')}. Move the knowledge date or unlink it.`,
        );
      }
    }
    const before = JSON.parse(head.state_json) as ModelState;

    const changes = diffStates(before, after);
    let kind: RevisionKind = input.kind ?? 'update';
    if (changes.length === 0) kind = 'checkpoint';
    else if (kind === 'checkpoint') kind = 'update';

    const rb = compute(before);
    const ra = compute(after);
    const impact = changes.length ? computeImpact(before, after, { before: rb, after: ra, changes }) : null;

    const security = primarySecurity(db, projectId);
    const market = security ? getQuote(db, security.id, security.priceSource) : null;

    const id = insertRevision(db, {
      projectId,
      parentId: head.id,
      kind,
      title,
      reason,
      notes: input.notes ?? '',
      asOfDate: input.asOfDate,
      state: after,
      computed: freeze(ra),
      changes,
      impact,
      market,
    });
    const ins = db.prepare('INSERT OR IGNORE INTO revision_evidence (revision_id, evidence_id, kind) VALUES (?, ?, ?)');
    for (const ev of evidenceIds) ins.run(id, ev, 'cited');
    for (const ev of new Set(after.links.map((l) => l.evidenceId))) ins.run(id, ev, 'linked');
    db.prepare('UPDATE drafts SET base_revision_id = ?, version = version + 1, updated_at = ? WHERE project_id = ?').run(id, nowIso(), projectId);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), projectId);
    return toRevisionFull(db, getRevisionRow(db, projectId, id));
  })();
}
