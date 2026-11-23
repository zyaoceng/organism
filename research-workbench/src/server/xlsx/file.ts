/**
 * The linked Excel file on disk: where it may be (inside the vault folder, ending in .xlsx), what
 * state it is in, and its bytes with their SHA-256. Nothing here writes.
 *
 * The vault is usually in iCloud. macOS may keep only a placeholder of a file ("dataless": the name
 * and size are there, the content is in the cloud); reading one from a background service blocks
 * or fails, so it is detected first, the download is requested with `brctl`, and the file is polled
 * until its content has arrived. Programs are run through FileDeps so tests need neither macOS
 * nor iCloud.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ok: read. missing: no such file. dataless: still in iCloud (download requested). denied: macOS or
 * the file's permissions keep this process out. locked: another program holds it or is writing it.
 * unreadable: anything else (not a regular file, I/O error; `reason` says which).
 */
export type WorkbookFileState = 'ok' | 'missing' | 'dataless' | 'denied' | 'locked' | 'unreadable';

export interface FileDeps {
  platform: NodeJS.Platform;
  /** Runs a program and waits for it; never throws (status null when it could not start). */
  run: (cmd: string, args: string[]) => Promise<{ status: number | null; stdout: string }>;
  sleep: (ms: number) => Promise<void>;
  stat: (file: string) => fs.Stats;
  /** How long to wait for iCloud after asking for a download. */
  downloadTimeoutMs: number;
  pollMs: number;
}

export const STAT_PROGRAM = '/usr/bin/stat';
export const BRCTL_PROGRAM = '/usr/bin/brctl';

export const defaultFileDeps: FileDeps = {
  platform: process.platform,
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 10_000, encoding: 'utf8' }, (err, stdout) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({ status: err ? (typeof code === 'number' ? code : null) : 0, stdout: String(stdout ?? '') });
      });
    }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  stat: (file) => fs.statSync(file),
  downloadTimeoutMs: 15_000,
  pollMs: 500,
};

export type WorkbookPathErrorCode = 'no-vault' | 'outside-vault' | 'not-xlsx';

export class WorkbookPathError extends Error {
  constructor(
    public readonly code: WorkbookPathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkbookPathError';
  }
}

const errno = (e: unknown): string => (typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : 'ERROR');
const isInside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Excel's lock file next to an open workbook: "~$" + the file name. */
export const excelLockPath = (file: string) => path.join(path.dirname(file), `~$${path.basename(file)}`);
/** What iCloud left in place of a file that is not downloaded, before macOS 14: ".<name>.icloud". */
export const legacyPlaceholderPath = (file: string) => path.join(path.dirname(file), `.${path.basename(file)}.icloud`);

/**
 * The absolute path of a vault-relative .xlsx. The real path (symlinks followed, for a file that
 * does not exist yet: of the deepest folder that does) must stay under the vault's real path.
 */
