/**
 * Writes the user's changes back into the linked Excel file. This is the only code that writes
 * inside the vault folder, and the only file it ever writes there is the linked .xlsx itself: the
 * new bytes go to a temp file next to it (named so iCloud does not sync it) which is then renamed
 * over it. Nothing else in the vault is created, moved, renamed or deleted.
 *
 * Order, each step refusing before anything is written:
 *  1. read the file again; it must be readable and its SHA-256 must be the one the page loaded
 *  2. Excel must not have it open (its lock file ~$name.xlsx)
 *  3. the cells must be assumption cells of this file
 *  4. build the new bytes, read them back and check that only the intended cells differ
 *     the file must not be marked read-only (403 FILE_READ_ONLY)
 *  5. copy the original to <dataDir>/workbook-backups/<projectId>/ (the newest 30 are kept)
 *  6. temp file, rename over the original keeping its mode
 *  7. read the file once more and compare its SHA-256 and size; record the write
 * When anything fails after the rename, the backup is put back and the error says so. A failure
 * before the rename (the folder is not writable: 403 WRITE_DENIED) leaves the file as it was.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CellRef, CellValue, WorkbookCell, WorkbookData } from '../../domain/workbook/types';
import type { WorkbookRevertDTO, WorkbookWriteRequest } from '../../shared/api';
import { currentActor } from '../actor';
import type { DB } from '../db/connection';
import { audit } from '../repos/audit';
import { fileStamp } from '../services/backup';
import { badRequest, conflict, HttpError, nowIso, parseJson } from '../util';
import { createEngine } from './engine';
import { excelLockPath, readWorkbookFile, sha256Hex, type FileDeps } from './file';
import { PatchError, patchXlsx, type CachedEdit, type PatchResult } from './patch';
import { readWorkbook } from './read';
import type { LoadedWorkbook } from './view';
import { XlsxError, readZip } from './zipRead';

/** The text a status cell is changed to. */
export const DECIDED_TEXT = '已定';
export const BACKUPS_KEPT = 30;
export const BACKUP_FOLDER = 'workbook-backups';
const MAX_CELLS = 500;

/** The temp file a write goes through: hidden, and ".nosync" keeps iCloud from uploading it. */
export const tempPathFor = (file: string) => path.join(path.dirname(file), `.${path.basename(file)}.wb.nosync`);

export interface WrittenCell extends CellRef {
  label: string;
  before: number;
  after: number;
  /** The cell held a formula, which the number replaced. */
  wasFormula: boolean;
  formula?: string;
}

export interface WrittenStatus extends CellRef {
  label: string;
  before: string;
  after: string;
}

/** What one row of workbook_writes says was written. */
export interface WrittenCells {
  changes: WrittenCell[];
  statusChanges: WrittenStatus[];
}

export interface WriteContext {
  db: DB;
  dataDir: string;
  projectId: string;
  /** Vault-relative path of the linked file, as stored. */
  relPath: string;
  /** Its absolute path (resolveInVault). */
  absPath: string;
  fileDeps: FileDeps;
  /** Parses bytes (the routes' cache). */
  load: (bytes: Buffer, sha256: string) => LoadedWorkbook;
  now?: () => Date;
  /** Tests: called once the new file is in place, before it is checked. */
  afterRename?: () => void;
}

