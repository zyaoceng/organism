# Research Workbench — Data Model

Two families of data (see `ARCHITECTURE.md` §6):

1. **Research state** — one JSON document per project, versioned. Lives in
   `drafts.state_json` (mutable working copy) and `revisions.state_json`
   (immutable). Validated by the zod schema in `src/domain/model/schema.ts`.
2. **Relational records** — SQLite tables for things with their own
   lifecycle.

Keep this file in sync with `src/domain/model/types.ts`,
`src/domain/model/schema.ts` and `src/server/db/migrations.ts`.

---

## 1. Research state (`ModelState`, schema version 1)

```ts
type ScenarioId = 'bear' | 'base' | 'bull';
type PeriodKey = string;            // a Period.id, or '_' for scalar nodes

interface ModelState {
  schemaVersion: 1;
  periods: Period[];                // ordered, one frequency per model
  nodes: ModelNode[];               // flat; hierarchy via parentId, sibling order = array order
  links: EvidenceLink[];            // evidence ↔ node relations (versioned)
  theses: Thesis[];
  valuation: ValuationContext;
}

interface Period {
  id: string;                       // canonical, stable: 'FY2028', 'FY2028Q1'
  label: string;                    // display: '2028'
  status: 'A' | 'E';                // Actual / Estimate
  endDate?: string;                 // ISO date of period end (optional)
}

interface Unit {
  kind: 'currency' | 'per_share' | 'percent' | 'multiple' | 'shares' | 'count' | 'number';
  currency?: string;                // ISO code for currency / per_share: 'TWD', 'USD'
  scale: 1 | 1e3 | 1e6 | 1e8 | 1e9; // 1e8 = 億 (hundred million)
  label?: string;                   // free text for count/number: 'units', 'GW', 'subscribers'
}

interface ModelNode {
  id: string;                       // 'n_' + 8 random base-36 chars; never reused
  name: string;
  parentId: string | null;          // null = top level
  timeMode: 'series' | 'scalar';
  unit: Unit | null;                // null for pure headings
  role?: NodeRole;                  // optional, unique per model
  formula?: string;                 // STORED form: '{n_ab12cd34} * (1 + {n_x}) ', '{n_eps}@FY2028 * {n_pe}'
  values: Record<PeriodKey, number>;                            // base (shared) values
  overrides: Partial<Record<'bear' | 'bull', Record<PeriodKey, number>>>;
  cellStatus: Record<string, 'A' | 'E'>;                        // per-cell status override
  notes: string;
}

type NodeRole = 'eps' | 'revenue' | 'gross_margin' | 'operating_income' | 'net_income'
  | 'diluted_shares' | 'eps_growth' | 'roic' | 'reinvestment_roi'
  | 'target_multiple' | 'target_price' | 'rerating';

interface EvidenceLink {
  id: string;
  evidenceId: string;               // → evidence.id
  nodeId: string;                   // → ModelNode.id
  relation: 'supports' | 'contradicts' | 'context' | 'triggered';
  locator?: string;                 // 'p.13', 'slide 7', '00:34:10'
  note?: string;
}

interface Thesis {
  id: string;
  statement: string;
  invalidation: string;             // conditions that would prove it wrong
  nodeIds: string[];
  status: 'active' | 'confirmed' | 'invalidated' | 'retired';
  reviewBy?: string;                // ISO date
}

interface ValuationContext {
  peers: Peer[];
  historicalPE: { low?: number; median?: number; high?: number; window?: string;
                  source?: string; asOf?: string; note?: string };
  rationale: Record<ScenarioId, string>;      // why this target multiple
  probabilities: Record<ScenarioId, number | null>;
}

interface Peer {
  id: string; name: string; ticker?: string;
  pe?: number; epsGrowth?: number; roic?: number; grossMargin?: number;
  basis?: string;                   // 'FY2027E', 'NTM'
  source?: string; asOf?: string; note?: string;
}
```

### Invariants (enforced by schema + `validateState`)

- Node IDs unique; `parentId` refers to an existing node; no hierarchy cycles.
- Period IDs unique and match `^[A-Za-z0-9_]+$`.
- `values`/`overrides` keys are existing period IDs (series) or `_` (scalar).
- Overrides exist only for estimate cells.
- At most one node per role.
- Links reference existing nodes (evidence existence is checked by the
  server).
- Formulas are stored only if they parse and create no cycle.

### Value resolution

`value(node, period, scenario)`:
override (Bear/Bull, estimate cells only) → base value → formula → empty.

### Frozen outputs (`revisions.computed_json`)

