/**
 * draft_ops: every write to a draft (browser saves, discards, restores, recoveries, AI operations,
 * commits) with who made it, what changed and the full state before it. It attributes pending
 * draft changes to their authors and lets a discarded draft be recovered.
 */
import { parseState } from '../../domain/model/schema';
import type { ModelState } from '../../domain/model/types';
import { changeKey } from '../../domain/revision/changeKey';
import { describeChange } from '../../domain/revision/describe';
import { diffStates, type ModelChange } from '../../domain/revision/diff';
import { isAgentActor } from '../../shared/actors';
import type { ContributorDTO, DraftDTO, DraftOpKind, DraftOpRowDTO, DraftPendingDTO } from '../../shared/api';
import { currentActor } from '../actor';
import type { DB } from '../db/connection';
import { badRequest, conflict, notFound, nowIso, parseJson } from '../util';
import { audit } from './audit';
import { getDraft, getDraftRow, getRevisionRow, writeDraftState, type DraftRow, type RevisionRow } from './projects';

export interface DraftOpRow {
  id: number;
  project_id: string;
  base_revision_id: string;
  version_after: number;
  actor: string;
  at: string;
  kind: DraftOpKind;
  op_json: string;
  changes_json: string;
  before_json: string | null;
  summary: string;
}

export interface LogDraftOp {
  projectId: string;
  baseRevisionId: string;
  versionBefore: number;
  versionAfter: number;
  kind: DraftOpKind;
  op: unknown;
  changes: ModelChange[];
  /** The draft state before this write (kept for recovery); null when nothing needs keeping. */
  before: ModelState | null;
  /** The state after the write; needed to merge consecutive browser saves. */
  after?: ModelState;
  summary: string;
  /** Merge into the previous row when it is a recent save of the same actor (browser autosave bursts). */
  coalesce?: boolean;
}

/** Consecutive autosaves of one person within this window share one row (and one "before"). */
const COALESCE_MS = 10 * 60_000;
/** The "before" state of save and ops rows is dropped after this; discards and restores keep theirs. */
const KEEP_BEFORE_MS = 90 * 24 * 3600_000;

/** Record a draft write. Runs inside the caller's transaction. Returns the row id. */
export function logDraftOp(db: DB, i: LogDraftOp): number {
  const actor = currentActor();
  const now = nowIso();
  if (i.coalesce && i.after) {
    const last = db.prepare('SELECT * FROM draft_ops WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(i.projectId) as DraftOpRow | undefined;
    if (
      last &&
      last.kind === 'save' &&
      last.actor === actor &&
      last.base_revision_id === i.baseRevisionId &&
      last.version_after === i.versionBefore &&
      last.before_json &&
      Date.now() - Date.parse(last.at) < COALESCE_MS
    ) {
      const changes = diffStates(JSON.parse(last.before_json) as ModelState, i.after);
      db.prepare('UPDATE draft_ops SET version_after = ?, at = ?, changes_json = ?, summary = ? WHERE id = ?').run(i.versionAfter, now, JSON.stringify(changes), i.summary, last.id);
      return last.id;
    }
  }
  const id = Number(
    db
      .prepare('INSERT INTO draft_ops (project_id, base_revision_id, version_after, actor, at, kind, op_json, changes_json, before_json, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.projectId, i.baseRevisionId, i.versionAfter, actor, now, i.kind, JSON.stringify(i.op ?? null), JSON.stringify(i.changes), i.before ? JSON.stringify(i.before) : null, i.summary).lastInsertRowid,
  );
  if (i.kind !== 'save') audit(db, i.projectId, 'draft', String(id), 'draft_op', null, { opId: id, kind: i.kind, summary: i.summary, versionAfter: i.versionAfter });
  return id;
}

const toRowDTO = (r: DraftOpRow & { change_count: number; has_before: number }): DraftOpRowDTO => ({
  id: r.id,
  at: r.at,
  actor: r.actor,
  kind: r.kind,
  summary: r.summary,
  changeCount: r.change_count,
  versionAfter: r.version_after,
  baseRevisionId: r.base_revision_id,
  hasBefore: r.has_before === 1,
});

const ROW_COLUMNS = 'id, project_id, base_revision_id, version_after, actor, at, kind, summary, json_array_length(changes_json) AS change_count, before_json IS NOT NULL AS has_before';

/** Newest first, without the stored states. */
export function listDraftOps(db: DB, projectId: string, o: { limit?: number; beforeId?: number } = {}): DraftOpRowDTO[] {
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 50) || 50, 1), 500);
  const rows = (
    o.beforeId
      ? db.prepare(`SELECT ${ROW_COLUMNS} FROM draft_ops WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?`).all(projectId, o.beforeId, limit)
      : db.prepare(`SELECT ${ROW_COLUMNS} FROM draft_ops WHERE project_id = ? ORDER BY id DESC LIMIT ?`).all(projectId, limit)
  ) as (DraftOpRow & { change_count: number; has_before: number })[];
  return rows.map(toRowDTO);
}

