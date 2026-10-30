import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as toml from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layout } from './layout.mjs';
import {
  MARK_BEGIN,
  MARK_END,
  PROMPT_TOOLS,
  RegisterError,
  SERVER_JSON,
  backupName,
  claudeCodeArgs,
  claudeDesktopConfigPath,
  codexBlock,
  codexConfigPath,
  detectTargets,
  findClaudeCli,
  mcpEntry,
  mergeClaudeDesktopConfig,
  mergeCodexConfig,
  registerAll,
  registrationStatus,
  writeWithBackup,
} from './register.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const L0 = layout({ home: '/Users/王小明', platform: 'darwin' });
const entryFor = (client, { L = L0, port = 4310 } = {}) => mcpEntry({ node: L.node, appCurrent: L.current, dataDir: L.dataDir, port, client });
const blocks = (text) => text.split('\n').filter((l) => l === MARK_BEGIN).length;

describe('mcpEntry', () => {
  it('runs the bundled Node on the adapter of the current version, with absolute paths', () => {
    expect(entryFor('claude-desktop')).toEqual({
      command: '/Users/王小明/ResearchWorkbench/runtime/current/bin/node',
      args: [
        '/Users/王小明/ResearchWorkbench/current/dist/mcp/research-workbench-mcp.mjs',
        '--client=claude-desktop',
        '--data-dir=/Users/王小明/Library/Application Support/ResearchWorkbench',
        '--port=4310',
      ],
    });
  });

  it('rejects relative paths, ~, a bad port and an unknown client', () => {
    const ok = { node: '/n/node', appCurrent: '/a/current', dataDir: '/d', port: 4310, client: 'chatgpt' };
    expect(() => mcpEntry(ok)).not.toThrow();
    for (const bad of [{ node: 'node' }, { appCurrent: '~/ResearchWorkbench/current' }, { dataDir: '/Users/~x/data' }, { dataDir: 'data' }, { port: 0 }, { port: 4310.5 }, { client: 'cursor' }]) {
      expect(() => mcpEntry({ ...ok, ...bad }), JSON.stringify(bad)).toThrow(RegisterError);
    }
  });
});

describe('Claude Desktop config', () => {
  const entry = entryFor('claude-desktop');

  it('replaces our old entry in place and keeps every other key and server', () => {
    const before = JSON.parse(fixture('claude_desktop_config.json'));
    const m = mergeClaudeDesktopConfig(fixture('claude_desktop_config.json'), entry);
    expect(m.changed).toBe(true);
    const after = JSON.parse(m.text);
    expect(after.mcpServers[SERVER_JSON]).toEqual(entry);
    expect(Object.keys(after)).toEqual(['globalShortcut', 'mcpServers', 'preferences']);
    expect(Object.keys(after.mcpServers)).toEqual(['filesystem', SERVER_JSON, 'weather']);
    expect(after.globalShortcut).toBe('Alt+Space');
    expect(after.mcpServers.filesystem).toEqual(before.mcpServers.filesystem);
    expect(after.mcpServers.weather).toEqual(before.mcpServers.weather);
    expect(after.preferences).toEqual(before.preferences);
    expect(m.text.endsWith('}\n')).toBe(true);
  });

  it('is idempotent and leaves an up-to-date file byte for byte', () => {
    const once = mergeClaudeDesktopConfig(fixture('claude_desktop_config.json'), entry).text;
    const twice = mergeClaudeDesktopConfig(once, entry);
    expect(twice).toEqual({ text: once, changed: false });
    const custom = `{"mcpServers":{"${SERVER_JSON}":${JSON.stringify(entry)}}}`;
    expect(mergeClaudeDesktopConfig(custom, entry)).toEqual({ text: custom, changed: false });
  });

  it('creates a new document for a missing or empty file', () => {
    for (const text of [null, '', '  \n']) expect(JSON.parse(mergeClaudeDesktopConfig(text, entry).text)).toEqual({ mcpServers: { [SERVER_JSON]: entry } });
    expect(JSON.parse(mergeClaudeDesktopConfig('{"globalShortcut":""}', entry).text)).toEqual({ globalShortcut: '', mcpServers: { [SERVER_JSON]: entry } });
  });

  it('refuses malformed JSON and unexpected shapes', () => {
    for (const text of ['{"mcpServers": {', '{"a": 1,}', '[]', '"x"', '{"mcpServers": []}', '{"mcpServers": "x"}']) {
      expect(() => mergeClaudeDesktopConfig(text, entry), text).toThrow(RegisterError);
    }
    expect(() => mergeClaudeDesktopConfig('{"mcpServers": {', entry)).toThrow(/不是有效的 JSON.*沒有修改它/);
  });

  it('round-trips paths with spaces and Chinese', () => {
    const L = layout({ home: '/Users/王 小明', platform: 'darwin' });
    const e = entryFor('claude-desktop', { L });
    expect(JSON.parse(mergeClaudeDesktopConfig(null, e).text).mcpServers[SERVER_JSON].args[2]).toBe('--data-dir=/Users/王 小明/Library/Application Support/ResearchWorkbench');
  });
});

