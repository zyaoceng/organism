import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schemaVersion, type DB } from '../db/connection';
import { migrate } from '../db/migrations';
import { rotateDbGeneration } from '../repos/meta';
import { fileStamp, writeVerifiedBackup } from './backup';

/**
 * Move a data directory from another machine (GitHub Codespaces) into this one.
 *
 * The archive is what the user guide's one-liner produces: `tar czf wb-data.tgz wb.db data/attachments`,
 * where wb.db is an online backup. A plain copy of data/workbench.db (with its -wal/-shm) and an
 * attachments/ folder at any depth also works. Everything is checked in a staging directory first;
 * the target is only touched once the database, its schema and every attachment hash are verified.
 *
 * The server must not be running on the target data directory (the installer stops it).
 */

export interface ImportedProject {
  name: string;
  ticker: string | null;
  revisions: number;
  lastCommitAt: string | null;
  lastAsOfDate: string | null;
  trades: number;
  evidence: number;
}

export interface ImportSummary {
  projects: ImportedProject[];
  /** Attachment rows (uploaded files) in the database. */
  attachments: number;
  schemaVersion: number;
  /** The archive held a write-ahead log next to the database; its changes were applied. */
  hadWal: boolean;
}

export class ImportError extends Error {
  constructor(
    message: string,
    /** Process exit code for the CLI: 2 = the target already has data and --force was not given. */
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportOptions {
  archive: string;
  dataDir: string;
  /** Replace a target database that already has companies (a copy is kept in <dataDir>/backups). */
  force?: boolean;
  /** Verify and summarise only; the target is not touched. */
  summaryOnly?: boolean;
  now?: () => Date;
  /** Parent of the staging directory. Default: the OS temp directory. */
  tmpDir?: string;
}

export interface ImportResult {
  summary: ImportSummary;
  /** False with summaryOnly. */
  imported: boolean;
  /** Copy of the database that was replaced: <dataDir>/backups/pre-import-<time>.db. */
  backupFile: string | null;
  /** Attachment files copied into <dataDir>/attachments (files already there are kept). */
  copiedAttachments: number;
}

const SHA_RE = /^[0-9a-f]{64}$/;
const sidecars = (file: string) => [`${file}-wal`, `${file}-shm`, `${file}-journal`];

export async function importData(opts: ImportOptions): Promise<ImportResult> {
  const archive = path.resolve(opts.archive);
  if (!fs.statSync(archive, { throwIfNoEntry: false })?.isFile()) throw new ImportError(`Archive not found: ${archive}`);
  const staging = fs.mkdtempSync(path.join(opts.tmpDir ?? os.tmpdir(), 'wb-import-'));
  try {
    const extracted = path.join(staging, 'archive');
    fs.mkdirSync(extracted);
    extract(archive, extracted);
    const tree = walk(extracted);
    const dbFile = locateDatabase(tree.files, extracted);
    const hadWal = (fs.statSync(`${dbFile}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0;

    // Opening the copied database replays a write-ahead log stored next to it; VACUUM INTO then
    // writes everything into one self-contained file.
    const clean = path.join(staging, 'clean.db');
    withDatabase(dbFile, (src) => {
      let check: unknown;
      try {
        check = src.pragma('quick_check', { simple: true });
      } catch (e) {
        throw new ImportError(`${rel(extracted, dbFile)} is damaged or is not a database: ${(e as Error).message}`);
      }
      if (check !== 'ok') throw new ImportError(`${rel(extracted, dbFile)} is damaged: ${String(check)}`);
      if (schemaVersion(src) === 0 || !src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()) {
        throw new ImportError(`${rel(extracted, dbFile)} is not a Research Workbench database`);
      }
      src.prepare('VACUUM INTO ?').run(clean);
    });

    const { summary, files } = withDatabase(clean, (db) => {
      db.pragma('foreign_keys = ON');
      try {
        migrate(db);
      } catch (e) {
        throw new ImportError((e as Error).message);
      }
      // a copy of another database keeps its generation; open browser tabs must notice the swap
      rotateDbGeneration(db);
      const integrity = (db.pragma('integrity_check') as { integrity_check: string }[]).map((r) => r.integrity_check);
      if (integrity.join() !== 'ok') throw new ImportError(`The database failed its integrity check: ${integrity.slice(0, 5).join('; ')}`);
      const fk = db.pragma('foreign_key_check') as { table: string; parent: string }[];
      if (fk.length) {
        const kinds = [...new Set(fk.map((r) => `${r.table} → ${r.parent}`))];
        throw new ImportError(`The database has ${fk.length} broken reference(s): ${kinds.slice(0, 5).join(', ')}`);
      }
      const files = verifyAttachments(db, attachmentDirs(tree.dirs, dbFile, extracted), extracted);
      db.pragma('journal_mode = DELETE');
      return { summary: summarize(db, hadWal), files };
    });
    if (opts.summaryOnly) return { summary, imported: false, backupFile: null, copiedAttachments: 0 };

    const dataDir = path.resolve(opts.dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    const target = path.join(dataDir, 'workbench.db');
    const backupFile = await backupTarget(target, dataDir, opts.force ?? false, opts.now?.() ?? new Date());

    // Attachments first: extra content-addressed files are harmless to the old database.
    const attachmentsDir = path.join(dataDir, 'attachments');
    let copiedAttachments = 0;
    for (const [sha, from] of files) {
      const dest = path.join(attachmentsDir, sha.slice(0, 2), sha);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(from, `${dest}.import.tmp`);
      fs.renameSync(`${dest}.import.tmp`, dest);
      copiedAttachments++;
    }

    // The old -wal/-shm must go before the new file takes the name, or SQLite would apply them to it.
    const incoming = `${target}.importing`;
    fs.copyFileSync(clean, incoming);
    for (const f of sidecars(target)) fs.rmSync(f, { force: true });
    fs.renameSync(incoming, target);
    return { summary, imported: true, backupFile, copiedAttachments };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function withDatabase<T>(file: string, fn: (db: DB) => T): T {
  let db: DB;
  try {
    db = new Database(file, { fileMustExist: true });
  } catch (e) {
    throw new ImportError(`Cannot open ${path.basename(file)}: ${(e as Error).message}`);
  }
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const rel = (root: string, p: string) => path.relative(root, p) || '.';

function extract(archive: string, into: string) {
  try {
    // the system tar (GNU or bsdtar) detects gzip itself and refuses absolute and ../ member names
    execFileSync('tar', ['-xf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer }).stderr ?? '').trim();
    throw new ImportError(`Could not extract ${path.basename(archive)} (is it a complete .tgz file?)${stderr ? `: ${stderr.split('\n')[0]}` : ''}`);
  }
}

/** Regular files and directories under root. Symlinks are ignored. */
function walk(root: string): { files: string[]; dirs: string[] } {
  const out = { files: [] as string[], dirs: [] as string[] };
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.dirs.push(p);
        visit(p);
      } else if (e.isFile()) out.files.push(p);
    }
  };
  visit(root);
  return out;
}

/** wb.db (an online backup) wins over data/workbench.db (a raw copy). */
function locateDatabase(files: string[], root: string): string {
  for (const name of ['wb.db', 'workbench.db']) {
    const found = files.filter((f) => path.basename(f) === name);
    if (found.length > 1) throw new ImportError(`The archive contains more than one ${name}: ${found.map((f) => rel(root, f)).join(', ')}`);
    if (found.length) return found[0];
  }
  throw new ImportError('The archive contains no database (expected wb.db or data/workbench.db)');
}

/** Folders named "attachments", the ones next to the database first. */
function attachmentDirs(dirs: string[], dbFile: string, root: string): string[] {
  const near = [path.join(path.dirname(dbFile), 'attachments'), path.join(path.dirname(dbFile), 'data', 'attachments')];
  const depth = (d: string) => rel(root, d).split(path.sep).length;
  return dirs
    .filter((d) => path.basename(d) === 'attachments')
    .sort((a, b) => {
      const na = near.indexOf(a);
      const nb = near.indexOf(b);
      if (na !== nb) return (na < 0 ? 99 : na) - (nb < 0 ? 99 : nb);
      return depth(a) - depth(b);
    });
}

/** Every attachment row must have its file, with the recorded sha256. Returns sha256 → staged file. */
function verifyAttachments(db: DB, dirs: string[], root: string): Map<string, string> {
  const rows = db.prepare('SELECT id, sha256, original_filename, storage_key FROM attachments ORDER BY created_at').all() as {
    id: string;
    sha256: string;
    original_filename: string;
    storage_key: string;
  }[];
  const files = new Map<string, string>();
  const seen = new Set<string>();
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const r of rows) {
    if (seen.has(r.sha256)) continue; // the same bytes uploaded twice share one file
    seen.add(r.sha256);
    if (!SHA_RE.test(r.sha256) || r.storage_key !== `${r.sha256.slice(0, 2)}/${r.sha256}`) throw new ImportError(`Attachment “${r.original_filename}” has an invalid storage key`);
    const found = dirs.map((d) => path.join(d, r.sha256.slice(0, 2), r.sha256)).find((f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile());
    if (!found) {
      missing.push(r.original_filename);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(found)).digest('hex');
    if (actual !== r.sha256) {
      mismatched.push(`${r.original_filename} (${rel(root, found)})`);
      continue;
    }
    files.set(r.sha256, found);
  }
  const list = (xs: string[]) => xs.slice(0, 5).join(', ') + (xs.length > 5 ? `, … (${xs.length} in all)` : '');
  if (missing.length) throw new ImportError(`${missing.length} attachment file(s) are missing from the archive: ${list(missing)}`);
  if (mismatched.length) throw new ImportError(`${mismatched.length} attachment file(s) do not match their recorded SHA-256: ${list(mismatched)}`);
  return files;
}

function summarize(db: DB, hadWal: boolean): ImportSummary {
  const projects = db
    .prepare(
      `SELECT p.name,
        (SELECT s.ticker FROM securities s WHERE s.project_id = p.id ORDER BY s.is_primary DESC, s.rowid LIMIT 1) AS ticker,
        (SELECT COUNT(*) FROM revisions r WHERE r.project_id = p.id) AS revisions,
        (SELECT MAX(r.committed_at) FROM revisions r WHERE r.project_id = p.id) AS lastCommitAt,
        (SELECT MAX(r.as_of_date) FROM revisions r WHERE r.project_id = p.id) AS lastAsOfDate,
        (SELECT COUNT(*) FROM trades t WHERE t.project_id = p.id) AS trades,
        (SELECT COUNT(*) FROM evidence e WHERE e.project_id = p.id) AS evidence
      FROM projects p ORDER BY p.created_at, p.rowid`,
    )
    .all() as ImportedProject[];
  const attachments = (db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n;
  return { projects, attachments, schemaVersion: schemaVersion(db), hadWal };
}

/**
 * Keep a copy of the database that is about to be replaced. Refuses (exit code 2) when it has
 * companies and force is not set; an unreadable database also needs force.
 */
async function backupTarget(target: string, dataDir: string, force: boolean, now: Date): Promise<string | null> {
  if (!fs.existsSync(target)) return null;
  assertNotInUse(target);
  let db: DB | null = null;
  try {
    let projects: number | null = null;
    try {
      db = new Database(target, { fileMustExist: true });
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
      projects = hasTable ? (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n : 0;
    } catch {
      // unreadable: treat it as holding data
    }
    if (projects !== 0 && !force) {
      throw new ImportError(
        projects === null
          ? `${target} exists but cannot be read. Run again with --force to replace it (a copy is kept in ${path.join(dataDir, 'backups')}).`
          : `${target} already holds ${projects} compan${projects === 1 ? 'y' : 'ies'}. Run again with --force to replace it (a copy is kept in ${path.join(dataDir, 'backups')}).`,
        2,
      );
    }
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `pre-import-${fileStamp(now)}`);
    let file = `${base}.db`;
    for (let n = 2; fs.existsSync(file); n++) file = `${base}-${n}.db`;
    try {
      if (!db) throw new Error('not readable');
      await writeVerifiedBackup(db, file);
    } catch {
      // a damaged database cannot be backed up online; keep its raw files instead
      fs.copyFileSync(target, file);
      for (const s of ['-wal', '-shm']) if (fs.existsSync(`${target}${s}`)) fs.copyFileSync(`${target}${s}`, `${file}${s}`);
    }
    return file;
  } finally {
    (db as DB | null)?.close();
  }
}

/**
 * Refuse while another process (a running server) has the target open: replacing the file under it
 * would lose everything it writes afterwards. The last connection to close a WAL database checkpoints
 * and deletes its -wal file, so one that is still there after our connection closes belongs to someone else.
 */
function assertNotInUse(target: string) {
  let db: DB | null = null;
  try {
    db = new Database(target, { fileMustExist: true });
    db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  } catch {
    return; // unreadable: nothing can be using it as a database
  } finally {
    db?.close();
  }
  if (fs.existsSync(`${target}-wal`)) {
    throw new ImportError(`${target} is open in another program (is Research Workbench still running?). Stop the server and run the import again.`);
  }
}
