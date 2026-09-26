import { compute, freeze, ENGINE_VERSION, type FrozenOutputs } from '../../domain/calc/engine';
import { parseState } from '../../domain/model/schema';
import type { ModelState } from '../../domain/model/types';
import type { ModelChange } from '../../domain/revision/diff';
import type { Impact } from '../../domain/revision/impact';
import type { DraftDTO, MarketContext, ProjectDTO, ProjectSummaryDTO, RevisionFull, RevisionKind, RevisionMeta, SecurityDTO } from '../../shared/api';
import type { DB } from '../db/connection';
import { badRequest, conflict, newId, notFound, nowIso, parseJson } from '../util';
import { audit } from './audit';

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
interface SecurityRow {
  id: string;
  project_id: string;
  name: string;
  ticker: string;
  exchange: string;
  api_symbol: string;
  currency: string;
  price_source: string;
  is_primary: number;
}
export interface RevisionRow {
  id: string;
  project_id: string;
  seq: number;
  parent_id: string | null;
  kind: RevisionKind;
  title: string;
  reason: string;
  notes: string;
  as_of_date: string | null;
  committed_at: string;
  state_json: string;
  computed_json: string;
  changes_json: string;
  impact_json: string;
  market_json: string | null;
  engine_version: string;
}
interface DraftRow {
  project_id: string;
  state_json: string;
  base_revision_id: string;
  version: number;
  updated_at: string;
}

const toProject = (r: ProjectRow): ProjectDTO => ({
  id: r.id,
  name: r.name,
  description: r.description,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});

export const toSecurity = (r: SecurityRow): SecurityDTO => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  ticker: r.ticker,
  exchange: r.exchange,
  apiSymbol: r.api_symbol,
  currency: r.currency,
  priceSource: r.price_source,
  isPrimary: r.is_primary === 1,
});

export function citedEvidence(db: DB, revisionId: string): string[] {
  return (db.prepare("SELECT evidence_id FROM revision_evidence WHERE revision_id = ? AND kind = 'cited'").all(revisionId) as { evidence_id: string }[]).map((r) => r.evidence_id);
}

export function toRevisionMeta(db: DB, r: RevisionRow): RevisionMeta {
  return {
    id: r.id,
    projectId: r.project_id,
    seq: r.seq,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    reason: r.reason,
    notes: r.notes,
    asOfDate: r.as_of_date,
    committedAt: r.committed_at,
    changes: parseJson<ModelChange[]>(r.changes_json, []),
    impact: parseJson<Impact | null>(r.impact_json, null),
    market: parseJson<MarketContext | null>(r.market_json, null),
    engineVersion: r.engine_version,
    citedEvidenceIds: citedEvidence(db, r.id),
  };
}

export function toRevisionFull(db: DB, r: RevisionRow): RevisionFull {
  return { ...toRevisionMeta(db, r), state: JSON.parse(r.state_json) as ModelState, computed: JSON.parse(r.computed_json) as FrozenOutputs };
}

// ---------------------------------------------------------------- projects

export function getProjectRow(db: DB, id: string): ProjectRow {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!r) throw notFound('Project');
  return r;
}

export function getProject(db: DB, id: string): ProjectDTO {
  return toProject(getProjectRow(db, id));
}

export function listSecurities(db: DB, projectId: string): SecurityDTO[] {
  return (db.prepare('SELECT * FROM securities WHERE project_id = ? ORDER BY is_primary DESC, ticker').all(projectId) as SecurityRow[]).map(toSecurity);
}

export function getSecurity(db: DB, id: string): SecurityDTO {
  const r = db.prepare('SELECT * FROM securities WHERE id = ?').get(id) as SecurityRow | undefined;
  if (!r) throw notFound('Security');
  return toSecurity(r);
}

export function primarySecurity(db: DB, projectId: string): SecurityDTO | null {
  return listSecurities(db, projectId)[0] ?? null;
}

export interface SecurityInput {
  name: string;
  ticker: string;
  exchange: string;
  apiSymbol: string;
  currency: string;
  priceSource: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  security: SecurityInput;
  state: ModelState;
  templateName: string;
}

export function createProject(db: DB, input: CreateProjectInput): string {
  if (!input.name.trim()) throw badRequest('Company name is required');
  const parsed = parseState(input.state);
  if (!parsed.ok) throw badRequest('Template is invalid', parsed.errors);
  const projectId = newId('prj');
  const now = nowIso();
  db.transaction(() => {
    db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(projectId, input.name.trim(), input.description ?? '', now, now);
    const s = input.security;
    db.prepare('INSERT INTO securities (id, project_id, name, ticker, exchange, api_symbol, currency, price_source, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
      newId('sec'),
      projectId,
      s.name.trim() || input.name.trim(),
      s.ticker.trim(),
      s.exchange.trim(),
      s.apiSymbol.trim() || s.ticker.trim(),
      s.currency.trim().toUpperCase() || 'TWD',
      s.priceSource || 'demo',
    );
    const revId = insertRevision(db, {
      projectId,
      parentId: null,
      kind: 'initial',
      title: `Project created from ${input.templateName}`,
      reason: 'Starting structure. No research knowledge yet.',
      notes: '',
      asOfDate: null,
      state: parsed.state,
      changes: [],
      impact: null,
      market: null,
      computed: freeze(compute(parsed.state)),
    });
    db.prepare('INSERT INTO drafts (project_id, state_json, base_revision_id, version, updated_at) VALUES (?, ?, ?, 1, ?)').run(projectId, JSON.stringify(parsed.state), revId, now);
  })();
  return projectId;
}

