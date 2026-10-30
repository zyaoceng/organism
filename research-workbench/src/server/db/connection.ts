import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileStamp } from '../services/backup';
import { migrate, MIGRATIONS } from './migrations';

export type DB = Database.Database;

export interface OpenOptions {
  /** Before migrating an existing database, write a copy to <backupDir>/pre-v<N>-<time>.db (never rotated). */
  backupDir?: string;
  now?: () => Date;
}

/** Open (and migrate) the SQLite database. Pass ':memory:' for tests. */
export function openDatabase(file: string, opts: OpenOptions = {}): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (file !== ':memory:' && opts.backupDir) backupBeforeMigrating(db, opts.backupDir, opts.now?.() ?? new Date());
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

function appliedVersions(db: DB): number[] {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  return table ? (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version) : [];
}

/** Highest applied schema version (0 for an empty database). */
export function schemaVersion(db: DB): number {
  return Math.max(0, ...appliedVersions(db));
}

/** A consistent copy of a database that already has data, taken only when migrations are about to run. */
function backupBeforeMigrating(db: DB, dir: string, now: Date) {
  const applied = appliedVersions(db);
  const latest = Math.max(...MIGRATIONS.map((m) => m.version));
  // a fresh file has nothing to lose; a newer database is refused by migrate()
  if (!applied.length || Math.max(...applied) > latest) return;
  if (MIGRATIONS.every((m) => applied.includes(m.version))) return;
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `pre-v${latest}-${fileStamp(now)}`);
  let target = `${base}.db`;
  for (let n = 2; fs.existsSync(target); n++) target = `${base}-${n}.db`;
  db.prepare('VACUUM INTO ?').run(target);
}