export function lastDraftOp(db: DB, projectId: string): DraftOpRowDTO | null {
  const r = db.prepare(`SELECT ${ROW_COLUMNS} FROM draft_ops WHERE project_id = ? ORDER BY id DESC LIMIT 1`).get(projectId) as (DraftOpRow & { change_count: number; has_before: number }) | undefined;
  return r ? toRowDTO(r) : null;
}

export function getDraftOpRow(db: DB, id: number): DraftOpRow {
  const r = db.prepare('SELECT * FROM draft_ops WHERE id = ?').get(id) as DraftOpRow | undefined;
  if (!r) throw notFound('Draft history entry');
  return r;
}

/** Writes after `version` (for "the draft changed since you read it: …"). */
export function draftOpsSince(db: DB, projectId: string, version: number): { actor: string; at: string; kind: DraftOpKind; summary: string }[] {
  return db.prepare('SELECT actor, at, kind, summary FROM draft_ops WHERE project_id = ? AND version_after > ? ORDER BY id').all(projectId, version) as {
    actor: string;
    at: string;
    kind: DraftOpKind;
    summary: string;
  }[];
}

export interface PendingAttribution {
  draft: DraftRow;
  head: RevisionRow;
  /** Uncommitted changes: head → draft. */
  changes: ModelChange[];
  /** Who last touched the field of a change; null for edits made before v2 (or never logged). */
  actorOf(c: ModelChange): string | null;
  /** Changes the user (or an unknown author) made: an AI may not commit or discard these. */
  userOwned: ModelChange[];
  contributors: ContributorDTO[];
}

/** The last writer of each field (changeKey) among the draft writes on a base, optionally only those before `beforeId`. */
function fieldOwners(db: DB, projectId: string, baseRevisionId: string, beforeId = Number.MAX_SAFE_INTEGER): Map<string, string> {
  const owner = new Map<string, string>();
  const rows = db.prepare('SELECT actor, changes_json FROM draft_ops WHERE project_id = ? AND base_revision_id = ? AND id < ? ORDER BY id').all(projectId, baseRevisionId, beforeId) as {
    actor: string;
    changes_json: string;
  }[];
  for (const r of rows) for (const c of parseJson<ModelChange[]>(r.changes_json, [])) owner.set(changeKey(c), r.actor);
  return owner;
}

/** The user's (or, before v2, nobody's recorded) edit: an AI may not commit, discard or take credit for it. */
const byUser = (actor: string | null | undefined) => actor === null || actor === undefined || actor === 'user';

/** Attribute each pending change to the last writer of its field since the draft's base. */
export function pendingAttribution(db: DB, projectId: string): PendingAttribution {
  const draft = getDraftRow(db, projectId);
  const head = getRevisionRow(db, projectId, draft.base_revision_id);
  const changes = diffStates(JSON.parse(head.state_json) as ModelState, JSON.parse(draft.state_json) as ModelState);
  const owner = fieldOwners(db, projectId, draft.base_revision_id);
  const actorOf = (c: ModelChange) => owner.get(changeKey(c)) ?? null;
  const counts = new Map<string | null, number>();
  for (const c of changes) counts.set(actorOf(c), (counts.get(actorOf(c)) ?? 0) + 1);
  return {
    draft,
    head,
    changes,
    actorOf,
    userOwned: changes.filter((c) => byUser(actorOf(c))),
    contributors: [...counts].map(([actor, n]) => ({ actor, changes: n })),
  };
}

export const periodLabeller = (state: ModelState) => {
  const labels = new Map(state.periods.map((p) => [p.id, `${p.label}${p.status}`]));
  return (k: string) => labels.get(k) ?? k;
};

/** Evidence titles for describeChange (read on first use), so a link reads 證據「Q3 法說會簡報」 rather than 證據「證據」. */
export const evidenceTitler = (db: DB, projectId: string) => {
  let titles: Map<string, string> | null = null;
  return (id: string): string => {
    titles ??= new Map((db.prepare('SELECT id, title FROM evidence WHERE project_id = ?').all(projectId) as { id: string; title: string }[]).map((r) => [r.id, r.title]));
    return titles.get(id) ?? '證據';
  };
};

