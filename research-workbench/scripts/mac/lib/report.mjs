/**
 * Text the installer prints: the --doctor report (OK/FAIL lines meant to be screenshotted), the data
 * import summary, and the closing instructions. Pure.
 */
import path from 'node:path';
import { APP_NAME, ONE_LINER, tilde } from './layout.mjs';
import { appUrl } from './health.mjs';
import { STATUS_ZH } from './register.mjs';

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

/** Terminal columns of a string (CJK characters take two). */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}
export const padEnd = (s, width) => s + ' '.repeat(Math.max(0, width - displayWidth(s)));

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

const TAGS = { ok: '[ OK ]', fail: '[FAIL]', warn: '[WARN]', skip: '[SKIP]', info: '[INFO]' };

/**
 * @param {{ status: 'ok' | 'fail' | 'warn' | 'skip' | 'info', label: string, detail?: string, lines?: string[] }[]} checks
 * @param {{ now?: Date }} o
 */
export function formatDoctorReport(checks, { now = new Date() } = {}) {
  const width = Math.max(...checks.map((c) => displayWidth(c.label)), 10) + 2;
  const rule = '-'.repeat(72);
  const out = [`研究工作台 診斷 / Research Workbench doctor   ${localStamp(now)}`, rule];
  for (const c of checks) {
    out.push(`${TAGS[c.status] ?? '[ ?? ]'} ${padEnd(c.label, width)}${c.detail ?? ''}`.trimEnd());
    for (const l of c.lines ?? []) out.push(`         ${l}`);
  }
  out.push(rule);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  out.push(
    fails === 0 && warns === 0
      ? '結果 / Result: 全部正常 / all OK'
      : `結果 / Result: ${fails} 項失敗 FAIL, ${warns} 項警告 WARN${fails ? '（請把這個畫面截圖回報 / please screenshot this）' : ''}`,
  );
  return `${out.join('\n')}\n`;
}

