import type Database from 'better-sqlite3';

/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped; add a new one.
 * Keep docs/DATA_MODEL.md in sync.
 *
 * v3 adds SQLite triggers (vault_*) that queue Obsidian notes in vault_changes whenever a synced
 * table changes. A future migration that rebuilds one of those tables (CREATE new, copy, DROP old,
 * RENAME) drops its triggers with it and must create them again.
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
  {
    version: 2,
    name: 'AI connection: actors, draft ops, AI sessions',
    sql: `
-- Added columns are nullable; rows written before v2 keep NULL (shown as "before v2").
-- Never backfill with UPDATE: revisions are immutable (revisions_no_update).
ALTER TABLE audit_log ADD COLUMN actor TEXT;
ALTER TABLE revisions ADD COLUMN created_by TEXT;
ALTER TABLE revisions ADD COLUMN contributors_json TEXT;
ALTER TABLE evidence ADD COLUMN created_by TEXT;
ALTER TABLE evidence ADD COLUMN published_at_source TEXT CHECK (published_at_source IN ('user','agent-asserted'));
ALTER TABLE catalysts ADD COLUMN created_by TEXT;
ALTER TABLE trades ADD COLUMN created_by TEXT;
ALTER TABLE trades ADD COLUMN source TEXT CHECK (source IN ('entry','import'));
ALTER TABLE trades ADD COLUMN external_ref TEXT;
ALTER TABLE trades ADD COLUMN source_text TEXT;
ALTER TABLE notes ADD COLUMN created_by TEXT;
ALTER TABLE reviews ADD COLUMN created_by TEXT;
CREATE UNIQUE INDEX trades_external_ref ON trades(external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX audit_project ON audit_log(project_id, id);

-- Every write to a draft (browser saves, discards, restores, AI operations), with the state before it.
CREATE TABLE draft_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  base_revision_id TEXT NOT NULL REFERENCES revisions(id),
  version_after INTEGER NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('save','ops','discard','restore','recover','commit')),
  op_json TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '[]',
  before_json TEXT,
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX draft_ops_project ON draft_ops(project_id, base_revision_id, id);

-- Writes of one AI client grouped into sessions (a gap of 30 minutes starts a new one).
CREATE TABLE ai_sessions (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  project_ids_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  summary_md TEXT,
  decisions_md TEXT,
  todo_md TEXT,
  summary_at TEXT
);
CREATE INDEX ai_sessions_client ON ai_sessions(client, last_at);

CREATE TABLE ai_clients (
  client TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  client_name TEXT,
  client_version TEXT,
  adapter_version TEXT
);

-- Insert-only marks on committed Research Updates (e.g. "wrong, exclude from calibration").
CREATE TABLE revision_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('excluded','included','note')),
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX revision_annotations_rev ON revision_annotations(revision_id, id);

-- A random id that changes when the whole database is replaced (data import), so open tabs reload.
CREATE TABLE db_meta (id INTEGER PRIMARY KEY CHECK (id = 1), db_generation TEXT NOT NULL, created_at TEXT NOT NULL);
INSERT INTO db_meta (id, db_generation, created_at) VALUES (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`,
  },
  {
    version: 3,
    name: 'Obsidian sync: note change queue, reflections',
    sql: `
-- Notes to (re)write in the Obsidian vault, in order. Filled by the vault_* triggers below, so every
-- write path (browser, AI, seeding, data import) is covered in the same transaction as the write.
CREATE TABLE vault_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  note_kind TEXT NOT NULL CHECK (note_kind IN ('company','research_update','trade','ai_session','index')),
  note_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  at TEXT NOT NULL,
  -- a deleted trade as it was (the note stays and says so)
  tombstone_json TEXT
);
CREATE INDEX vault_changes_note ON vault_changes(note_id, seq);

-- "## 反思" sections read back from Obsidian. Append-only: every version is kept; '' records a
-- section cleared in Obsidian (the previous text stays readable).
CREATE TABLE reflection_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_kind TEXT NOT NULL CHECK (note_kind IN ('company','research_update','trade')),
  note_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  body_md TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  source_path TEXT NOT NULL,
  file_mtime TEXT,
  received_at TEXT NOT NULL,
  actor TEXT
);
CREATE INDEX reflection_versions_note ON reflection_versions(note_id, id);
CREATE INDEX reflection_versions_project ON reflection_versions(project_id, id);
CREATE TRIGGER reflection_versions_no_update BEFORE UPDATE ON reflection_versions
BEGIN SELECT RAISE(ABORT, 'reflection versions are append-only'); END;
CREATE TRIGGER reflection_versions_no_delete BEFORE DELETE ON reflection_versions
BEGIN SELECT RAISE(ABORT, 'reflection versions are append-only'); END;

-- The plugin's last status report per vault.
CREATE TABLE vault_clients (
  client TEXT PRIMARY KEY,
  vault_name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  plugin_version TEXT NOT NULL DEFAULT '',
  cursor INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL DEFAULT '{}'
);
-- Where each note lives in each vault (for "open in Obsidian").
CREATE TABLE vault_note_paths (
  vault_name TEXT NOT NULL,
  note_id TEXT NOT NULL,
  path TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (vault_name, note_id)
);

-- Backfill: every existing note once, before the triggers exist.
INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'company', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM projects ORDER BY created_at, id;
INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'research_update', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM revisions WHERE kind <> 'initial' ORDER BY committed_at, seq;
INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'trade', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM trades ORDER BY created_at, id;
INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'ai_session', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM ai_sessions WHERE summary_md IS NOT NULL ORDER BY started_at, id;
INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('index', 'index-companies', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-trades', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-ai', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Companies. commitDraft touches updated_at only, which must not queue anything.
CREATE TRIGGER vault_projects_ins AFTER INSERT ON projects BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('company', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-companies', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER vault_projects_upd AFTER UPDATE ON projects
WHEN OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.archived_at IS NOT NEW.archived_at BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('company', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-companies', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
-- Other notes link to the company by "<ticker> <name>": a new name or ticker re-renders them too.
CREATE TRIGGER vault_projects_rename AFTER UPDATE OF name ON projects WHEN OLD.name IS NOT NEW.name BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'research_update', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM revisions WHERE project_id = NEW.id AND kind <> 'initial' ORDER BY seq;
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'trade', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM trades WHERE project_id = NEW.id ORDER BY created_at, id;
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'ai_session', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM ai_sessions
    WHERE summary_md IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(ai_sessions.project_ids_json) WHERE value = NEW.id) ORDER BY started_at, id;
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('index', 'index-trades', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-ai', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER vault_securities_upd AFTER UPDATE ON securities
WHEN OLD.name IS NOT NEW.name OR OLD.ticker IS NOT NEW.ticker OR OLD.exchange IS NOT NEW.exchange OR OLD.currency IS NOT NEW.currency BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('company', NEW.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-companies', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'research_update', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM revisions WHERE project_id = NEW.project_id AND kind <> 'initial' ORDER BY seq;
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'trade', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM trades WHERE project_id = NEW.project_id ORDER BY created_at, id;
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'ai_session', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM ai_sessions
    WHERE summary_md IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(ai_sessions.project_ids_json) WHERE value = NEW.project_id) ORDER BY started_at, id;
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('index', 'index-trades', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-ai', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Research Updates (the starting snapshot has no note).
CREATE TRIGGER vault_revisions_ins AFTER INSERT ON revisions WHEN NEW.kind <> 'initial' BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('research_update', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('company', NEW.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-companies', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
-- "Marked wrong" shows on the update and in the company's list.
CREATE TRIGGER vault_annotations_ins AFTER INSERT ON revision_annotations BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'research_update', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM revisions WHERE id = NEW.revision_id AND kind <> 'initial';
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('company', NEW.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
-- Cited evidence is listed by title and link.
CREATE TRIGGER vault_evidence_upd AFTER UPDATE ON evidence
WHEN OLD.title IS NOT NEW.title OR OLD.url IS NOT NEW.url OR OLD.published_at IS NOT NEW.published_at BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT DISTINCT 'research_update', r.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM revision_evidence re JOIN revisions r ON r.id = re.revision_id
    WHERE re.evidence_id = NEW.id AND r.kind <> 'initial';
END;

-- Trades. A deleted trade keeps its note, rendered from the tombstone.
CREATE TRIGGER vault_trades_ins AFTER INSERT ON trades BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('trade', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('company', NEW.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-trades', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-companies', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER vault_trades_upd AFTER UPDATE ON trades BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('trade', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('company', NEW.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-trades', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-companies', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER vault_trades_del AFTER DELETE ON trades BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at, tombstone_json) VALUES ('trade', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'), json_object(
    'id', OLD.id, 'projectId', OLD.project_id, 'securityId', OLD.security_id, 'side', OLD.side, 'entryDate', OLD.entry_date, 'entryPrice', OLD.entry_price,
    'quantity', OLD.quantity, 'entryReason', OLD.entry_reason, 'targetPriceAtEntry', OLD.target_price_at_entry, 'stopAtEntry', OLD.stop_at_entry,
    'atrAtEntry', OLD.atr_at_entry, 'atrMultiple', OLD.atr_multiple, 'revisionId', OLD.revision_id, 'exitDate', OLD.exit_date, 'exitPrice', OLD.exit_price,
    'exitReason', OLD.exit_reason, 'fees', OLD.fees, 'notes', OLD.notes, 'source', OLD.source, 'createdBy', OLD.created_by, 'externalRef', OLD.external_ref,
    'sourceText', OLD.source_text, 'createdAt', OLD.created_at, 'updatedAt', OLD.updated_at, 'deletedAt', strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('company', OLD.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-trades', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-companies', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Catalysts are listed on the company note.
CREATE TRIGGER vault_catalysts_ins AFTER INSERT ON catalysts BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('company', NEW.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER vault_catalysts_upd AFTER UPDATE ON catalysts BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('company', NEW.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER vault_catalysts_del AFTER DELETE ON catalysts BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('company', OLD.project_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Reviews of a trade are listed on the trade note (a review of a deleted trade changes nothing).
CREATE TRIGGER vault_reviews_ins AFTER INSERT ON reviews WHEN NEW.subject_type = 'trade' BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'trade', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM trades WHERE id = NEW.subject_id;
END;
CREATE TRIGGER vault_reviews_upd AFTER UPDATE ON reviews WHEN NEW.subject_type = 'trade' OR OLD.subject_type = 'trade' BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'trade', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM trades
    WHERE (NEW.subject_type = 'trade' AND id = NEW.subject_id) OR (OLD.subject_type = 'trade' AND id = OLD.subject_id) ORDER BY id;
END;
CREATE TRIGGER vault_reviews_del AFTER DELETE ON reviews WHEN OLD.subject_type = 'trade' BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'trade', id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM trades WHERE id = OLD.subject_id;
END;

-- AI sessions get a note once they have a summary; recordAiActions updates only last_at,
-- actions_json and project_ids_json, which the note shows too.
CREATE TRIGGER vault_ai_sessions_ins AFTER INSERT ON ai_sessions WHEN NEW.summary_md IS NOT NULL BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('ai_session', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-ai', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'company', p.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM json_each(NEW.project_ids_json) j JOIN projects p ON p.id = j.value;
END;
CREATE TRIGGER vault_ai_sessions_upd AFTER UPDATE OF summary_md, decisions_md, todo_md, last_at, actions_json, project_ids_json ON ai_sessions
WHEN NEW.summary_md IS NOT NULL BEGIN
  INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('ai_session', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ('index', 'index-ai', 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO vault_changes (note_kind, note_id, op, at) SELECT 'company', p.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM json_each(NEW.project_ids_json) j JOIN projects p ON p.id = j.value;
END;
`,
  },
];

/** The schema version this code writes (the highest migration). */
export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/** Apply pending migrations. Refuses a database written by a newer version of the app. */
export function migrate(db: Database.Database): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const known = Math.max(...MIGRATIONS.map((m) => m.version));
  const newest = Math.max(0, ...applied);
  if (newest > known) {
    throw new Error(`This database was created by a newer version of Research Workbench (schema v${newest}; this version knows up to v${known}). Update the app before opening it.`);
  }
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
