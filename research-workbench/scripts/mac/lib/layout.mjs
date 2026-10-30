/**
 * Where the Mac installer puts things. Pure: everything takes the home folder and platform as
 * arguments, so the layout is unit-tested on Linux.
 *
 *   ~/ResearchWorkbench/runtime/node-v24.22.2-darwin-arm64/   bundled Node (written by install.sh)
 *   ~/ResearchWorkbench/runtime/current -> node-v…             stable Node path used by the LaunchAgent
 *   ~/ResearchWorkbench/app-<sha7>/                            one folder per installed release
 *   ~/ResearchWorkbench/current -> app-<sha7>                  the version launchd runs
 *   ~/Library/Application Support/ResearchWorkbench/           data (database, attachments, backups/)
 *   ~/Library/Logs/ResearchWorkbench/                          server and install logs
 *
 * On Linux (CI and dry runs only) data and logs go to the XDG equivalents.
 */
import path from 'node:path';

export const REPO = 'zyaoceng/organism';
export const BRANCH = 'claude/vibrant-thompson-s3npyj';
export const APP_SUBDIR = 'research-workbench';
export const LABEL = 'com.researchworkbench';
export const APP_NAME = '研究工作台';
export const DEFAULT_PORT = 4310;
/** The one-liner the user pastes into Terminal; re-running it is the update. */
export const ONE_LINER = `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/${APP_SUBDIR}/scripts/mac/install.sh)"`;

/**
 * @param {{ home: string, platform?: string, serviceNode?: string }} o
 *   serviceNode: the Node the LaunchAgent runs; defaults to runtime/current/bin/node (WB_NODE overrides it in tests).
 */
export function layout({ home, platform = process.platform, serviceNode }) {
  if (!path.isAbsolute(home)) throw new Error(`home must be absolute: ${home}`);
  const mac = platform === 'darwin';
  const root = path.join(home, 'ResearchWorkbench');
  const dataDir = mac ? path.join(home, 'Library', 'Application Support', 'ResearchWorkbench') : path.join(home, '.local', 'share', 'research-workbench');
  const logsDir = mac ? path.join(home, 'Library', 'Logs', 'ResearchWorkbench') : path.join(home, '.local', 'state', 'research-workbench', 'logs');
  const node = serviceNode ?? path.join(root, 'runtime', 'current', 'bin', 'node');
  return {
    home,
    mac,
    root,
    runtimeDir: path.join(root, 'runtime'),
    node,
    nodeBin: path.dirname(node),
    current: path.join(root, 'current'),
    settings: path.join(root, 'settings.json'),
    lock: path.join(root, '.install.lock'),
    dataDir,
    backupsDir: path.join(dataDir, 'backups'),
    logsDir,
    stdoutLog: path.join(logsDir, 'server.out.log'),
    stderrLog: path.join(logsDir, 'server.err.log'),
    installLog: path.join(logsDir, 'install.log'),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    launcher: path.join(home, 'Applications', `${APP_NAME}.app`),
    downloadsArchive: path.join(home, 'Downloads', 'wb-data.tgz'),
  };
}

/** `app-<sha7>` for a release; `app-<sha7>-local` (or `app-local`) for an install from a checkout. */
export function appDirName({ commit, local }) {
  const short = commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : null;
  if (!local) {
    if (!short) throw new Error(`not a commit sha: ${commit}`);
    return `app-${short}`;
  }
  return short ? `app-${short}-local` : 'app-local';
}

/** Every folder the installer creates under ~/ResearchWorkbench for a version: final, `.partial` and set-aside `.old-*`. */
export const isAppDir = (name) => /^app-[0-9a-z-]+(\.partial|\.old-\d+)?$/.test(name);

/** Paths (relative to the app root, `/`-separated) not copied by --source-dir: build output, local data, caches. */
const EXCLUDED = ['node_modules', 'dist', 'data', 'e2e/output', '.vite', '.git'];
export function shouldCopy(rel) {
  const r = rel.split(path.sep).join('/').replace(/^\.\//, '');
  if (r === '' || r === '.') return true;
  if (r.split('/').pop() === '.DS_Store') return false;
  return !EXCLUDED.some((x) => r === x || r.startsWith(`${x}/`));
}

/** wb-data.tgz → wb-data.imported-2026-10-30.tgz (next to it), so a re-run does not import it again. */
export function importedArchiveName(file, date = new Date(), exists = () => false) {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/\.(tgz|tar\.gz)$/i, '');
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const first = path.join(dir, `${base}.imported-${day}.tgz`);
  if (!exists(first)) return first;
  return path.join(dir, `${base}.imported-${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.tgz`);
}

/** Replace the home folder with ~ for messages (never for files launchd reads). */
export const tilde = (p, home) => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
