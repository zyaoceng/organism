import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, schemaVersion, type DB } from './db/connection';
import { MIGRATIONS, SCHEMA_VERSION } from './db/migrations';
import { BackupService, fileStamp } from './services/backup';

let dir: string;
let db: DB | null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backup-'));
  db = null;
});
afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const backupsDir = () => path.join(dir, 'backups');
const ls = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

function withProject(file = path.join(dir, 'workbench.db')): DB {
  const d = openDatabase(file);
  d.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Lite-On', '2026-01-01', '2026-01-01')").run();
  return d;
}

function readOnly<T>(file: string, fn: (d: DB) => T): T {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

describe('daily backups', () => {
  it('backs up once per 24 hours into a verified single file', async () => {
    db = withProject();
    let now = new Date(2026, 9, 1, 10, 0, 0);
    const svc = new BackupService(db, backupsDir(), { now: () => now });
    expect(svc.status()).toEqual({ lastBackupAt: null, count: 0, dir: backupsDir(), lastError: null });

    const first = await svc.maybeBackup();
    expect(path.basename(first!)).toBe('workbench-20261001-100000.db');
    expect(ls(svc.dailyDir)).toEqual(['workbench-20261001-100000.db']); // no .tmp, -wal or -shm left
    readOnly(first!, (d) => {
      expect(d.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'Lite-On' }]);
      expect(d.pragma('journal_mode', { simple: true })).toBe('delete');
    });

    now = new Date(now.getTime() + 23 * HOUR);
    expect(await svc.maybeBackup()).toBeNull();
    now = new Date(now.getTime() + HOUR);
    const second = await svc.maybeBackup();
    expect(path.basename(second!)).toBe('workbench-20261002-100000.db');
    expect(svc.status()).toMatchObject({ count: 2, lastBackupAt: new Date(2026, 9, 2, 10, 0, 0).toISOString() });
  });

  it('does not let a backup named in the future (clock or time zone changed) hold off new ones', async () => {
    db = withProject();
    const svc = new BackupService(db, backupsDir(), { now: () => new Date(2026, 9, 10, 10, 0, 0) });
    fs.mkdirSync(svc.dailyDir, { recursive: true });
    fs.writeFileSync(path.join(svc.dailyDir, 'workbench-20261009-080000.db'), '');
    fs.writeFileSync(path.join(svc.dailyDir, 'workbench-20261012-090000.db'), '');
    expect(path.basename((await svc.maybeBackup())!)).toBe('workbench-20261010-100000.db');
    expect(await svc.maybeBackup()).toBeNull(); // today's copy now counts
  });

  it('runs one backup at a time and waits for it on stop()', async () => {
    db = withProject();
    const svc = new BackupService(db, backupsDir());
    const [a, b] = await Promise.all([svc.maybeBackup(), svc.maybeBackup()]);
    expect(a).toBe(b);
    expect(ls(svc.dailyDir)).toHaveLength(1);

    fs.rmSync(svc.dailyDir, { recursive: true });
    const pending = svc.maybeBackup();
    await svc.stop();
    expect(fs.existsSync((await pending)!)).toBe(true);
    expect(await svc.maybeBackup()).toBeNull(); // stopped
  });

  it('start() backs up at startup', async () => {
    db = withProject();
    const svc = new BackupService(db, backupsDir());
    svc.start();
    await svc.stop();
    expect(svc.status().count).toBe(1);
  });

  it('keeps the newest backup per day for 14 days and per ISO week for 8 weeks; leaves other copies alone', async () => {
    db = withProject();
    const svc = new BackupService(db, backupsDir(), { now: () => new Date(2026, 2, 4, 10, 0, 0) }); // Wednesday
    fs.mkdirSync(svc.dailyDir, { recursive: true });
    // two backups a day from 1 January to 2 March (3 March is missing)
    for (let d = new Date(2026, 0, 1); d <= new Date(2026, 2, 2); d.setDate(d.getDate() + 1)) {
      for (const h of [9, 18]) fs.writeFileSync(path.join(svc.dailyDir, `workbench-${fileStamp(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h))}.db`), '');
    }
    fs.writeFileSync(path.join(svc.dailyDir, 'workbench-20260301-120000.db.tmp'), '');
    fs.writeFileSync(path.join(svc.dailyDir, 'workbench-20260301-120000.db.tmp-wal'), '');
    fs.writeFileSync(path.join(svc.dailyDir, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(backupsDir(), 'pre-v2-20250101-000000.db'), '');
    fs.writeFileSync(path.join(backupsDir(), 'pre-import-20250101-000000.db'), '');

    expect(path.basename((await svc.maybeBackup())!)).toBe('workbench-20260304-100000.db');
    const days = ['0302', '0301', '0228', '0227', '0226', '0225', '0224', '0223', '0222', '0221', '0220', '0219', '0218'];
    const weeks = ['0215', '0208', '0201', '0125', '0118']; // the Sundays of older weeks
    const expected = ['workbench-20260304-100000.db', ...[...days, ...weeks].map((d) => `workbench-2026${d}-180000.db`), 'notes.txt'];
    expect(ls(svc.dailyDir)).toEqual(expected.sort());
    expect(ls(backupsDir())).toEqual(['daily', 'pre-import-20250101-000000.db', 'pre-v2-20250101-000000.db']);
    expect(svc.status().count).toBe(19);
  });

  it('reports a failed backup', async () => {
    db = withProject();
    fs.mkdirSync(backupsDir());
    fs.writeFileSync(path.join(backupsDir(), 'daily'), 'not a directory');
    const errors: unknown[] = [];
    const svc = new BackupService(db, backupsDir(), { onError: (e) => errors.push(e) });
    await expect(svc.maybeBackup()).rejects.toThrow();
    expect(svc.status().lastError).toMatch(/EEXIST|ENOTDIR/);
    svc.start();
    await svc.stop();
    expect(errors).toHaveLength(1);
  });
});

