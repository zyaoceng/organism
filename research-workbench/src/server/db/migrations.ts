import type Database from 'better-sqlite3';

/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped; add a new one.
 * Keep docs/DATA_MODEL.md in sync.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
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
  name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  exchange TEXT NOT NULL,
  api_symbol TEXT NOT NULL,
  currency TEXT NOT NULL,
  price_source TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX securities_project ON securities(project_id);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  parent_id TEXT REFERENCES revisions(id),
  kind TEXT NOT NULL CHECK (kind IN ('initial','update','checkpoint','restore')),
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  as_of_date TEXT,
  committed_at TEXT NOT NULL,
  state_json TEXT NOT NULL,
  computed_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  market_json TEXT,
  engine_version TEXT NOT NULL,
  UNIQUE (project_id, seq)
);

-- Revisions are immutable snapshots.
CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions
BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions
BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;

CREATE TABLE drafts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  state_json TEXT NOT NULL,
  base_revision_id TEXT NOT NULL REFERENCES revisions(id),
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  url TEXT,
  published_at TEXT,
  added_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  verification TEXT,
  archived_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX evidence_project ON evidence(project_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_sha ON attachments(sha256);

CREATE TABLE evidence_attachments (
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (evidence_id, attachment_id)
);

CREATE TABLE revision_evidence (
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  kind TEXT NOT NULL CHECK (kind IN ('cited','linked')),
  PRIMARY KEY (revision_id, evidence_id, kind)
);
CREATE INDEX revision_evidence_ev ON revision_evidence(evidence_id);

CREATE TABLE catalysts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  expected_date TEXT,
  date_precision TEXT NOT NULL DEFAULT 'day',
  actual_date TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming',
  expected_outcome TEXT NOT NULL DEFAULT '',
  actual_outcome TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  node_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  revision_id TEXT REFERENCES revisions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX catalysts_project ON catalysts(project_id);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  security_id TEXT NOT NULL REFERENCES securities(id),
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  quantity REAL NOT NULL,
  entry_reason TEXT NOT NULL DEFAULT '',
  target_price_at_entry REAL,
  stop_at_entry REAL,
  atr_at_entry REAL,
  atr_multiple REAL,
  revision_id TEXT REFERENCES revisions(id),
  exit_date TEXT,
  exit_price REAL,
  exit_reason TEXT NOT NULL DEFAULT '',
  fees REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX trades_project ON trades(project_id);

CREATE TABLE price_bars (
  security_id TEXT NOT NULL REFERENCES securities(id),
  provider TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
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
  as_of TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (security_id, provider)
);

CREATE TABLE market_fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  categories_json TEXT NOT NULL DEFAULT '[]',
  thesis_verdict TEXT,
  execution_verdict TEXT,
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
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);
`,
  },
];

export function migrate(db: Database.Database): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
    })();
    ran.push(m.version);
  }
  return ran;
}
