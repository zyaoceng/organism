/**
 * Connects the Obsidian plugin (obsidian-plugin/, built by `npm run build` into dist/obsidian-plugin/)
 * to a vault: lists the vaults Obsidian knows from its obsidian.json, copies main.js and manifest.json
 * into <vault>/.obsidian/plugins/research-workbench-sync/ and writes the plugin's data.json with the
 * server URL and the `obsidian` token from <dataDir>/tokens.json.
 *
 * The vault holds the user's own writing, so this module never deletes anything there and never
 * writes outside our plugin folder, except for adding our id to .obsidian/community-plugins.json
 * while Obsidian is closed. data.json keeps every key it already has (the plugin keeps its sync state
 * there); an unreadable one is copied aside before it is replaced. A folder that is not ours (another
 * plugin's manifest, a symlink to a development checkout) is left alone and reported. Only Node
 * built-ins: install.sh downloads this file next to install.mjs, which runs before `npm ci`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ONE_LINER, tilde } from './layout.mjs';
import { displayWidth, padEnd } from './report.mjs';

export const PLUGIN_ID = 'research-workbench-sync';
export const PLUGIN_NAME = 'Research Workbench Sync';
export const PLUGIN_FILES = ['main.js', 'manifest.json'];
/** Where `npm run build` puts the plugin, relative to the app folder. */
export const PLUGIN_BUILD_DIR = path.join('dist', 'obsidian-plugin');
/** The plugin's own defaults (obsidian-plugin/src/settings.ts DEFAULTS); only filled in when absent. */
export const DATA_DEFAULTS = { rootFolder: '研究工作台', intervalSec: 60 };
export const CHECK_LABEL = 'Obsidian 外掛 / Obsidian plugin';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const firstLine = (s) => String(s ?? '').trim().split('\n')[0];
const stripBom = (s) => String(s).replace(/^\uFEFF/, '');

// ------------------------------------------------------------ pure

/** Obsidian's list of vaults (Linux only for tests and --obsidian-vault; the installer asks on macOS only). */
export const obsidianConfigPath = (home, platform = process.platform) =>
  platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json') : path.join(home, '.config', 'obsidian', 'obsidian.json');

export const pluginTargetDir = (vault) => path.join(vault, '.obsidian', 'plugins', PLUGIN_ID);
export const communityPluginsPath = (vault) => path.join(vault, '.obsidian', 'community-plugins.json');
export const isICloudVault = (p) => String(p).includes('/Library/Mobile Documents/');
export const isPermissionError = (e) => e?.code === 'EPERM' || e?.code === 'EACCES';
export const serverUrlFor = (port) => `http://127.0.0.1:${port}`;

/** true, false, or 'denied' when macOS privacy settings keep Terminal out (Documents, Desktop, iCloud Drive). */
export function probePath(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return isPermissionError(e) ? 'denied' : false;
  }
}

/**
 * The vaults in obsidian.json (`{ vaults: { <id>: { path, ts, open } } }`) that still exist and have a
 * .obsidian folder; open first, then the most recently used. A vault Terminal may not look into is
 * kept with `denied: true`, so choosing it leads to the permission hint instead of a silent omission.
 * @param {string} text
 * @param {{ exists: (p: string) => boolean | 'denied' }} o
 * @returns {{ vaults: { id: string, path: string, name: string, ts: number, open: boolean, denied: boolean }[], error: string | null }}
 */
export function parseVaults(text, { exists }) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return { vaults: [], error: `obsidian.json 無法讀取 / not JSON: ${firstLine(e.message)}` };
  }
  if (!isPlainObject(j) || !isPlainObject(j.vaults)) return { vaults: [], error: 'obsidian.json 沒有 vaults / has no vaults' };
  const vaults = [];
  for (const [id, v] of Object.entries(j.vaults)) {
    if (!isPlainObject(v) || typeof v.path !== 'string' || !path.isAbsolute(v.path)) continue;
    const p = path.normalize(v.path).replace(/\/+$/, '') || '/';
    const root = exists(p);
    if (!root) continue;
    const config = root === 'denied' ? 'denied' : exists(path.join(p, '.obsidian'));
    if (!config) continue;
    vaults.push({ id, path: p, name: path.basename(p), ts: Number.isFinite(v.ts) ? v.ts : 0, open: v.open === true, denied: root === 'denied' || config === 'denied' });
  }
  vaults.sort((a, b) => Number(b.open) - Number(a.open) || b.ts - a.ts);
  return { vaults, error: null };
}

