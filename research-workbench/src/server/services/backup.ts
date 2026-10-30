import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/connection';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Retention: the newest backup of each of the 14 most recent days, and of each of the 8 most recent ISO weeks. */
const KEEP_DAYS = 14;
const KEEP_WEEKS = 8;
const DAILY_RE = /^workbench-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as YYYYMMDD-HHmmss, used in backup file names. */
export function fileStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // Thursday of the same week decides the year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${pad(week)}`;
}

const sidecars = (file: string) => [`${file}-wal`, `${file}-shm`, `${file}-journal`];

/**
 * Write a consistent single-file copy of an open database: online backup to <file>.tmp, switch the
 * copy out of WAL mode (no -wal/-shm next to it), PRAGMA quick_check on a read-only connection, then
 * rename into place. Nothing is left behind when a step fails.
 */
export async function writeVerifiedBackup(db: DB, file: string): Promise<void> {
  const tmp = `${file}.tmp`;
  const cleanup = () => {
    for (const f of [tmp, ...sidecars(tmp)]) fs.rmSync(f, { force: true });
  };
  cleanup();
  try {
    await db.backup(tmp);
    const rw = new Database(tmp, { fileMustExist: true });
    try {
      rw.pragma('journal_mode = DELETE');
    } finally {
      rw.close();
    }
    const ro = new Database(tmp, { readonly: true, fileMustExist: true });
    let check: unknown;
    try {
      check = ro.pragma('quick_check', { simple: true });
    } finally {
      ro.close();
    }
    if (check !== 'ok') throw new Error(`The backup copy failed its integrity check: ${String(check)}`);
    fs.renameSync(tmp, file);
  } finally {
    cleanup();
  }
}

export interface BackupStatus {
  /** Time of the newest daily backup (from its file name). */
  lastBackupAt: string | null;
  count: number;
  dir: string;
  lastError: string | null;
}

export interface BackupOptions {
  now?: () => Date;
  /** Called when a scheduled backup fails (the server logs it). */
  onError?: (err: unknown) => void;
}

/**
 * Daily backups in <dir>/daily/workbench-YYYYMMDD-HHmmss.db. Checked at startup and every hour; a new
 * copy is made when the newest one is 24 hours old. Pre-migration (pre-v*) and pre-import copies in
 * <dir> itself are never rotated.
 */
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<string | null> | null = null;
  private stopped = false;
  private lastError: string | null = null;
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly db: DB,
    readonly dir: string,
    opts: BackupOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError ?? (() => {});
  }

  get dailyDir(): string {
    return path.join(this.dir, 'daily');
  }

  /** Daily backups, newest first. */
  list(): { file: string; at: Date }[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dailyDir);
    } catch {
      return [];
    }
    return names
      .flatMap((name) => {
        const m = DAILY_RE.exec(name);
        if (!m) return [];
        const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
        return [{ file: path.join(this.dailyDir, name), at: new Date(y, mo - 1, d, h, mi, s) }];
      })
      .sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  /** Back up when the newest daily backup is 24 hours old or there is none. Resolves to the new file, or null. */
  maybeBackup(): Promise<string | null> {
    if (this.stopped) return Promise.resolve(null);
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<string | null> {
    const now = this.now();
    // a name in the future (the clock or the time zone changed) must not hold off backups for days
    const newest = this.list().find((b) => b.at.getTime() <= now.getTime());
    if (newest && now.getTime() - newest.at.getTime() < DAY_MS) return null;
    try {
      fs.mkdirSync(this.dailyDir, { recursive: true });
      const file = path.join(this.dailyDir, `workbench-${fileStamp(now)}.db`);
      await writeVerifiedBackup(this.db, file);
      this.prune();
      this.lastError = null;
      return file;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /** Keep the newest file per day (14 days) and per ISO week (8 weeks); delete the rest and stray .tmp files. */
  private prune() {
    const keep = new Set<string>();
    const days = new Set<string>();
    const weeks = new Set<string>();
    for (const b of this.list()) {
      const day = localDay(b.at);
      const week = isoWeek(b.at);
      if (!days.has(day) && days.size < KEEP_DAYS) {
        days.add(day);
        keep.add(b.file);
      }
      if (!weeks.has(week) && weeks.size < KEEP_WEEKS) {
        weeks.add(week);
        keep.add(b.file);
      }
    }
    for (const name of fs.readdirSync(this.dailyDir)) {
      const file = path.join(this.dailyDir, name);
      const stray = /\.tmp(-wal|-shm|-journal)?$/.test(name);
      if (stray || (DAILY_RE.test(name) && !keep.has(file))) fs.rmSync(file, { force: true });
    }
  }

  /** Check at startup and then every hour. */
  start() {
    if (this.timer || this.stopped) return;
    const tick = () => {
      this.maybeBackup().catch((e) => this.onError(e));
    };
    tick();
    this.timer = setInterval(tick, HOUR_MS);
    this.timer.unref();
  }

  /** Stop the timer and wait for a backup that is being written. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  status(): BackupStatus {
    const all = this.list();
    return { lastBackupAt: all[0]?.at.toISOString() ?? null, count: all.length, dir: this.dir, lastError: this.lastError };
  }
}
