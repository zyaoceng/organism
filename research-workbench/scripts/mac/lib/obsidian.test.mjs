import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLUGIN_ID,
  communityPluginsPath,
  decideVault,
  enableSteps,
  formatVaultMenu,
  installPlugin,
  isICloudVault,
  isPermissionError,
  mergeCommunityPlugins,
  mergePluginData,
  obsidianConfigPath,
  parseVaultChoice,
  parseVaults,
  pluginCheck,
  pluginTargetDir,
  readObsidianToken,
  tccHelp,
} from './obsidian.mjs';
import { displayWidth } from './report.mjs';

const HOME = '/Users/王小明';
const icloud = `${HOME}/Library/Mobile Documents/iCloud~md~obsidian/Documents/雲端筆記`;

describe('paths', () => {
  it('knows where Obsidian keeps its vault list and where our plugin goes', () => {
    expect(obsidianConfigPath(HOME, 'darwin')).toBe(`${HOME}/Library/Application Support/obsidian/obsidian.json`);
    expect(obsidianConfigPath('/home/a', 'linux')).toBe('/home/a/.config/obsidian/obsidian.json');
    expect(pluginTargetDir('/v/筆記')).toBe(`/v/筆記/.obsidian/plugins/${PLUGIN_ID}`);
    expect(communityPluginsPath('/v')).toBe('/v/.obsidian/community-plugins.json');
    expect(isICloudVault(icloud)).toBe(true);
    expect(isICloudVault(`${HOME}/Documents/x`)).toBe(false);
  });

  it('treats EPERM and EACCES as macOS permission refusals', () => {
    expect(isPermissionError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true);
    expect(isPermissionError({ code: 'EACCES' })).toBe(true);
    expect(isPermissionError({ code: 'ENOENT' })).toBe(false);
    expect(isPermissionError(null)).toBe(false);
  });
});

describe('parseVaults', () => {
  const json = JSON.stringify({
    vaults: {
      a1: { path: `${HOME}/Documents/投資筆記`, ts: 100, open: false },
      b2: { path: `${HOME}/Notes/Work/`, ts: 300 },
      c3: { path: `${HOME}/gone`, ts: 999, open: true },
      d4: { path: `${HOME}/no-config`, ts: 50 },
      e5: { path: icloud, ts: 10, open: true },
      f6: { path: 'relative/vault', ts: 1 },
      g7: 'junk',
    },
    frame: 'hidden',
  });
  const present = new Set([`${HOME}/Documents/投資筆記`, `${HOME}/Documents/投資筆記/.obsidian`, `${HOME}/Notes/Work`, `${HOME}/Notes/Work/.obsidian`, `${HOME}/no-config`]);
  const exists = (p) => (p.startsWith(`${HOME}/Library/Mobile Documents/`) ? 'denied' : present.has(p));

  it('keeps existing vaults with a .obsidian folder, open first, then the most recent', () => {
    const { vaults, error } = parseVaults(json, { exists });
    expect(error).toBeNull();
    expect(vaults.map((v) => v.id)).toEqual(['e5', 'b2', 'a1']);
    expect(vaults[1]).toEqual({ id: 'b2', path: `${HOME}/Notes/Work`, name: 'Work', ts: 300, open: false, denied: false });
    expect(vaults[0]).toMatchObject({ name: '雲端筆記', open: true, denied: true });
  });

  it('reports bad JSON and a file without vaults instead of throwing', () => {
    expect(parseVaults('{oops', { exists })).toMatchObject({ vaults: [], error: expect.stringContaining('obsidian.json') });
    expect(parseVaults('[]', { exists }).vaults).toEqual([]);
    expect(parseVaults('{"vaults":null}', { exists }).error).toContain('vaults');
    expect(parseVaults('{"vaults":{}}', { exists })).toEqual({ vaults: [], error: null });
  });
});

describe('formatVaultMenu', () => {
  const vaults = [
    { id: 'a', path: `${HOME}/Documents/投資筆記`, name: '投資筆記', ts: 2, open: true, denied: false },
    { id: 'b', path: '/Volumes/外接/Work', name: 'Work', ts: 1, open: false, denied: false },
    { id: 'c', path: icloud, name: '雲端筆記', ts: 0, open: false, denied: true },
  ];
  it('numbers the vaults, aligns the paths across CJK names and ends with 0', () => {
    const lines = formatVaultMenu(vaults, HOME).split('\n');
    expect(lines[0]).toBe('  1) 投資筆記   ~/Documents/投資筆記（目前開著）');
    expect(lines[1]).toBe('  2) Work       /Volumes/外接/Work');
    expect(lines[2]).toContain('3) 雲端筆記   ~/Library/Mobile Documents/');
    expect(lines[2]).toContain('（iCloud，需要允許「終端機」存取）');
    expect(lines.at(-1)).toBe('  0) 先不要連接 Obsidian / skip');
    const col = (l) => displayWidth(l.slice(0, l.search(/[~/]/)));
    expect(new Set(lines.slice(0, 3).map(col)).size).toBe(1);
  });
});