export interface WriteOutcome {
  id: number;
  beforeSha: string;
  afterSha: string;
  afterSize: number;
  /** Relative to the data folder. */
  backupFile: string;
  cells: WrittenCells;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCell = (v: Record<string, unknown>): v is Record<string, unknown> & CellRef =>
  typeof v.sheet === 'string' && v.sheet.length > 0 && v.sheet.length <= 300 && typeof v.address === 'string' && /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(v.address);

/** A request body as POST …/workbook/write takes it; anything else is refused. */
export function parseWriteRequest(body: unknown): WorkbookWriteRequest {
  const b = isObject(body) ? body : {};
  if (typeof b.baseSha !== 'string' || !/^[0-9a-f]{64}$/.test(b.baseSha)) throw badRequest('baseSha is required');
  const changes = b.changes ?? [];
  const statusChanges = b.statusChanges ?? [];
  if (!Array.isArray(changes) || !Array.isArray(statusChanges) || changes.length + statusChanges.length > MAX_CELLS) throw badRequest('changes and statusChanges must be lists');
  const seen = new Set<string>();
  const once = (c: CellRef) => {
    const k = `${c.sheet}\0${c.address}`;
    if (seen.has(k)) throw badRequest(`Cell named twice: ${c.sheet}!${c.address}`);
    seen.add(k);
  };
  for (const c of changes) {
    if (!isObject(c) || !isCell(c) || typeof c.value !== 'number' || !Number.isFinite(c.value)) throw badRequest('Each change needs a sheet, an address and a finite number');
    once(c);
  }
  for (const s of statusChanges) {
    if (!isObject(s) || !isCell(s) || s.to !== DECIDED_TEXT) throw badRequest(`Each status change needs a sheet, an address and to: ${DECIDED_TEXT}`);
    once(s);
  }
  if (!seen.size) throw badRequest('There is nothing to write', { code: 'NOTHING_TO_WRITE' });
  return {
    baseSha: b.baseSha,
    changes: (changes as { sheet: string; address: string; value: number }[]).map((c) => ({ sheet: c.sheet, address: c.address, value: c.value })),
    statusChanges: (statusChanges as CellRef[]).map((s) => ({ sheet: s.sheet, address: s.address, to: DECIDED_TEXT })),
  };
}

const cellKey = (c: CellRef) => `${c.sheet}\0${c.address}`;
const sameValue = (a: CellValue, b: CellValue) => a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));

/** The requested cells as assumption cells of this file, with what they hold now. Refuses any other cell. */
function resolveCells(loaded: LoadedWorkbook, req: WorkbookWriteRequest): WrittenCells {
  const byValue = new Map(loaded.detect.assumptions.map((a) => [cellKey({ sheet: a.sheet, address: a.valueCell }), a]));
  const byStatus = new Map(loaded.detect.assumptions.flatMap((a) => (a.statusCell ? [[cellKey({ sheet: a.sheet, address: a.statusCell }), a] as const] : [])));
  const notOurs = (c: CellRef, what: string): never => {
    throw badRequest(`${c.sheet}!${c.address} is not ${what} of this workbook`, { code: 'NOT_AN_ASSUMPTION', sheet: c.sheet, address: c.address });
  };
  const sheetOf = (name: string) => loaded.workbook.sheets.find((s) => s.name === name);
  const changes = req.changes.map((c): WrittenCell => {
    const a = byValue.get(cellKey(c)) ?? notOurs(c, 'the value cell of an assumption');
    const formula = sheetOf(c.sheet)?.cells[c.address]?.formula;
    return { sheet: c.sheet, address: c.address, label: a.label, before: a.value, after: c.value, wasFormula: formula !== undefined, ...(formula !== undefined ? { formula } : {}) };
  });
  const statusChanges = req.statusChanges.map((s): WrittenStatus => {
    const a = byStatus.get(cellKey(s)) ?? notOurs(s, 'the status cell of an assumption');
    if (a.status !== 'needs-decision') throw badRequest(`${s.sheet}!${s.address} is not marked 要`, { code: 'NOT_AN_ASSUMPTION', sheet: s.sheet, address: s.address });
    const before = sheetOf(s.sheet)?.cells[s.address]?.value;
    return { sheet: s.sheet, address: s.address, label: a.label, before: typeof before === 'string' ? before : '', after: s.to };
  });
  return { changes, statusChanges };
}

/**
 * The stored results that change once `once` (the file with the cells already changed) is
 * recalculated: every cell whose value the engine computes differently for it than for the original.
 */
function staleResults(loaded: LoadedWorkbook, once: Buffer, skip: Set<string>): CachedEdit[] {
  const engine = createEngine(readWorkbook(once));
  const out: CachedEdit[] = [];
  try {
    loaded.engine.set([]);
    for (const sheet of loaded.workbook.sheets) {
      for (const cell of Object.values(sheet.cells)) {
        const ref = { sheet: sheet.name, address: cell.address };
        if (skip.has(cellKey(ref)) || (cell.type === 'empty' && cell.formula === undefined)) continue;
        const [before] = loaded.engine.get([ref]);
        const [after] = engine.get([ref]);
        if (!sameValue(before, after)) out.push({ ...ref, value: after });
      }
    }
  } finally {
    engine.dispose();
  }
  return out;
}