/** The numbered menu; `0` never connects anything. */
export function formatVaultMenu(vaults, home) {
  const width = Math.max(...vaults.map((v) => displayWidth(v.name)), 4) + 3;
  const out = vaults.map((v, i) => {
    const notes = [v.open && '目前開著', isICloudVault(v.path) && 'iCloud', v.denied && '需要允許「終端機」存取'].filter(Boolean);
    return `  ${i + 1}) ${padEnd(v.name, width)}${tilde(v.path, home)}${notes.length ? `（${notes.join('，')}）` : ''}`;
  });
  out.push('  0) 先不要連接 Obsidian / skip');
  return out.join('\n');
}

/** A menu answer: full-width digits and spaces are fine; anything else (also '') is null. */
export function parseVaultChoice(answer, n) {
  const s = String(answer ?? '').normalize('NFKC').trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const i = Number(s);
  return i <= n ? i : null;
}

/**
 * data.json with our server URL and token. Every other key stays as it is (the plugin's cursor, known
 * ids and the user's own settings); rootFolder and intervalSec are only filled in when absent.
 * @returns {{ text: string, changed: boolean, unparsable: boolean }} text is the input itself when unchanged
 */
export function mergePluginData(existingText, { serverUrl, token }) {
  let old = null;
  let unparsable = false;
  if (existingText !== null && existingText !== undefined) {
    try {
      // a BOM (TextEdit, some editors) is not a reason to set the plugin's sync state aside
      old = JSON.parse(stripBom(existingText));
    } catch {
      old = null;
    }
    if (!isPlainObject(old)) {
      old = null;
      unparsable = true;
    }
  }
  const next = { ...(old ?? {}), serverUrl, token };
  for (const [k, v] of Object.entries(DATA_DEFAULTS)) if (!Object.hasOwn(next, k)) next[k] = v;
  const changed = old === null || old.serverUrl !== serverUrl || old.token !== token || Object.keys(DATA_DEFAULTS).some((k) => !Object.hasOwn(old, k));
  return { text: changed ? `${JSON.stringify(next, null, 2)}\n` : existingText, changed, unparsable };
}

/**
 * Obsidian's list of enabled community plugins with our id added. Missing file: a new list. Anything
 * but an array of strings is not ours to fix, so it is left untouched.
 * @returns {{ text: string | null, changed: boolean, error?: string }}
 */
export function mergeCommunityPlugins(existingText, id = PLUGIN_ID) {
  // an empty file is what Obsidian leaves when nothing was ever enabled: the same as a missing one
  if (existingText === null || existingText === undefined || stripBom(existingText).trim() === '') return { text: JSON.stringify([id], null, 2), changed: true };
  let arr;
  try {
    arr = JSON.parse(stripBom(existingText));
  } catch (e) {
    return { text: null, changed: false, error: `community-plugins.json 無法讀取 / not JSON: ${firstLine(e.message)}` };
  }
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) return { text: null, changed: false, error: 'community-plugins.json 不是外掛清單 / not a list of plugin ids' };
  if (arr.includes(id)) return { text: existingText, changed: false };
  return { text: JSON.stringify([...arr, id], null, 2), changed: true };
}

