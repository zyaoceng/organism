/** Evidence, catalysts, trades, notes, reviews and templates: records with their own lifecycle. */
import { atrAsOf } from '../../domain/market/indicators';
import type { ModelState } from '../../domain/model/types';
import {
  SOURCE_TYPES,
  type CatalystDTO,
  type EvidenceDTO,
  type EvidenceKind,
  type NoteDTO,
  type ReviewDTO,
  type SourceType,
  type TemplateDTO,
  type TradeDTO,
} from '../../shared/api';
import type { DB } from '../db/connection';
import { toAttachmentDTO, type AttachmentRow } from '../storage/attachments';
import { badRequest, conflict, isDate, newId, notFound, nowIso, parseJson } from '../util';
import { audit } from './audit';
import { frozenTargetPrice, getDraftRow, getSecurity, revisionAsOf } from './projects';
import { getBars } from './market';

// ---------------------------------------------------------------- evidence

interface EvidenceRow {
  id: string;
  project_id: string;
  title: string;
  source_name: string;
  source_type: string;
  url: string | null;
  published_at: string | null;
  added_at: string;
  notes: string;
  verification: string | null;
  archived_at: string | null;
  updated_at: string;
}

const SOURCE_TYPE_SET = new Set<string>(SOURCE_TYPES.map((s) => s.value));

function evidenceAttachments(db: DB, evidenceId: string): AttachmentRow[] {
  return db
    .prepare('SELECT a.* FROM attachments a JOIN evidence_attachments ea ON ea.attachment_id = a.id WHERE ea.evidence_id = ? ORDER BY ea.position, a.created_at')
    .all(evidenceId) as AttachmentRow[];
}

function toEvidence(db: DB, r: EvidenceRow): EvidenceDTO {
  const atts = evidenceAttachments(db, r.id);
  const kind: EvidenceKind = atts.some((a) => a.mime_type.startsWith('image/')) ? 'image' : atts.length ? 'file' : r.url ? 'url' : 'note';
  const refs = db
    .prepare('SELECT re.revision_id, re.kind, r.seq FROM revision_evidence re JOIN revisions r ON r.id = re.revision_id WHERE re.evidence_id = ? ORDER BY r.seq')
    .all(r.id) as { revision_id: string; kind: 'cited' | 'linked'; seq: number }[];
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    sourceName: r.source_name,
    sourceType: r.source_type as SourceType,
    url: r.url,
    publishedAt: r.published_at,
    addedAt: r.added_at,
    notes: r.notes,
    verification: r.verification as EvidenceDTO['verification'],
    archivedAt: r.archived_at,
    updatedAt: r.updated_at,
    kind,
    attachments: atts.map(toAttachmentDTO),
    revisionRefs: refs.map((x) => ({ revisionId: x.revision_id, seq: x.seq, kind: x.kind })),
  };
}

function getEvidenceRow(db: DB, id: string): EvidenceRow {
  const r = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as EvidenceRow | undefined;
  if (!r) throw notFound('Evidence');
  return r;
}

export function getEvidence(db: DB, id: string): EvidenceDTO {
  return toEvidence(db, getEvidenceRow(db, id));
}