```ts
interface FrozenOutputs {
  engineVersion: string;
  values: Record<ScenarioId, Record<NodeId, Record<PeriodKey, number | null>>>;
  est:    Record<NodeId, Record<PeriodKey, boolean>>;   // estimate flag (base scenario)
}
```

### Change set (`revisions.changes_json`)

A list of `ModelChange` (see `src/domain/revision/diff.ts`):
`node_added, node_removed, node_renamed, node_moved, children_reordered,
node_unit, node_role, node_time_mode, formula_changed, value_changed
(scenario = base|bear|bull), cell_status_changed, notes_changed,
period_added, period_removed, period_changed, link_added, link_removed,
link_changed, thesis_added, thesis_removed, thesis_changed,
valuation_changed`.

### Impact (`revisions.impact_json`)

```ts
interface Impact {
  basisPeriodId: string | null;          // EPS period used by the target-price formula
  headline: {
    eps: { periodId; scenario; before; after }[];     // every estimate period × scenario
    targetPrice: { scenario; before; after }[];
    targetMultiple: { scenario; before; after }[];
  };
  nodes: { nodeId; name; direct: boolean;
           cells: { scenario; periodKey; before; after }[] }[];   // dependency order
  attribution: { nodeId; name; eps: Record<ScenarioId, number|null>;
                 targetPrice: Record<ScenarioId, number|null>; note?: string }[];
  residual: { eps: Record<ScenarioId, number|null>; targetPrice: Record<ScenarioId, number|null> };
}
```

---

## 2. Relational schema (SQLite)

All IDs are text. Dates are ISO strings (`YYYY-MM-DD`); timestamps are ISO
date-times in UTC.

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE securities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,              -- 'Lite-On Technology'
  ticker TEXT NOT NULL,            -- '2301'
  exchange TEXT NOT NULL,          -- 'TWSE'
  api_symbol TEXT NOT NULL,        -- '2301.TW'
  currency TEXT NOT NULL,          -- 'TWD'
  price_source TEXT NOT NULL,      -- provider id used for chart/quote: 'yahoo' | 'demo' | 'csv'
  is_primary INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE drafts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  state_json TEXT NOT NULL,
  base_revision_id TEXT NOT NULL REFERENCES revisions(id),
  version INTEGER NOT NULL,        -- optimistic lock
  updated_at TEXT NOT NULL
);

CREATE TABLE revisions (           -- insert-only
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,            -- 1, 2, 3 … per project
  parent_id TEXT REFERENCES revisions(id),
  kind TEXT NOT NULL,              -- initial | update | checkpoint | restore
  title TEXT NOT NULL,
  reason TEXT NOT NULL,            -- interpretation: why the view changed
  notes TEXT NOT NULL DEFAULT '',
  as_of_date TEXT,                 -- knowledge date; NULL only for kind='initial'
  committed_at TEXT NOT NULL,      -- system time
  state_json TEXT NOT NULL,        -- full snapshot
  computed_json TEXT NOT NULL,     -- frozen outputs
  changes_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  market_json TEXT,                -- {price, currency, asOf, provider, fetchedAt} or NULL
  engine_version TEXT NOT NULL,
  UNIQUE (project_id, seq)
);
-- Triggers revisions_no_update / revisions_no_delete abort any UPDATE or DELETE:
-- snapshots are immutable at the database level, not only in application code.

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',   -- publisher / author / speaker
  source_type TEXT NOT NULL,              -- news | earnings_call | filing | broker_report | industry_report
                                          -- | presentation | customer_announcement | conversation | expert
                                          -- | dataset | screenshot | other
  url TEXT,
  published_at TEXT,                      -- date the information became public
  added_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',         -- excerpt / what it says
  verification TEXT,                      -- optional: unverified | verified | disputed
  archived_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE attachments (                -- immutable
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,              -- 'ab/ab12…' relative to attachments dir
  created_at TEXT NOT NULL
);

CREATE TABLE evidence_attachments (
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (evidence_id, attachment_id)
);

CREATE TABLE revision_evidence (
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  kind TEXT NOT NULL,                     -- cited | linked
  PRIMARY KEY (revision_id, evidence_id, kind)
);

CREATE TABLE catalysts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL,                     -- earnings | investor_day | conference | product_launch
                                          -- | customer_qualification | factory_ramp | regulatory | other
  expected_date TEXT,
  date_precision TEXT NOT NULL DEFAULT 'day',   -- day | month | quarter
  actual_date TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming',      -- upcoming | occurred | delayed | cancelled
  expected_outcome TEXT NOT NULL DEFAULT '',
  actual_outcome TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  node_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  revision_id TEXT REFERENCES revisions(id),    -- the update it caused (model impact)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  security_id TEXT NOT NULL REFERENCES securities(id),
  side TEXT NOT NULL,                     -- long | short
  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  quantity REAL NOT NULL,
  entry_reason TEXT NOT NULL DEFAULT '',
  target_price_at_entry REAL,
  stop_at_entry REAL,
  atr_at_entry REAL,
  atr_multiple REAL,
  revision_id TEXT REFERENCES revisions(id),     -- research snapshot valid on entry_date
  exit_date TEXT,
  exit_price REAL,
  exit_reason TEXT NOT NULL DEFAULT '',
  fees REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE price_bars (
  security_id TEXT NOT NULL REFERENCES securities(id),
  provider TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL,
  adj_close REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (security_id, provider, date)
);

