#!/usr/bin/env node
/**
 * Research Workbench installer for macOS. scripts/mac/install.sh downloads the bundled Node and runs
 * this file with it; it uses only Node built-ins and the pure helpers in ./lib, so it works before
 * `npm ci`.
 *
 *   install.mjs [--yes] [--port <n>] [--import <wb-data.tgz>] [--no-register]   install, or update to release.json's commit
 *   install.mjs --dry-run | --doctor | --uninstall [--purge]
 *   install.mjs --source-dir <checkout> [--no-launchd]             CI: install a local checkout
 *
 * Re-running is the update: the new version is built in its own ~/ResearchWorkbench/app-<sha7>
 * folder next to the running one, `current` is switched over, and if /api/health does not answer
 * within 60 s the previous version, its LaunchAgent and the database as it was before the switch are
 * put back. After that the AI apps found on this Mac are pointed at the MCP adapter (lib/register.mjs).
 * Environment overrides (tests and install.sh):
 * WB_SOURCE_DIR, WB_RELEASE_COMMIT (skip reading release.json), WB_NODE (the Node the service runs).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ArgsError, HELP, parseInstallArgs } from './lib/args.mjs';
import { appUrl, checkHealth, healthUrl, waitForHealth } from './lib/health.mjs';
import { launchAgent, parseLaunchctlPrint, parseLsof, parsePrintDisabled, renderPlist, serviceTarget } from './lib/launchd.mjs';
import { launcherScript, osacompileArgs } from './lib/launcher.mjs';
import { APP_NAME, DEFAULT_PORT, ONE_LINER, appDirName, importedArchiveName, layout, shouldCopy, tilde } from './lib/layout.mjs';
import { appDirsToDelete } from './lib/prune.mjs';
import { detectTargets, registerAll, registrationStatus } from './lib/register.mjs';
import { ReleaseError, isCommit, parseRelease, releaseUrl, tarExtractArgs, tarballUrl } from './lib/release.mjs';
import { finalMessage, formatBytes, formatDoctorReport, formatImportSummary, lastJsonLine, registrationCheck, summarizeDiagnostics } from './lib/report.mjs';
import { nodeForMacos } from './lib/system.mjs';

class InstallError extends Error {
  constructor(zh, en, details = []) {
    super(`${zh} / ${en}`);
    this.details = details;
  }
}

const isCi = !!process.env.CI;
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const MARKER = '.wb-install.json';
const say = (zh, en) => console.log(`==> ${zh} / ${en}`);
const ok = (zh, en) => console.log(`    OK  ${zh} / ${en}`);
const warn = (zh, en) => console.log(`    !!  ${zh} / ${en}`);
const info = (zh, en) => console.log(`    --  ${zh} / ${en}`);
const plan = (zh, en) => console.log(`    [dry-run] ${zh} / ${en}`);
const fail = (zh, en, details) => {
  throw new InstallError(zh, en, details);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fs.existsSync(p);

/** Write a GitHub Actions step output (the macOS workflow reads launchd=ok|skipped). */
function ciOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// ------------------------------------------------------------ processes

/** Run to completion and capture output; never throws. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
}

const hasCommand = (cmd) => run('/bin/sh', ['-c', `command -v ${cmd}`]).status === 0;

/** PATH starts with the Node that runs this script (the bundled one), then the system folders. */
function childEnv(extra = {}) {
  const bin = path.dirname(process.execPath);
  const rest = (process.env.PATH ?? '').split(':').filter((p) => p && p !== bin && !SYSTEM_PATH.includes(p));
  return {
    ...process.env,
    PATH: [bin, ...SYSTEM_PATH, ...rest].join(':'),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...extra,
  };
}