export function updateProject(db: DB, id: string, patch: { name?: string; description?: string; archived?: boolean }): ProjectDTO {
  const before = getProjectRow(db, id);
  const name = patch.name !== undefined ? patch.name.trim() : before.name;
  if (!name) throw badRequest('Company name is required');
  const archivedAt = patch.archived === undefined ? before.archived_at : patch.archived ? before.archived_at ?? nowIso() : null;
  db.prepare('UPDATE projects SET name = ?, description = ?, archived_at = ?, updated_at = ? WHERE id = ?').run(name, patch.description ?? before.description, archivedAt, nowIso(), id);
  const after = getProjectRow(db, id);
  audit(db, id, 'project', id, 'update', before, after);
  return toProject(after);
}

export function updateSecurity(db: DB, id: string, patch: Partial<SecurityInput>): SecurityDTO {
  const before = getSecurity(db, id);
  const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as SecurityDTO;
  if (!next.ticker.trim()) throw badRequest('Ticker is required');
  db.prepare('UPDATE securities SET name = ?, ticker = ?, exchange = ?, api_symbol = ?, currency = ?, price_source = ? WHERE id = ?').run(
    next.name,
    next.ticker,
    next.exchange,
    next.apiSymbol,
    next.currency.toUpperCase(),
    next.priceSource,
    id,
  );
  audit(db, before.projectId, 'security', id, 'update', before, next);
  return getSecurity(db, id);
}

export function listProjectSummaries(db: DB): ProjectSummaryDTO[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY archived_at IS NOT NULL, updated_at DESC').all() as ProjectRow[];
  return rows.map((r) => {
    const security = primarySecurity(db, r.id);
    const head = headRevisionRow(db, r.id);
    const draft = db.prepare('SELECT state_json, base_revision_id FROM drafts WHERE project_id = ?').get(r.id) as { state_json: string; base_revision_id: string } | undefined;
    let targetPrice: ProjectSummaryDTO['targetPrice'] = null;
    if (head) {
      const state = JSON.parse(head.state_json) as ModelState;
      const computed = JSON.parse(head.computed_json) as FrozenOutputs;
      const tp = state.nodes.find((n) => n.role === 'target_price');
      if (tp) {
        const pick = (s: 'bear' | 'base' | 'bull') => computed.values[s][tp.id]?._ ?? null;
        targetPrice = { bear: pick('bear'), base: pick('base'), bull: pick('bull') };
      }
    }
    let lastPrice: ProjectSummaryDTO['lastPrice'] = null;
    if (security) {
      const q = db.prepare('SELECT * FROM quotes WHERE security_id = ? AND provider = ?').get(security.id, security.priceSource) as
        | { price: number; currency: string | null; as_of: string; provider: string; fetched_at: string }
        | undefined;
      if (q) lastPrice = { price: q.price, currency: q.currency, asOf: q.as_of, provider: q.provider, fetchedAt: q.fetched_at };
    }
    return {
      ...toProject(r),
      security,
      head: head ? { id: head.id, seq: head.seq, title: head.title, asOfDate: head.as_of_date, committedAt: head.committed_at } : null,
      draftDirty: !!(draft && head && canonical(draft.state_json) !== canonical(head.state_json)),
      targetPrice,
      lastPrice,
    };
  });
}

const canonical = (json: string) => JSON.stringify(JSON.parse(json));

// ---------------------------------------------------------------- drafts

export function getDraftRow(db: DB, projectId: string): DraftRow {
  const r = db.prepare('SELECT * FROM drafts WHERE project_id = ?').get(projectId) as DraftRow | undefined;
  if (!r) throw notFound('Draft');
  return r;
}

export function getDraft(db: DB, projectId: string): DraftDTO {
  const r = getDraftRow(db, projectId);
  return { state: JSON.parse(r.state_json) as ModelState, version: r.version, baseRevisionId: r.base_revision_id, updatedAt: r.updated_at };
}

