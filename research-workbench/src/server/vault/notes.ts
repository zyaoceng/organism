/**
 * Notes for the Obsidian vault, assembled from the database and rendered by src/domain/vault/render.
 * The server only renders; the plugin merges the result into the files (it never deletes or
 * overwrites text outside the generated block).
 *
 * vault_changes (filled by the v3 triggers) says which notes changed; GET /api/vault/notes pages
 * through it. Each page renders the latest state of every note it names, so a note that changed
 * five times is sent once.
 */
import type { FrozenOutputs } from '../../domain/calc/engine';
import type { ModelState } from '../../domain/model/types';
import type { ModelChange } from '../../domain/revision/diff';
import { targetPriceCurrency } from '../../domain/valuation/targets';
import { LINK_TOKEN_RE } from '../../domain/vault/links';
import {
  frozenHeadline,
  renderAiSessionNote,
  renderCompanyNote,
  renderIndexNote,
  renderResearchUpdateNote,
  renderTradeNote,
  type AiSessionIn,
  type CatalystIn,
  type CompanyRef,
  type EvidenceIn,
  type Headline,
  type NoteContext,
  type ReviewIn,
  type RevisionIn,
  type TradeIn,
} from '../../domain/vault/render';
import { reflectionBody } from '../../domain/vault/reflection';
import { isReflectionKind, kindOfWbId, VAULT_PROTOCOL, WB_ID_RE, type IndexId, type RenderedNote, type VaultNotesResponse } from '../../domain/vault/types';
import { actorLabel, CLIENT_LABEL, isAgentClient } from '../../shared/actors';
import type { AiActionDTO, MarketContext, TradeDTO } from '../../shared/api';
import type { DB } from '../db/connection';
import { excludedSet } from '../repos/annotations';
import { citedEvidence, type RevisionRow } from '../repos/projects';
import { listCatalysts, listReviews, toTrade, type TradeRow } from '../repos/records';
import { localToday, parseJson } from '../util';

/** Labels and dates the renderer may not compute itself (it imports neither src/server nor src/shared). */
export function noteContext(publicUrl: string): NoteContext {
  return {
    publicUrl,
    localDate: (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : localToday(d);
    },
    actorLabel: (a) => actorLabel(a, 'zh-TW'),
    clientLabel: (c) => (isAgentClient(c) ? CLIENT_LABEL['zh-TW'][c] : c),
  };
}

/** A deleted trade as the vault_trades_del trigger stored it. */
export type TradeTombstone = TradeDTO & { deletedAt: string };

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
}

interface ProjectData {
  ref: CompanyRef;
  archived: boolean;
  security: { ticker: string; exchange: string; currency: string } | null;
}

interface RevisionData {
  row: RevisionRow;
  state: ModelState;
  meta: RevisionIn;
}

/**
 * Database reads for one request, memoised: a page of 200 notes reads each company once. Never
 * kept across requests (the data may change between them).
 */
export class NoteSource {
  private projects = new Map<string, ProjectData | null>();
  private revisions = new Map<string, RevisionData[]>();
  private excluded = new Map<string, Set<string>>();
  private trades = new Map<string, TradeIn[]>();
  private sessions: AiSessionIn[] | null = null;
  private rendered = new Map<string, RenderedNote | null>();
  /** Render errors of this request (logged by the route). */
  readonly errors: string[] = [];

  constructor(
    readonly db: DB,
    readonly ctx: NoteContext,
  ) {}

  project(id: string): ProjectData | null {
    if (!this.projects.has(id)) {
      const p = this.db.prepare('SELECT id, name, archived_at FROM projects WHERE id = ?').get(id) as { id: string; name: string; archived_at: string | null } | undefined;
      const s = p
        ? (this.db.prepare('SELECT ticker, exchange, currency FROM securities WHERE project_id = ? ORDER BY is_primary DESC, ticker LIMIT 1').get(id) as
            | { ticker: string; exchange: string; currency: string }
            | undefined)
        : undefined;
      this.projects.set(id, p ? { ref: { id: p.id, ticker: s?.ticker ?? '', name: p.name }, archived: p.archived_at !== null, security: s ?? null } : null);
    }
    return this.projects.get(id)!;
  }

