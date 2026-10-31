/**
 * Cross-company reads: the dashboard, the trade log and the securities "update all prices"
 * refreshes. Set-based: a fixed number of queries however many companies there are.
 */
import type { FrozenOutputs } from '../../domain/calc/engine';
import type { ModelState } from '../../domain/model/types';
import { catalystTiming, expectedWindowEnd, quoteFreshness, thesesDue, type DatePrecision } from '../../domain/portfolio/flags';
import { entryBarIndex, tradeMetrics } from '../../domain/trade/metrics';
import { frozenTargets, probabilityWeightedTarget, targetPriceCurrency, upside } from '../../domain/valuation/targets';
import { isAgentClient, type AgentClient } from '../../shared/actors';
import type { CatalystBrief, DashboardRowDTO, JournalTradeDTO, RevisionKind, SecurityDTO } from '../../shared/api';
import type { DB } from '../db/connection';
import { barsBySecurity } from './market';
import { toSecurity } from './projects';
import { toReview, toTrade, type ReviewRow, type TradeRow } from './records';
import { latestExcerpts } from '../vault/reflections';

// ---------------------------------------------------------------- dashboard

interface ProjectQuoteRow {
  id: string;
  name: string;
  archived_at: string | null;
  updated_at: string;
  sec_id: string | null;
  sec_name: string | null;
  ticker: string | null;
  exchange: string | null;
  api_symbol: string | null;
  currency: string | null;
  price_source: string | null;
  q_price: number | null;
  q_currency: string | null;
  q_as_of: string | null;
  q_fetched_at: string | null;
}

interface HeadRow {
  project_id: string;
  id: string;
  seq: number;
  kind: RevisionKind;
  title: string;
  as_of_date: string | null;
  committed_at: string;
  state_json: string;
  computed_json: string;
}

interface OpenTradeRow {
  id: string;
  project_id: string;
  side: 'long' | 'short';
  entry_date: string;
  entry_price: number;
  quantity: number;
  stop_at_entry: number | null;
  atr_multiple: number | null;
  fees: number;
  sec_currency: string;
  q_price: number | null;
  q_as_of: string | null;
}

interface OpenCatalystRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  expected_date: string | null;
  date_precision: DatePrecision;
}

/** The primary security of a project: same order as listSecurities (projects.ts). */
const PRIMARY_SECURITY = 'SELECT s2.id FROM securities s2 WHERE s2.project_id = p.id ORDER BY s2.is_primary DESC, s2.ticker LIMIT 1';

const byProject = <T extends { project_id: string }>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.project_id, [...(m.get(r.project_id) ?? []), r]);
  return m;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const firstLine = (md: string | null) => {
  const line = md?.split('\n').map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 140) : null;
};

export interface DashboardOptions {
  now: Date;
  /** Local date the date flags are computed for. */
  today: string;
  staleAfterMs: number;
  /** Price sources with generated prices (demo). */
  synthetic: Set<string>;
}