describe('parseVaultChoice', () => {
  it('takes 0..n with spaces and full-width digits, and nothing else', () => {
    expect(parseVaultChoice(' 2 ', 3)).toBe(2);
    expect(parseVaultChoice('２', 3)).toBe(2);
    expect(parseVaultChoice('0', 3)).toBe(0);
    expect(parseVaultChoice('3', 3)).toBe(3);
    expect(parseVaultChoice('9', 3)).toBeNull();
    expect(parseVaultChoice('', 3)).toBeNull();
    expect(parseVaultChoice('1a', 3)).toBeNull();
    expect(parseVaultChoice('-1', 3)).toBeNull();
    expect(parseVaultChoice(null, 3)).toBeNull();
  });
});

describe('mergePluginData', () => {
  const ours = { serverUrl: 'http://127.0.0.1:4310', token: 'tok-1' };
  it('starts with the plugin defaults when there is no data.json', () => {
    const r = mergePluginData(null, ours);
    expect(r).toMatchObject({ changed: true, unparsable: false });
    expect(r.text).toBe(`${JSON.stringify({ serverUrl: 'http://127.0.0.1:4310', token: 'tok-1', rootFolder: '研究工作台', intervalSec: 60 }, null, 2)}\n`);
  });

  it('keeps the sync state and the user settings, and replaces only the URL and token', () => {
    const old = JSON.stringify({ serverUrl: 'http://127.0.0.1:4320', token: 'old', rootFolder: '我的研究', intervalSec: 120, cursor: 42, known: ['c:1', 't:2'], pending: ['r:3'], generation: 'g1' });
    const r = mergePluginData(old, ours);
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ serverUrl: 'http://127.0.0.1:4310', token: 'tok-1', rootFolder: '我的研究', intervalSec: 120, cursor: 42, known: ['c:1', 't:2'], pending: ['r:3'], generation: 'g1' });
    expect(Object.keys(JSON.parse(r.text))[0]).toBe('serverUrl');
  });

  it('changes nothing when it is already right (the text comes back byte for byte)', () => {
    const same = '{"serverUrl":"http://127.0.0.1:4310","token":"tok-1","rootFolder":"x","intervalSec":60,"cursor":7}';
    expect(mergePluginData(same, ours)).toEqual({ text: same, changed: false, unparsable: false });
  });

  it('starts fresh from unreadable input and says so', () => {
    for (const bad of ['{not json', '[]', '"str"', 'null']) {
      const r = mergePluginData(bad, ours);
      expect(r).toMatchObject({ changed: true, unparsable: true });
      expect(JSON.parse(r.text).token).toBe('tok-1');
    }
  });
});

describe('BOM and empty files (regression)', () => {
  it('reads a data.json with a BOM instead of setting the sync state aside', () => {
    const old = `\uFEFF${JSON.stringify({ serverUrl: 'http://127.0.0.1:4310', token: 'old', rootFolder: 'x', intervalSec: 90, state: { cursor: 7 } })}`;
    const r = mergePluginData(old, { serverUrl: 'http://127.0.0.1:4310', token: 'new' });
    expect(r.unparsable).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ token: 'new', rootFolder: 'x', intervalSec: 90, state: { cursor: 7 } });
  });

  it('treats an empty or BOM-only community-plugins.json as missing', () => {
    for (const t of ['', '  \n', '\uFEFF']) expect(mergeCommunityPlugins(t)).toEqual({ text: JSON.stringify([PLUGIN_ID], null, 2), changed: true });
    expect(JSON.parse(mergeCommunityPlugins('\uFEFF["dataview"]').text)).toEqual(['dataview', PLUGIN_ID]);
  });
});