  private excludedOf(projectId: string): Set<string> {
    if (!this.excluded.has(projectId)) this.excluded.set(projectId, excludedSet(this.db, projectId));
    return this.excluded.get(projectId)!;
  }

  /** All revisions of a project with their frozen headlines, by seq. */
  revisionsOf(projectId: string): RevisionData[] {
    if (!this.revisions.has(projectId)) {
      const excluded = this.excludedOf(projectId);
      const rows = this.db.prepare('SELECT * FROM revisions WHERE project_id = ? ORDER BY seq').all(projectId) as RevisionRow[];
      this.revisions.set(
        projectId,
        rows.map((row) => {
          const state = JSON.parse(row.state_json) as ModelState;
          const computed = JSON.parse(row.computed_json) as FrozenOutputs;
          const meta: RevisionIn = {
            id: row.id,
            seq: row.seq,
            kind: row.kind,
            title: row.title,
            reason: row.reason,
            notes: row.notes,
            asOfDate: row.as_of_date,
            committedAt: row.committed_at,
            createdBy: row.created_by,
            excludedFromCalibration: excluded.has(row.id),
            headline: frozenHeadline(state, computed),
          };
          return { row, state, meta };
        }),
      );
    }
    return this.revisions.get(projectId)!;
  }

  /** Head revision's frozen headline without parsing every revision (company index). */
  private head(projectId: string): { meta: Pick<RevisionIn, 'asOfDate' | 'committedAt'>; headline: Headline } | null {
    const cached = this.revisions.get(projectId);
    if (cached) {
      const h = cached.at(-1);
      return h ? { meta: h.meta, headline: h.meta.headline } : null;
    }
    const row = this.db.prepare('SELECT state_json, computed_json, as_of_date, committed_at FROM revisions WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as
      | Pick<RevisionRow, 'state_json' | 'computed_json' | 'as_of_date' | 'committed_at'>
      | undefined;
    if (!row) return null;
    return {
      meta: { asOfDate: row.as_of_date, committedAt: row.committed_at },
      headline: frozenHeadline(JSON.parse(row.state_json) as ModelState, JSON.parse(row.computed_json) as FrozenOutputs),
    };
  }

  tradesOf(projectId: string): TradeIn[] {
    if (!this.trades.has(projectId)) {
      const rows = this.db.prepare('SELECT * FROM trades WHERE project_id = ? ORDER BY entry_date DESC, created_at DESC, id').all(projectId) as TradeRow[];
      this.trades.set(projectId, rows.map(toTrade));
    }
    return this.trades.get(projectId)!;
  }

  /** AI sessions that have a summary (only those get a note). */
  summarisedSessions(): AiSessionIn[] {
    if (!this.sessions) {
      const rows = this.db.prepare('SELECT * FROM ai_sessions WHERE summary_md IS NOT NULL ORDER BY last_at DESC, id').all() as SessionRow[];
      this.sessions = rows.map((r) => ({
        id: r.id,
        client: r.client,
        startedAt: r.started_at,
        lastAt: r.last_at,
        projectIds: parseJson<string[]>(r.project_ids_json, []),
        actions: parseJson<AiActionDTO[]>(r.actions_json, []).map((a) => ({ at: a.at, kind: a.kind, summary: a.summary })),
        summary: r.summary_md,
        decisions: r.decisions_md,
        todo: r.todo_md,
      }));
    }
    return this.sessions;
  }

  private companiesOf(s: AiSessionIn): CompanyRef[] {
    return s.projectIds.map((id) => this.project(id)?.ref).filter((c): c is CompanyRef => !!c);
  }

  /** The latest tombstone of a deleted trade, if it was deleted. */
  tombstone(tradeId: string): TradeTombstone | null {
    const r = this.db.prepare("SELECT tombstone_json FROM vault_changes WHERE note_id = ? AND op = 'delete' ORDER BY seq DESC LIMIT 1").get(tradeId) as
      | { tombstone_json: string | null }
      | undefined;
    return r?.tombstone_json ? toTombstone(parseJson<Record<string, unknown>>(r.tombstone_json, {})) : null;
  }

  /** The note as it is now, or null when its entity no longer exists (and left no tombstone). */
  render(wbId: string): RenderedNote | null {
    if (!this.rendered.has(wbId)) {
      let note: RenderedNote | null = null;
      try {
        note = this.withStoredReflection(this.renderUncached(wbId));
      } catch (e) {
        // one broken row must not stop the whole vault from syncing; the note is reported missing
        note = null;
        this.errors.push(`${wbId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.rendered.set(wbId, note);
    }
    return this.rendered.get(wbId)!;
  }

  /**
   * The body is written only when the file is created. When the server already holds a reflection
   * (the user deleted the note and re-created it, or a second vault), the new file starts with that
   * text, so reading it back is not taken as the reflection being cleared.
   */
  private withStoredReflection(note: RenderedNote | null): RenderedNote | null {
    if (!note || !isReflectionKind(note.kind)) return note;
    const latest = this.db.prepare('SELECT body_md FROM reflection_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1').get(note.wbId) as
      | { body_md: string }
      | undefined;
    return latest?.body_md ? { ...note, body: reflectionBody(latest.body_md) } : note;
  }

  private renderUncached(wbId: string): RenderedNote | null {
    const kind = kindOfWbId(wbId);
    const ctx = this.ctx;
    switch (kind) {
      case 'company': {
        const p = this.project(wbId);
        if (!p) return null;
        const revs = this.revisionsOf(wbId);
        const head = revs.at(-1);
        return renderCompanyNote(
          {
            company: { ...p.ref, archived: p.archived },
            security: p.security,
            revisions: revs.map((r) => r.meta),
            headMarket: head ? toMarket(parseJson<MarketContext | null>(head.row.market_json, null)) : null,
            targetCurrency: head ? targetPriceCurrency(head.state) : null,
            trades: this.tradesOf(wbId),
            catalysts: listCatalysts(this.db, wbId).map(
              (c): CatalystIn => ({ id: c.id, title: c.title, type: c.type, expectedDate: c.expectedDate, datePrecision: c.datePrecision, status: c.status, expectedOutcome: c.expectedOutcome }),
            ),
            aiSessions: this.summarisedSessions().filter((s) => s.projectIds.includes(wbId)),
          },
          ctx,
        );
      }
      case 'research_update': {
        const r = this.db.prepare('SELECT project_id, kind FROM revisions WHERE id = ?').get(wbId) as { project_id: string; kind: string } | undefined;
        if (!r || r.kind === 'initial') return null;
        const p = this.project(r.project_id);
        if (!p) return null;
        const revs = this.revisionsOf(r.project_id);
        const rev = revs.find((x) => x.row.id === wbId)!;
        const parent = rev.row.parent_id ? revs.find((x) => x.row.id === rev.row.parent_id) : undefined;
        const evidence = this.db.prepare('SELECT id, title, url, published_at FROM evidence WHERE project_id = ?').all(r.project_id) as {
          id: string;
          title: string;
          url: string | null;
          published_at: string | null;
        }[];
        return renderResearchUpdateNote(
          {
            company: p.ref,
            revision: { ...rev.meta, changes: parseJson<ModelChange[]>(rev.row.changes_json, []), citedEvidenceIds: citedEvidence(this.db, wbId) },
            before: parent ? parent.meta.headline : null,
            periods: rev.state.periods.map((x) => ({ id: x.id, label: x.label })),
            evidence: evidence.map((e): EvidenceIn => ({ id: e.id, title: e.title, url: e.url, publishedAt: e.published_at })),
          },
          ctx,
        );
      }
      case 'trade': {
        const row = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(wbId) as TradeRow | undefined;
        const tomb = row ? null : this.tombstone(wbId);
        const trade: TradeIn | null = row ? toTrade(row) : tomb;
        if (!trade) return null;
        const p = this.project(trade.projectId);
        if (!p) return null;
        const rev = trade.revisionId
          ? (this.db.prepare('SELECT id, seq, as_of_date, title FROM revisions WHERE id = ?').get(trade.revisionId) as
              | { id: string; seq: number; as_of_date: string | null; title: string }
              | undefined)
          : undefined;
        return renderTradeNote(
          {
            company: p.ref,
            trade,
            revision: rev ? { id: rev.id, seq: rev.seq, asOfDate: rev.as_of_date, title: rev.title } : null,
            reviews: listReviews(this.db, trade.projectId).map(
              (v): ReviewIn => ({
                id: v.id,
                subjectType: v.subjectType,
                subjectId: v.subjectId,
                title: v.title,
                thesisVerdict: v.thesisVerdict,
                executionVerdict: v.executionVerdict,
                lessons: v.lessons,
                createdAt: v.createdAt,
              }),
            ),
            deletedAt: tomb?.deletedAt ?? null,
          },
          ctx,
        );
      }
      case 'ai_session': {
        const s = this.summarisedSessions().find((x) => x.id === wbId);
        return s ? renderAiSessionNote({ session: s, companies: this.companiesOf(s) }, ctx) : null;
      }
      case 'index':
        return this.renderIndex(wbId as IndexId);
      default:
        return null;
    }
  }

  private renderIndex(id: IndexId): RenderedNote {
    if (id === 'index-companies') {
      const ids = (this.db.prepare('SELECT id FROM projects ORDER BY id').all() as { id: string }[]).map((r) => r.id);
      const open = new Map(
        (this.db.prepare('SELECT project_id, COUNT(*) AS n FROM trades WHERE exit_date IS NULL OR exit_price IS NULL GROUP BY project_id').all() as { project_id: string; n: number }[]).map((r) => [
          r.project_id,
          r.n,
        ]),
      );
      return renderIndexNote(
        {
          id,
          companies: ids.map((pid) => {
            const h = this.head(pid);
            return {
              company: this.project(pid)!.ref,
              tpBase: h?.headline.targetPrice.base ?? null,
              lastUpdate: h ? h.meta.asOfDate ?? this.ctx.localDate(h.meta.committedAt) : null,
              openTrades: open.get(pid) ?? 0,
            };
          }),
        },
        this.ctx,
      );
    }
    if (id === 'index-trades') {
      const rows = this.db.prepare('SELECT * FROM trades ORDER BY entry_date DESC, created_at DESC, id').all() as TradeRow[];
      return renderIndexNote(
        {
          id,
          trades: rows.flatMap((r) => {
            const p = this.project(r.project_id);
            return p ? [{ trade: toTrade(r), company: p.ref }] : [];
          }),
        },
        this.ctx,
      );
    }
    return renderIndexNote({ id, sessions: this.summarisedSessions().map((s) => ({ session: s, companies: this.companiesOf(s) })) }, this.ctx);
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The trigger's json_object back into a TradeDTO (missing fields get their column defaults). */
function toTombstone(j: Record<string, unknown>): TradeTombstone | null {
  const id = str(j.id);
  const projectId = str(j.projectId);
  if (!id || !projectId) return null;
  return {
    id,
    projectId,
    securityId: str(j.securityId) ?? '',
    side: j.side === 'short' ? 'short' : 'long',
    entryDate: str(j.entryDate) ?? '',
    entryPrice: num(j.entryPrice) ?? 0,
    quantity: num(j.quantity) ?? 0,
    entryReason: str(j.entryReason) ?? '',
    targetPriceAtEntry: num(j.targetPriceAtEntry),
    stopAtEntry: num(j.stopAtEntry),
    atrAtEntry: num(j.atrAtEntry),
    atrMultiple: num(j.atrMultiple),
    revisionId: str(j.revisionId),
    exitDate: str(j.exitDate),
    exitPrice: num(j.exitPrice),
    exitReason: str(j.exitReason) ?? '',
    fees: num(j.fees) ?? 0,
    notes: str(j.notes) ?? '',
    createdBy: str(j.createdBy),
    source: j.source === 'import' || j.source === 'entry' ? j.source : null,
    externalRef: str(j.externalRef),
    sourceText: str(j.sourceText),
    createdAt: str(j.createdAt) ?? '',
    updatedAt: str(j.updatedAt) ?? '',
    deletedAt: str(j.deletedAt) ?? '',
  };
}

const toMarket = (m: MarketContext | null) => (m && Number.isFinite(m.price) ? { price: m.price, currency: m.currency, asOf: m.asOf } : null);

// ---------------------------------------------------------------- pages

export const MAX_PAGE = 500;
export const DEFAULT_PAGE = 200;
export const MAX_IDS = 200;

export function latestSeq(db: DB): number {
  return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM vault_changes').get() as { m: number }).m;
}

/** Ids linked from these notes ([[wb:<id>|…]] tokens and link-valued keys). */
function linkedIds(notes: RenderedNote[]): Set<string> {
  const out = new Set<string>();
  for (const n of notes) {
    for (const text of [n.block, n.body]) for (const m of text.matchAll(LINK_TOKEN_RE)) out.add(m[1]);
    for (const [, v] of n.frontmatter) if (v && typeof v === 'object' && 'link' in v) out.add(v.link);
  }
  return out;
}

/** Default paths of the notes these link to that are not in the page (the plugin may not have them yet). */
function namesFor(src: NoteSource, notes: RenderedNote[]): Record<string, string> {
  const inPage = new Set(notes.map((n) => n.wbId));
  const names: Record<string, string> = {};
  for (const id of [...linkedIds(notes)].sort()) {
    if (inPage.has(id) || !WB_ID_RE.test(id)) continue;
    const p = pathOf(src, id);
    if (p) names[id] = p;
  }
  return names;
}

/** Default path of a note (relative to the plugin's root folder), or null when there is no such note. */
export function pathOf(src: NoteSource, wbId: string): string | null {
  return src.render(wbId)?.path ?? null;
}

interface PageMeta {
  generation: string;
  publicUrl: string;
}

/** Changes after `after`, oldest first; each note once, in the order of its latest change. */
export function notesAfter(src: NoteSource, after: number, limit: number, meta: PageMeta): VaultNotesResponse {
  const db = src.db;
  const rows = db.prepare('SELECT seq, note_id FROM vault_changes WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as { seq: number; note_id: string }[];
  const last = new Map<string, number>();
  for (const r of rows) {
    last.delete(r.note_id);
    last.set(r.note_id, r.seq);
  }
  const notes: RenderedNote[] = [];
  const missing: string[] = [];
  for (const id of last.keys()) {
    const n = src.render(id);
    if (n) notes.push(n);
    else missing.push(id);
  }
  const nextAfter = rows.length ? rows[rows.length - 1].seq : after;
  const more = !!db.prepare('SELECT 1 FROM vault_changes WHERE seq > ? LIMIT 1').get(nextAfter);
  return { protocol: VAULT_PROTOCOL, ...meta, latestSeq: latestSeq(db), nextAfter, more, notes, names: namesFor(src, notes), missing };
}

/** Specific notes (pending retries, the rebuild command). `nextAfter` is latestSeq and `more` false. */
export function notesByIds(src: NoteSource, ids: string[], meta: PageMeta): VaultNotesResponse {
  const notes: RenderedNote[] = [];
  const missing: string[] = [];
  for (const id of [...new Set(ids)]) {
    const n = src.render(id);
    if (n) notes.push(n);
    else missing.push(id);
  }
  const seq = latestSeq(src.db);
  return { protocol: VAULT_PROTOCOL, ...meta, latestSeq: seq, nextAfter: seq, more: false, notes, names: namesFor(src, notes), missing };
}