const withoutValue = (c: WorkbookCell | undefined) => {
  if (!c) return null;
  const { type: _type, value: _value, hasCached: _hasCached, ...rest } = c;
  return rest;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What differs between the original and the patched workbook beyond what was asked for; empty when
 * exactly the intended cells differ. Formulas are compared as read (a shared formula written out as
 * plain ones reads the same).
 */
export function unintendedDifferences(before: WorkbookData, after: WorkbookData, cells: WrittenCells, cached: CachedEdit[], cacheDropped: CellRef[]): string[] {
  const problems: string[] = [];
  const numbers = new Map(cells.changes.map((c) => [cellKey(c), c.after]));
  const texts = new Map(cells.statusChanges.map((c) => [cellKey(c), c.after]));
  const dropped = new Set(cacheDropped.map(cellKey));
  const results = new Map(cached.map((c) => [cellKey(c), c.value]));
  if (!same(before.sheets.map((s) => [s.name, s.hidden, s.merges]), after.sheets.map((s) => [s.name, s.hidden, s.merges]))) problems.push('the sheets, their names or their merged cells differ');
  if (!same(before.definedNames, after.definedNames) || before.date1904 !== after.date1904) problems.push('the defined names differ');
  if (!same(before.sharedStrings, after.sharedStrings)) problems.push('the shared strings differ');
  for (const sheet of before.sheets) {
    const next = after.sheets.find((s) => s.name === sheet.name);
    if (!next) continue;
    for (const address of new Set([...Object.keys(sheet.cells), ...Object.keys(next.cells)])) {
      const [a, b] = [sheet.cells[address], next.cells[address]];
      const k = cellKey({ sheet: sheet.name, address });
      const at = `${sheet.name}!${address}`;
      const sameRest = (ignore: (keyof WorkbookCell)[]) => {
        const strip = (c: WorkbookCell | undefined) => {
          const rest: Record<string, unknown> = { ...withoutValue(c) };
          for (const key of ignore) delete rest[key];
          return rest;
        };
        return same(strip(a), strip(b));
      };
      if (numbers.has(k)) {
        if (!b || b.formula !== undefined || b.type !== 'number' || b.value !== numbers.get(k) || !sameRest(['formula', 'arrayRef'])) problems.push(`${at} did not become the number asked for`);
      } else if (texts.has(k)) {
        if (!b || b.formula !== undefined || b.type !== 'string' || b.value !== texts.get(k) || !sameRest([])) problems.push(`${at} did not become the text asked for`);
      } else if (results.has(k)) {
        const want = results.get(k)!;
        const stored = dropped.has(k) || want === null ? !b || (b.type === 'empty' && b.value === null) : !!b && sameValue(b.value, want);
        if (!stored || (b ? !sameRest([]) : a?.formula !== undefined || a?.note !== undefined)) problems.push(`${at} does not hold the recalculated result`);
      } else if (!same(a ?? null, b ?? null)) problems.push(`${at} changed and was not meant to`);
      if (problems.length >= 20) return problems;
    }
  }
  return problems;
}

/** ZIP entries that differ although the patch did not name them. */
function unintendedParts(original: Buffer, patched: Buffer, patch: PatchResult): string[] {
  const before = readZip(original);
  const after = new Map(readZip(patched).map((e) => [e.name, e]));
  const allowed = new Set([...patch.changedParts, ...patch.removedParts]);
  const problems: string[] = [];
  for (const e of before) {
    if (allowed.has(e.name)) continue;
    const now = after.get(e.name);
    if (!now || now.method !== e.method || now.crc !== e.crc || !now.packed.equals(e.packed)) problems.push(e.name);
  }
  for (const name of after.keys()) if (!before.some((e) => e.name === name)) problems.push(name);
  return problems;
}

/**
 * The new bytes for the file, checked: read back, only the intended cells differ, every other ZIP
 * entry is the original's, and (when the file's stored results could be trusted) the stored results
 * of the new file are the ones its formulas give.
 */
export function buildPatched(original: Buffer, loaded: LoadedWorkbook, cells: WrittenCells): { bytes: Buffer; patch: PatchResult; recalculated: number } {
  const input = {
    numbers: cells.changes.map((c) => ({ sheet: c.sheet, address: c.address, value: c.after })),
    texts: cells.statusChanges.map((c) => ({ sheet: c.sheet, address: c.address, text: c.after })),
  };
  const verified = loaded.selfCheck.state === 'verified';
  let cached: CachedEdit[] = [];
  let patch: PatchResult;
  try {
    patch = patchXlsx(original, input, loaded.workbook);
    if (verified) {
      // stored results are refreshed only when this engine reproduced every one Excel stored
      cached = staleResults(loaded, patch.bytes, new Set([...input.numbers, ...input.texts].map(cellKey)));
      if (cached.length) patch = patchXlsx(original, { ...input, cached }, loaded.workbook);
    }
  } catch (e) {
    if (e instanceof PatchError) throw conflict(`This cell cannot be written: ${e.message}`, { code: 'CELL_NOT_WRITABLE', reason: e.code });
    throw e;
  }
  const failed = (problems: string[]): never => {
    throw new HttpError(500, `The new file did not pass its check, so nothing was written: ${problems.slice(0, 5).join('; ')}`, { code: 'VERIFY_FAILED', problems });
  };
  const after = readWorkbook(patch.bytes);
  const cellProblems = unintendedDifferences(loaded.workbook, after, cells, cached, patch.cacheDropped);
  if (cellProblems.length) failed(cellProblems);
  const partProblems = unintendedParts(original, patch.bytes, patch);
  if (partProblems.length) failed(partProblems.map((p) => `part ${p} changed and was not meant to`));
  if (verified) {
    const engine = createEngine(after);
    try {
      const check = engine.selfCheck();
      if (check.state === 'mismatch') failed(check.mismatches.map((m) => `${m.sheet}!${m.address} stores a result its formula does not give`));
    } finally {
      engine.dispose();
    }
  }
  return { bytes: patch.bytes, patch, recalculated: cached.length };
}

const BACKUP_NAME = /^\d{8}-\d{6}(?:_\d{2})?-.+\.xlsx$/i;

export const backupDirFor = (dataDir: string, projectId: string) => path.join(dataDir, BACKUP_FOLDER, projectId.replace(/[^A-Za-z0-9_-]/g, '_'));

/** Copies the original bytes into the project's backup folder, checks the copy, and keeps the newest BACKUPS_KEPT. Returns the new file. */
export function backupOriginal(dataDir: string, projectId: string, name: string, bytes: Buffer, now: Date): string {
  const dir = backupDirFor(dataDir, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = fileStamp(now);
  let copy = path.join(dir, `${stamp}-${name}`);
  // two writes within one second
  for (let n = 2; fs.existsSync(copy); n++) copy = path.join(dir, `${stamp}_${String(n).padStart(2, '0')}-${name}`);
  try {
    fs.writeFileSync(copy, bytes, { flag: 'wx' });
    if (sha256Hex(fs.readFileSync(copy)) !== sha256Hex(bytes)) throw new Error('The backup copy does not match the original');
  } catch (e) {
    // a copy that is not the original must not sit among the backups, where it would also push a good one out
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') fs.rmSync(copy, { force: true });
    throw e;
  }
  const all = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_NAME.test(f))
    .sort()
    .reverse();
  for (const old of all.slice(BACKUPS_KEPT)) if (path.join(dir, old) !== copy) fs.rmSync(path.join(dir, old), { force: true });
  return copy;
}

/** Puts `bytes` in place of `file` through the temp file next to it, keeping the mode. */
function replaceFile(file: string, bytes: Buffer, mode: number, beforeRename?: () => void): void {
  const tmp = tempPathFor(file);
  let made = false;
  try {
    // what is left of an interrupted write is this module's own and is overwritten; anything else at that name
    // (a link, which a write would follow out of the folder, or a folder) is left alone and the write refused
    const left = fs.lstatSync(tmp, { throwIfNoEntry: false });
    if (left && !left.isFile()) throw new Error(`${path.basename(tmp)} in the folder of the file is not a file`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), mode);
    made = true;
    try {
      // one call may write only part of the bytes
      for (let at = 0; at < bytes.length; ) {
        const n = fs.writeSync(fd, bytes, at, bytes.length - at);
        if (n <= 0) throw new Error('the temp file took no more bytes');
        at += n;
      }
      // the mode asked for at creation is cut by the umask
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // only bytes that are on disk exactly as they were checked go over the user's file
    if (!fs.readFileSync(tmp).equals(bytes)) throw new Error('the temp file does not hold what was written to it');
    beforeRename?.();
    fs.renameSync(tmp, file);
  } catch (e) {
    // the temp file is this module's own; the linked file was not touched
    if (made) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // it could not be removed: the next write overwrites it
      }
    }
    throw e;
  }
}