describe('opening a database', () => {
  it('copies an existing database before migrating it, never a fresh one', () => {
    const file = path.join(dir, 'workbench.db');
    const now = () => new Date(2026, 9, 30, 9, 5, 7);
    // fresh file: nothing to copy
    openDatabase(file, { backupDir: backupsDir(), now }).close();
    expect(fs.existsSync(backupsDir())).toBe(false);
    withProject(path.join(dir, 'other.db')).close();

    const next = SCHEMA_VERSION + 1;
    MIGRATIONS.push({ version: next, name: 'test only', sql: 'CREATE TABLE extra (x TEXT);' });
    try {
      db = openDatabase(path.join(dir, 'other.db'), { backupDir: backupsDir(), now });
      expect(schemaVersion(db)).toBe(next);
      expect(ls(backupsDir())).toEqual([`pre-v${next}-20261030-090507.db`]);
      readOnly(path.join(backupsDir(), `pre-v${next}-20261030-090507.db`), (d) => {
        expect(schemaVersion(d)).toBe(SCHEMA_VERSION);
        expect(d.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'Lite-On' }]);
      });
      db.close();
      // already migrated: no further copy
      db = openDatabase(path.join(dir, 'other.db'), { backupDir: backupsDir(), now });
      expect(ls(backupsDir())).toHaveLength(1);
      // without a backup directory (tests) or in memory nothing is written
      openDatabase(file).close();
      openDatabase(':memory:', { backupDir: path.join(dir, 'mem') }).close();
      expect(fs.existsSync(path.join(dir, 'mem'))).toBe(false);
    } finally {
      MIGRATIONS.pop();
    }
  });

  it('refuses a database written by a newer version', () => {
    const file = path.join(dir, 'workbench.db');
    const d = withProject(file);
    d.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (99, ?)').run(new Date().toISOString());
    d.close();
    expect(() => openDatabase(file, { backupDir: backupsDir() })).toThrow(/newer version of Research Workbench \(schema v99/);
    expect(fs.existsSync(backupsDir())).toBe(false);
    // the file is closed again and still readable
    readOnly(file, (r) => expect(schemaVersion(r)).toBe(99));
  });
});