/** GET /draft/pending: the uncommitted changes in words, with their authors. */
export function draftPending(db: DB, projectId: string): DraftPendingDTO {
  const a = pendingAttribution(db, projectId);
  const periodLabel = periodLabeller(JSON.parse(a.draft.state_json) as ModelState);
  const evidenceTitle = evidenceTitler(db, projectId);
  const counts: Record<string, number> = {};
  for (const c of a.contributors) counts[c.actor ?? 'before-v2'] = c.changes;
  return {
    version: a.draft.version,
    changes: a.changes.map((c) => ({ text: describeChange(c, { lang: 'zh-TW', periodLabel, evidenceTitle }), actor: a.actorOf(c) })),
    counts,
  };
}

/** Put back the draft as it was before a logged write (e.g. recover a discarded draft). The current draft is logged too. */
export function recoverDraft(db: DB, projectId: string, opId: number, version: number): DraftDTO {
  const op = db.prepare('SELECT * FROM draft_ops WHERE id = ? AND project_id = ?').get(opId, projectId) as DraftOpRow | undefined;
  if (!op) throw notFound('Draft history entry');
  if (!op.before_json) throw badRequest('This entry no longer keeps the draft from before it.');
  const parsed = parseState(JSON.parse(op.before_json));
  if (!parsed.ok) throw badRequest('The saved draft is invalid', parsed.errors);
  const ids = [...new Set(parsed.state.links.map((l) => l.evidenceId))];
  if (ids.length) {
    const found = new Set((db.prepare(`SELECT id FROM evidence WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(projectId, ...ids) as { id: string }[]).map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw badRequest(`The earlier draft links evidence that was deleted since (${missing.join(', ')}), so it cannot be recovered.`);
  }
  return db.transaction(() => {
    const row = getDraftRow(db, projectId);
    if (row.version !== version) throw conflict('The draft was changed elsewhere (another window?). Reload to continue.', { code: 'VERSION', currentVersion: row.version });
    const before = JSON.parse(row.state_json) as ModelState;
    const changes = diffStates(before, parsed.state);
    // The recovery row names its caller as the author of everything it puts back. An AI must not
    // bring back the user's uncommitted edits (say, from a draft the user discarded) under its own
    // name, where it could then commit them.
    if (isAgentActor(currentActor())) {
      const head = JSON.parse(getRevisionRow(db, projectId, row.base_revision_id).state_json) as ModelState;
      const owner = fieldOwners(db, projectId, row.base_revision_id, opId);
      const brought = new Set(changes.map(changeKey));
      const users = diffStates(head, parsed.state).filter((c) => brought.has(changeKey(c)) && byUser(owner.get(changeKey(c))));
      if (users.length) {
        const periodLabel = periodLabeller(parsed.state);
        const evidenceTitle = evidenceTitler(db, projectId);
        const texts = users.map((c) => describeChange(c, { lang: 'zh-TW', periodLabel, evidenceTitle }));
        throw conflict(`這份草稿裡有使用者還沒提交的修改（${texts.length} 項），AI 不能把它們復原成自己的修改；請使用者在網站復原`, { code: 'USER_CHANGES', changes: texts });
      }
    }
    if (!writeDraftState(db, projectId, parsed.state, version)) throw conflict('The draft was changed elsewhere (another window?). Reload to continue.', { code: 'VERSION' });
    logDraftOp(db, {
      projectId,
      baseRevisionId: row.base_revision_id,
      versionBefore: version,
      versionAfter: version + 1,
      kind: 'recover',
      op: { type: 'recover', opId },
      changes,
      before,
      summary: `回到 ${op.at.slice(0, 16).replace('T', ' ')} 那次${KIND_ZH[op.kind]}之前的草稿（${changes.length} 項）`,
    });
    return getDraft(db, projectId);
  })();
}

const KIND_ZH: Record<DraftOpKind, string> = { save: '儲存', ops: 'AI 修改', discard: '捨棄', restore: '還原', recover: '復原', commit: '提交' };

/** Drop the stored "before" state of old save and ops rows (the rows themselves stay). */
export function pruneDraftOps(db: DB, now = new Date()): number {
  const cutoff = new Date(now.getTime() - KEEP_BEFORE_MS).toISOString();
  return db.prepare("UPDATE draft_ops SET before_json = NULL WHERE kind IN ('save','ops') AND at < ? AND before_json IS NOT NULL").run(cutoff).changes;
}