describe('Codex config.toml', () => {
  const entry = entryFor('chatgpt');

  it('keeps every byte outside the managed block, comments included', () => {
    const src = fixture('codex-config.toml');
    const m = mergeCodexConfig(src, entry, toml);
    expect(m.changed).toBe(true);
    expect(m.text.startsWith(src)).toBe(true);
    expect(m.text.slice(src.length)).toBe(`\n${codexBlock(entry)}\n`);
    for (const c of ['# Codex settings, written by hand.', '# the default model', '# keep this comment', '# profiles']) expect(m.text).toContain(c);
  });

  it('leaves the other servers, profiles and top-level keys deep-equal', () => {
    const src = fixture('codex-config.toml');
    const before = toml.parse(src);
    const after = toml.parse(mergeCodexConfig(src, entry, toml).text);
    expect(after.mcp_servers.github).toEqual(before.mcp_servers.github);
    expect(after.profiles).toEqual(before.profiles);
    expect(after.notes).toEqual(before.notes);
    expect(after.model).toBe('gpt-5');
    expect(String(after.started)).toBe(String(before.started));
  });

  it('sets the write tools to prompt and everything else to approve', () => {
    const own = toml.parse(mergeCodexConfig(fixture('codex-config.toml'), entry, toml).text).mcp_servers.research_workbench;
    expect(own.command).toBe(entry.command);
    expect(own.args).toEqual(entry.args);
    expect(own.default_tools_approval_mode).toBe('approve');
    expect(Object.keys(own.tools).sort()).toEqual([...PROMPT_TOOLS].sort());
    for (const t of PROMPT_TOOLS) expect(own.tools[t].approval_mode).toBe('prompt');
    expect(own.startup_timeout_sec).toBe(20);
    expect(own.tool_timeout_sec).toBe(120);
    expect(own.tool_input_schema_max_bytes).toBe(20000);
  });

  it('is idempotent', () => {
    const once = mergeCodexConfig(fixture('codex-config.toml'), entry, toml).text;
    expect(mergeCodexConfig(once, entry, toml)).toEqual({ text: once, changed: false });
  });

  it('replaces an older managed block (another port), leaving exactly one block', () => {
    const old = mergeCodexConfig(fixture('codex-config.toml'), entryFor('chatgpt', { port: 4311 }), toml).text;
    const m = mergeCodexConfig(old, entry, toml);
    expect(m.changed).toBe(true);
    expect(blocks(m.text)).toBe(1);
    expect(m.text.split('\n').filter((l) => l === MARK_END)).toHaveLength(1);
    expect(m.text).not.toContain('--port=4311');
    expect(m.text).toBe(mergeCodexConfig(fixture('codex-config.toml'), entry, toml).text);
  });

  // Codex writes config.toml with toml_edit: a new table goes after our tables but before the file's
  // trailing comment, which is our end marker
  const codexAppended = (text) => text.replace(`${MARK_END}\n`, `[projects."/Users/王小明/code"]\ntrust_level = "trusted"\n${MARK_END}\n`);

  it('leaves an entry that already reads right alone after Codex added its own tables', () => {
    const once = mergeCodexConfig(fixture('codex-config.toml'), entry, toml).text;
    for (const edited of [codexAppended(once), `${once}\n[projects."/x"]\ntrust_level = "trusted"\n`]) {
      expect(toml.parse(edited).projects).toBeDefined();
      expect(mergeCodexConfig(edited, entry, toml)).toEqual({ text: edited, changed: false });
    }
  });

  it('keeps a table Codex put inside our markers when the entry has to change', () => {
    const edited = codexAppended(mergeCodexConfig(fixture('codex-config.toml'), entryFor('chatgpt', { port: 4311 }), toml).text);
    const m = mergeCodexConfig(edited, entry, toml);
    const after = toml.parse(m.text);
    expect(after.projects).toEqual({ '/Users/王小明/code': { trust_level: 'trusted' } });
    expect(after.mcp_servers.research_workbench.args).toEqual(entry.args);
    expect(after.mcp_servers.github).toEqual(toml.parse(fixture('codex-config.toml')).mcp_servers.github);
    expect(blocks(m.text)).toBe(1);
    expect(m.text).not.toContain('--port=4311');
    expect(m.text.endsWith(`${codexBlock(entry)}\n`)).toBe(true);
  });

  it('moves a managed block found in the middle of the file to the end without joining lines', () => {
    const src = `a = 1\n\n${codexBlock(entryFor('chatgpt', { port: 4311 }))}\n\n[profiles.x]\nmodel = "o3"\n`;
    const m = mergeCodexConfig(src, entry, toml);
    expect(m.text.startsWith('a = 1\n\n[profiles.x]\nmodel = "o3"\n\n# >>> research-workbench')).toBe(true);
    expect(blocks(m.text)).toBe(1);
    expect(toml.parse(m.text).profiles).toEqual({ x: { model: 'o3' } });
  });

  it('replaces a hand-written [mcp_servers.research_workbench] with its .tools subtable', () => {
    const src = fixture('codex-handwritten.toml');
    const m = mergeCodexConfig(src, entry, toml);
    const after = toml.parse(m.text);
    expect(after.mcp_servers.research_workbench.args).toEqual(entry.args);
    expect(after.mcp_servers.research_workbench.tools.record_trade.approval_mode).toBe('prompt');
    expect(after.mcp_servers.github).toEqual({ command: 'npx' });
    expect(m.text).not.toContain('/somewhere/else');
    expect(m.text).toContain('# the GitHub server\n[mcp_servers.github]');
    expect(blocks(m.text)).toBe(1);
  });

  it('refuses what it cannot replace safely: inline tables, dotted keys, invalid TOML', () => {
    const cases = {
      'mcp_servers = { github = { command = "npx" } }\n': /無法安全地合併/,
      '[mcp_servers]\nresearch_workbench = { command = "x" }\n': /請手動刪除/,
      'mcp_servers.research_workbench.command = "x"\n': /請手動刪除/,
      'model = "gpt-5\n': /格式有誤，沒有修改它/,
      '[a]\nx = 1\n[a]\nx = 2\n': /格式有誤/,
    };
    for (const [src, msg] of Object.entries(cases)) expect(() => mergeCodexConfig(src, entry, toml), src).toThrow(msg);
  });

  it('starts a missing or empty file with the block alone', () => {
    for (const text of [null, '', '\n\n']) expect(mergeCodexConfig(text, entry, toml).text).toBe(`${codexBlock(entry)}\n`);
  });

  it('writes a data folder with spaces, quotes and Chinese as TOML strings that parse back unchanged', () => {
    const odd = mcpEntry({ node: '/Users/a b/node', appCurrent: '/Users/a b/current', dataDir: '/Users/王 "小明"\\data\'s', port: 4310, client: 'chatgpt' });
    expect(odd.args[2]).toBe('--data-dir=/Users/王 "小明"\\data\'s');
    expect(toml.parse(mergeCodexConfig(null, odd, toml).text).mcp_servers.research_workbench.args).toEqual(odd.args);
    // mcpEntry refuses control characters; the TOML writer still escapes DEL, which JSON leaves raw
    const del = { command: '/n', args: ['/x\x7fy', '\t'] };
    expect(toml.parse(codexBlock(del)).mcp_servers.research_workbench.args).toEqual(del.args);
  });

  it('uses CODEX_HOME when it is set', () => {
    expect(codexConfigPath({ home: '/Users/a', env: {} })).toBe('/Users/a/.codex/config.toml');
    expect(codexConfigPath({ home: '/Users/a', env: { CODEX_HOME: '/opt/codex' } })).toBe('/opt/codex/config.toml');
  });
});

