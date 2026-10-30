import { compute, freeze, type CalcResult } from '../../domain/calc/engine';
import { indexAtOrBefore } from '../../domain/market/indicators';
import { parseState } from '../../domain/model/schema';
import type { ModelState } from '../../domain/model/types';
import { describeChange } from '../../domain/revision/describe';
import { diffStates, type ModelChange } from '../../domain/revision/diff';
import { findLargeMoves, type LargeMove } from '../../domain/revision/guards';
import { computeImpact, type Impact } from '../../domain/revision/impact';
import { isAgentActor, type Actor } from '../../shared/actors';
import type { CommitPreviewDTO, MarketContext, RevisionFull, RevisionKind, SecurityDTO } from '../../shared/api';
import { currentActor, noteAiAction } from '../actor';
import type { DB } from '../db/connection';
import { audit } from '../repos/audit';
import { evidenceTitler, logDraftOp, pendingAttribution, periodLabeller, type PendingAttribution } from '../repos/draftOps';
import { barsMeta, getBars, getQuote } from '../repos/market';
import { assertLinksBelong, getDraftRow, getRevisionRow, insertRevision, primarySecurity, toRevisionFull, type DraftRow, type RevisionRow } from '../repos/projects';
import { addDays, badRequest, conflict, isDate, localToday, nowIso } from '../util';
import { keyOutputsDiff } from './draftOps';

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

export interface PrepareInput {
  asOfDate: string;
  evidenceIds?: string[];
  /** Omitted: the current version (a preview). */
  draftVersion?: number;
  kind?: RevisionKind;
}

export interface PreparedCommit {
  draft: DraftRow;
  head: RevisionRow;
  before: ModelState;
  after: ModelState;
  changes: ModelChange[];
  kind: RevisionKind;
  rb: CalcResult;
  ra: CalcResult;
  impact: Impact | null;
  evidenceIds: string[];
  citedEvidence: { id: string; title: string; publishedAt: string | null }[];
  market: MarketContext | null;
  attribution: PendingAttribution;
  largeMoves: LargeMove[];
}

/** Days a daily bar may lie before a backdated knowledge date and still count as "the price then". */
const BAR_MAX_AGE_DAYS = 7;

/**
 * The price recorded with a commit. A knowledge date of today (or later) takes the latest quote; a
 * backdated one takes the close of the last daily bar on or before it (never today's price for an
 * old date). No such bar within a week: no price.
 */
export function marketContextFor(db: DB, security: SecurityDTO, asOfDate: string, today: string): MarketContext | null {
  if (asOfDate >= today) {
    const q = getQuote(db, security.id, security.priceSource);
    return q ? { ...q, basis: 'quote' } : null;
  }
  const bars = getBars(db, security.id, security.priceSource);
  const i = indexAtOrBefore(bars, asOfDate);
  if (i < 0 || bars[i].date < addDays(asOfDate, -BAR_MAX_AGE_DAYS)) return null;
  return {
    price: bars[i].close,
    currency: security.currency,
    asOf: `${bars[i].date}T00:00:00.000Z`,
    provider: security.priceSource,
    fetchedAt: barsMeta(db, security.id, security.priceSource).lastFetchedAt ?? nowIso(),
    basis: 'bar',
  };
}

/**
 * Every check of a commit except the insert, shared by the preview and the commit:
 * knowledge-date order, evidence look-ahead, draft validity, before/after, impact, the price,
 * who made the pending changes and which moves need confirmation. Call inside a transaction.
 */