export function buildDashboard(db: DB, o: DashboardOptions): DashboardRowDTO[] {
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.archived_at, p.updated_at,
         s.id AS sec_id, s.name AS sec_name, s.ticker, s.exchange, s.api_symbol, s.currency, s.price_source,
         q.price AS q_price, q.currency AS q_currency, q.as_of AS q_as_of, q.fetched_at AS q_fetched_at
       FROM projects p
       LEFT JOIN securities s ON s.id = (${PRIMARY_SECURITY})
       LEFT JOIN quotes q ON q.security_id = s.id AND q.provider = s.price_source
       ORDER BY p.archived_at IS NOT NULL, p.updated_at DESC`,
    )
    .all() as ProjectQuoteRow[];
  const heads = new Map(
    (
      db
        .prepare(
          `SELECT r.project_id, r.id, r.seq, r.kind, r.title, r.as_of_date, r.committed_at, r.state_json, r.computed_json
           FROM revisions r JOIN (SELECT project_id, MAX(seq) AS seq FROM revisions GROUP BY project_id) h
             ON h.project_id = r.project_id AND h.seq = r.seq`,
        )
        .all() as HeadRow[]
    ).map((r) => [r.project_id, r]),
  );
  const drafts = new Map(
    (db.prepare('SELECT project_id, state_json, updated_at FROM drafts').all() as { project_id: string; state_json: string; updated_at: string }[]).map((r) => [r.project_id, r]),
  );
  const trades = byProject(
    db
      .prepare(
        `SELECT t.id, t.project_id, t.side, t.entry_date, t.entry_price, t.quantity, t.stop_at_entry, t.atr_multiple, t.fees,
           s.currency AS sec_currency, q.price AS q_price, q.as_of AS q_as_of
         FROM trades t JOIN securities s ON s.id = t.security_id
         LEFT JOIN quotes q ON q.security_id = t.security_id AND q.provider = s.price_source
         WHERE t.exit_date IS NULL ORDER BY t.entry_date`,
      )
      .all() as OpenTradeRow[],
  );
  const catalysts = byProject(
    db.prepare("SELECT id, project_id, title, status, expected_date, date_precision FROM catalysts WHERE status IN ('upcoming','delayed')").all() as OpenCatalystRow[],
  );
  // latest AI session per company, and latest AI write in the audit log (agent actors only)
  const sessions = new Map(
    (
      db
        .prepare(
          `SELECT project_id, client, last_at, summary_md FROM (
             SELECT j.value AS project_id, s.client, s.last_at, s.summary_md,
                    ROW_NUMBER() OVER (PARTITION BY j.value ORDER BY s.last_at DESC) AS rn
             FROM ai_sessions s, json_each(s.project_ids_json) j) WHERE rn = 1`,
        )
        .all() as { project_id: string; client: string; last_at: string; summary_md: string | null }[]
    ).map((r) => [r.project_id, r]),
  );
  const audits = new Map(
    (
      db
        .prepare(
          `SELECT project_id, substr(actor, 7) AS client, MAX(at) AS at FROM audit_log
           WHERE project_id IS NOT NULL AND actor LIKE 'agent:%' GROUP BY project_id`,
        )
        .all() as { project_id: string; client: string; at: string }[]
    ).map((r) => [r.project_id, r]),
  );

  return projects.map((p): DashboardRowDTO => {
    const head = heads.get(p.id);
    const headState = head ? (JSON.parse(head.state_json) as ModelState) : null;
    const draft = drafts.get(p.id);
    let draftState = headState;
    let draftDirty = false;
    if (draft && head && draft.state_json !== head.state_json) {
      draftState = JSON.parse(draft.state_json) as ModelState;
      draftDirty = JSON.stringify(draftState) !== JSON.stringify(headState);
    } else if (draft && !head) {
      draftState = JSON.parse(draft.state_json) as ModelState;
    }

    const security = p.sec_id
      ? { id: p.sec_id, name: p.sec_name!, ticker: p.ticker!, exchange: p.exchange!, apiSymbol: p.api_symbol!, currency: p.currency!, priceSource: p.price_source! }
      : null;
    let price: DashboardRowDTO['price'] = null;
    if (security && p.q_price !== null && p.q_as_of && p.q_fetched_at) {
      const f = quoteFreshness({ asOf: p.q_as_of, fetchedAt: p.q_fetched_at }, o.now, o.today, o.staleAfterMs);
      price = {
        value: p.q_price,
        currency: p.q_currency ?? security.currency,
        asOf: p.q_as_of,
        fetchedAt: p.q_fetched_at,
        provider: security.priceSource,
        synthetic: o.synthetic.has(security.priceSource),
        stale: f.stale,
        marketDate: f.marketDate!,
        lagDays: f.lagDays ?? 0,
      };
    }

    // targets from the committed head, never from the draft
    const tps = headState && head ? frozenTargets(headState, JSON.parse(head.computed_json) as FrozenOutputs) : { bear: null, base: null, bull: null };
    const w = probabilityWeightedTarget(tps, headState?.valuation.probabilities ?? { bear: null, base: null, bull: null });
    const tpCurrency = headState ? targetPriceCurrency(headState) : null;
    const priceCurrency = price?.currency ?? security?.currency ?? null;
    const currencyMismatch = !!tpCurrency && !!priceCurrency && tpCurrency.toUpperCase() !== priceCurrency.toUpperCase();
    const px = price?.value ?? null;

    const open = (trades.get(p.id) ?? []).map((t) => ({
      t,
      m: tradeMetrics(
        { side: t.side, entryDate: t.entry_date, entryPrice: t.entry_price, quantity: t.quantity, stopAtEntry: t.stop_at_entry, atrMultiple: t.atr_multiple, exitDate: null, exitPrice: null, fees: t.fees },
        [],
        { quote: t.q_price !== null && t.q_as_of ? { price: t.q_price, asOf: t.q_as_of } : null },
      ),
    }));
    const rs = open.map((x) => x.m.rMultiple).filter((r): r is number => r !== null);
    const pnl = new Map<string, number>();
    for (const { t, m } of open) if (m.pnl !== null) pnl.set(t.sec_currency, (pnl.get(t.sec_currency) ?? 0) + m.pnl);

    let upcoming = 0;
    let undated = 0;
    let overdue = 0;
    let next: CatalystBrief | null = null;
    let oldestOverdue: CatalystBrief | null = null;
    for (const c of catalysts.get(p.id) ?? []) {
      const timing = catalystTiming({ status: c.status, expectedDate: c.expected_date, datePrecision: c.date_precision }, o.today);
      if (timing === 'undated' || !c.expected_date) {
        undated++;
        continue;
      }
      const brief: CatalystBrief = { id: c.id, title: c.title, expectedDate: c.expected_date, datePrecision: c.date_precision, windowEnd: expectedWindowEnd(c.expected_date, c.date_precision) };
      if (timing === 'overdue') {
        overdue++;
        if (!oldestOverdue || brief.windowEnd < oldestOverdue.windowEnd) oldestOverdue = brief;
      } else if (timing === 'upcoming') {
        upcoming++;
        if (!next || brief.windowEnd < next.windowEnd) next = brief;
      }
    }

    const theses = draftState?.theses ?? [];
    const due = thesesDue(theses, o.today);
    const ahead = theses
      .filter((th) => th.status === 'active' && typeof th.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(th.reviewBy) && th.reviewBy > o.today)
      .map((th) => th.reviewBy!)
      .sort();

    return {
      projectId: p.id,
      name: p.name,
      archivedAt: p.archived_at,
      updatedAt: p.updated_at,
      security,
      price,
      target: {
        currency: tpCurrency,
        bear: tps.bear,
        base: tps.base,
        bull: tps.bull,
        weighted: w.value,
        weightSum: w.weightSum,
        upsideBase: currencyMismatch ? null : upside(tps.base, px),
        upsideWeighted: currencyMismatch ? null : upside(w.value, px),
        currencyMismatch,
      },
      research:
        head && head.as_of_date
          ? { revisionId: head.id, seq: head.seq, kind: head.kind, title: head.title, asOfDate: head.as_of_date, committedAt: head.committed_at }
          : null,
      draftDirty,
      draftUpdatedAt: draft?.updated_at ?? null,
      positions: {
        open: open.length,
        avgR: mean(rs),
        rCount: rs.length,
        pnl: [...pnl].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, value })),
        items: open.map(({ t, m }) => ({
          tradeId: t.id,
          side: t.side,
          entryDate: t.entry_date,
          entryPrice: t.entry_price,
          quantity: t.quantity,
          rMultiple: m.rMultiple,
          returnPct: m.returnPct,
          markSource: m.markSource,
        })),
      },
      catalysts: { upcoming, undated, overdue, next, oldestOverdue },
      theses: { reviewDue: due.length, nextReviewBy: ahead[0] ?? null },
      ai: latestAi(sessions.get(p.id), audits.get(p.id)),
    };
  });
}

/** The newer of the latest AI session (with its summary) and the latest AI write in the audit log. */
function latestAi(
  s: { client: string; last_at: string; summary_md: string | null } | undefined,
  a: { client: string; at: string } | undefined,
): DashboardRowDTO['ai'] {
  const fromSession = s && isAgentClient(s.client) ? { client: s.client as AgentClient, at: s.last_at, summary: firstLine(s.summary_md) } : null;
  const fromAudit = a && isAgentClient(a.client) ? { client: a.client as AgentClient, at: a.at, summary: null } : null;
  if (fromSession && fromAudit) return fromAudit.at > fromSession.at ? fromAudit : fromSession;
  return fromSession ?? fromAudit;
}

// ---------------------------------------------------------------- trade log

export interface JournalFilter {
  status: 'all' | 'open' | 'closed';
  projectId?: string;
  /** Entry date range (inclusive). */
  from?: string;
  to?: string;
}

type JournalRow = TradeRow & {
  project_name: string;
  project_archived_at: string | null;
  ticker: string;
  exchange: string;
  sec_name: string;
  sec_currency: string;
  price_source: string;
  q_price: number | null;
  q_as_of: string | null;
  rev_seq: number | null;
  rev_title: string | null;
  rev_as_of: string | null;
  rev_kind: RevisionKind | null;
};

/** All trades across companies, newest entry first, with metrics from each security's own cached prices. */
export function listJournalTrades(db: DB, f: JournalFilter, o: { synthetic: Set<string> }): JournalTradeDTO[] {
  const rows = db
    .prepare(
      `SELECT t.*, p.name AS project_name, p.archived_at AS project_archived_at,
         s.ticker, s.exchange, s.name AS sec_name, s.currency AS sec_currency, s.price_source,
         q.price AS q_price, q.as_of AS q_as_of,
         r.seq AS rev_seq, r.title AS rev_title, r.as_of_date AS rev_as_of, r.kind AS rev_kind
       FROM trades t JOIN projects p ON p.id = t.project_id JOIN securities s ON s.id = t.security_id
       LEFT JOIN quotes q ON q.security_id = t.security_id AND q.provider = s.price_source
       LEFT JOIN revisions r ON r.id = t.revision_id
       WHERE (@status = 'all' OR (@status = 'open' AND t.exit_date IS NULL) OR (@status = 'closed' AND t.exit_date IS NOT NULL))
         AND (@projectId IS NULL OR t.project_id = @projectId)
         AND (@from IS NULL OR t.entry_date >= @from) AND (@to IS NULL OR t.entry_date <= @to)
       ORDER BY t.entry_date DESC, t.created_at DESC`,
    )
    .all({ status: f.status, projectId: f.projectId ?? null, from: f.from ?? null, to: f.to ?? null }) as JournalRow[];
  if (!rows.length) return [];
  const bars = barsBySecurity(db, [...new Set(rows.map((r) => r.security_id))]);
  const reviews = new Map<string, ReturnType<typeof toReview>[]>();
  const reviewRows = db
    .prepare("SELECT * FROM reviews WHERE subject_type = 'trade' AND subject_id IN (SELECT value FROM json_each(?)) ORDER BY created_at")
    .all(JSON.stringify(rows.map((r) => r.id))) as ReviewRow[];
  for (const r of reviewRows) reviews.set(r.subject_id!, [...(reviews.get(r.subject_id!) ?? []), toReview(r)]);
  const reflections = latestExcerpts(db, rows.map((r) => r.id));

  return rows.map((r): JournalTradeDTO => {
    const trade = toTrade(r);
    const b = bars.get(r.security_id) ?? [];
    return {
      ...trade,
      project: { id: r.project_id, name: r.project_name, archived: r.project_archived_at !== null },
      security: { ticker: r.ticker, exchange: r.exchange, name: r.sec_name, currency: r.sec_currency, priceSource: r.price_source, synthetic: o.synthetic.has(r.price_source) },
      metrics: tradeMetrics(trade, b, { quote: r.q_price !== null && r.q_as_of ? { price: r.q_price, asOf: r.q_as_of } : null }),
      barsCoverEntry: entryBarIndex(b, trade.entryDate) >= 0,
      research:
        r.revision_id && r.rev_seq !== null
          ? { revisionId: r.revision_id, seq: r.rev_seq, title: r.rev_title ?? '', asOfDate: r.rev_as_of, kind: r.rev_kind ?? 'update' }
          : null,
      reviews: (reviews.get(r.id) ?? []).map((v) => ({
        id: v.id,
        title: v.title,
        thesisVerdict: v.thesisVerdict,
        executionVerdict: v.executionVerdict,
        categories: v.categories.map((c) => c.category),
        createdAt: v.createdAt,
      })),
      reflection: reflections.get(r.id) ?? null,
    };
  });
}

// ---------------------------------------------------------------- update all prices

/**
 * What "update all prices" refreshes: the primary security of every active company, plus any
 * security with an open trade (also in an archived company). Most recently updated first.
 */
export function refreshTargets(db: DB): (SecurityDTO & { projectName: string })[] {
  const rows = db
    .prepare(
      `SELECT s.*, p.name AS project_name FROM securities s JOIN projects p ON p.id = s.project_id
       WHERE (p.archived_at IS NULL AND s.id = (${PRIMARY_SECURITY}))
          OR EXISTS (SELECT 1 FROM trades t WHERE t.security_id = s.id AND t.exit_date IS NULL)
       ORDER BY p.updated_at DESC, s.is_primary DESC, s.ticker`,
    )
    .all() as (Parameters<typeof toSecurity>[0] & { project_name: string })[];
  return rows.map((r) => ({ ...toSecurity(r), projectName: r.project_name }));
}