describe('Claude Code', () => {
  it('removes, then adds the server in user scope with the entry as JSON', () => {
    const entry = entryFor('claude-code');
    const a = claudeCodeArgs(entry);
    expect(a.remove).toEqual(['mcp', 'remove', '--scope', 'user', SERVER_JSON]);
    expect(a.add.slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', SERVER_JSON]);
    expect(a.add).toHaveLength(6);
    expect(JSON.parse(a.add[5])).toEqual({ type: 'stdio', command: entry.command, args: entry.args, env: {} });
    expect(a.get).toEqual(['mcp', 'get', SERVER_JSON]);
  });

  it('finds the CLI where its installers put it', () => {
    const at = (...found) => findClaudeCli({ home: '/Users/a', exists: (p) => found.includes(p) });
    expect(at()).toBeNull();
    expect(at('/Users/a/.claude/local/claude')).toBe('/Users/a/.claude/local/claude');
    expect(at('/Users/a/.claude/local/claude', '/Users/a/.local/bin/claude')).toBe('/Users/a/.local/bin/claude');
    expect(at('/opt/homebrew/bin/claude')).toBe('/opt/homebrew/bin/claude');
  });
});

describe('backups', () => {
  it('names backups by local time and never reuses a name', () => {
    const d = new Date(2026, 9, 30, 9, 5, 7);
    expect(backupName('/x/c.json', d, () => false)).toBe('/x/c.json.bak-20261030-090507');
    const taken = new Set(['/x/c.json.bak-20261030-090507', '/x/c.json.bak-20261030-090507-2']);
    expect(backupName('/x/c.json', d, (p) => taken.has(p))).toBe('/x/c.json.bak-20261030-090507-3');
  });
});

// ------------------------------------------------------------ the side effects, in a temporary home

describe('registerAll and registrationStatus', () => {
  let home;
  let L;
  let calls;
  /** pgrep answers from this set; osascript "quits" the app. */
  let running;
  let answers;
  let cliOk;

  const exists = (p) => p.startsWith(`${home}/`) && fs.existsSync(p);
  const write = (p, text) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const desktopFile = () => claudeDesktopConfigPath(home);
  const codexFile = () => path.join(home, '.codex', 'config.toml');
  const claudeJson = () => path.join(home, '.claude.json');
  const backups = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.bak-`));

  function run(cmd, args) {
    calls.push([cmd, ...args]);
    if (cmd === 'pgrep') return { status: running.has(args[1]) ? 0 : 1, stdout: '', stderr: '' };
    if (cmd === 'osascript') {
      running.delete(/"(\w+)"/.exec(args[1])[1]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd.endsWith('/claude')) {
      const doc = fs.existsSync(claudeJson()) ? JSON.parse(fs.readFileSync(claudeJson(), 'utf8')) : {};
      if (args[1] === 'remove') {
        if (!doc.mcpServers?.[args[4]]) return { status: 1, stdout: '', stderr: 'No MCP server found' };
        delete doc.mcpServers[args[4]];
      } else if (args[1] === 'add-json') {
        if (!cliOk) return { status: 1, stdout: '', stderr: 'Invalid configuration\nmore' };
        doc.mcpServers = { ...doc.mcpServers, [args[4]]: JSON.parse(args[5]) };
      } else if (args[1] === 'get') {
        const s = doc.mcpServers?.[args[2]];
        return s ? { status: 0, stdout: `${args[2]}:\n  Scope: User config\n  Args: ${s.args.join(' ')}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'not found' };
      }
      fs.writeFileSync(claudeJson(), JSON.stringify(doc));
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command ${cmd}`);
  }

  const opts = (extra = {}) => ({
    layout: L,
    port: 4310,
    loadToml: () => toml,
    run,
    ask: (q) => {
      calls.push(['ask', q]);
      return answers.shift() ?? true;
    },
    exists,
    env: {},
    now: () => new Date(2026, 9, 30, 10, 0, 0),
    sleep: async () => {},
    ...extra,
  });
  const byTarget = (results) => Object.fromEntries(results.map((r) => [r.target, r]));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-register-'));
    L = layout({ home, platform: 'darwin' });
    calls = [];
    running = new Set();
    answers = [];
    cliOk = true;
    write(path.join(L.current, 'dist', 'mcp', 'research-workbench-mcp.mjs'), '// adapter\n');
    write(path.join(L.dataDir, 'tokens.json'), JSON.stringify({ version: 1, tokens: { user: 'u', 'claude-desktop': 'a', 'claude-code': 'b', chatgpt: 'c' } }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('skips the apps that are not on this Mac', async () => {
    const r = byTarget(await registerAll(opts()));
    expect(r['claude-desktop']).toMatchObject({ status: 'skipped', label: 'Claude 桌面版' });
    expect(r['claude-code'].status).toBe('skipped');
    expect(r.chatgpt.status).toBe('skipped');
    expect(calls).toEqual([]);
    expect(detectTargets(opts()).map((t) => t.found)).toEqual([false, false, false]);
  });

  it('merges into Claude Desktop and Codex, with backups, and is idempotent', async () => {
    write(desktopFile(), fixture('claude_desktop_config.json'));
    write(codexFile(), fixture('codex-config.toml'));
    fs.chmodSync(codexFile(), 0o600);
    expect(detectTargets(opts()).map((t) => t.found)).toEqual([true, false, true]);

    const first = byTarget(await registerAll(opts()));
    expect(first['claude-desktop'].status).toBe('registered');
    expect(first['claude-desktop'].message).toContain('下次打開 Claude 桌面版 就能使用');
    expect(first.chatgpt.status).toBe('registered');
    expect(first.chatgpt.message).toContain('commit_research_update');
    expect(fs.readFileSync(first['claude-desktop'].backup, 'utf8')).toBe(fixture('claude_desktop_config.json'));
    expect(fs.readFileSync(first.chatgpt.backup, 'utf8')).toBe(fixture('codex-config.toml'));
    expect(first.chatgpt.backup.endsWith('config.toml.bak-20261030-100000')).toBe(true);
    expect(fs.statSync(codexFile()).mode & 0o777).toBe(0o600);
    const desktop = JSON.parse(fs.readFileSync(desktopFile(), 'utf8'));
    expect(desktop.mcpServers[SERVER_JSON].args[1]).toBe('--client=claude-desktop');
    expect(desktop.mcpServers.weather.env.API_KEY).toBe('abc');
    expect(toml.parse(fs.readFileSync(codexFile(), 'utf8')).mcp_servers.research_workbench.args[1]).toBe('--client=chatgpt');

    const second = byTarget(await registerAll(opts()));
    expect(second['claude-desktop'].status).toBe('unchanged');
    expect(second.chatgpt.status).toBe('unchanged');
    expect(backups(desktopFile())).toHaveLength(1);
    expect(backups(codexFile())).toHaveLength(1);

    const status = byTarget(registrationStatus(opts()));
    expect(status['claude-desktop']).toMatchObject({ status: 'ok', token: true });
    expect(status.chatgpt).toMatchObject({ status: 'ok', token: true });
    expect(status['claude-code']).toMatchObject({ status: 'absent' });
    expect(byTarget(registrationStatus(opts({ port: 4320 })))['claude-desktop'].status).toBe('stale-paths');
  });

  it('quits a running app first (after asking), re-reads its file, and says to reopen it', async () => {
    write(desktopFile(), '{}');
    running.add('Claude');
    const r = byTarget(await registerAll(opts()));
    expect(r['claude-desktop'].status).toBe('registered');
    expect(r['claude-desktop'].message).toContain('請重新打開 Claude 桌面版');
    expect(calls.map((c) => c[0])).toEqual(['pgrep', 'ask', 'osascript', 'pgrep']);
    expect(calls[2]).toEqual(['osascript', '-e', 'tell application "Claude" to quit']);
    expect(r['claude-desktop'].backup).toBeTruthy();
  });

  it('does not write when the user keeps the app open, or when it does not quit', async () => {
    write(desktopFile(), '{}');
    running.add('Claude');
    answers = [false];
    expect(byTarget(await registerAll(opts()))['claude-desktop'].status).toBe('skipped');
    expect(fs.readFileSync(desktopFile(), 'utf8')).toBe('{}');

    const stubborn = (cmd, args) => (cmd === 'osascript' ? { status: 0, stdout: '', stderr: '' } : run(cmd, args));
    const r = byTarget(await registerAll(opts({ run: stubborn, quitTimeoutMs: 2000 })))['claude-desktop'];
    expect(r.status).toBe('failed');
    expect(r.message).toContain('沒有在 2 秒內結束');
    expect(fs.readFileSync(desktopFile(), 'utf8')).toBe('{}');
    expect(backups(desktopFile())).toEqual([]);
  });

  it('backs up a malformed file and refuses to change it', async () => {
    write(desktopFile(), '{"mcpServers": {');
    write(codexFile(), 'model = "unterminated\n');
    const r = byTarget(await registerAll(opts()));
    expect(r['claude-desktop'].status).toBe('failed');
    expect(r['claude-desktop'].message).toMatch(/不是有效的 JSON.*原檔已備份到 ~\/Library\/Application Support\/Claude\/claude_desktop_config\.json\.bak-/);
    expect(r.chatgpt.message).toMatch(/格式有誤.*原檔已備份到/);
    expect(fs.readFileSync(desktopFile(), 'utf8')).toBe('{"mcpServers": {');
    expect(fs.readFileSync(codexFile(), 'utf8')).toBe('model = "unterminated\n');
    expect(backups(desktopFile())).toHaveLength(1);
    expect(backups(codexFile())).toHaveLength(1);
    expect(byTarget(registrationStatus(opts()))['claude-desktop'].status).toBe('unreadable');
  });

  it('creates Claude Desktop’s file when only its folder exists, and Codex’s when only ChatGPT.app exists', async () => {
    fs.mkdirSync(path.dirname(desktopFile()), { recursive: true });
    const withApp = (p) => p === '/Applications/ChatGPT.app' || exists(p);
    const r = byTarget(await registerAll(opts({ exists: withApp })));
    expect(r['claude-desktop']).toMatchObject({ status: 'registered', backup: null });
    expect(r.chatgpt).toMatchObject({ status: 'registered', backup: null });
    expect(fs.readFileSync(codexFile(), 'utf8')).toBe(`${codexBlock(entryFor('chatgpt', { L }))}\n`);
  });

  it('registers with Claude Code through its CLI, backing up ~/.claude.json', async () => {
    write(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n');
    write(claudeJson(), JSON.stringify({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'x', args: [] } } }));
    const r = byTarget(await registerAll(opts()))['claude-code'];
    expect(r.status).toBe('registered');
    expect(fs.readFileSync(r.backup, 'utf8')).toContain('numStartups');
    const cli = path.join(home, '.local', 'bin', 'claude');
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      [cli, 'mcp', 'remove'],
      [cli, 'mcp', 'add-json'],
      [cli, 'mcp', 'get'],
    ]);
    const doc = JSON.parse(fs.readFileSync(claudeJson(), 'utf8'));
    expect(doc.mcpServers.other).toEqual({ type: 'stdio', command: 'x', args: [] });
    expect(doc.mcpServers[SERVER_JSON].args[1]).toBe('--client=claude-code');
    expect(byTarget(registrationStatus(opts()))['claude-code']).toMatchObject({ status: 'ok', token: true });

    calls = [];
    expect(byTarget(await registerAll(opts()))['claude-code'].status).toBe('unchanged');
    expect(calls).toEqual([]);
  });

  it('reports a failing Claude Code CLI', async () => {
    write(path.join(home, '.claude', 'local', 'claude'), '#!/bin/sh\n');
    cliOk = false;
    const r = byTarget(await registerAll(opts()))['claude-code'];
    expect(r).toMatchObject({ status: 'failed', message: 'claude mcp add-json 失敗：Invalid configuration' });
  });

  it('refuses without the adapter or the client’s token, and only on macOS', async () => {
    write(desktopFile(), '{}');
    write(path.join(L.dataDir, 'tokens.json'), JSON.stringify({ tokens: { user: 'u' } }));
    let r = byTarget(await registerAll(opts()))['claude-desktop'];
    expect(r.status).toBe('failed');
    expect(r.message).toContain('沒有 claude-desktop 的連線憑證');
    expect(byTarget(registrationStatus(opts()))['claude-desktop']).toMatchObject({ status: 'missing', token: false });

    fs.rmSync(path.join(L.current, 'dist'), { recursive: true });
    r = byTarget(await registerAll(opts()))['claude-desktop'];
    expect(r.message).toContain('找不到 AI 連線程式');
    expect(fs.readFileSync(desktopFile(), 'utf8')).toBe('{}');

    const linux = layout({ home, platform: 'linux' });
    expect((await registerAll(opts({ layout: linux }))).map((x) => x.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('writes through a symlinked config file and puts the original back when the check after writing fails', () => {
    const real = path.join(home, 'dotfiles', 'config.toml');
    write(real, 'a = 1\n');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.symlinkSync(real, codexFile());
    const backup = writeWithBackup(codexFile(), 'a = 2\n');
    expect(fs.lstatSync(codexFile()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('a = 2\n');
    expect(fs.readFileSync(backup, 'utf8')).toBe('a = 1\n');

    expect(() =>
      writeWithBackup(codexFile(), 'a = 3\n', {
        validate: () => {
          throw new Error('nope');
        },
      }),
    ).toThrow(/已還原/);
    expect(fs.readFileSync(real, 'utf8')).toBe('a = 2\n');
  });
});