export function prepareCommit(db: DB, projectId: string, input: PrepareInput, today: string): PreparedCommit {
  if (!isDate(input.asOfDate)) throw badRequest('Knowledge date must be YYYY-MM-DD');
  if (input.asOfDate > addDays(today, 1)) throw badRequest(`Knowledge date ${input.asOfDate} is in the future`, { code: 'FUTURE_DATE' });
  const draft = getDraftRow(db, projectId);
  if (input.draftVersion !== undefined && draft.version !== input.draftVersion) {
    throw conflict('The draft changed since you reviewed it. Review the changes again before committing.', { code: 'VERSION_MISMATCH', currentVersion: draft.version });
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
  const citedEvidence: PreparedCommit['citedEvidence'] = [];
  for (const id of evidenceIds) {
    const ev = db.prepare('SELECT title, published_at FROM evidence WHERE id = ? AND project_id = ?').get(id, projectId) as { title: string; published_at: string | null } | undefined;
    if (!ev) throw badRequest(`Evidence ${id} not found in this project`);
    if (ev.published_at && ev.published_at > input.asOfDate) {
      throw badRequest(`“${ev.title}” was published ${ev.published_at}, after this update’s knowledge date ${input.asOfDate}. Citing it would be look-ahead.`);
    }
    citedEvidence.push({ id, title: ev.title, publishedAt: ev.published_at });
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
  const market = security ? marketContextFor(db, security, input.asOfDate, today) : null;
  return {
    draft,
    head,
    before,
    after,
    changes,
    kind,
    rb,
    ra,
    impact,
    evidenceIds,
    citedEvidence,
    market,
    attribution: pendingAttribution(db, projectId),
    largeMoves: findLargeMoves(before, after, rb, ra, changes),
  };
}

/** Rules for a commit made by an AI, in the order they are checked (USER_CHANGES and confirmation are separate). */
function agentChecks(p: PreparedCommit, input: PrepareInput, today: string) {
  if (input.asOfDate > today) throw badRequest(`知情日期 ${input.asOfDate} 晚於今天（${today}）`, { code: 'FUTURE_DATE', today });
  if (input.kind && input.kind !== 'update' && input.kind !== 'checkpoint') throw badRequest('AI 只能提交 update 或 checkpoint 類型的研究更新', { code: 'KIND_NOT_ALLOWED' });
  if (input.asOfDate < today && !p.citedEvidence.some((e) => e.publishedAt && e.publishedAt <= input.asOfDate)) {
    throw badRequest(`知情日期 ${input.asOfDate} 早於今天：回溯的研究更新必須引用一份發布日期不晚於那天的證據（evidence_ids）。舊研究請用證據或筆記記錄。`, {
      code: 'BACKDATED_NEEDS_EVIDENCE',
    });
  }
}

const userChangeTexts = (db: DB, projectId: string, p: PreparedCommit) => {
  const periodLabel = periodLabeller(p.after);
  const evidenceTitle = evidenceTitler(db, projectId);
  return p.attribution.userOwned.map((c) => describeChange(c, { lang: 'zh-TW', periodLabel, evidenceTitle }));
};

export interface CommitOptions {
  /** Set for AI clients: the stricter rules apply. */
  agent?: { confirmedByUser: boolean };
}

/**
 * Commit the draft as an immutable Research Update:
 * validate → diff → compute before/after → impact + attribution → freeze outputs → insert → rebase draft.
 * Runs in one transaction.
 */
export function commitDraft(db: DB, projectId: string, input: CommitInput, today = localToday(), opts: CommitOptions = {}): RevisionFull {
  const title = (input.title ?? '').trim();
  const reason = (input.reason ?? '').trim();
  if (!title) throw badRequest('A Research Update needs a title');
  if (!reason) throw badRequest('Explain the reason / interpretation: why did your view change (or why is it unchanged)?');

  return db.transaction(() => {
    const p = prepareCommit(db, projectId, input, today);
    if (opts.agent) {
      agentChecks(p, input, today);
      const user = userChangeTexts(db, projectId, p);
      if (user.length) {
        throw conflict(`草稿裡有使用者還沒提交的修改：${user.slice(0, 5).join('；')}${user.length > 5 ? `…（共 ${user.length} 項）` : ''}。請使用者在網站提交或捨棄後再試`, {
          code: 'USER_CHANGES',
          changes: user,
        });
      }
      if (p.largeMoves.length && !opts.agent.confirmedByUser) {
        throw conflict(`變動很大，需要使用者確認：${p.largeMoves.map((m) => m.text).join('；')}。先在對話中問使用者，同意後帶 confirmed_by_user=true`, {
          code: 'NEEDS_CONFIRMATION',
          largeMoves: p.largeMoves,
        });
      }
    }
    const actor: Actor = currentActor();
    const id = insertRevision(db, {
      projectId,
      parentId: p.head.id,
      kind: p.kind,
      title,
      reason,
      notes: input.notes ?? '',
      asOfDate: input.asOfDate,
      state: p.after,
      computed: freeze(p.ra),
      changes: p.changes,
      impact: p.impact,
      market: p.market,
      createdBy: actor,
      contributors: p.attribution.contributors,
    });
    const ins = db.prepare('INSERT OR IGNORE INTO revision_evidence (revision_id, evidence_id, kind) VALUES (?, ?, ?)');
    for (const ev of p.evidenceIds) ins.run(id, ev, 'cited');
    for (const ev of new Set(p.after.links.map((l) => l.evidenceId))) ins.run(id, ev, 'linked');
    db.prepare('UPDATE drafts SET base_revision_id = ?, version = version + 1, updated_at = ? WHERE project_id = ?').run(id, nowIso(), projectId);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), projectId);
    const rev = toRevisionFull(db, getRevisionRow(db, projectId, id));
    logDraftOp(db, {
      projectId,
      baseRevisionId: id,
      versionBefore: p.draft.version,
      versionAfter: p.draft.version + 1,
      kind: 'commit',
      op: { type: 'commit', revisionId: id, seq: rev.seq },
      changes: [],
      before: null,
      summary: `提交研究更新 #${rev.seq}「${title}」`,
    });
    audit(db, projectId, 'revision', id, 'commit', null, { seq: rev.seq, title, kind: p.kind, asOfDate: input.asOfDate, contributors: p.attribution.contributors });
    noteAiAction({ kind: 'commit', projectId, ref: id, summary: `提交研究更新 #${rev.seq}「${title}」（知情日 ${input.asOfDate}）` });
    return rev;
  })();
}

