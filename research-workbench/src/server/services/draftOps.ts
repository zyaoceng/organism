import crypto from 'node:crypto';
import { compute, type Issue } from '../../domain/calc/engine';
import { AgentOpError, applyAgentOp } from '../../domain/agent/ops';
import type { DraftOpsRequest } from '../../domain/agent/schema';
import { parseState } from '../../domain/model/schema';
import { findByRole } from '../../domain/model/tree';
import type { ModelState } from '../../domain/model/types';
import { describeChange } from '../../domain/revision/describe';
import { diffStates } from '../../domain/revision/diff';
import { basisPeriodId, keyOutputs } from '../../domain/revision/impact';
import { isAgentActor, type Actor } from '../../shared/actors';
import type { DraftIssueDTO, DraftOpResultDTO, DraftOpsResponse, KeyOutputsDiffDTO } from '../../shared/api';
import { noteAiAction } from '../actor';
import type { DB } from '../db/connection';
import { draftOpsSince, evidenceTitler, logDraftOp, periodLabeller } from '../repos/draftOps';
import { assertLinksBelong, getDraftRow, writeDraftState } from '../repos/projects';
import { badRequest, conflict } from '../util';

/** Headline outputs before and after, with their units, on the after-state's basis period. */
export function keyOutputsDiff(before: ModelState, after: ModelState, rb = compute(before), ra = compute(after)): KeyOutputsDiffDTO {
  const basis = basisPeriodId(after);
  return {
    basisPeriodId: basis,
    units: {
      eps: findByRole(after, 'eps')?.unit ?? null,
      targetPrice: findByRole(after, 'target_price')?.unit ?? null,
      targetMultiple: findByRole(after, 'target_multiple')?.unit ?? null,
    },
    before: keyOutputs(before, rb, basis),
    after: keyOutputs(after, ra, basis),
  };
}

const issueKey = (i: Issue) => `${i.code}:${i.nodeId}:${i.periodKey ?? ''}`;

/**
 * POST /api/projects/:id/draft/ops: apply AI draft operations in one transaction.
 * A dry run computes everything and writes nothing; it returns the version to pass back as
 * expectedVersion. An AI write must name that version, so it never overwrites edits it has not seen.
 */
export function applyDraftOps(db: DB, projectId: string, req: DraftOpsRequest, ctx: { actor: Actor; dbGeneration: string }): DraftOpsResponse {
  return db.transaction((): DraftOpsResponse => {
    const row = getDraftRow(db, projectId);
    if (isAgentActor(ctx.actor) && !req.dryRun && req.expectedVersion === undefined) {
      throw badRequest('AI 寫入必須帶 expectedVersion（先用 dryRun 取得）', { code: 'EXPECTED_VERSION_REQUIRED' });
    }
    if (req.expectedVersion !== undefined && req.expectedVersion !== row.version) {
      throw conflict(`草稿在你讀取之後被改過（你的版本 v${req.expectedVersion}，目前 v${row.version}）`, {
        code: 'VERSION_MISMATCH',
        currentVersion: row.version,
        since: draftOpsSince(db, projectId, req.expectedVersion),
      });
    }
    const evidenceIds = [...new Set(req.ops.flatMap((o) => (o.op === 'link_evidence' ? [o.evidence_id] : [])))];
    if (evidenceIds.length) {
      const found = new Set(
        (db.prepare(`SELECT id FROM evidence WHERE project_id = ? AND id IN (${evidenceIds.map(() => '?').join(',')})`).all(projectId, ...evidenceIds) as { id: string }[]).map((r) => r.id),
      );
      const missing = evidenceIds.filter((id) => !found.has(id));
      if (missing.length) throw badRequest(`這家公司找不到證據：${missing.join(', ')}（先用 add_evidence 新增）`, { code: 'EVIDENCE_NOT_FOUND', missing });
    }

    const s0 = JSON.parse(row.state_json) as ModelState;
    const periodLabel = periodLabeller(s0);
    const evidenceTitle = evidenceTitler(db, projectId);
    let s = s0;
    const results: DraftOpResultDTO[] = [];
    req.ops.forEach((op, index) => {
      const sBefore = s;
      try {
        const r = applyAgentOp(s, op);
        s = r.state;
        results.push({ index, ...r.result, description: diffStates(sBefore, s).map((c) => describeChange(c, { lang: 'zh-TW', periodLabel, evidenceTitle })) });
      } catch (e) {
        if (!(e instanceof AgentOpError)) throw e;
        throw badRequest(`第 ${index + 1} 個操作（${op.op}）失敗：${e.message}`, { code: 'OP_FAILED', opIndex: index, op, message: e.message, candidates: e.candidates });
      }
    });

    const parsed = parseState(s);
    if (!parsed.ok) throw badRequest('改完的模型有錯誤，沒有寫入', { code: 'INVALID_STATE', errors: parsed.errors });
    s = parsed.state;
    assertLinksBelong(db, projectId, s);

    const rb = compute(s0);
    const ra = compute(s);
    const known = new Set(rb.issues.map(issueKey));
    const ix = ra.ix;
    const issues: DraftIssueDTO[] = ra.issues.map((i) => ({
      severity: i.severity,
      code: i.code,
      message: i.message,
      nodeId: i.nodeId,
      nodeName: ix.byId.get(i.nodeId)?.name ?? i.nodeId,
      ...(i.periodKey ? { periodKey: i.periodKey } : {}),
      isNew: !known.has(issueKey(i)),
    }));
    const changes = diffStates(s0, s);
    const warnings = results.flatMap((r) => r.warnings);
    if (!changes.length) warnings.push('這些操作沒有改變任何東西');
    const base = {
      baseRevisionId: row.base_revision_id,
      results,
      keyOutputs: keyOutputsDiff(s0, s, rb, ra),
      issues,
      warnings,
      url: `/#/p/${encodeURIComponent(projectId)}/model`,
    };
    const hash = crypto.createHash('sha256').update(`${ctx.dbGeneration}:${row.version}:${JSON.stringify(req.ops)}`).digest('hex').slice(0, 16);
    if (req.dryRun) return { dryRun: true, version: row.version, previewHash: hash, ...base };

    if (req.previewHash && req.previewHash !== hash) {
      throw badRequest('這組操作和預覽（dry run）時不同；請重新 dry run', { code: 'PREVIEW_MISMATCH' });
    }
    if (!changes.length) return { dryRun: false, version: row.version, ...base };
    if (!writeDraftState(db, projectId, s, row.version)) {
      throw conflict('草稿剛被改過，請重新讀取', { code: 'VERSION_MISMATCH', currentVersion: getDraftRow(db, projectId).version, since: draftOpsSince(db, projectId, row.version) });
    }
    const described = results.flatMap((r) => r.description);
    const head = described.slice(0, 3).join('；') + (described.length > 3 ? `…（共 ${changes.length} 項）` : '');
    const draftOpId = logDraftOp(db, {
      projectId,
      baseRevisionId: row.base_revision_id,
      versionBefore: row.version,
      versionAfter: row.version + 1,
      kind: 'ops',
      op: { ops: req.ops, rationale: req.rationale ?? null },
      changes,
      before: s0,
      summary: req.rationale?.trim() || head,
    });
    noteAiAction({ kind: 'draft_ops', projectId, ref: String(draftOpId), summary: `改了 ${changes.length} 項：${head}` });
    return { dryRun: false, version: row.version + 1, draftOpId, ...base };
  })();
}