describe('mergeCommunityPlugins', () => {
  it('adds our id once and keeps the others in order', () => {
    const r = mergeCommunityPlugins('["dataview","calendar"]');
    expect(r).toEqual({ text: JSON.stringify(['dataview', 'calendar', PLUGIN_ID], null, 2), changed: true });
    expect(mergeCommunityPlugins(r.text)).toEqual({ text: r.text, changed: false });
    expect(mergeCommunityPlugins(null)).toEqual({ text: JSON.stringify([PLUGIN_ID], null, 2), changed: true });
  });

  it('refuses anything but a list of ids', () => {
    for (const bad of ['{x', '{"a":1}', '[1,2]', '"x"']) expect(mergeCommunityPlugins(bad)).toMatchObject({ text: null, changed: false, error: expect.any(String) });
  });
});

describe('readObsidianToken', () => {
  it('reads tokens.obsidian from tokens.json', () => {
    expect(readObsidianToken(JSON.stringify({ version: 1, tokens: { user: 'u', obsidian: 'o-tok' } }))).toBe('o-tok');
    expect(readObsidianToken(JSON.stringify({ tokens: { user: 'u' } }))).toBeNull();
    expect(readObsidianToken(JSON.stringify({ tokens: { obsidian: '' } }))).toBeNull();
    expect(readObsidianToken('nope')).toBeNull();
    expect(readObsidianToken('')).toBeNull();
  });
});

describe('help texts', () => {
  it('points to the Files and Folders setting and the settings-page zip', () => {
    const lines = tccHelp(`${HOME}/Documents/投資筆記`, 4320, HOME);
    expect(lines[0]).toContain('~/Documents/投資筆記');
    expect(lines[1]).toContain('系統設定 → 隱私權與安全性 → 檔案與資料夾 → 終端機');
    expect(lines[1]).toContain('「文件」');
    expect(lines[2]).toContain('http://127.0.0.1:4320/#/settings');
    expect(lines[2]).toContain('下載 Obsidian 外掛');
    expect(tccHelp(icloud, 4310, HOME)[1]).toContain('打開「iCloud 雲碟」');
  });

  it('reminds about Restricted mode, enabling the plugin and the synced token', () => {
    const text = enableSteps({ vault: '/v', home: HOME, running: true, enabled: false }).join('\n');
    expect(text).toContain('限制模式');
    expect(text).toContain('Research Workbench Sync');
    expect(text).toContain('結束 Obsidian');
    expect(text).toContain('只在這台 Mac');
    expect(enableSteps({ vault: '/v', home: HOME, running: false, enabled: true }).join('\n')).not.toContain('結束 Obsidian');
  });
});

describe('decideVault', () => {
  const o = (x = {}) => ({ obsidian: false, obsidianVault: null, noObsidian: false, ...x });
  it('prefers the flags, then the saved vault, then asks', () => {
    expect(decideVault({ o: o({ noObsidian: true }), saved: { vault: '/v' }, mac: true })).toMatchObject({ action: 'skip', status: 'skipped' });
    expect(decideVault({ o: o({ obsidianVault: '/flag' }), saved: { vault: '/v' }, mac: false })).toEqual({ action: 'use', vault: '/flag', source: 'flag' });
    expect(decideVault({ o: o(), saved: { vault: '/v' }, mac: true })).toEqual({ action: 'use', vault: '/v', source: 'saved' });
    expect(decideVault({ o: o({ obsidian: true }), saved: { vault: '/v' }, mac: true })).toEqual({ action: 'ask' });
    expect(decideVault({ o: o(), saved: undefined, mac: true })).toEqual({ action: 'ask' });
    expect(decideVault({ o: o(), saved: undefined, mac: false })).toMatchObject({ action: 'skip' });
    expect(decideVault({ o: o(), saved: { vault: '/v' }, mac: false })).toMatchObject({ action: 'use', source: 'saved' });
  });

  it('remembers a "no" until --obsidian', () => {
    const d = decideVault({ o: o(), saved: { declined: true }, mac: true });
    expect(d).toMatchObject({ action: 'skip', status: 'declined' });
    expect(d.message).toContain('-- --obsidian');
    expect(decideVault({ o: o({ obsidian: true }), saved: { declined: true }, mac: true })).toEqual({ action: 'ask' });
  });
});

// ------------------------------------------------------------ files, on a temporary home