export interface PreviewInput {
  asOfDate?: string;
  kind?: 'update' | 'checkpoint';
  evidenceIds?: string[];
}

/** What a commit would record, for the AI to show the user before committing (POST /revisions/preview). */
export function previewCommit(db: DB, projectId: string, input: PreviewInput, today: string, actor: Actor): { dto: Omit<CommitPreviewDTO, 'previewId' | 'expiresAt'>; prepared: PreparedCommit } {
  const asOfDate = input.asOfDate ?? today;
  if (input.kind !== undefined && input.kind !== 'update' && input.kind !== 'checkpoint') {
    throw badRequest('AI 只能提交 update 或 checkpoint 類型的研究更新', { code: 'KIND_NOT_ALLOWED' });
  }
  return db.transaction(() => {
    const req: PrepareInput = { asOfDate, kind: input.kind, evidenceIds: input.evidenceIds };
    const p = prepareCommit(db, projectId, req, today);
    const agent = isAgentActor(actor);
    if (agent) agentChecks(p, req, today);
    const periodLabel = periodLabeller(p.after);
    const evidenceTitle = evidenceTitler(db, projectId);
    const userChanges = agent ? userChangeTexts(db, projectId, p) : [];
    const blocked = userChanges.length ? `草稿裡有使用者還沒提交的修改（${userChanges.length} 項）。請使用者在網站提交或捨棄後再試` : null;
    const dto: Omit<CommitPreviewDTO, 'previewId' | 'expiresAt'> = {
      projectId,
      draftVersion: p.draft.version,
      baseRevisionId: p.draft.base_revision_id,
      asOfDate,
      kind: p.kind === 'checkpoint' ? 'checkpoint' : 'update',
      today,
      changes: p.changes.map((c) => ({ text: describeChange(c, { lang: 'zh-TW', periodLabel, evidenceTitle }), actor: p.attribution.actorOf(c) })),
      changeCount: p.changes.length,
      keyOutputs: keyOutputsDiff(p.before, p.after, p.rb, p.ra),
      largeMoves: p.largeMoves,
      needsConfirmation: p.largeMoves.length > 0,
      userChanges,
      blocked,
      market: p.market,
      citedEvidence: p.citedEvidence,
    };
    return { dto, prepared: p };
  })();
}