/** tokens.obsidian from <dataDir>/tokens.json (src/server/tokens.ts), or null. */
export function readObsidianToken(tokensText) {
  try {
    const t = JSON.parse(tokensText)?.tokens?.obsidian;
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** What to tell the user when macOS keeps Terminal out of the vault folder. */
export function tccHelp(vault, port, home) {
  const where = isICloudVault(vault) ? '「iCloud 雲碟」' : '「文件」「桌面」或「iCloud 雲碟」';
  return [
    `macOS 不允許「終端機」寫入這個資料夾 / macOS blocked Terminal: ${tilde(vault, home)}`,
    `打開「系統設定 → 隱私權與安全性 → 檔案與資料夾 → 終端機」，打開${where}，再貼一次安裝指令`,
    `或打開 ${serverUrlFor(port)}/#/settings 按「下載 Obsidian 外掛」，把 zip 解壓縮到 vault 的 .obsidian/plugins/ 裡`,
  ];
}

/** The steps the user takes in Obsidian; the installer cannot turn off Restricted mode for them. */
export function enableSteps({ vault, home, running, enabled }) {
  const out = [];
  if (running) out.push('Obsidian 正在執行：請先完全結束 Obsidian 再打開，新的外掛檔案才會載入 / restart Obsidian to load the plugin');
  out.push('在 Obsidian 打開「設定 → 第三方外掛」，關閉「限制模式」/ Settings → Community plugins → turn off Restricted mode');
  out.push(
    enabled
      ? `「已安裝的外掛」裡的「${PLUGIN_NAME}」已經勾選；若沒有出現，按重新整理後打開它 / reload Installed plugins if it is not listed`
      : `在「已安裝的外掛」按重新整理，打開「${PLUGIN_NAME}」/ reload Installed plugins and enable ${PLUGIN_NAME}`,
  );
  out.push(`連線憑證存在 ${tilde(path.join(pluginTargetDir(vault), 'data.json'), home)}，會跟著 vault 同步（iCloud 或 Obsidian Sync）；請只在這台 Mac 上啟用這個外掛`);
  return out;
}

/**
 * Which vault to use this run, before any prompt.
 * @param {{ o: { noObsidian?: boolean, obsidian?: boolean, obsidianVault?: string | null }, saved: { vault?: string, declined?: boolean } | undefined, mac: boolean }} a
 * @returns {{ action: 'use', vault: string, source: 'flag' | 'saved' } | { action: 'skip', status: 'skipped' | 'declined', message: string } | { action: 'ask' }}
 */
export function decideVault({ o, saved, mac }) {
  if (o.noObsidian) return { action: 'skip', status: 'skipped', message: '不連接 Obsidian（--no-obsidian）' };
  if (o.obsidianVault) return { action: 'use', vault: o.obsidianVault, source: 'flag' };
  if (!o.obsidian && typeof saved?.vault === 'string' && saved.vault) return { action: 'use', vault: saved.vault, source: 'saved' };
  if (!mac) return { action: 'skip', status: 'skipped', message: '只在 macOS 上詢問；可以用 --obsidian-vault <資料夾> 指定' };
  if (!o.obsidian && saved?.declined) return { action: 'skip', status: 'declined', message: `之前選擇不連接 Obsidian；要連接請執行 ${ONE_LINER} -- --obsidian` };
  return { action: 'ask' };
}

// ------------------------------------------------------------ files

/** The built plugin in an app folder: { dir, version } or null when `npm run build` did not produce it. */
export function builtPlugin(appDir) {
  const dir = path.join(appDir, PLUGIN_BUILD_DIR);
  if (!PLUGIN_FILES.every((f) => fs.existsSync(path.join(dir, f)))) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return { dir, version: typeof m.version === 'string' ? m.version : '?' };
  } catch {
    return null;
  }
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Copy the plugin into one vault and write its data.json. Never throws.
 * @param {{ vault: string, appDir: string, dataDir: string, port: number, home: string,
 *   obsidianRunning?: () => boolean | null, now?: () => Date, write?: (file: string, text: string) => void }} o
 *   obsidianRunning: null when unknown (community-plugins.json is then left alone). write: tests inject failures.
 * @returns {{ status: 'installed' | 'updated' | 'unchanged' | 'skipped' | 'blocked' | 'failed', message: string,
 *   lines: string[], pluginVersion?: string, dir?: string }}
 */
export function installPlugin({ vault, appDir, dataDir, port, home, obsidianRunning = () => null, now = () => new Date(), write = writeFileAtomic }) {
  const t = (p) => tilde(p, home);
  if (typeof vault !== 'string' || !path.isAbsolute(vault)) return { status: 'skipped', message: `vault 必須是絕對路徑 / not an absolute path: ${vault}`, lines: [] };
  const dir = pluginTargetDir(vault);
  try {
    const st = probePath(path.join(vault, '.obsidian'));
    if (st === 'denied') return { status: 'blocked', message: '沒有權限讀取這個 vault', lines: tccHelp(vault, port, home) };
    if (!st) return { status: 'skipped', message: `${t(vault)} 不是 Obsidian 的 vault（沒有 .obsidian 資料夾）；在 Obsidian 打開過一次再執行，或用 -- --obsidian 重新選擇`, lines: [] };
    const built = builtPlugin(appDir);
    if (!built) return { status: 'skipped', message: `找不到建置好的外掛 ${t(path.join(appDir, PLUGIN_BUILD_DIR))}（npm run build 應該要產生它）；請再執行一次安裝指令`, lines: [] };
    const token = readObsidianToken(readOrNull(path.join(dataDir, 'tokens.json')) ?? '');
    if (!token) return { status: 'skipped', message: `${t(path.join(dataDir, 'tokens.json'))} 裡沒有 obsidian 的連線憑證（伺服器啟動時會產生）；請再執行一次安裝指令`, lines: [] };

    // a folder of that name we did not create: leave it alone
    let existed = false;
    try {
      const st2 = fs.lstatSync(dir);
      if (st2.isSymbolicLink()) return { status: 'skipped', message: `${t(dir)} 是捷徑（symlink），可能是你自己的開發版本；沒有更動`, lines: [] };
      if (!st2.isDirectory()) return { status: 'skipped', message: `${t(dir)} 不是資料夾；沒有更動`, lines: [] };
      existed = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (existed) {
      const m = readOrNull(path.join(dir, 'manifest.json'));
      let id = PLUGIN_ID;
      try {
        if (m !== null) id = JSON.parse(m)?.id;
      } catch {
        id = null;
      }
      if (id !== PLUGIN_ID) return { status: 'skipped', message: `${t(dir)} 裡是別的外掛（manifest id ${id ?? '?'}）；沒有更動`, lines: [] };
    }

    fs.mkdirSync(dir, { recursive: true });
    let changed = false;
    for (const f of PLUGIN_FILES) {
      const src = fs.readFileSync(path.join(built.dir, f), 'utf8');
      if (readOrNull(path.join(dir, f)) === src) continue;
      write(path.join(dir, f), src);
      changed = true;
    }
    const dataFile = path.join(dir, 'data.json');
    const old = readOrNull(dataFile);
    const merged = mergePluginData(old, { serverUrl: serverUrlFor(port), token });
    const lines = [];
    if (merged.changed) {
      if (merged.unparsable && old !== null) {
        const aside = `${dataFile}.bak-${stamp(now())}`;
        fs.copyFileSync(dataFile, aside, fs.constants.COPYFILE_EXCL);
        lines.push(`原本的 data.json 無法讀取，已保留一份在 ${t(aside)} / the unreadable data.json was kept aside`);
      }
      write(dataFile, merged.text);
      changed = true;
    }

    // turn the plugin on, only while Obsidian is closed (it rewrites the file from memory when it quits)
    const running = obsidianRunning();
    let enabled = false;
    if (running === false) {
      const cp = communityPluginsPath(vault);
      const r = mergeCommunityPlugins(readOrNull(cp));
      if (r.error) lines.push(`${r.error}；沒有更動，請在 Obsidian 裡自己打開外掛`);
      else {
        if (r.changed) write(cp, r.text);
        enabled = true;
      }
    }
    const status = !existed ? 'installed' : changed ? 'updated' : 'unchanged';
    // an update that changed nothing does not repeat the steps in Obsidian
    if (status !== 'unchanged') lines.push(...enableSteps({ vault, home, running: running === true, enabled }));
    return { status, message: `${t(dir)}（外掛 ${built.version}）`, lines, pluginVersion: built.version, dir };
  } catch (e) {
    if (isPermissionError(e)) return { status: 'blocked', message: `沒有權限寫入 ${t(vault)}（${e.code}）`, lines: tccHelp(vault, port, home) };
    return { status: 'failed', message: `${firstLine(e?.message ?? e)}`, lines: [] };
  }
}

/**
 * The --doctor line: are the plugin files in the vault, the same version as the installed build, and
 * does data.json point at this server with the current token. Problems are warnings.
 * @returns {{ status: 'ok' | 'warn' | 'skip', label: string, detail: string, lines?: string[] }}
 */
export function pluginCheck({ vault, appDir, dataDir, port, home }) {
  const label = CHECK_LABEL;
  if (!vault) return { status: 'skip', label, detail: '沒有連接 vault / no vault connected' };
  const t = (p) => tilde(p, home);
  const dir = pluginTargetDir(vault);
  const rerun = '重新執行安裝指令會再複製一次 / re-run the installer to copy it again';
  try {
    const st = probePath(dir);
    if (st === 'denied') return { status: 'warn', label, detail: `沒有權限讀取 / no access: ${t(dir)}`, lines: tccHelp(vault, port, home).slice(1) };
    if (!st || !PLUGIN_FILES.every((f) => fs.existsSync(path.join(dir, f)))) return { status: 'warn', label, detail: `外掛檔案不在 / files missing: ${t(dir)}`, lines: [rerun] };
    const have = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))?.version ?? '?';
    const built = appDir ? builtPlugin(appDir) : null;
    const problems = [];
    if (built && built.version !== have) problems.push(`vault 裡是 ${have}，安裝的是 ${built.version} / version differs`);
    let data = null;
    try {
      data = JSON.parse(stripBom(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')));
    } catch {
      problems.push('data.json 缺少或無法讀取 / data.json missing');
    }
    if (data) {
      const token = readObsidianToken(readOrNull(path.join(dataDir, 'tokens.json')) ?? '');
      if (!token || data.token !== token) problems.push('data.json 的憑證不是目前的 / stale token');
      if (data.serverUrl !== serverUrlFor(port)) problems.push(`data.json 指向 ${data.serverUrl}，不是 ${serverUrlFor(port)} / stale server URL`);
    }
    const detail = `${have}  ${t(dir)}`;
    return problems.length ? { status: 'warn', label, detail, lines: [...problems, rerun] } : { status: 'ok', label, detail };
  } catch (e) {
    return { status: 'warn', label, detail: firstLine(e?.message ?? e), lines: [rerun] };
  }
}