/** Long commands (npm) write to the install log; in CI they print straight to the job log. */
function runLogged(title, cmd, args, { cwd, env, logFile }) {
  fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} ${title}: ${cmd} ${args.join(' ')}  (in ${cwd})\n`);
  const fd = isCi ? null : fs.openSync(logFile, 'a');
  try {
    const r = spawnSync(cmd, args, { cwd, env, stdio: fd === null ? 'inherit' : ['ignore', fd, fd] });
    return r.error ? -1 : r.status;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function tail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}

function download(url, file) {
  const r = run('curl', ['-fL', '--retry', '3', '--connect-timeout', '20', isCi ? '-sS' : '--progress-bar', '-o', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) fail('下載失敗，請確認網路連線後重試', `download failed: ${url}`);
}

function fetchText(url) {
  const r = run('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '20', url]);
  if (r.status !== 0) fail('無法連線到 GitHub，請確認網路連線後重試', `cannot fetch ${url}`, [r.stderr.trim()]);
  return r.stdout;
}

// ------------------------------------------------------------ prompts (always from /dev/tty: stdin may be the piped script)

function readTtyLine(prompt) {
  let fd;
  try {
    fd = fs.openSync('/dev/tty', 'r+');
  } catch {
    return null;
  }
  try {
    fs.writeSync(fd, prompt);
    const buf = Buffer.alloc(256);
    let s = '';
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        if (e.code !== 'EAGAIN') throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      if (n <= 0) break;
      s += buf.toString('utf8', 0, n);
      if (s.includes('\n')) break;
    }
    return s.split('\n')[0].replace(/\r$/, '').trim();
  } finally {
    fs.closeSync(fd);
  }
}

function ask(o, question, defaultYes) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  if (o.yes) {
    console.log(`${question} ${hint} ${defaultYes ? 'y' : 'n'}  (--yes)`);
    return defaultYes;
  }
  const a = readTtyLine(`${question} ${hint} `);
  if (a === null) {
    console.log(`${question} ${hint} ${defaultYes ? 'y' : 'n'}  （沒有可輸入的終端機，用預設答案 / no terminal, default answer）`);
    return defaultYes;
  }
  return a === '' ? defaultYes : /^(y|yes|是|好|對)$/i.test(a);
}

/** A confirmation that has to be typed out; never answered by --yes. */
function askTyped(question, word) {
  const a = readTtyLine(`${question}\n請輸入 ${word} 確認，直接按 Enter 取消 / type ${word} to confirm: `);
  return a !== null && a.toLowerCase() === word;
}

// ------------------------------------------------------------ launchd and the port

const uid = () => process.getuid();
const target = () => serviceTarget(uid());

function jobInfo() {
  const r = run('launchctl', ['print', target()]);
  return r.status === 0 ? parseLaunchctlPrint(r.stdout) : null;
}
function jobDisabled() {
  const r = run('launchctl', ['print-disabled', `gui/${uid()}`]);
  return r.status === 0 ? parsePrintDisabled(r.stdout) : null;
}

/** `launchctl bootout` (errors ignored: usually "not loaded"), wait for the job to go, then the 2 s settle time. */
async function stopService() {
  run('launchctl', ['bootout', target()]);
  for (let i = 0; i < 20 && jobInfo(); i++) await sleep(500);
  await sleep(2000);
}

/** `launchctl enable` + `bootstrap`; one retry after another bootout (bootstrap fails with error 5 when a stale job lingers). */
async function startService(plist) {
  run('launchctl', ['enable', target()]);
  let r = run('launchctl', ['bootstrap', `gui/${uid()}`, plist]);
  if (r.status !== 0) {
    await stopService();
    run('launchctl', ['enable', target()]);
    r = run('launchctl', ['bootstrap', `gui/${uid()}`, plist]);
  }
  return r;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function portListeners(port) {
  if (!hasCommand('lsof')) return [];
  return parseLsof(run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']).stdout);
}

/** Free, or held by our own LaunchAgent (which the switch restarts anyway). */
async function portStatus(port, launchd) {
  if (await portFree(port)) return { free: true, ours: false, who: '' };
  const listeners = portListeners(port);
  const pid = launchd ? jobInfo()?.pid : undefined;
  const ours = pid !== undefined && listeners.some((l) => l.pid === pid);
  return { free: false, ours, who: listeners.map((l) => `${l.command} (pid ${l.pid})`).join(', ') || '?' };
}

const portBusy = (port, who) =>
  fail(`埠 ${port} 已經被其他程式使用：${who}`, `port ${port} is in use by ${who}`, [
    '請關閉那個程式（例如另一個終端機裡的 npm start）後再執行一次，',
    `或改用其他埠 / or use another port: ${ONE_LINER} -- --port 4320`,
  ]);

// ------------------------------------------------------------ the app folder

function gitHead(dir) {
  // on a Mac without the Command Line Tools `git` is a stub that opens an install dialog
  if (process.platform === 'darwin' && run('xcode-select', ['-p']).status !== 0) return null;
  const r = run('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return r.status === 0 && isCommit(r.stdout.trim()) ? r.stdout.trim() : null;
}

function resolveRelease(o) {
  if (o.sourceDir) {
    if (!exists(path.join(o.sourceDir, 'package.json')) || !exists(path.join(o.sourceDir, 'package-lock.json'))) {
      fail('--source-dir 不是研究工作台的資料夾', `--source-dir has no package.json / package-lock.json: ${o.sourceDir}`);
    }
    const commit = isCommit(process.env.GITHUB_SHA) ? process.env.GITHUB_SHA : gitHead(o.sourceDir);
    return { commit, local: true, label: `本機資料夾 local checkout ${o.sourceDir}${commit ? ` (${commit.slice(0, 7)})` : ''}` };
  }
  const pinned = process.env.WB_RELEASE_COMMIT;
  if (pinned) {
    if (!isCommit(pinned)) fail('WB_RELEASE_COMMIT 不是完整的 commit', `WB_RELEASE_COMMIT is not a full commit sha: ${pinned}`);
    return { commit: pinned, local: false, label: `commit ${pinned.slice(0, 7)}` };
  }
  try {
    const r = parseRelease(fetchText(releaseUrl()));
    return { commit: r.commit, local: false, label: `commit ${r.short}${r.date ? ` (${r.date})` : ''}` };
  } catch (e) {
    if (e instanceof ReleaseError && e.code === 'PENDING') {
      fail('目前還沒有通過測試、可以安裝的版本（release.json 的 commit 是 pending），請稍後再試', 'no tested release yet: release.json says "pending"; try again later');
    }
    if (e instanceof ReleaseError) fail('release.json 格式錯誤', e.message);
    throw e;
  }
}

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

function sqliteLoads(dir, node = process.execPath) {
  return run(node, ['-e', "require('better-sqlite3')(':memory:').close()"], { cwd: dir, env: childEnv() });
}

/** A finished folder for this release, built by this Node ABI, can be reused as is. */
function reusable(dir, rel) {
  const m = readMarker(dir);
  return (
    !rel.local &&
    m?.commit === rel.commit &&
    m.modules === process.versions.modules &&
    m.arch === process.arch &&
    exists(path.join(dir, 'dist', 'client', 'index.html')) &&
    sqliteLoads(dir).status === 0
  );
}

function fetchRelease(commit, dest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-download-'));
  try {
    const archive = path.join(tmp, 'source.tar.gz');
    say(`下載研究工作台 ${commit.slice(0, 7)}`, `downloading ${tarballUrl(commit)}`);
    download(tarballUrl(commit), archive);
    const r = run('tar', tarExtractArgs(archive, dest, commit));
    if (r.status !== 0 || !exists(path.join(dest, 'package.json'))) fail('解壓縮失敗', 'could not extract research-workbench/ from the download', [r.stderr.trim()]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Download (or copy) into <name>.partial, npm ci, build, check better-sqlite3, then rename into place. */
function buildVersion(o, L, rel, finalDir) {
  const partial = `${finalDir}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  if (rel.local) {
    say('複製本機資料夾', `copying ${o.sourceDir}`);
    fs.cpSync(o.sourceDir, partial, { recursive: true, verbatimSymlinks: true, filter: (from) => shouldCopy(path.relative(o.sourceDir, from)) });
  } else fetchRelease(rel.commit, partial);
  fs.writeFileSync(path.join(partial, 'version.json'), `${JSON.stringify({ commit: rel.commit ?? 'local', installedAt: new Date().toISOString() }, null, 2)}\n`);

  const env = childEnv();
  const npm = path.join(path.dirname(process.execPath), 'npm');
  if (!exists(npm)) fail('找不到內建 Node 的 npm', `npm not found next to ${process.execPath}`);
  const logHint = isCi ? [] : [`完整記錄 / full log: ${tilde(L.installLog, L.home)}`];
  say('安裝套件 npm ci（約 1–3 分鐘）', 'installing packages (npm ci, 1-3 min)');
  if (runLogged('npm ci', npm, ['ci', '--no-audit', '--no-fund'], { cwd: partial, env, logFile: L.installLog }) !== 0) {
    fail('安裝套件失敗', 'npm ci failed', [...sqliteHint(partial), ...tail(L.installLog, 25), ...logHint]);
  }
  say('建置網頁介面 npm run build', 'building the web interface');
  if (runLogged('npm run build', npm, ['run', 'build'], { cwd: partial, env, logFile: L.installLog }) !== 0) {
    fail('建置失敗', 'npm run build failed', [...tail(L.installLog, 25), ...logHint]);
  }
  const s = sqliteLoads(partial);
  if (s.status !== 0) fail('資料庫元件 better-sqlite3 無法載入', 'better-sqlite3 does not load', [...sqliteHint(partial), ...s.stderr.trim().split('\n').slice(-8)]);
  ok('better-sqlite3 可以載入', 'better-sqlite3 loads');
  const marker = { commit: rel.commit, local: rel.local, node: process.version, modules: process.versions.modules, arch: process.arch, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(partial, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  return partial;
}

/** Only when npm fell back to compiling better-sqlite3 (no prebuilt binary) is Xcode relevant. */
function sqliteHint(dir) {
  const b = path.join(dir, 'node_modules', 'better-sqlite3', 'build');
  if (!exists(path.join(b, 'config.gypi')) && !exists(path.join(b, 'Makefile'))) return [];
  return [
    'better-sqlite3 沒有可用的預先編譯檔，改從原始碼編譯但失敗了。/ No prebuilt better-sqlite3; building it from source failed.',
    '請先在終端機執行 xcode-select --install 安裝「Xcode 命令列工具」，完成後再貼一次安裝指令。/ Install the Xcode Command Line Tools and re-run.',
  ];
}

const readLinkName = (link) => {
  try {
    return path.basename(fs.readlinkSync(link));
  } catch {
    return null;
  }
};

/** Atomically point ~/ResearchWorkbench/current at `name` (a sibling folder). */
function pointCurrent(L, name) {
  const tmp = `${L.current}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(name, tmp);
  fs.renameSync(tmp, L.current);
}

const DB_FILES = ['workbench.db', 'workbench.db-wal', 'workbench.db-shm'];
const rollbackDir = (L) => path.join(L.root, '.rollback-db');

/**
 * With the server stopped: copy the database files aside. A new version that fails its health check
 * may already have migrated them, and the previous version refuses a newer schema, so a rollback puts
 * this copy back. Clones on APFS, so it costs no space until one side changes.
 */
function snapshotDb(L) {
  const dir = rollbackDir(L);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!exists(path.join(L.dataDir, DB_FILES[0]))) return null;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of DB_FILES) {
    if (exists(path.join(L.dataDir, f))) fs.copyFileSync(path.join(L.dataDir, f), path.join(dir, f), fs.constants.COPYFILE_FICLONE);
  }
  return dir;
}

/** With the new version stopped: put the snapshot back (its -wal/-shm first go, or SQLite would apply them). */
function restoreDb(L, snap) {
  if (!snap || !exists(path.join(snap, DB_FILES[0]))) return;
  for (const f of [...DB_FILES.slice(1), 'workbench.db-journal']) fs.rmSync(path.join(L.dataDir, f), { force: true });
  for (const f of DB_FILES) {
    if (!exists(path.join(snap, f))) continue;
    const tmp = path.join(L.dataDir, `${f}.restore-${process.pid}`);
    fs.copyFileSync(path.join(snap, f), tmp, fs.constants.COPYFILE_FICLONE);
    fs.renameSync(tmp, path.join(L.dataDir, f));
  }
  ok('資料庫已還原成更新前的狀態', 'the database was put back as it was before the update');
}

function prune(L, current, previous) {
  const entries = fs
    .readdirSync(L.root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtimeMs: fs.statSync(path.join(L.root, d.name)).mtimeMs }));
  for (const name of appDirsToDelete({ entries, current, previous })) {
    fs.rmSync(path.join(L.root, name), { recursive: true, force: true });
    console.log(`    刪除舊版本 / removed old version ${name}`);
  }
}

function takeLock(L) {
  fs.mkdirSync(L.root, { recursive: true });
  try {
    fs.mkdirSync(L.lock);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(path.join(L.lock, 'pid'), 'utf8').trim()) || 0;
    } catch {
      /* no pid file: an installer stopped right after taking the lock */
    }
    let alive = false;
    try {
      alive = pid > 0 && process.kill(pid, 0);
    } catch {
      /* gone */
    }
    if (alive) fail('另一個安裝程式正在執行，請等它結束', `another installer is running (pid ${pid})`);
    fs.rmSync(L.lock, { recursive: true, force: true });
    fs.mkdirSync(L.lock);
  }
  fs.writeFileSync(path.join(L.lock, 'pid'), String(process.pid));
  return () => fs.rmSync(L.lock, { recursive: true, force: true });
}

function readSettings(L) {
  try {
    return JSON.parse(fs.readFileSync(L.settings, 'utf8'));
  } catch {
    return {};
  }
}

function writeFileAtomic(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------ steps

/** --import, else ~/Downloads/wb-data.tgz when present. macOS may refuse Terminal access to Downloads: say so instead of silently skipping. */
function findArchive(o, L) {
  if (o.importFile) return o.importFile;
  try {
    fs.statSync(L.downloadsArchive);
    return L.downloadsArchive;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      warn(
        '沒有權限讀取「下載項目」資料夾，無法檢查 wb-data.tgz。請到「系統設定 → 隱私權與安全性 → 檔案與資料夾 → 終端機」打開「下載項目」，再執行一次',
        `no permission to read ${tilde(L.downloadsArchive, L.home)} (${e.code}); allow Terminal to access the Downloads folder and re-run`,
      );
    }
    return null;
  }
}

/** Stop the service, show the archive summary, confirm, import; a second typed confirmation before replacing existing companies. */
async function importStep(o, L, appDir, launchd, port) {
  const file = findArchive(o, L);
  if (!file) return 'none';
  if (!exists(file)) fail('找不到要匯入的檔案', `import file not found: ${file}`);
  say(`找到舊資料 ${tilde(file, L.home)}，先停止服務並檢查內容`, 'found a data archive; stopping the service and checking it');
  if (launchd) await stopService();
  else if ((await checkHealth(healthUrl(port))).ok) fail(`有伺服器正在埠 ${port} 執行，匯入前請先停止它`, `a server is running on port ${port}; stop it before importing`);
  const cli = (extra) =>
    run(process.execPath, ['--import', 'tsx', 'src/server/cli/import-data.ts', '--archive', file, '--data-dir', L.dataDir, ...extra], { cwd: appDir, env: childEnv() });
  const check = cli(['--summary-only']);
  const summary = lastJsonLine(check.stdout);
  if (check.status !== 0 || !summary) {
    warn('這個資料檔不能匯入，已略過（檔案保留）', 'the archive was rejected and is kept; continuing without it');
    for (const l of check.stderr.trim().split('\n').slice(-8)) console.log(`        ${l}`);
    return 'rejected';
  }
  console.log(formatImportSummary(summary, path.basename(file)));
  if (!ask(o, '要匯入這些資料嗎？/ Import this data?', true)) {
    say('略過匯入，檔案保留，下次執行會再詢問', 'import skipped; the archive is kept');
    return 'declined';
  }
  let r = cli([]);
  if (r.status === 2) {
    warn('目前的資料庫裡已經有公司資料', 'the current database already has companies');
    if (o.yes) {
      warn('使用 --yes 時不會覆蓋現有資料；要覆蓋請不加 --yes 再執行一次', 'with --yes existing data is never replaced; re-run without --yes to replace it');
      return 'kept-existing';
    }
    if (!askTyped('要用匯入的資料「取代」目前的資料嗎？目前的資料庫會先備份到 backups/。/ Replace the current data (a backup is kept)?', 'yes')) {
      say('保留目前的資料，沒有匯入', 'kept the current data; nothing imported');
      return 'kept-existing';
    }
    r = cli(['--force']);
  }
  if (r.status !== 0) fail('匯入失敗，目前的資料沒有被修改', 'import failed', r.stderr.trim().split('\n').slice(-10));
  for (const l of r.stdout.trim().split('\n').slice(0, -1)) console.log(`    ${l}`);
  const done = importedArchiveName(file, new Date(), exists);
  fs.renameSync(file, done);
  ok(`匯入完成；資料檔已改名為 ${path.basename(done)}，重跑不會再匯入`, 'imported; the archive was renamed so a re-run does not import it again');
  return 'imported';
}

/** --no-launchd: start the server ourselves, wait for /api/health, stop it. */
async function smokeTest(L, port) {
  if (!(await portFree(port))) {
    warn(`埠 ${port} 被占用，略過啟動測試`, `port ${port} is busy; skipping the start-up test`);
    return 'skipped';
  }
  fs.mkdirSync(L.logsDir, { recursive: true });
  const out = fs.openSync(L.stdoutLog, 'a');
  const err = fs.openSync(L.stderrLog, 'a');
  const env = { ...childEnv(), WORKBENCH_DATA_DIR: L.dataDir, WORKBENCH_PORT: String(port), WORKBENCH_LOG_LEVEL: 'warn' };
  const child = spawn(L.node, ['--import', 'tsx', 'src/server/main.ts'], { cwd: L.current, env, stdio: ['ignore', out, err] });
  let exitCode = null;
  const exited = new Promise((r) =>
    child.once('exit', (code, signal) => {
      exitCode = code ?? signal;
      r();
    }),
  );
  try {
    say('啟動測試：直接啟動伺服器並檢查 /api/health', 'start-up test: running the server directly and polling /api/health');
    const h = await waitForHealth({ url: healthUrl(port), timeoutMs: 60_000, stop: () => (exitCode === null ? null : `the server exited (${exitCode})`) });
    return h.ok ? 'ok' : `failed: ${h.lastError}`;
  } finally {
    if (exitCode === null) child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(t);
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

async function waitHealthy(port) {
  let dots = 0;
  const h = await waitForHealth({
    url: healthUrl(port),
    timeoutMs: 60_000,
    onWait: () => {
      if (++dots % 5 === 0) process.stdout.write('.');
    },
  });
  if (dots >= 5) process.stdout.write('\n');
  return h;
}

/** osacompile the launcher into a temporary folder, then move it over the old one. */
function buildLauncher(L, port) {
  if (!hasCommand('osacompile')) {
    warn('找不到 osacompile，略過建立 App', 'osacompile not found; launcher skipped');
    return false;
  }
  const dir = path.dirname(L.launcher);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, '.wb-launcher-'));
  try {
    const app = path.join(tmp, path.basename(L.launcher));
    const r = run('osacompile', osacompileArgs(app, launcherScript({ port, logsDir: tilde(L.logsDir, L.home) })));
    if (r.status !== 0) {
      warn('建立 App 失敗；仍可用瀏覽器打開', `osacompile failed: ${r.stderr.trim()}`);
      return false;
    }
    fs.rmSync(L.launcher, { recursive: true, force: true });
    fs.renameSync(app, L.launcher);
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** smol-toml from the installed app's node_modules (this script itself runs before `npm ci`). */
const tomlLoader = (L) => () => createRequire(path.join(L.current, 'package.json'))('smol-toml');

/** pgrep, osascript and the claude CLI; the CLI may be a Node script, which finds the bundled Node first. */
const runForApps = (cmd, args, opts = {}) => run(cmd, args, { env: childEnv(), ...opts });

// ------------------------------------------------------------ install

/** In a dry run install.sh has not created runtime/current yet (it runs us from a temporary Node), so a missing one is fine. */
function checkPlatform(L, dry = false) {
  if (process.platform === 'darwin') {
    const v = run('sw_vers', ['-productVersion']).stdout.trim();
    if (!nodeForMacos(v)) fail(`這台 Mac 的 macOS ${v} 太舊，需要 macOS 11 以上`, `macOS ${v} is too old; macOS 11 or later is required`);
  } else if (process.platform !== 'linux') fail('只支援 macOS', `unsupported platform ${process.platform}`);
  for (const cmd of ['curl', 'tar']) if (!hasCommand(cmd)) fail(`找不到 ${cmd}`, `${cmd} not found`);
  if (dry && !exists(L.node)) return;
  if (!exists(L.node)) fail('找不到內建的 Node，請用安裝指令（install.sh）執行', `bundled Node not found: ${L.node}`);
  const v = run(L.node, ['-p', 'process.versions.modules']).stdout.trim();
  if (v !== process.versions.modules) fail('內建 Node 與執行安裝程式的 Node 版本不同', `${L.node} (ABI ${v}) differs from ${process.execPath} (ABI ${process.versions.modules})`);
}

async function install(o, L, settings) {
  const port = o.port ?? settings.port ?? DEFAULT_PORT;
  const launchd = !o.noLaunchd;
  console.log(`研究工作台安裝程式 / Research Workbench installer  (Node ${process.version} ${process.platform}-${process.arch})`);
  if (o.dryRun) return dryRun(o, L, port, launchd);

  checkPlatform(L);
  if (launchd) {
    const p = await portStatus(port, launchd);
    if (!p.free && !p.ours) portBusy(port, p.who);
  }
  const unlock = takeLock(L);
  try {
    // a. which version
    say('確認要安裝的版本', 'resolving the version to install');
    const rel = resolveRelease(o);
    console.log(`    ${rel.label}`);
    const name = appDirName(rel);
    const finalDir = path.join(L.root, name);
    let previous = readLinkName(L.current);
    fs.mkdirSync(L.logsDir, { recursive: true });

    // b. download / copy, npm ci, build
    if (reusable(finalDir, rel)) ok(`${name} 已經建置好，直接使用`, `${name} is already built; reusing it`);
    else {
      const partial = buildVersion(o, L, rel, finalDir);
      if (exists(finalDir)) {
        // same folder name (re-install of a checkout, or a Node upgrade): set the old one aside, it may be running
        const aside = `${finalDir}.old-${Date.now()}`;
        fs.renameSync(finalDir, aside);
        if (previous === name) {
          // keep `current` on the running copy until the new build has passed the health check
          previous = path.basename(aside);
          pointCurrent(L, previous);
        }
      }
      fs.renameSync(partial, finalDir);
      ok(`已建置 ${name}`, `built ${name}`);
    }

    // c. folders
    for (const d of [L.dataDir, L.backupsDir, L.logsDir]) fs.mkdirSync(d, { recursive: true });
    ok(`資料位置 ${tilde(L.dataDir, L.home)}`, 'data folder ready');

    // d. data import (stops the service; if it fails the old version is started again)
    try {
      await importStep(o, L, finalDir, launchd, port);
    } catch (e) {
      if (launchd && exists(L.plist)) await startService(L.plist);
      throw e;
    }

    // e. switch and start; on any failure `current` goes back to the version that ran before
    const restorePrevious = () => {
      if (!previous || previous === name || !exists(path.join(L.root, previous))) return false;
      pointCurrent(L, previous);
      return true;
    };
    let snap = null;
    let oldPlist = null;
    const putPlistBack = () => {
      if (oldPlist !== null) writeFileAtomic(L.plist, oldPlist);
    };
    let service = 'off';
    if (launchd) {
      say('切換到新版本並啟動背景服務', 'switching to the new version and starting the LaunchAgent');
      await stopService();
      let p = await portStatus(port, launchd);
      for (let i = 0; i < 10 && !p.free; i++) {
        await sleep(1000);
        p = await portStatus(port, launchd);
      }
      if (!p.free) {
        if (exists(L.plist)) await startService(L.plist); // put the old version back
        portBusy(port, p.who);
      }
      snap = snapshotDb(L);
      oldPlist = exists(L.plist) ? fs.readFileSync(L.plist, 'utf8') : null;
      pointCurrent(L, name);
      const plist = renderPlist(launchAgent({ node: L.node, workingDirectory: L.current, dataDir: L.dataDir, port, stdoutLog: L.stdoutLog, stderrLog: L.stderrLog }));
      writeFileAtomic(L.plist, plist);
      if (hasCommand('plutil')) {
        const lint = run('plutil', ['-lint', L.plist]);
        if (lint.status !== 0) {
          restorePrevious();
          putPlistBack();
          if (oldPlist !== null) await startService(L.plist); // the service was stopped above
          fail('LaunchAgent 設定檔格式錯誤', 'the LaunchAgent plist is invalid', [lint.stdout.trim(), lint.stderr.trim()]);
        }
      }
      const b = await startService(L.plist);
      if (b.status !== 0 && isCi) {
        // GitHub's macOS runners may not allow a gui/<uid> bootstrap; verify the app directly and say so
        console.log(`::warning title=launchd::launchctl bootstrap gui/${uid()} not possible on this runner: ${b.stderr.trim()}`);
        warn('這台機器不能使用 launchctl bootstrap，改用直接啟動測試（launchd 未驗證）', 'launchctl bootstrap is not possible here; launchd NOT verified');
        service = 'skipped';
        const t = await smokeTest(L, port);
        if (t !== 'ok') {
          if (restorePrevious()) {
            putPlistBack();
            restoreDb(L, snap);
          }
          fail('新版本無法啟動', `start-up test ${t}`, tail(L.stderrLog, 30));
        }
        ok('伺服器可以啟動並通過健康檢查', 'the server starts and answers /api/health');
      } else {
        if (b.status !== 0) {
          if (restorePrevious()) {
            putPlistBack();
            await startService(L.plist);
          }
          fail('無法啟動背景服務', `launchctl bootstrap failed: ${b.stderr.trim()}`, [
            '請到「系統設定 → 一般 → 登入項目與延伸功能」確認「node」有打開，再貼一次安裝指令。',
            'Check System Settings → General → Login Items & Extensions, then re-run the installer.',
          ]);
        }
        const h = await waitHealthy(port);
        if (!h.ok) {
          const logTail = tail(L.stderrLog, 30);
          if (restorePrevious()) {
            warn(`新版本 60 秒內沒有回應，切回上一版 ${previous}`, `the new version did not answer /api/health within 60 s; rolling back to ${previous}`);
            await stopService();
            putPlistBack();
            restoreDb(L, snap);
            await startService(L.plist);
            const back = await waitHealthy(port);
            if (back.ok) ok('已切回上一版，可以繼續使用', 'rolled back; the previous version is running');
            else warn('上一版也沒有回應', 'the previous version did not answer either');
          }
          fail('新版本無法啟動', `/api/health did not answer within 60 s (${h.lastError})`, [`記錄 / log ${tilde(L.stderrLog, L.home)}:`, ...logTail]);
        }
        ok(`服務已啟動：${appUrl(port)}`, `service is up (${h.elapsedMs} ms)`);
        service = 'ok';
      }
    } else {
      snap = snapshotDb(L);
      pointCurrent(L, name);
      ok(`current → ${name}`, 'switched');
      const t = await smokeTest(L, port);
      if (t.startsWith('failed')) {
        if (restorePrevious()) restoreDb(L, snap);
        fail('新版本無法啟動', `start-up test ${t}`, tail(L.stderrLog, 30));
      }
      if (t === 'ok') ok('伺服器可以啟動並通過健康檢查', 'the server starts and answers /api/health');
    }
    ciOutput('launchd', service);
    fs.rmSync(rollbackDir(L), { recursive: true, force: true });
    writeFileAtomic(L.settings, `${JSON.stringify({ ...settings, port }, null, 2)}\n`);
    prune(L, name, previous);

    // f. launcher
    let launcher = false;
    if (launchd) {
      say(`建立 App：${tilde(L.launcher, L.home)}`, 'building the launcher app');
      launcher = buildLauncher(L, port);
      if (launcher) ok(`已建立「${APP_NAME}」`, 'launcher ready');
    }
    ciOutput('launcher', launcher ? 'ok' : 'off');

    // g. the AI apps; after the health check, so the server has written tokens.json
    let registration = null;
    if (!o.noRegister) {
      say('登記到 Claude 與 ChatGPT', 'registering the MCP adapter with the AI apps');
      registration = await registerAll({ layout: L, port, loadToml: tomlLoader(L), run: runForApps, ask: (q, d) => ask(o, q, d), log: { ok, warn, info } });
    }
    ciOutput('register', registration ? registration.map((r) => `${r.target}:${r.status}`).join(',') : 'off');

    // h. how to use it
    console.log(finalMessage({ L, port, launcher, launchd: service === 'ok', registration }));
    return 0;
  } finally {
    unlock();
  }
}

async function dryRun(o, L, port, launchd) {
  const problems = [];
  const check = (fn) => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof InstallError)) throw e;
      problems.push(e.message, ...e.details);
      console.log(`    [dry-run] FAIL ${e.message}`);
    }
  };
  check(() => checkPlatform(L, true));
  let rel = null;
  check(() => {
    rel = resolveRelease(o);
  });
  if (rel) {
    const name = appDirName(rel);
    const dir = path.join(L.root, name);
    plan(`安裝 ${rel.label}`, 'would install this version');
    plan(
      exists(dir) ? `${tilde(dir, L.home)} 已存在（${reusable(dir, rel) ? '直接使用' : '會重新建置'}）` : `建立 ${tilde(dir, L.home)}`,
      `app folder ${name}${exists(dir) ? ' exists' : ''}`,
    );
    plan('執行 npm ci、npm run build，檢查 better-sqlite3', `npm ci + npm run build with PATH=${path.dirname(process.execPath)}:…`);
    plan(`current → ${name}（目前 / now: ${readLinkName(L.current) ?? '無 / none'}）`, 'switch current');
  }
  plan(`資料 ${tilde(L.dataDir, L.home)}，記錄 ${tilde(L.logsDir, L.home)}`, 'data and log folders');
  const archive = findArchive(o, L);
  if (archive && !exists(archive)) problems.push(`import file not found: ${archive}`);
  plan(
    archive ? `匯入 ${tilde(archive, L.home)}${exists(archive) ? `（${formatBytes(fs.statSync(archive).size)}）` : '（找不到 / missing）'}` : `沒有要匯入的資料（${tilde(L.downloadsArchive, L.home)} 不存在）`,
    archive ? 'would import the archive after confirmation' : 'no data archive to import',
  );
  const p = await portStatus(port, launchd);
  if (!p.free && !p.ours && launchd) problems.push(`port ${port} is in use by ${p.who}`);
  plan(`埠 ${port}：${p.free ? '可用' : p.ours ? '由研究工作台使用中' : `被占用 ${p.who}`}`, `port ${port} ${p.free ? 'free' : p.ours ? 'held by our service' : 'busy'}`);
  if (launchd) {
    const plist = renderPlist(launchAgent({ node: L.node, workingDirectory: L.current, dataDir: L.dataDir, port, stdoutLog: L.stdoutLog, stderrLog: L.stderrLog }));
    plan(`寫入 ${tilde(L.plist, L.home)}，bootout → enable → bootstrap`, 'LaunchAgent:');
    for (const l of plist.trimEnd().split('\n')) console.log(`        ${l}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dry-'));
    try {
      if (hasCommand('plutil')) {
        fs.writeFileSync(path.join(tmp, 'a.plist'), plist);
        const lint = run('plutil', ['-lint', path.join(tmp, 'a.plist')]);
        if (lint.status !== 0) problems.push(`plist: ${lint.stdout.trim()}`);
      }
      if (hasCommand('osacompile')) {
        const r = run('osacompile', osacompileArgs(path.join(tmp, `${APP_NAME}.app`), launcherScript({ port, logsDir: tilde(L.logsDir, L.home) })));
        if (r.status !== 0) problems.push(`launcher AppleScript: ${r.stderr.trim()}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    plan(`建立 ${tilde(L.launcher, L.home)}`, 'build the launcher app');
  } else plan('不建立背景服務與 App；改為直接啟動伺服器測試 /api/health', 'no LaunchAgent or launcher; start-up test instead');
  if (o.noRegister) plan('不登記到 Claude／ChatGPT（--no-register）', 'no AI registration');
  else if (!L.mac) plan('只在 macOS 上登記到 Claude／ChatGPT', 'AI registration is macOS only');
  else {
    const found = detectTargets({ layout: L }).filter((x) => x.found);
    plan(
      found.length ? `登記到 ${found.map((x) => `${x.label}（${tilde(x.file, L.home)}，先備份）`).join('、')}` : '沒有找到 Claude 或 ChatGPT，不登記',
      found.length ? `would register with ${found.map((x) => x.client).join(', ')}` : 'no AI app found',
    );
  }
  if (problems.length) {
    console.log(`\n[dry-run] 有 ${problems.length} 個問題 / problems:`);
    for (const l of problems) console.log(`  - ${l}`);
    return 1;
  }
  console.log('\n[dry-run] 檢查完成，沒有修改任何東西 / all checks passed, nothing was changed');
  return 0;
}

// ------------------------------------------------------------ uninstall

async function uninstall(o, L) {
  const launchd = !o.noLaunchd;
  const remove = [...(launchd ? [L.plist, L.launcher] : []), L.root, ...(o.purge ? [L.dataDir, L.logsDir] : [])].filter(exists);
  if (o.dryRun) {
    if (launchd) plan(`停止背景服務 ${target()}`, 'would boot out the LaunchAgent');
    for (const p of remove) plan(`刪除 ${tilde(p, L.home)}`, 'would delete');
    if (!o.purge) plan(`保留資料 ${tilde(L.dataDir, L.home)}`, 'data is kept');
    return 0;
  }
  if (o.purge && !askTyped(`這會永久刪除所有研究資料與備份：${tilde(L.dataDir, L.home)} / This deletes ALL data and backups.`, 'yes')) {
    say('已取消，沒有刪除任何東西', 'cancelled; nothing was deleted');
    return 1;
  }
  if (launchd) {
    say('停止背景服務', 'stopping the LaunchAgent');
    run('launchctl', ['bootout', target()]);
  }
  for (const p of remove) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`    刪除 / removed ${tilde(p, L.home)}`);
  }
  if (o.purge) ok('已完整移除，包括資料', 'uninstalled, data deleted');
  else ok(`已移除；資料保留在 ${tilde(L.dataDir, L.home)}（重新安裝會繼續使用）`, 'uninstalled; data kept (a re-install picks it up)');
  return 0;
}

// ------------------------------------------------------------ doctor

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else total += fs.lstatSync(f).size;
    }
  };
  walk(dir);
  return total;
}

async function doctor(o, L, settings) {
  const port = o.port ?? settings.port ?? DEFAULT_PORT;
  const launchd = !o.noLaunchd;
  const checks = [];
  const add = (status, label, detail, lines) => checks.push({ status, label, detail, lines });
  const t = (p) => tilde(p, L.home);

  if (process.platform === 'darwin') {
    const v = run('sw_vers', ['-productVersion']).stdout.trim();
    add(nodeForMacos(v) ? 'ok' : 'fail', 'macOS', `${v || '?'}${nodeForMacos(v) ? `（使用 Node ${nodeForMacos(v)}）` : '（需要 11 以上 / needs 11+）'}`);
    const arm = run('sysctl', ['-n', 'hw.optional.arm64']).stdout.trim() === '1';
    const rosetta = run('sysctl', ['-n', 'sysctl.proc_translated']).stdout.trim() === '1';
    const brand = run('sysctl', ['-n', 'machdep.cpu.brand_string']).stdout.trim();
    add('ok', '晶片 / chip', `${arm ? 'arm64 (Apple Silicon)' : 'x64 (Intel)'}${brand ? `  ${brand}` : ''}${rosetta ? '  [Rosetta]' : ''}`);
  } else add('info', '系統 / system', `${os.type()} ${os.release()} ${process.arch}`);

  const nv = exists(L.node) ? run(L.node, ['--version']) : null;
  add(nv?.status === 0 ? 'ok' : 'fail', '內建 Node / bundled Node', nv?.status === 0 ? `${nv.stdout.trim()}  ${t(L.node)}` : `找不到 / missing: ${t(L.node)}`);

  let appDir = null;
  try {
    appDir = fs.realpathSync(L.current);
  } catch {
    /* not installed */
  }
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(appDir ?? '', 'version.json'), 'utf8'));
  } catch {
    /* missing */
  }
  if (!appDir) add('fail', '目前版本 / app version', `尚未安裝 / not installed (${t(L.current)})`);
  else add(version?.commit ? 'ok' : 'fail', '目前版本 / app version', `${version?.commit ? String(version.commit).slice(0, 12) : 'version.json 缺少 / missing'}  ${version?.installedAt ?? ''}  ${path.basename(appDir)}`);

  if (appDir && nv?.status === 0) {
    const s = run(L.node, ['-e', "const d=require('better-sqlite3')(':memory:');console.log(d.prepare('select sqlite_version() v').get().v);d.close()"], { cwd: appDir, env: childEnv() });
    add(s.status === 0 ? 'ok' : 'fail', 'better-sqlite3', s.status === 0 ? `可以載入 / loads (SQLite ${s.stdout.trim()})` : '無法載入 / does not load', s.status === 0 ? [] : s.stderr.trim().split('\n').slice(-4));
  } else add('fail', 'better-sqlite3', '無法檢查 / cannot check');

  let job = null;
  if (launchd) {
    job = jobInfo();
    const disabled = jobDisabled();
    const hint = ['到「系統設定 → 一般 → 登入項目與延伸功能」打開「node」，或重新貼上安裝指令 / enable it in Login Items or re-run the installer'];
    if (!exists(L.plist)) add('fail', 'LaunchAgent', `找不到 / missing ${t(L.plist)}`, hint);
    else if (disabled) add('fail', '背景服務 / launchd', '已被停用 / disabled', hint);
    else if (!job) add('fail', '背景服務 / launchd', '沒有載入 / not loaded', hint);
    else add(job.state === 'running' ? 'ok' : 'fail', '背景服務 / launchd', `${job.state ?? '?'}${job.pid ? `, pid ${job.pid}` : ''}, runs ${job.runs ?? '?'}, last exit ${job.lastExitCode ?? '?'}`);
  } else add('skip', '背景服務 / launchd', '--no-launchd');

  const listeners = portListeners(port);
  if (!listeners.length) add(launchd ? 'fail' : 'warn', '埠 / port', `${port}：沒有程式在使用 / nothing listening`);
  else {
    const ours = !launchd || (job?.pid !== undefined && listeners.some((l) => l.pid === job.pid));
    add(ours ? 'ok' : 'warn', '埠 / port', `${port}：${listeners.map((l) => `${l.command} (pid ${l.pid})`).join(', ')}${ours ? '' : '（不是背景服務 / not the LaunchAgent）'}`);
  }

  const h = await checkHealth(healthUrl(port));
  add(h.ok ? 'ok' : launchd ? 'fail' : 'warn', '健康檢查 / health', h.ok ? `HTTP ${h.status}, ${h.ms} ms  ${healthUrl(port)}` : `${h.error}  ${healthUrl(port)}`);
  if (h.ok) {
    const d = await checkHealth(`http://127.0.0.1:${port}/api/diagnostics`);
    let json = null;
    try {
      json = JSON.parse(d.body ?? '');
    } catch {
      /* not JSON */
    }
    if (d.ok && json) {
      const s = summarizeDiagnostics(json);
      add(s.ok ? 'ok' : 'warn', '診斷與備份 / diagnostics', s.detail, s.lines);
    } else add('warn', '診斷與備份 / diagnostics', d.error ?? 'not JSON');
  }

  // the AI apps: our entry in each config with today's paths and port, and the client's token in tokens.json
  if (L.mac) {
    for (const r of registrationStatus({ layout: L, port, loadToml: tomlLoader(L) })) {
      const c = registrationCheck(r, L.home);
      add(c.status, c.label, c.detail, c.lines);
    }
  } else add('skip', 'AI 登記 / AI apps', '只在 macOS / macOS only');

  if (exists(L.dataDir)) {
    // daily/, weekly/ and the permanent pre-v*/pre-import copies (src/server/services/backup.ts)
    const backups = exists(L.backupsDir)
      ? fs
          .readdirSync(L.backupsDir, { recursive: true })
          .filter((f) => String(f).endsWith('.db'))
          .map((f) => ({ f: String(f), at: fs.statSync(path.join(L.backupsDir, String(f))).mtime }))
          .sort((a, b) => b.at - a.at)
      : [];
    const newest = backups[0] ? `，最新 / newest ${backups[0].f}` : '';
    add('info', '資料 / data', `${formatBytes(dirSize(L.dataDir))}  ${t(L.dataDir)}`, [`backups/：${backups.length} 個備份檔 / backup files${newest}`]);
  } else add('warn', '資料 / data', `尚未建立 / not created: ${t(L.dataDir)}`);
  if (launchd) add(exists(L.launcher) ? 'ok' : 'warn', '啟動 App / launcher', t(L.launcher));
  const logTail = tail(L.stderrLog, 20);
  add('info', '記錄 / log', `${t(L.stderrLog)}（最後 20 行 / last 20 lines）`, logTail.length ? logTail : ['（空的 / empty）']);

  process.stdout.write(formatDoctorReport(checks));
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

// ------------------------------------------------------------ main

async function main() {
  let o;
  try {
    o = parseInstallArgs(process.argv.slice(2), process.env);
  } catch (e) {
    if (!(e instanceof ArgsError)) throw e;
    console.error(`錯誤 / Error: ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (o.mode === 'help') {
    console.log(HELP);
    return 0;
  }
  // launchctl, lsof, plutil, sw_vers live in the system folders; make sure they are found whatever the user's PATH
  const own = (process.env.PATH ?? '').split(':').filter(Boolean);
  process.env.PATH = [...own, ...SYSTEM_PATH.filter((p) => !own.includes(p))].join(':');
  const L = layout({ home: os.homedir(), serviceNode: process.env.WB_NODE || undefined });
  if (!L.mac) o.noLaunchd = true; // Linux is for CI and dry runs: no launchd there
  const settings = readSettings(L);
  if (o.mode === 'doctor') return doctor(o, L, settings);
  if (o.mode === 'uninstall') return uninstall(o, L);
  return install(o, L, settings);
}

main().then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (e) => {
    if (e instanceof InstallError) {
      console.error(`\n錯誤 / Error: ${e.message}`);
      for (const l of e.details) if (l) console.error(`  ${l}`);
      console.error(`\n需要協助時請執行診斷並截圖 / for help run the doctor and send a screenshot:\n  ${ONE_LINER} -- --doctor`);
    } else console.error(e);
    process.exitCode = 1;
  },
);