const queues = new Map<string, Promise<unknown>>();

/** One write to a file at a time. */
function inTurn<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(file) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(file, tail);
  void tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return run;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const lockedError = () => new HttpError(423, 'Excel has the file open; close it in Excel, then write again', { code: 'FILE_LOCKED' });
const changedError = (sha256: string | null) => conflict('The Excel file changed after it was loaded; nothing was written', { code: 'FILE_CHANGED', sha256 });

/** Writes the request into the linked file. Throws HttpError (409 FILE_CHANGED, 423 FILE_LOCKED, …) without writing when a check fails. */
export function writeBack(ctx: WriteContext, req: WorkbookWriteRequest): Promise<WriteOutcome> {
  return inTurn(ctx.absPath, async () => {
    const file = ctx.absPath;
    const read = await readWorkbookFile(file, ctx.fileDeps);
    if (read.state !== 'ok' || !read.bytes || !read.sha256) throw conflict('The linked Excel file cannot be read right now', { code: 'WORKBOOK_UNREADABLE', state: read.state, reason: read.reason });
    if (read.sha256 !== req.baseSha) throw changedError(read.sha256);
    if (read.excelOpen) throw lockedError();
    const original = read.bytes;
    let loaded: LoadedWorkbook;
    try {
      loaded = ctx.load(original, read.sha256);
    } catch (e) {
      if (e instanceof XlsxError) throw conflict('The linked Excel file cannot be read right now', { code: 'WORKBOOK_UNREADABLE', state: 'unreadable', reason: e.code });
      throw e;
    }
    const cells = resolveCells(loaded, req);
    const { bytes: patched } = buildPatched(original, loaded, cells);
    const afterSha = sha256Hex(patched);

    const mode = fs.statSync(file).mode & 0o7777;
    // a rename replaces a file whatever its own permissions say; a file nobody may write to is the user's "do not change this"
    if ((mode & 0o222) === 0) throw new HttpError(403, 'The Excel file is marked read-only, so nothing was written', { code: 'FILE_READ_ONLY' });
    let backup: string;
    try {
      backup = backupOriginal(ctx.dataDir, ctx.projectId, path.basename(file), original, ctx.now?.() ?? new Date());
    } catch (e) {
      throw new HttpError(500, `The copy of the original could not be made, so nothing was written (${errorText(e)})`, { code: 'BACKUP_FAILED', reason: errorText(e) });
    }
    const backupFile = path.relative(ctx.dataDir, backup).split(path.sep).join('/');
    try {
      replaceFile(file, patched, mode, () => {
        // the last moment the original is still there: it must be the file that was read, and not open in Excel
        if (fs.existsSync(excelLockPath(file))) throw lockedError();
        const now = sha256Hex(fs.readFileSync(file));
        if (now !== req.baseSha) throw changedError(now);
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // the rename did not happen: the file is as it was. A background service is often allowed to read a folder and not to write in it
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new HttpError(403, `The Mac did not let the Research Workbench service write in the folder of the Excel file (${code}); nothing was written`, { code: 'WRITE_DENIED', reason: code });
      throw new HttpError(500, `Writing to the Excel file failed (${errorText(e)}). The file was not changed`, { code: 'WRITE_FAILED', restored: true, backupFile, reason: errorText(e) });
    }

    try {
      ctx.afterRename?.();
      const check = await readWorkbookFile(file, ctx.fileDeps);
      if (check.state !== 'ok' || check.sha256 !== afterSha || check.size !== patched.length) throw new Error(`the file read back after the write is not the one written (${check.state}${check.reason ? `, ${check.reason}` : ''})`);
      const id = ctx.db.transaction(() => {
        const row = ctx.db
          .prepare('INSERT INTO workbook_writes (project_id, rel_path, at, actor, cells_json, before_sha256, before_size, after_sha256, after_size, backup_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ctx.projectId, ctx.relPath, nowIso(), currentActor(), JSON.stringify(cells), req.baseSha, original.length, afterSha, patched.length, backupFile);
        const writeId = Number(row.lastInsertRowid);
        audit(ctx.db, ctx.projectId, 'workbook', String(writeId), 'update', { path: ctx.relPath, sha256: req.baseSha, size: original.length }, { path: ctx.relPath, sha256: afterSha, size: patched.length, backupFile, ...cells });
        return writeId;
      })();
      return { id, beforeSha: req.baseSha, afterSha, afterSize: patched.length, backupFile, cells };
    } catch (e) {
      const reason = errorText(e);
      let restored = false;
      try {
        const saved = fs.readFileSync(backup);
        replaceFile(file, saved, mode);
        restored = sha256Hex(fs.readFileSync(file)) === req.baseSha;
      } catch {
        restored = false;
      }
      throw new HttpError(
        500,
        restored ? `Writing to the Excel file failed (${reason}). The file was put back as it was before` : `Writing to the Excel file failed (${reason}) and the file could not be put back. The copy from before the write is ${backup}`,
        { code: 'WRITE_FAILED', restored, backupFile, reason },
      );
    }
  });
}

interface WriteRow {
  id: number;
  at: string;
  cells_json: string;
  before_sha256: string;
  after_sha256: string;
}

/**
 * Whether an older version of the file is back (iCloud does that when two devices disagree): the
 * file is byte for byte what it was before an earlier write, and not what the latest write left.
 * Returns the cells of the writes that are no longer in it, the later write winning, each matched
 * to an assumption of the file as it is now.
 */
export function detectRevert(db: DB, projectId: string, relPath: string, sha256: string | null, loaded: LoadedWorkbook | null): WorkbookRevertDTO | null {
  if (!sha256) return null;
  const rows = db.prepare('SELECT id, at, cells_json, before_sha256, after_sha256 FROM workbook_writes WHERE project_id = ? AND rel_path = ? ORDER BY id').all(projectId, relPath) as WriteRow[];
  const latest = rows[rows.length - 1];
  if (!latest || latest.after_sha256 === sha256) return null;
  let from = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].before_sha256 === sha256) {
      from = i;
      break;
    }
  }
  if (from < 0) return null;
  const lost = rows.slice(from);
  const changes = new Map<string, WrittenCell>();
  const statusChanges = new Map<string, WrittenStatus>();
  for (const row of lost) {
    const cells = parseJson<Partial<WrittenCells>>(row.cells_json, {});
    for (const c of cells.changes ?? []) changes.set(cellKey(c), c);
    for (const s of cells.statusChanges ?? []) statusChanges.set(cellKey(s), s);
  }
  const assumptions = loaded?.detect.assumptions ?? [];
  const byValue = (c: CellRef) => assumptions.find((a) => a.sheet === c.sheet && a.valueCell === c.address)?.id ?? null;
  const byStatus = (c: CellRef) => assumptions.find((a) => a.sheet === c.sheet && a.statusCell === c.address && a.status === 'needs-decision')?.id ?? null;
  return {
    writtenAt: lost[0].at,
    writes: lost.length,
    changes: [...changes.values()].map((c) => ({ id: byValue(c), sheet: c.sheet, address: c.address, label: c.label, value: c.after })),
    statusChanges: [...statusChanges.values()].map((s) => ({ id: byStatus(s), sheet: s.sheet, address: s.address, label: s.label })),
  };
}