export function resolveInVault(vaultDir: string, relPath: string): string {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0') || path.isAbsolute(relPath)) throw new WorkbookPathError('outside-vault', 'The path must be relative to the vault folder');
  let root: string;
  try {
    root = fs.realpathSync(vaultDir);
  } catch (e) {
    throw new WorkbookPathError('no-vault', `The vault folder cannot be opened (${errno(e)})`);
  }
  const wanted = path.resolve(root, relPath);
  if (!isInside(root, wanted) || wanted === root) throw new WorkbookPathError('outside-vault', 'The file must be inside the vault folder');
  const base = path.basename(wanted);
  if (!/\.xlsx$/i.test(base) || base.startsWith('~$')) throw new WorkbookPathError('not-xlsx', 'Only .xlsx files can be linked');
  // follow symlinks as far as the path exists
  let existing = wanted;
  const rest: string[] = [];
  let real: string | null = null;
  for (;;) {
    try {
      real = fs.realpathSync(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = real === null ? wanted : path.join(real, ...rest);
  if (!isInside(root, resolved) || resolved === root) throw new WorkbookPathError('outside-vault', 'The file must be inside the vault folder');
  if (!/\.xlsx$/i.test(path.basename(resolved))) throw new WorkbookPathError('not-xlsx', 'Only .xlsx files can be linked');
  return resolved;
}

export interface WorkbookFileInfo {
  state: WorkbookFileState;
  /** Why it is not ok: an errno (EACCES…), 'not-a-file', 'too-large' or 'changing'. */
  reason: string | null;
  size: number | null;
  mtimeMs: number | null;
  /** Excel's lock file is next to it: the workbook is open in Excel. */
  excelOpen: boolean;
}

export interface WorkbookFileRead extends WorkbookFileInfo {
  bytes: Buffer | null;
  sha256: string | null;
}

/** A file larger than this is not read: no model is, and every request would hold it in memory. */
export const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;

export const sha256Hex = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

async function isDataless(file: string, st: fs.Stats, deps: FileDeps): Promise<boolean> {
  if (deps.platform !== 'darwin') return false;
  // `stat -f %Sf` prints the file flags by name, e.g. "compressed,dataless"
  const r = await deps.run(STAT_PROGRAM, ['-f', '%Sf', file]);
  if (r.status === 0) return r.stdout.trim().split(/[,\s]+/).includes('dataless');
  // a placeholder has its full size and no blocks on disk
  return st.blocks === 0 && st.size > 0;
}

/** The file's state without reading it. */
export async function inspectFile(file: string, deps: FileDeps = defaultFileDeps): Promise<WorkbookFileInfo> {
  const excelOpen = fs.existsSync(excelLockPath(file));
  const none = (state: WorkbookFileState, reason: string | null): WorkbookFileInfo => ({ state, reason, size: null, mtimeMs: null, excelOpen });
  let st: fs.Stats;
  try {
    st = deps.stat(file);
  } catch (e) {
    const code = errno(e);
    // a name too long for the file system cannot be a file that is there
    if (code === 'ENAMETOOLONG') return none('missing', code);
    if (code === 'ENOENT' || code === 'ENOTDIR') return fs.existsSync(legacyPlaceholderPath(file)) ? none('dataless', null) : none('missing', code);
    return none(code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unreadable', code);
  }
  if (!st.isFile()) return none('unreadable', 'not-a-file');
  const dataless = await isDataless(file, st, deps);
  return { state: dataless ? 'dataless' : 'ok', reason: null, size: st.size, mtimeMs: st.mtimeMs, excelOpen };
}

function readState(code: string): WorkbookFileState {
  if (code === 'EACCES' || code === 'EPERM') return 'denied';
  if (code === 'ENOENT') return 'missing';
  // what macOS answers when a process may not trigger the download of a dataless file
  if (code === 'EDEADLK') return 'dataless';
  if (code === 'EBUSY' || code === 'EAGAIN' || code === 'ETXTBSY') return 'locked';
  return 'unreadable';
}

/**
 * Reads the file. A dataless file is asked for (`brctl download`) and waited on for
 * `downloadTimeoutMs`; when it has not arrived by then the state stays 'dataless' and the next call
 * tries again. A file that changes while it is read is read once more, then reported as 'locked'.
 */
export async function readWorkbookFile(file: string, deps: FileDeps = defaultFileDeps): Promise<WorkbookFileRead> {
  let info = await inspectFile(file, deps);
  if (info.state === 'dataless') {
    await deps.run(BRCTL_PROGRAM, ['download', file]);
    for (let waited = 0; info.state === 'dataless' && waited < deps.downloadTimeoutMs; waited += deps.pollMs) {
      await deps.sleep(deps.pollMs);
      info = await inspectFile(file, deps);
    }
  }
  if (info.state !== 'ok') return { ...info, bytes: null, sha256: null };
  if ((info.size ?? 0) > MAX_WORKBOOK_BYTES) return { ...info, state: 'unreadable', reason: 'too-large', bytes: null, sha256: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    let bytes: Buffer;
    let after: fs.Stats;
    try {
      bytes = fs.readFileSync(file);
      after = deps.stat(file);
    } catch (e) {
      const code = errno(e);
      return { ...info, state: readState(code), reason: code, bytes: null, sha256: null };
    }
    if (after.size === bytes.length && after.mtimeMs === info.mtimeMs) return { ...info, bytes, sha256: sha256Hex(bytes) };
    info = { ...info, size: after.size, mtimeMs: after.mtimeMs };
  }
  return { ...info, state: 'locked', reason: 'changing', bytes: null, sha256: null };
}

export interface VaultAccess {
  readable: boolean;
  /** errno when it is not, e.g. EPERM (macOS privacy settings) or ENOENT. */
  reason: string | null;
}

/** Whether this process can list the vault folder (a background service may be refused where Terminal is not). */
export function vaultAccess(vaultDir: string): VaultAccess {
  try {
    fs.readdirSync(vaultDir);
    return { readable: true, reason: null };
  } catch (e) {
    return { readable: false, reason: errno(e) };
  }
}

export interface VaultFileEntry {
  /** Relative to the vault folder, with "/". */
  path: string;
  name: string;
  /** Null for a placeholder, whose own size says nothing. */
  size: number | null;
  mtimeMs: number | null;
  dataless: boolean;
}

export const MAX_LISTED_FILES = 500;
const MAX_VISITED_DIRS = 5000;

/**
 * Every .xlsx in the vault, newest first. Hidden folders (.obsidian, .trash), Excel lock files and
 * symlinked folders are skipped; a folder that cannot be read is skipped too.
 */
export function listVaultXlsx(vaultDir: string, deps: Pick<FileDeps, 'platform'> = defaultFileDeps, limit = MAX_LISTED_FILES): { files: VaultFileEntry[]; truncated: boolean } {
  const files: VaultFileEntry[] = [];
  const queue = [''];
  let visited = 0;
  let truncated = false;
  while (queue.length) {
    const rel = queue.shift()!;
    if (++visited > MAX_VISITED_DIRS) {
      truncated = true;
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(vaultDir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) queue.push(relPath);
        continue;
      }
      if (!e.isFile()) continue;
      const placeholder = /^\.(.+\.xlsx)\.icloud$/i.exec(e.name);
      if (placeholder) {
        files.push({ path: rel ? `${rel}/${placeholder[1]}` : placeholder[1], name: placeholder[1], size: null, mtimeMs: null, dataless: true });
        continue;
      }
      if (!/\.xlsx$/i.test(e.name) || e.name.startsWith('~$') || e.name.startsWith('.')) continue;
      try {
        const st = fs.statSync(path.join(vaultDir, relPath));
        files.push({ path: relPath, name: e.name, size: st.size, mtimeMs: st.mtimeMs, dataless: deps.platform === 'darwin' && st.blocks === 0 && st.size > 0 });
      } catch {
        // gone or not ours to read: not listed
      }
    }
  }
  files.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || a.path.localeCompare(b.path));
  if (files.length > limit) truncated = true;
  return { files: files.slice(0, limit), truncated };
}