export function listEvidence(db: DB, projectId: string): EvidenceDTO[] {
  return (db.prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY added_at DESC').all(projectId) as EvidenceRow[]).map((r) => toEvidence(db, r));
}

export interface EvidenceInput {
  title?: string;
  sourceName?: string;
  sourceType?: string;
  url?: string | null;
  publishedAt?: string | null;
  notes?: string;
  verification?: string | null;
}

function cleanEvidence(input: EvidenceInput, base?: EvidenceRow) {
  const url = input.url === undefined ? base?.url ?? null : input.url?.trim() || null;
  if (url && !/^https?:\/\//i.test(url)) throw badRequest('URL must start with http:// or https://');
  const publishedAt = input.publishedAt === undefined ? base?.published_at ?? null : input.publishedAt || null;
  if (publishedAt && !isDate(publishedAt)) throw badRequest('Publication date must be YYYY-MM-DD');
  const sourceType = input.sourceType ?? base?.source_type ?? 'other';
  if (!SOURCE_TYPE_SET.has(sourceType)) throw badRequest(`Unknown source type ${sourceType}`);
  const verification = input.verification === undefined ? base?.verification ?? null : input.verification || null;
  if (verification && !['unverified', 'verified', 'disputed'].includes(verification)) throw badRequest('Invalid verification status');
  return {
    title: (input.title ?? base?.title ?? '').trim(),
    source_name: (input.sourceName ?? base?.source_name ?? '').trim(),
    source_type: sourceType,
    url,
    published_at: publishedAt,
    notes: input.notes ?? base?.notes ?? '',
    verification,
  };
}

export function createEvidence(db: DB, projectId: string, input: EvidenceInput, attachmentIds: string[] = []): EvidenceDTO {
  const c = cleanEvidence(input);
  if (!c.source_name && c.url) {
    try {
      c.source_name = new URL(c.url).hostname.replace(/^www\./, '');
    } catch {
      /* keep empty */
    }
  }
  if (!c.title) {
    c.title = c.url ? c.url.replace(/^https?:\/\//, '').slice(0, 120) : attachmentIds.length ? 'Untitled file' : '';
  }
  if (!c.title) throw badRequest('Evidence needs a title, a URL, a file or a note');
  const id = newId('ev');
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO evidence (id, project_id, title, source_name, source_type, url, published_at, added_at, notes, verification, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, projectId, c.title, c.source_name, c.source_type, c.url, c.published_at, now, c.notes, c.verification, now);
    attachmentIds.forEach((a, i) => db.prepare('INSERT INTO evidence_attachments (evidence_id, attachment_id, position) VALUES (?, ?, ?)').run(id, a, i));
  })();
  return getEvidence(db, id);
}

export function updateEvidence(db: DB, id: string, input: EvidenceInput): EvidenceDTO {
  const before = getEvidenceRow(db, id);
  const c = cleanEvidence(input, before);
  if (!c.title) throw badRequest('Evidence needs a title');
  if (c.published_at && c.published_at !== before.published_at) {
    const earliest = db
      .prepare('SELECT r.seq, r.as_of_date FROM revision_evidence re JOIN revisions r ON r.id = re.revision_id WHERE re.evidence_id = ? AND r.as_of_date IS NOT NULL ORDER BY r.as_of_date LIMIT 1')
      .get(id) as { seq: number; as_of_date: string } | undefined;
    if (earliest && c.published_at > earliest.as_of_date) {
      throw badRequest(`Research Update #${earliest.seq} (knowledge date ${earliest.as_of_date}) already relies on this evidence; its publication date cannot be later than that.`);
    }
  }
  db.prepare('UPDATE evidence SET title = ?, source_name = ?, source_type = ?, url = ?, published_at = ?, notes = ?, verification = ?, updated_at = ? WHERE id = ?').run(
    c.title,
    c.source_name,
    c.source_type,
    c.url,
    c.published_at,
    c.notes,
    c.verification,
    nowIso(),
    id,
  );
  audit(db, before.project_id, 'evidence', id, 'update', before, getEvidenceRow(db, id));
  return getEvidence(db, id);
}

export function addEvidenceAttachments(db: DB, id: string, attachmentIds: string[]): EvidenceDTO {
  const before = getEvidence(db, id);
  const start = before.attachments.length;
  attachmentIds.forEach((a, i) => db.prepare('INSERT OR IGNORE INTO evidence_attachments (evidence_id, attachment_id, position) VALUES (?, ?, ?)').run(id, a, start + i));
  const after = getEvidence(db, id);
  audit(db, before.projectId, 'evidence', id, 'update', { attachments: before.attachments.map((a) => a.id) }, { attachments: after.attachments.map((a) => a.id) });
  return after;
}

export function setEvidenceArchived(db: DB, id: string, archived: boolean): EvidenceDTO {
  const before = getEvidenceRow(db, id);
  db.prepare('UPDATE evidence SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? nowIso() : null, nowIso(), id);
  audit(db, before.project_id, 'evidence', id, archived ? 'archive' : 'unarchive', before, getEvidenceRow(db, id));
  return getEvidence(db, id);
}

/** Why an evidence item cannot be deleted, or null if it can. */
export function evidenceDeleteBlocker(db: DB, id: string): string | null {
  const ev = getEvidenceRow(db, id);
  const ref = db
    .prepare('SELECT r.seq FROM revision_evidence re JOIN revisions r ON r.id = re.revision_id WHERE re.evidence_id = ? ORDER BY r.seq LIMIT 1')
    .get(id) as { seq: number } | undefined;
  if (ref) return `It is part of Research Update #${ref.seq}. Archive it instead; history must stay reconstructable.`;
  const draft = getDraftRow(db, ev.project_id);
  if ((JSON.parse(draft.state_json) as ModelState).links.some((l) => l.evidenceId === id)) return 'It is linked to a node in the current draft. Unlink it first.';
  const cats = db.prepare('SELECT title, evidence_ids_json FROM catalysts WHERE project_id = ?').all(ev.project_id) as { title: string; evidence_ids_json: string }[];
  const cat = cats.find((c) => parseJson<string[]>(c.evidence_ids_json, []).includes(id));
  if (cat) return `It is attached to the catalyst “${cat.title}”.`;
  return null;
}

export function deleteEvidence(db: DB, id: string) {
  const blocker = evidenceDeleteBlocker(db, id);
  if (blocker) throw conflict(`This evidence cannot be deleted. ${blocker}`);
  const before = getEvidence(db, id);
  db.transaction(() => {
    db.prepare('DELETE FROM evidence_attachments WHERE evidence_id = ?').run(id);
    db.prepare('DELETE FROM evidence WHERE id = ?').run(id);
  })();
  audit(db, before.projectId, 'evidence', id, 'delete', before, null);
}

// ---------------------------------------------------------------- catalysts

interface CatalystRow {
  id: string;
  project_id: string;
  title: string;
  type: string;
  expected_date: string | null;
  date_precision: string;
  actual_date: string | null;
  status: string;
  expected_outcome: string;
  actual_outcome: string;
  notes: string;
  node_ids_json: string;
  evidence_ids_json: string;
  revision_id: string | null;
  created_at: string;
  updated_at: string;
}

const toCatalyst = (r: CatalystRow): CatalystDTO => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  type: r.type,
  expectedDate: r.expected_date,
  datePrecision: r.date_precision as CatalystDTO['datePrecision'],
  actualDate: r.actual_date,
  status: r.status as CatalystDTO['status'],
  expectedOutcome: r.expected_outcome,
  actualOutcome: r.actual_outcome,
  notes: r.notes,
  nodeIds: parseJson<string[]>(r.node_ids_json, []),
  evidenceIds: parseJson<string[]>(r.evidence_ids_json, []),
  revisionId: r.revision_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function getCatalystRow(db: DB, id: string): CatalystRow {
  const r = db.prepare('SELECT * FROM catalysts WHERE id = ?').get(id) as CatalystRow | undefined;
  if (!r) throw notFound('Catalyst');
  return r;
}

export function listCatalysts(db: DB, projectId: string): CatalystDTO[] {
  return (db.prepare('SELECT * FROM catalysts WHERE project_id = ? ORDER BY COALESCE(actual_date, expected_date) IS NULL, COALESCE(actual_date, expected_date)').all(projectId) as CatalystRow[]).map(
    toCatalyst,
  );
}

export type CatalystInput = Partial<Omit<CatalystDTO, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>;

function cleanCatalyst(db: DB, projectId: string, input: CatalystInput, base?: CatalystDTO): CatalystDTO {
  const next = { ...(base ?? ({} as CatalystDTO)), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as CatalystDTO;
  next.title = (next.title ?? '').trim();
  if (!next.title) throw badRequest('Catalyst needs a title');
  next.type = next.type || 'other';
  next.datePrecision = next.datePrecision || 'day';
  if (!['day', 'month', 'quarter'].includes(next.datePrecision)) throw badRequest('Invalid date precision');
  next.status = next.status || 'upcoming';
  if (!['upcoming', 'occurred', 'delayed', 'cancelled'].includes(next.status)) throw badRequest('Invalid status');
  for (const k of ['expectedDate', 'actualDate'] as const) {
    if (next[k] === '') next[k] = null;
    if (next[k] && !isDate(next[k])) throw badRequest(`${k} must be YYYY-MM-DD`);
  }
  next.expectedDate ??= null;
  next.actualDate ??= null;
  next.expectedOutcome ??= '';
  next.actualOutcome ??= '';
  next.notes ??= '';
  next.nodeIds ??= [];
  next.evidenceIds ??= [];
  next.revisionId ??= null;
  if (next.revisionId) {
    const ok = db.prepare('SELECT 1 FROM revisions WHERE id = ? AND project_id = ?').get(next.revisionId, projectId);
    if (!ok) throw badRequest('Research Update not found in this project');
  }
  return next;
}

export function createCatalyst(db: DB, projectId: string, input: CatalystInput): CatalystDTO {
  const c = cleanCatalyst(db, projectId, input);
  const id = newId('cat');
  const now = nowIso();
  db.prepare(
    `INSERT INTO catalysts (id, project_id, title, type, expected_date, date_precision, actual_date, status, expected_outcome, actual_outcome, notes, node_ids_json, evidence_ids_json, revision_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, c.title, c.type, c.expectedDate, c.datePrecision, c.actualDate, c.status, c.expectedOutcome, c.actualOutcome, c.notes, JSON.stringify(c.nodeIds), JSON.stringify(c.evidenceIds), c.revisionId, now, now);
  return toCatalyst(getCatalystRow(db, id));
}

export function updateCatalyst(db: DB, id: string, input: CatalystInput): CatalystDTO {
  const beforeRow = getCatalystRow(db, id);
  const before = toCatalyst(beforeRow);
  const c = cleanCatalyst(db, before.projectId, input, before);
  db.prepare(
    `UPDATE catalysts SET title = ?, type = ?, expected_date = ?, date_precision = ?, actual_date = ?, status = ?, expected_outcome = ?, actual_outcome = ?, notes = ?, node_ids_json = ?, evidence_ids_json = ?, revision_id = ?, updated_at = ? WHERE id = ?`,
  ).run(c.title, c.type, c.expectedDate, c.datePrecision, c.actualDate, c.status, c.expectedOutcome, c.actualOutcome, c.notes, JSON.stringify(c.nodeIds), JSON.stringify(c.evidenceIds), c.revisionId, nowIso(), id);
  const after = toCatalyst(getCatalystRow(db, id));
  audit(db, before.projectId, 'catalyst', id, 'update', before, after);
  return after;
}

export function deleteCatalyst(db: DB, id: string) {
  const before = toCatalyst(getCatalystRow(db, id));
  db.prepare('DELETE FROM catalysts WHERE id = ?').run(id);
  audit(db, before.projectId, 'catalyst', id, 'delete', before, null);
}

// ---------------------------------------------------------------- trades

interface TradeRow {
  id: string;
  project_id: string;
  security_id: string;
  side: 'long' | 'short';
  entry_date: string;
  entry_price: number;
  quantity: number;
  entry_reason: string;
  target_price_at_entry: number | null;
  stop_at_entry: number | null;
  atr_at_entry: number | null;
  atr_multiple: number | null;
  revision_id: string | null;
  exit_date: string | null;
  exit_price: number | null;
  exit_reason: string;
  fees: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

const toTrade = (r: TradeRow): TradeDTO => ({
  id: r.id,
  projectId: r.project_id,
  securityId: r.security_id,
  side: r.side,
  entryDate: r.entry_date,
  entryPrice: r.entry_price,
  quantity: r.quantity,
  entryReason: r.entry_reason,
  targetPriceAtEntry: r.target_price_at_entry,
  stopAtEntry: r.stop_at_entry,
  atrAtEntry: r.atr_at_entry,
  atrMultiple: r.atr_multiple,
  revisionId: r.revision_id,
  exitDate: r.exit_date,
  exitPrice: r.exit_price,
  exitReason: r.exit_reason,
  fees: r.fees,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function getTradeRow(db: DB, id: string): TradeRow {
  const r = db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as TradeRow | undefined;
  if (!r) throw notFound('Trade');
  return r;
}

export function listTrades(db: DB, projectId: string): TradeDTO[] {
  return (db.prepare('SELECT * FROM trades WHERE project_id = ? ORDER BY entry_date DESC, created_at DESC').all(projectId) as TradeRow[]).map(toTrade);
}

export type TradeInput = Partial<Omit<TradeDTO, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>;

const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

function validateTrade(t: TradeDTO) {
  if (!isDate(t.entryDate)) throw badRequest('Entry date must be YYYY-MM-DD');
  if (!(t.entryPrice > 0)) throw badRequest('Entry price must be positive');
  if (!(t.quantity > 0)) throw badRequest('Position size must be positive');
  if (t.side !== 'long' && t.side !== 'short') throw badRequest('Side must be long or short');
  if (t.exitDate && !isDate(t.exitDate)) throw badRequest('Exit date must be YYYY-MM-DD');
  if (t.exitDate && t.exitDate < t.entryDate) throw badRequest('Exit date is before the entry date');
  if ((t.exitDate === null) !== (t.exitPrice === null)) throw badRequest('Exit needs both a date and a price');
  if (t.exitPrice !== null && !(t.exitPrice > 0)) throw badRequest('Exit price must be positive');
  for (const k of ['targetPriceAtEntry', 'stopAtEntry', 'atrAtEntry', 'atrMultiple'] as const) {
    if (t[k] !== null && !Number.isFinite(t[k])) throw badRequest(`${k} must be a number`);
  }
}

/**
 * Record a trade. The research snapshot is the latest Research Update whose knowledge date is on
 * or before the entry date (no look-ahead); target price and ATR default from that snapshot and
 * from cached bars up to the entry date.
 */
export function createTrade(db: DB, projectId: string, input: TradeInput): TradeDTO {
  const securityId = input.securityId ?? (db.prepare('SELECT id FROM securities WHERE project_id = ? ORDER BY is_primary DESC LIMIT 1').get(projectId) as { id: string } | undefined)?.id;
  if (!securityId) throw badRequest('The project has no security');
  const security = getSecurity(db, securityId);
  if (security.projectId !== projectId) throw badRequest('Security belongs to another project');
  const entryDate = input.entryDate ?? '';
  if (!isDate(entryDate)) throw badRequest('Entry date must be YYYY-MM-DD');
  const rev = input.revisionId ? checkTradeRevision(db, projectId, input.revisionId, entryDate) : revisionAsOf(db, projectId, entryDate);
  let targetPrice = numOrNull(input.targetPriceAtEntry);
  if (targetPrice === null && rev) {
    const row = db.prepare('SELECT * FROM revisions WHERE id = ?').get(rev.id) as Parameters<typeof frozenTargetPrice>[0];
    targetPrice = frozenTargetPrice(row).base;
  }
  let atrValue = numOrNull(input.atrAtEntry);
  if (atrValue === null) {
    const bars = getBars(db, securityId, security.priceSource);
    atrValue = bars.length ? atrAsOf(bars, entryDate, 14) : null;
  }
  const atrMultiple = numOrNull(input.atrMultiple) ?? 2;
  const entryPrice = Number(input.entryPrice);
  const side = input.side ?? 'long';
  let stop = numOrNull(input.stopAtEntry);
  if (stop === null && atrValue !== null && entryPrice > 0) stop = side === 'long' ? entryPrice - atrMultiple * atrValue : entryPrice + atrMultiple * atrValue;
  const now = nowIso();
  const t: TradeDTO = {
    id: newId('trd'),
    projectId,
    securityId,
    side,
    entryDate,
    entryPrice,
    quantity: Number(input.quantity),
    entryReason: input.entryReason ?? '',
    targetPriceAtEntry: targetPrice,
    stopAtEntry: stop,
    atrAtEntry: atrValue,
    atrMultiple,
    revisionId: rev?.id ?? null,
    exitDate: input.exitDate || null,
    exitPrice: numOrNull(input.exitPrice),
    exitReason: input.exitReason ?? '',
    fees: Number(input.fees ?? 0) || 0,
    notes: input.notes ?? '',
    createdAt: now,
    updatedAt: now,
  };
  validateTrade(t);
  db.prepare(
    `INSERT INTO trades (id, project_id, security_id, side, entry_date, entry_price, quantity, entry_reason, target_price_at_entry, stop_at_entry, atr_at_entry, atr_multiple, revision_id, exit_date, exit_price, exit_reason, fees, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.id, projectId, securityId, t.side, t.entryDate, t.entryPrice, t.quantity, t.entryReason, t.targetPriceAtEntry, t.stopAtEntry, t.atrAtEntry, t.atrMultiple, t.revisionId, t.exitDate, t.exitPrice, t.exitReason, t.fees, t.notes, now, now);
  return toTrade(getTradeRow(db, t.id));
}

/** A trade may only reference research that was known on its entry date. */
function checkTradeRevision(db: DB, projectId: string, revisionId: string, entryDate: string): { id: string } {
  const r = db.prepare('SELECT id, seq, as_of_date FROM revisions WHERE id = ? AND project_id = ?').get(revisionId, projectId) as { id: string; seq: number; as_of_date: string | null } | undefined;
  if (!r) throw badRequest('Research Update not found in this project');
  if (!r.as_of_date || r.as_of_date > entryDate) {
    throw badRequest(`Research Update #${r.seq} has knowledge date ${r.as_of_date ?? '(none)'}, after the entry date ${entryDate}; a trade cannot rely on research made later.`);
  }
  return r;
}

export function updateTrade(db: DB, id: string, input: TradeInput): TradeDTO {
  const before = toTrade(getTradeRow(db, id));
  const next: TradeDTO = { ...before };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || k === 'id' || k === 'projectId' || k === 'securityId' || k === 'revisionId') continue;
    (next as unknown as Record<string, unknown>)[k] = v;
  }
  // The research snapshot follows the entry date unless one is chosen explicitly (and valid then).
  if (input.revisionId) next.revisionId = checkTradeRevision(db, before.projectId, input.revisionId, String(next.entryDate)).id;
  else if (input.entryDate && input.entryDate !== before.entryDate && isDate(input.entryDate)) next.revisionId = revisionAsOf(db, before.projectId, input.entryDate)?.id ?? null;
  for (const k of ['entryPrice', 'quantity', 'fees'] as const) next[k] = Number(next[k]);
  for (const k of ['targetPriceAtEntry', 'stopAtEntry', 'atrAtEntry', 'atrMultiple', 'exitPrice'] as const) next[k] = numOrNull(next[k]);
  next.exitDate = next.exitDate || null;
  validateTrade(next);
  db.prepare(
    `UPDATE trades SET side = ?, entry_date = ?, entry_price = ?, quantity = ?, entry_reason = ?, target_price_at_entry = ?, stop_at_entry = ?, atr_at_entry = ?, atr_multiple = ?, revision_id = ?, exit_date = ?, exit_price = ?, exit_reason = ?, fees = ?, notes = ?, updated_at = ? WHERE id = ?`,
  ).run(next.side, next.entryDate, next.entryPrice, next.quantity, next.entryReason, next.targetPriceAtEntry, next.stopAtEntry, next.atrAtEntry, next.atrMultiple, next.revisionId, next.exitDate, next.exitPrice, next.exitReason, next.fees, next.notes, nowIso(), id);
  const after = toTrade(getTradeRow(db, id));
  audit(db, before.projectId, 'trade', id, 'update', before, after);
  return after;
}

export function deleteTrade(db: DB, id: string) {
  const before = toTrade(getTradeRow(db, id));
  db.prepare('DELETE FROM trades WHERE id = ?').run(id);
  audit(db, before.projectId, 'trade', id, 'delete', before, null);
}

// ---------------------------------------------------------------- notes

const toNote = (r: { id: string; project_id: string; body: string; created_at: string; updated_at: string }): NoteDTO => ({
  id: r.id,
  projectId: r.project_id,
  body: r.body,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listNotes(db: DB, projectId: string): NoteDTO[] {
  return (db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Parameters<typeof toNote>[0][]).map(toNote);
}

export function createNote(db: DB, projectId: string, body: string): NoteDTO {
  if (!body.trim()) throw badRequest('Note is empty');
  const id = newId('note');
  const now = nowIso();
  db.prepare('INSERT INTO notes (id, project_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, body, now, now);
  return toNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Parameters<typeof toNote>[0]);
}

export function updateNote(db: DB, id: string, body: string): NoteDTO {
  const before = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Parameters<typeof toNote>[0] | undefined;
  if (!before) throw notFound('Note');
  db.prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?').run(body, nowIso(), id);
  const after = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Parameters<typeof toNote>[0];
  audit(db, before.project_id, 'note', id, 'update', before, after);
  return toNote(after);
}

export function deleteNote(db: DB, id: string) {
  const before = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Parameters<typeof toNote>[0] | undefined;
  if (!before) throw notFound('Note');
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  audit(db, before.project_id, 'note', id, 'delete', before, null);
}

// ---------------------------------------------------------------- reviews

interface ReviewRow {
  id: string;
  project_id: string;
  subject_type: string;
  subject_id: string | null;
  title: string;
  outcome: string;
  categories_json: string;
  thesis_verdict: string | null;
  execution_verdict: string | null;
  lessons: string;
  created_at: string;
  updated_at: string;
}

const toReview = (r: ReviewRow): ReviewDTO => ({
  id: r.id,
  projectId: r.project_id,
  subjectType: r.subject_type as ReviewDTO['subjectType'],
  subjectId: r.subject_id,
  title: r.title,
  outcome: r.outcome,
  categories: parseJson(r.categories_json, []),
  thesisVerdict: r.thesis_verdict as ReviewDTO['thesisVerdict'],
  executionVerdict: r.execution_verdict as ReviewDTO['executionVerdict'],
  lessons: r.lessons,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listReviews(db: DB, projectId: string): ReviewDTO[] {
  return (db.prepare('SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as ReviewRow[]).map(toReview);
}

export type ReviewInput = Partial<Omit<ReviewDTO, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>;

function cleanReview(input: ReviewInput, base?: ReviewDTO): ReviewDTO {
  const next = { ...(base ?? ({} as ReviewDTO)), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ReviewDTO;
  next.title = (next.title ?? '').trim();
  if (!next.title) throw badRequest('Review needs a title');
  next.subjectType ||= 'project';
  if (!['project', 'revision', 'trade', 'thesis', 'catalyst'].includes(next.subjectType)) throw badRequest('Invalid review subject');
  next.subjectId ??= null;
  next.outcome ??= '';
  next.lessons ??= '';
  next.categories = (next.categories ?? []).filter((c) => c && typeof c.category === 'string').map((c) => ({ category: c.category, notes: c.notes ?? '' }));
  next.thesisVerdict ??= null;
  next.executionVerdict ??= null;
  return next;
}

export function createReview(db: DB, projectId: string, input: ReviewInput): ReviewDTO {
  const r = cleanReview(input);
  const id = newId('rvw');
  const now = nowIso();
  db.prepare(
    'INSERT INTO reviews (id, project_id, subject_type, subject_id, title, outcome, categories_json, thesis_verdict, execution_verdict, lessons, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, r.subjectType, r.subjectId, r.title, r.outcome, JSON.stringify(r.categories), r.thesisVerdict, r.executionVerdict, r.lessons, now, now);
  return toReview(db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow);
}

export function updateReview(db: DB, id: string, input: ReviewInput): ReviewDTO {
  const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined;
  if (!row) throw notFound('Review');
  const before = toReview(row);
  const r = cleanReview(input, before);
  db.prepare('UPDATE reviews SET subject_type = ?, subject_id = ?, title = ?, outcome = ?, categories_json = ?, thesis_verdict = ?, execution_verdict = ?, lessons = ?, updated_at = ? WHERE id = ?').run(
    r.subjectType,
    r.subjectId,
    r.title,
    r.outcome,
    JSON.stringify(r.categories),
    r.thesisVerdict,
    r.executionVerdict,
    r.lessons,
    nowIso(),
    id,
  );
  const after = toReview(db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow);
  audit(db, before.projectId, 'review', id, 'update', before, after);
  return after;
}

export function deleteReview(db: DB, id: string) {
  const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined;
  if (!row) throw notFound('Review');
  db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  audit(db, row.project_id, 'review', id, 'delete', toReview(row), null);
}

// ---------------------------------------------------------------- templates

export function listSavedTemplates(db: DB): TemplateDTO[] {
  return (db.prepare('SELECT id, name, description, created_at FROM templates ORDER BY created_at DESC').all() as { id: string; name: string; description: string; created_at: string }[]).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    builtIn: false,
    createdAt: r.created_at,
  }));
}

export function getSavedTemplateState(db: DB, id: string): { name: string; state: ModelState } {
  const r = db.prepare('SELECT name, state_json FROM templates WHERE id = ?').get(id) as { name: string; state_json: string } | undefined;
  if (!r) throw notFound('Template');
  return { name: r.name, state: JSON.parse(r.state_json) as ModelState };
}

export function saveTemplate(db: DB, name: string, description: string, state: ModelState): TemplateDTO {
  if (!name.trim()) throw badRequest('Template needs a name');
  const id = newId('tpl');
  const now = nowIso();
  db.prepare('INSERT INTO templates (id, name, description, state_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), description, JSON.stringify(state), now);
  return { id, name: name.trim(), description, builtIn: false, createdAt: now };
}

export function deleteTemplate(db: DB, id: string) {
  const r = db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  if (!r.changes) throw notFound('Template');
}