export function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The last line of stdout that parses as a JSON object (the import CLI prints its summary last). */
export function lastJsonLine(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/** A count from a number, an array (its length) or an object with count/total. */
function count(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') for (const k of ['count', 'total']) if (typeof v[k] === 'number') return v[k];
  return null;
}
const sum = (rows, key) => (rows.some((r) => typeof r?.[key] === 'number') ? rows.reduce((a, r) => a + (typeof r?.[key] === 'number' ? r[key] : 0), 0) : null);
const day = (s) => (typeof s === 'string' && s ? s.slice(0, 10) : null);

/**
 * Readable Chinese summary of the import CLI's JSON (src/server/services/dataImport.ts ImportSummary:
 * `{ projects: [{ name, ticker, revisions, lastCommitAt, lastAsOfDate, trades, evidence }], attachments,
 * schemaVersion, hadWal }`). Unknown shapes fall back to the raw JSON so there is still something to confirm.
 */
export function formatImportSummary(summary, archiveName = 'wb-data.tgz') {
  const s = summary && typeof summary === 'object' ? summary : {};
  const projects = Array.isArray(s.projects) ? s.projects : [];
  const out = [`要匯入的資料 / Data to import（${archiveName}）`];
  const row = (label, v) => v !== null && v !== undefined && out.push(`  ${padEnd(label, 30)}${v}`);
  row('公司 / companies', Array.isArray(s.projects) ? projects.length : count(s.projects));
  row('研究更新 / research updates', count(s.revisions) ?? sum(projects, 'revisions'));
  row('交易 / trades', count(s.trades) ?? sum(projects, 'trades'));
  row('證據 / evidence', count(s.evidence) ?? sum(projects, 'evidence'));
  row('附件 / attachments', count(s.attachments));
  if (projects.length) {
    out.push('  各公司 / per company:');
    for (const p of projects.slice(0, 40)) {
      if (!p || typeof p !== 'object') continue;
      const parts = [];
      if (typeof p.revisions === 'number') parts.push(`研究更新 ${p.revisions} 筆`);
      const last = day(p.lastCommitAt);
      if (last) parts.push(`最後提交 ${last}`);
      if (typeof p.trades === 'number') parts.push(`交易 ${p.trades} 筆`);
      out.push(`    • ${[p.name, p.ticker].filter(Boolean).join(' ') || '?'}${parts.length ? `：${parts.join('，')}` : ''}`);
    }
    if (projects.length > 40) out.push(`    …以及另外 ${projects.length - 40} 家 / and ${projects.length - 40} more`);
  }
  if (s.hadWal) out.push('  已包含尚未寫回主檔的最新修改（WAL）/ includes the latest changes from the write-ahead log');
  if (out.length === 1) out.push(`  ${JSON.stringify(summary)}`);
  return out.join('\n');
}

/**
 * One line from GET /api/diagnostics (src/server/app.ts): `{ version: { commit, installedAt }, schemaVersion,
 * dataDir, backups: { lastBackupAt, count, dir, lastError } }`; whatever subset is present.
 * @returns {{ ok: boolean, detail: string, lines: string[] }} ok is false when the last backup failed
 */
export function summarizeDiagnostics(d) {
  if (!d || typeof d !== 'object') return { ok: false, detail: 'no data', lines: [] };
  const parts = [];
  const lines = [];
  const commit = d.version?.commit ?? d.commit;
  if (commit) parts.push(`commit ${String(commit).slice(0, 7)}`);
  if (d.schemaVersion !== undefined) parts.push(`schema v${d.schemaVersion}`);
  const b = d.backups;
  let ok = true;
  if (b && typeof b === 'object') {
    parts.push(b.lastBackupAt ? `最近備份 last backup ${b.lastBackupAt}` : '尚無備份 / no backup yet');
    if (typeof b.count === 'number') parts.push(`${b.count} 份 / files`);
    if (b.lastError) {
      ok = false;
      lines.push(`備份錯誤 / backup error: ${b.lastError}`);
    }
    if (b.dir) lines.push(`備份位置 / backups: ${b.dir}`);
  }
  if (d.dataDir) lines.push(`資料位置 / data: ${d.dataDir}`);
  return { ok, detail: parts.join('，') || JSON.stringify(d).slice(0, 120), lines };
}

/**
 * The AI apps section: one line per app from register.mjs registerAll(); null means --no-register.
 * @param {{ label: string, status: string, message?: string }[] | null} registration
 */
export function registrationLines(registration) {
  const out = ['AI 連線 / AI apps:'];
  if (!registration) {
    out.push('  沒有登記到 Claude／ChatGPT（--no-register）；不加 --no-register 再執行一次安裝指令即可 / skipped');
    return out;
  }
  const width = Math.max(...registration.map((r) => displayWidth(r.label)), 10) + 2;
  for (const r of registration) {
    const msg = r.status === 'unchanged' ? '' : r.message;
    out.push(`  ${padEnd(r.label, width)}${STATUS_ZH[r.status] ?? r.status}${msg ? `：${msg}` : ''}`);
  }
  if (registration.some((r) => r.status === 'registered' || r.status === 'unchanged')) {
    out.push('  在 AI 對話裡直接請它用「研究工作台」查模型、寫草稿、記交易；提交前它會先給你看差異。');
    out.push('  網站的「設定」頁有連線狀態，以及可以貼進 Claude 專案指示／ChatGPT 自訂指令的說明文字。');
  }
  return out;
}

/**
 * One --doctor line per AI app from register.mjs registrationStatus(): is our entry in its config
 * with today's paths and port, and is the client's token in tokens.json. Problems are warnings: the
 * app itself works without them.
 * @param {{ label: string, status: string, token: boolean, file?: string, detail?: string }} r
 */
export function registrationCheck(r, home) {
  const label = `AI：${r.label}`;
  if (r.status === 'absent') return { status: 'skip', label, detail: r.detail ?? '沒有安裝 / not installed' };
  const where = r.file ? `  ${tilde(r.file, home)}` : '';
  const token = r.token ? '憑證 OK / token ok' : '缺少憑證 / no token in tokens.json';
  const rerun = '重新執行安裝指令即可登記 / re-run the installer to register';
  if (r.status === 'ok') {
    return r.token
      ? { status: 'ok', label, detail: `已登記 / registered，${token}${where}` }
      : { status: 'warn', label, detail: `已登記 / registered，${token}${where}`, lines: ['伺服器啟動時會產生 tokens.json；請重新執行安裝指令 / the server writes tokens.json at start-up'] };
  }
  const what = { missing: '沒有登記 / not registered', 'stale-paths': '登記的路徑或埠不是目前的 / stale paths or port' }[r.status] ?? '設定檔無法讀取 / config unreadable';
  return { status: 'warn', label, detail: `${what}，${token}${where}`, lines: [r.detail, rerun].filter(Boolean) };
}

/** Closing instructions after a successful install (Chinese first, short English hints). `registration` undefined: no AI section. */
export function finalMessage({ L, port, launcher, launchd, registration }) {
  const t = (p) => tilde(p, L.home);
  const out = ['', '安裝完成 / Installed', ''];
  out.push('怎麼打開 / How to open:');
  if (launcher) {
    out.push(`  1. 在 Finder 打開你的個人「應用程式」資料夾 ${t(path.dirname(L.launcher))}，雙擊「${APP_NAME}」。`);
    out.push('     把它拖到 Dock 或桌面，之後點一下就能打開。/ Drag it to the Dock or Desktop.');
    out.push(`  2. 或在瀏覽器打開 ${appUrl(port)} 並加入書籤。/ Or bookmark ${appUrl(port)}`);
  } else out.push(`  在瀏覽器打開 ${appUrl(port)} 並加入書籤。/ Bookmark ${appUrl(port)}`);
  if (launchd) out.push('  背景服務會在登入後自動啟動，不必開終端機。/ The service starts at login.');
  else out.push('  （沒有建立背景服務，伺服器要自己用 npm start 啟動 / no LaunchAgent was set up）');
  out.push('');
  out.push(`資料 / Data:     ${t(L.dataDir)}`);
  out.push(`備份 / Backups:  ${t(L.backupsDir)}（每天自動備份；建議開啟 Time Machine）`);
  out.push(`記錄 / Logs:     ${t(L.logsDir)}`);
  out.push('');
  if (registration !== undefined) out.push(...registrationLines(registration), '');
  out.push('更新 / Update:   在「終端機」再貼一次同一行安裝指令（資料會保留）/ re-run the same one-liner');
  out.push(`  ${ONE_LINER}`);
  out.push('診斷 / Doctor:   同一行指令最後加上 -- --doctor，把結果截圖回報 / append -- --doctor');
  out.push(`  ${ONE_LINER} -- --doctor`);
  return out.join('\n');
}