describe('installPlugin and pluginCheck', () => {
  let tmp;
  let home;
  let vault;
  let app;
  let dataDir;
  const MAIN = 'module.exports = class P {};\n';
  const MANIFEST = `${JSON.stringify({ id: PLUGIN_ID, name: 'Research Workbench Sync', version: '0.1.0' })}\n`;

  /** Every file under a folder with its content, for "nothing else changed". */
  const snapshot = (dir) => {
    const out = {};
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const p = path.join(dir, String(f));
      if (fs.lstatSync(p).isFile()) out[String(f)] = fs.readFileSync(p, 'utf8');
    }
    return out;
  };
  const run = (x = {}) => installPlugin({ vault, appDir: app, dataDir, port: 4310, home, obsidianRunning: () => false, ...x });
  const target = () => pluginTargetDir(vault);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-obsidian-'));
    home = path.join(tmp, 'home');
    vault = path.join(home, 'Documents', '投資筆記');
    app = path.join(tmp, 'app');
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.mkdirSync(path.join(vault, '日記'), { recursive: true });
    fs.writeFileSync(path.join(vault, '日記', '2026-10-30.md'), '# 今天\n我自己寫的筆記\n');
    fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{"promptDelete":false}');
    fs.writeFileSync(communityPluginsPath(vault), '["dataview"]');
    fs.mkdirSync(path.join(app, 'dist', 'obsidian-plugin'), { recursive: true });
    fs.writeFileSync(path.join(app, 'dist', 'obsidian-plugin', 'main.js'), MAIN);
    fs.writeFileSync(path.join(app, 'dist', 'obsidian-plugin', 'manifest.json'), MANIFEST);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'tokens.json'), JSON.stringify({ version: 1, tokens: { user: 'u', obsidian: 'obs-token' } }));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('copies the plugin, writes data.json, enables it, and changes nothing else in the vault', () => {
    const before = snapshot(vault);
    const r = run();
    expect(r).toMatchObject({ status: 'installed', pluginVersion: '0.1.0', dir: target() });
    expect(fs.readFileSync(path.join(target(), 'main.js'), 'utf8')).toBe(MAIN);
    expect(fs.readFileSync(path.join(target(), 'manifest.json'), 'utf8')).toBe(MANIFEST);
    expect(JSON.parse(fs.readFileSync(path.join(target(), 'data.json'), 'utf8'))).toEqual({ serverUrl: 'http://127.0.0.1:4310', token: 'obs-token', rootFolder: '研究工作台', intervalSec: 60 });
    expect(JSON.parse(fs.readFileSync(communityPluginsPath(vault), 'utf8'))).toEqual(['dataview', PLUGIN_ID]);
    expect(r.lines.join('\n')).toContain('限制模式');
    const after = snapshot(vault);
    const prefix = path.join('.obsidian', 'plugins', PLUGIN_ID) + path.sep;
    const others = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(prefix) && k !== path.join('.obsidian', 'community-plugins.json')));
    expect(others(after)).toEqual(others(before));
    expect(Object.keys(after).filter((k) => k.startsWith(prefix)).sort()).toEqual(['data.json', 'main.js', 'manifest.json'].map((f) => prefix + f));
    expect(pluginCheck({ vault, appDir: app, dataDir, port: 4310, home })).toMatchObject({ status: 'ok', detail: expect.stringContaining('0.1.0') });
  });

  it('an update keeps the plugin state, writes nothing when nothing changed, and follows a new port', () => {
    run();
    const dataFile = path.join(target(), 'data.json');
    const state = { ...JSON.parse(fs.readFileSync(dataFile, 'utf8')), rootFolder: '我的研究', cursor: 12, known: ['c:1'] };
    fs.writeFileSync(dataFile, JSON.stringify(state));
    const mtime = fs.statSync(dataFile).mtimeMs;
    const writes = [];
    const write = (f, t) => {
      writes.push(path.basename(f));
      fs.writeFileSync(f, t);
    };
    const same = run({ write });
    expect(same).toMatchObject({ status: 'unchanged', lines: [] });
    expect(writes).toEqual([]);
    expect(fs.statSync(dataFile).mtimeMs).toBe(mtime);

    fs.writeFileSync(path.join(app, 'dist', 'obsidian-plugin', 'main.js'), `${MAIN}// v2\n`);
    const moved = run({ port: 4320, write });
    expect(moved.status).toBe('updated');
    expect(writes).toEqual(['main.js', 'data.json']);
    expect(JSON.parse(fs.readFileSync(dataFile, 'utf8'))).toEqual({ ...state, serverUrl: 'http://127.0.0.1:4320' });
    expect(pluginCheck({ vault, appDir: app, dataDir, port: 4310, home })).toMatchObject({ status: 'warn', lines: expect.arrayContaining([expect.stringContaining('stale server URL')]) });
  });

  it('keeps an unreadable data.json aside before replacing it', () => {
    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(path.join(target(), 'data.json'), '{half written');
    const r = run({ now: () => new Date('2026-10-31T01:02:03Z') });
    expect(r.status).toBe('updated');
    expect(fs.readFileSync(path.join(target(), 'data.json.bak-20261031T010203Z'), 'utf8')).toBe('{half written');
    expect(JSON.parse(fs.readFileSync(path.join(target(), 'data.json'), 'utf8')).token).toBe('obs-token');
  });

  it('leaves community-plugins.json alone while Obsidian runs, when unknown, and when it is not a list', () => {
    expect(run({ obsidianRunning: () => true }).lines.join('\n')).toContain('結束 Obsidian');
    expect(fs.readFileSync(communityPluginsPath(vault), 'utf8')).toBe('["dataview"]');
    run({ obsidianRunning: () => null });
    expect(fs.readFileSync(communityPluginsPath(vault), 'utf8')).toBe('["dataview"]');
    fs.writeFileSync(communityPluginsPath(vault), '{"weird":true}');
    expect(run().lines[0]).toContain('community-plugins.json');
    expect(fs.readFileSync(communityPluginsPath(vault), 'utf8')).toBe('{"weird":true}');
  });

  it('touches nothing when the folder is not a vault, the build or the token is missing, or the folder is not ours', () => {
    const plain = path.join(home, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(run({ vault: plain })).toMatchObject({ status: 'skipped', message: expect.stringContaining('.obsidian') });
    expect(fs.readdirSync(plain)).toEqual([]);
    expect(run({ vault: 'relative' }).status).toBe('skipped');
    expect(run({ appDir: path.join(tmp, 'nope') })).toMatchObject({ status: 'skipped', message: expect.stringContaining('npm run build') });
    fs.writeFileSync(path.join(dataDir, 'tokens.json'), '{"tokens":{}}');
    expect(run()).toMatchObject({ status: 'skipped', message: expect.stringContaining('obsidian') });
    expect(fs.existsSync(target())).toBe(false);
    fs.writeFileSync(path.join(dataDir, 'tokens.json'), '{"tokens":{"obsidian":"t"}}');

    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(path.join(target(), 'manifest.json'), '{"id":"someone-else"}');
    expect(run()).toMatchObject({ status: 'skipped', message: expect.stringContaining('someone-else') });
    expect(fs.readdirSync(target())).toEqual(['manifest.json']);
    fs.rmSync(target(), { recursive: true });

    const dev = path.join(tmp, 'dev-checkout');
    fs.mkdirSync(dev);
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.symlinkSync(dev, target());
    expect(run()).toMatchObject({ status: 'skipped', message: expect.stringContaining('symlink') });
    expect(fs.readdirSync(dev)).toEqual([]);
    expect(fs.readFileSync(communityPluginsPath(vault), 'utf8')).toBe('["dataview"]');
  });

  it('turns a macOS refusal into the permission hint instead of failing', () => {
    const write = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    const r = run({ write });
    expect(r.status).toBe('blocked');
    expect(r.lines.join('\n')).toContain('檔案與資料夾 → 終端機');
    expect(r.lines.join('\n')).toContain('#/settings');
    expect(run({ write: () => fs.writeFileSync('/nonexistent-dir/x', '') }).status).toBe('failed');
  });

  it('pluginCheck skips without a vault and warns about missing files and a stale token or version', () => {
    expect(pluginCheck({ vault: null, appDir: app, dataDir, port: 4310, home })).toMatchObject({ status: 'skip' });
    expect(pluginCheck({ vault, appDir: app, dataDir, port: 4310, home })).toMatchObject({ status: 'warn', detail: expect.stringContaining('files missing') });
    run();
    fs.writeFileSync(path.join(dataDir, 'tokens.json'), JSON.stringify({ tokens: { obsidian: 'rotated' } }));
    fs.writeFileSync(path.join(app, 'dist', 'obsidian-plugin', 'manifest.json'), JSON.stringify({ id: PLUGIN_ID, version: '0.2.0' }));
    const c = pluginCheck({ vault, appDir: app, dataDir, port: 4310, home });
    expect(c.status).toBe('warn');
    expect(c.lines.join('\n')).toContain('stale token');
    expect(c.lines.join('\n')).toContain('0.2.0');
  });
});