/** Evidence IDs linked in a state must belong to the project. */
export function assertLinksBelong(db: DB, projectId: string, state: ModelState) {
  const ids = [...new Set(state.links.map((l) => l.evidenceId))];
  if (!ids.length) return;
  const found = new Set(
    (db.prepare(`SELECT id FROM evidence WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(projectId, ...ids) as { id: string }[]).map((r) => r.id),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw badRequest(`Evidence not found in this project: ${missing.join(', ')}`);
}

export function saveDraft(db: DB, projectId: string, state: unknown, expectedVersion: number): DraftDTO {
  const parsed = parseState(state);
  if (!parsed.ok) throw badRequest('The model is invalid and was not saved', parsed.errors);
  assertLinksBelong(db, projectId, parsed.state);
  const row = getDraftRow(db, projectId);
  if (row.version !== expectedVersion) {
    throw conflict('The draft was changed elsewhere (another window?). Reload to continue.', { currentVersion: row.version });
  }
  const now = nowIso();
  db.prepare('UPDATE drafts SET state_json = ?, version = version + 1, updated_at = ? WHERE project_id = ?').run(JSON.stringify(parsed.state), now, projectId);
  return getDraft(db, projectId);
}

export function resetDraftTo(db: DB, projectId: string, revisionId: string, expectedVersion?: number): DraftDTO {
  const row = getDraftRow(db, projectId);
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw conflict('The draft was changed elsewhere (another window?). Reload to continue.', { currentVersion: row.version });
  }
  const rev = getRevisionRow(db, projectId, revisionId);
  db.prepare('UPDATE drafts SET state_json = ?, version = version + 1, updated_at = ? WHERE project_id = ?').run(rev.state_json, nowIso(), projectId);
  return getDraft(db, projectId);
}

// ---------------------------------------------------------------- revisions

export function headRevisionRow(db: DB, projectId: string): RevisionRow | undefined {
  return db.prepare('SELECT * FROM revisions WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as RevisionRow | undefined;
}

export function getRevisionRow(db: DB, projectId: string, id: string): RevisionRow {
  const r = db.prepare('SELECT * FROM revisions WHERE id = ? AND project_id = ?').get(id, projectId) as RevisionRow | undefined;
  if (!r) throw notFound('Revision');
  return r;
}

export function listRevisions(db: DB, projectId: string): RevisionMeta[] {
  return (db.prepare('SELECT * FROM revisions WHERE project_id = ? ORDER BY seq').all(projectId) as RevisionRow[]).map((r) => toRevisionMeta(db, r));
}

export function listRevisionRows(db: DB, projectId: string): RevisionRow[] {
  return db.prepare('SELECT * FROM revisions WHERE project_id = ? ORDER BY seq').all(projectId) as RevisionRow[];
}

/** The research state valid on `date`: latest revision whose knowledge date is on or before it. */
export function revisionAsOf(db: DB, projectId: string, date: string): RevisionRow | undefined {
  return db
    .prepare('SELECT * FROM revisions WHERE project_id = ? AND as_of_date IS NOT NULL AND as_of_date <= ? ORDER BY seq DESC LIMIT 1')
    .get(projectId, date) as RevisionRow | undefined;
}

export interface InsertRevision {
  projectId: string;
  parentId: string | null;
  kind: RevisionKind;
  title: string;
  reason: string;
  notes: string;
  asOfDate: string | null;
  state: ModelState;
  computed: FrozenOutputs;
  changes: ModelChange[];
  impact: Impact | null;
  market: MarketContext | null;
}

export function insertRevision(db: DB, r: InsertRevision): string {
  const id = newId('rev');
  const seq = ((db.prepare('SELECT MAX(seq) AS m FROM revisions WHERE project_id = ?').get(r.projectId) as { m: number | null }).m ?? 0) + 1;
  db.prepare(
    `INSERT INTO revisions (id, project_id, seq, parent_id, kind, title, reason, notes, as_of_date, committed_at, state_json, computed_json, changes_json, impact_json, market_json, engine_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    r.projectId,
    seq,
    r.parentId,
    r.kind,
    r.title,
    r.reason,
    r.notes,
    r.asOfDate,
    nowIso(),
    JSON.stringify(r.state),
    JSON.stringify(r.computed),
    JSON.stringify(r.changes),
    JSON.stringify(r.impact),
    r.market ? JSON.stringify(r.market) : null,
    ENGINE_VERSION,
  );
  return id;
}

/** Headline outputs frozen in a revision (for trades and summaries). */
export function frozenTargetPrice(row: RevisionRow): Record<'bear' | 'base' | 'bull', number | null> {
  const state = JSON.parse(row.state_json) as ModelState;
  const computed = JSON.parse(row.computed_json) as FrozenOutputs;
  const tp = state.nodes.find((n) => n.role === 'target_price');
  const out = { bear: null, base: null, bull: null } as Record<'bear' | 'base' | 'bull', number | null>;
  if (!tp) return out;
  for (const s of ['bear', 'base', 'bull'] as const) out[s] = computed.values[s][tp.id]?._ ?? null;
  return out;
}