CREATE TABLE quotes (
  security_id TEXT NOT NULL REFERENCES securities(id),
  provider TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT,
  as_of TEXT NOT NULL,                    -- provider's market time
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (security_id, provider)
);

CREATE TABLE market_fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- quote | history | csv_import
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,                   -- ok | error
  message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE notes (                      -- project journal
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reviews (                    -- post-mortems
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_type TEXT NOT NULL,             -- project | revision | trade | thesis | catalyst
  subject_id TEXT,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',       -- what actually happened
  categories_json TEXT NOT NULL DEFAULT '[]',   -- [{category, notes}]
  thesis_verdict TEXT,                    -- right | wrong | mixed | unclear
  execution_verdict TEXT,                 -- good | poor | mixed | n/a
  lessons TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  entity TEXT NOT NULL,                   -- evidence | catalyst | trade | note | review | security | project
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,                   -- update | delete | archive (v2 adds more, §2a)
  at TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT
);

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
```

The statements above are migration 1 (schema v1). Later migrations only add
to it; see §2a.

Review error categories (fixed list, user-selected):
`evidence_quality, evidence_interpretation, assumption_magnitude,
model_formula, timing_catalyst, valuation_multiple, trading_execution,
risk_management`.

---

## 2a. Migration v2: who did what (AI connection)

`migrations.ts` exports `SCHEMA_VERSION` (the highest migration); tests compare
against it. Before migrating an existing database the server copies it to
`backups/pre-v<N>-<time>.db`.

Added columns are nullable. Rows written before v2 keep `NULL` and are shown as
“before v2” (「v2 之前」); nothing is backfilled, because revisions are
immutable.

**Actors.** `audit_log.actor`, every `*.created_by`, `draft_ops.actor` and
`revision_annotations.actor` hold `user`, `system` (seeding, CLIs, background
work) or `agent:<client>` with client `claude-desktop`, `claude-code` or
`chatgpt` (`src/shared/actors.ts`). A request whose caller cannot be
identified may read but not write (401 `NO_ACTOR`), so `unknown` is never
stored. Bare client ids appear only in `ai_sessions.client` and
`ai_clients.client`. The browser is identified by an HttpOnly cookie from
`GET /api/session`; AI clients send a Bearer token from
`<dataDir>/tokens.json` (created by the server, mode 0600). This records who
acted; it is not security: any program of the same macOS user can read the
file.

```sql
ALTER TABLE audit_log ADD COLUMN actor TEXT;
ALTER TABLE revisions ADD COLUMN created_by TEXT;        -- who committed it
ALTER TABLE revisions ADD COLUMN contributors_json TEXT; -- [{actor, changes}]: who made its draft edits
ALTER TABLE evidence ADD COLUMN created_by TEXT;
ALTER TABLE evidence ADD COLUMN published_at_source TEXT CHECK (published_at_source IN ('user','agent-asserted'));
ALTER TABLE catalysts ADD COLUMN created_by TEXT;
ALTER TABLE trades ADD COLUMN created_by TEXT;
ALTER TABLE trades ADD COLUMN source TEXT CHECK (source IN ('entry','import'));
ALTER TABLE trades ADD COLUMN external_ref TEXT;         -- 'jrnl:' + sha256(normalised excerpt)[0:32]
ALTER TABLE trades ADD COLUMN source_text TEXT;          -- the normalised journal excerpt
ALTER TABLE notes ADD COLUMN created_by TEXT;
ALTER TABLE reviews ADD COLUMN created_by TEXT;
CREATE UNIQUE INDEX trades_external_ref ON trades(external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX audit_project ON audit_log(project_id, id);

CREATE TABLE draft_ops (                  -- every write to a draft
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  base_revision_id TEXT NOT NULL REFERENCES revisions(id),
  version_after INTEGER NOT NULL,          -- drafts.version after the write
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- save | ops | discard | restore | recover | commit
  op_json TEXT NOT NULL,                   -- AI ops and rationale, or {type, revisionId|opId}
  changes_json TEXT NOT NULL DEFAULT '[]', -- ModelChange[] of this write
  before_json TEXT,                        -- full draft state before it (recovery)
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX draft_ops_project ON draft_ops(project_id, base_revision_id, id);

CREATE TABLE ai_sessions (                -- one AI client's writes until 30 idle minutes
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,                    -- claude-desktop | claude-code | chatgpt
  project_ids_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]', -- [{at, tool, kind, projectId, ref, summary}], last 500
  summary_md TEXT, decisions_md TEXT, todo_md TEXT,  -- save_session_summary
  summary_at TEXT
);
CREATE INDEX ai_sessions_client ON ai_sessions(client, last_at);

CREATE TABLE ai_clients (                 -- connection status (settings page, diagnostics)
  client TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,              -- any request (written at most once a minute)
  last_heartbeat_at TEXT,                  -- MCP adapter start / every 10 minutes
  client_name TEXT, client_version TEXT, adapter_version TEXT
);

CREATE TABLE revision_annotations (       -- insert-only marks on committed updates
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                      -- excluded | included | note
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX revision_annotations_rev ON revision_annotations(revision_id, id);

CREATE TABLE db_meta (                    -- exactly one row
  id INTEGER PRIMARY KEY CHECK (id = 1),
  db_generation TEXT NOT NULL,             -- 32 hex; rotated by the data import
  created_at TEXT NOT NULL
);
```

Rules that go with these tables:

- **Audit.** `audit_log.action` is now `create | update | delete | archive |
  unarchive | draft_op | commit`; every create is audited (`after_json` is the
  new record). Draft writes other than browser saves add a `draft_op` row, and
  each commit a `commit` row (`entity='revision'`).
- **Draft attribution.** A pending change (head → draft) belongs to the last
  `draft_ops` row since the draft's base whose `changes_json` touches the same
  field (`src/domain/revision/changeKey.ts`). Changes with no such row (edits
  made before v2) count as the user's. An AI may not commit or discard the
  user's pending changes (409 `USER_CHANGES`).
- **Saves.** Browser autosaves by the same person within 10 minutes share one
  `save` row (its `before_json` is the state before the burst). The
  `before_json` of `save` and `ops` rows is dropped after 90 days; discard,
  restore and recover rows keep theirs, so a discarded draft can be recovered
  (`POST /api/projects/:id/draft/recover`).
- **Committed price.** `revisions.market_json` gains `basis`: `quote` (the
  latest quote, knowledge date today) or `bar` (the close of the last daily bar
  on or before a backdated knowledge date, at most 7 days earlier; otherwise no
  price).
- **Evidence dates.** An AI must give a publication date, never in the future;
  it is stored with `published_at_source = 'agent-asserted'` and shown with a
  badge. A date set by the user is `user`.
- **Imported trades.** `external_ref` is unique across all companies, so the
  same journal excerpt imported again returns the existing trade (`status:
  'existing'`). Re-importing an excerpt whose trade was deleted needs
  `allowReimport` (409 `IMPORT_DELETED` otherwise). Imported trades store only
  the numbers in the journal: no default target, ATR or stop.
- **Exclusions.** The latest `excluded`/`included` annotation of a revision
  decides whether it is left out of the estimate history and calibration
  (`RevisionMeta.excludedFromCalibration`, `SeriesPoint.excluded`). The
  revision itself is never changed.
- **Generation.** `dbGeneration` is read on every request; a save from a page
  opened before the database was replaced is refused (409 `DB_GENERATION`) and
  the page reloads.

---

## 3. Point-in-time queries

| Question | Query |
|---|---|
| What did I believe on date D? | Latest revision with `as_of_date ≤ D` → `state_json`. |
| FY28 EPS estimate over time | `computed_json.values[s][epsNode]['FY2028']` for every revision, x-axis `as_of_date`. |
| When did assumption X change and why? | Revisions whose `changes_json` mention node X → `title`, `reason`, cited evidence. |
| Which sources supported X on date D? | `links` for X in the state of the revision valid on D. |
| Research state behind a trade | `trades.revision_id` (resolved by `entry_date`). |
| Who wrote this, and which AI changed the draft? | `created_by` / `audit_log.actor`; `draft_ops` per project. |

## 4. Project JSON export

`GET /api/projects/:id/export` returns:

```json
{
  "format": "research-workbench/project",
  "formatVersion": 1,
  "exportedAt": "…",
  "project": {}, "securities": [], "draft": {}, "revisions": [],
  "evidence": [], "attachments": [], "catalysts": [], "trades": [],
  "notes": [], "reviews": [], "auditLog": []
}
```

Attachment rows include `sha256` and `original_filename`; the files
themselves are in `data/attachments/` and can be bundled separately.
