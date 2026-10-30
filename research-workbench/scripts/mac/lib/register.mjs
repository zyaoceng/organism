/**
 * Registers the MCP adapter (dist/mcp/research-workbench-mcp.mjs) with the AI apps on this Mac:
 * Claude Desktop (claude_desktop_config.json), Claude Code (`claude mcp add-json --scope user`) and
 * the ChatGPT desktop app (~/.codex/config.toml). Every client runs the same adapter with its own
 * --client; the adapter reads that client's token from <dataDir>/tokens.json, which the server writes
 * at start-up, so the config files hold no secrets. The paths go through the stable runtime/current
 * and current links, so an update needs no re-registration.
 *
 * The merges are pure and unit-tested on fixtures. The side effects refuse to touch a file they cannot
 * parse, quit the app first (it may rewrite its config when it quits), back up, write atomically and
 * read the file back. Only Node built-ins: install.sh downloads this file next to install.mjs, which
 * runs before `npm ci`; smol-toml comes from the installed app through `loadToml`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tilde } from './layout.mjs';

export const SERVER_JSON = 'research-workbench';
export const SERVER_TOML = 'research_workbench';
/** Tools ChatGPT asks about every time; every other tool of ours runs without a prompt. */
export const PROMPT_TOOLS = ['commit_research_update', 'record_trade', 'close_trade'];
export const MARK_BEGIN = '# >>> research-workbench (managed by the Research Workbench installer; edits here are replaced) >>>';
export const MARK_END = '# <<< research-workbench <<<';
export const ADAPTER = path.join('dist', 'mcp', 'research-workbench-mcp.mjs');

/** The same names as CLIENT_LABEL['zh-TW'] in src/shared/actors.ts (plain JS here: it runs before npm ci). */
export const TARGETS = [
  { client: 'claude-desktop', label: 'Claude 桌面版' },
  { client: 'claude-code', label: 'Claude Code' },
  { client: 'chatgpt', label: 'ChatGPT 桌面版' },
];

/** How a registerAll() status reads in the installer's messages. */
export const STATUS_ZH = { registered: '已登記', unchanged: '已登記', skipped: '略過', failed: '沒有登記' };

/** A refusal with a message for the user (Chinese); the file in question was not modified. */
export class RegisterError extends Error {}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const firstLine = (s) => String(s ?? '').trim().split('\n')[0];

/** Structural equality for parsed JSON/TOML values (smol-toml dates are Date subclasses; NaN equals NaN). */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.toISOString() === b.toISOString();
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** Command and args are what we own; Claude Code may add `type` and `env` around them. */
const sameServer = (got, entry) => isPlainObject(got) && got.command === entry.command && deepEqual(got.args, entry.args);

// ------------------------------------------------------------ pure: entries and paths

/**
 * The adapter command for one client. GUI apps do not inherit the shell's PATH or HOME expansion, so
 * every path is absolute and `~`-free.
 * @param {{ node: string, appCurrent: string, dataDir: string, port: number, client: string }} o
 * @returns {{ command: string, args: string[] }}
 */
export function mcpEntry({ node, appCurrent, dataDir, port, client }) {
  for (const [name, p] of Object.entries({ node, appCurrent, dataDir })) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('~') || /[\x00-\x1f\x7f]/.test(p)) {
      throw new RegisterError(`${name} 必須是絕對路徑，不能有 ~ / ${name} must be an absolute path without ~: ${p}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RegisterError(`port is not a TCP port: ${port}`);
  if (!TARGETS.some((t) => t.client === client)) throw new RegisterError(`unknown client: ${client}`);
  return { command: node, args: [path.join(appCurrent, ADAPTER), `--client=${client}`, `--data-dir=${dataDir}`, `--port=${port}`] };
}

export const claudeDesktopConfigPath = (home) => path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
export const claudeCodeUserConfigPath = (home) => path.join(home, '.claude.json');
export const codexConfigPath = ({ home, env = {} }) =>
  env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? path.join(env.CODEX_HOME, 'config.toml') : path.join(home, '.codex', 'config.toml');
const chatgptApps = (home) => ['/Applications/ChatGPT.app', path.join(home, 'Applications', 'ChatGPT.app')];

/** Where the claude CLI is installed by its own installer (native, then the older local npm install) or Homebrew. */
export const claudeCliCandidates = (home) => [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
export const findClaudeCli = ({ home, exists }) => claudeCliCandidates(home).find((p) => exists(p)) ?? null;

/** argv for `claude` (user scope: available in every project). `remove` may fail when nothing is registered yet. */
export function claudeCodeArgs(entry) {
  const json = JSON.stringify({ type: 'stdio', command: entry.command, args: entry.args, env: {} });
  return {
    remove: ['mcp', 'remove', '--scope', 'user', SERVER_JSON],
    add: ['mcp', 'add-json', '--scope', 'user', SERVER_JSON, json],
    get: ['mcp', 'get', SERVER_JSON],
  };
}

// ------------------------------------------------------------ pure: Claude Desktop JSON

/**
 * Set mcpServers["research-workbench"], keeping every other key and server in order. Unchanged when
 * the entry is already there (the file is then left exactly as it is, formatting included).
 * @param {string | null} text the current file, null when it does not exist
 * @returns {{ text: string, changed: boolean }}
 */
export function mergeClaudeDesktopConfig(text, entry) {
  let doc = {};
  if (text != null && text.trim() !== '') {
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new RegisterError(`claude_desktop_config.json 不是有效的 JSON（${firstLine(e.message)}），沒有修改它`);
    }
    if (!isPlainObject(doc)) throw new RegisterError('claude_desktop_config.json 的最外層不是 { … } 物件，沒有修改它');
  }
  if (doc.mcpServers !== undefined && !isPlainObject(doc.mcpServers)) throw new RegisterError('claude_desktop_config.json 的 mcpServers 不是 { … } 物件，沒有修改它');
  if (deepEqual(doc.mcpServers?.[SERVER_JSON], entry)) return { text, changed: false };
  doc.mcpServers = { ...doc.mcpServers, [SERVER_JSON]: entry };
  return { text: `${JSON.stringify(doc, null, 2)}\n`, changed: true };
}

// ------------------------------------------------------------ pure: Codex TOML

/**
 * smol-toml parses but does not keep comments, so the file is edited as text: our tables live in one
 * marker-delimited block at the end, and the result is validated by parsing the whole file.
 */
const BLOCK_RE = /(?:^[ \t]*\r?\n)*^# >>> research-workbench\b[^\n]*\n(?:(?!^# >>> research-workbench\b)[\s\S])*?^# <<< research-workbench <<<[^\n]*(?:\n|$)/gm;
const STRAY_MARK_RE = /^# (?:>>>|<<<) research-workbench\b[^\n]*(?:\n|$)/gm;
const OWN_HEADER_RE = /^\s*\[\s*mcp_servers\s*\.\s*["']?research_workbench["']?(\s*\.[^\]]*)?\s*\]/;
const HEADER_RE = /^\s*\[/;
const KEEP_RE = /^\s*(#.*)?$/;

/** A TOML basic string: JSON's escapes are valid TOML; DEL is the one control character JSON leaves raw. */
const tomlString = (s) => JSON.stringify(String(s)).replace(/\x7f/g, '\\u007f');

/** Our managed block, written by hand (smol-toml's stringify could repeat an [mcp_servers] header). */
export function codexBlock(entry) {
  const t = `mcp_servers.${SERVER_TOML}`;
  return [
    MARK_BEGIN,
    `[${t}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120',
    'tool_input_schema_max_bytes = 20000',
    'default_tools_approval_mode = "approve"',
    ...PROMPT_TOOLS.flatMap((tool) => ['', `[${t}.tools.${tool}]`, 'approval_mode = "prompt"']),
    MARK_END,
  ].join('\n');
}

/** Remove hand-written [mcp_servers.research_workbench…] tables up to the next header, keeping the comments right above that header. */
function removeOwnTables(text) {
  const out = [];
  let dropped = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (HEADER_RE.test(line)) {
      const own = OWN_HEADER_RE.test(line);
      if (skipping && !own) {
        let keep = dropped.length;
        while (keep > 0 && KEEP_RE.test(dropped[keep - 1])) keep--;
        const kept = dropped.slice(keep);
        while (kept.length && out.length && out.at(-1).trim() === '' && kept[0].trim() === '') kept.shift();
        out.push(...kept);
      }
      skipping = own;
      dropped = [];
    }
    if (skipping) dropped.push(line);
    else out.push(line);
  }
  return out.join('\n');
}

const parseOrNull = (toml, text) => {
  try {
    return toml.parse(text);
  } catch {
    return null;
  }
};
const ownServer = (doc) => (isPlainObject(doc?.mcp_servers) ? doc.mcp_servers[SERVER_TOML] : undefined);

/** Our server as the parsed file has it equals the entry, with the write tools set to prompt. */
export function codexEntryMatches(doc, entry) {
  const got = ownServer(doc);
  return sameServer(got, entry) && PROMPT_TOOLS.every((t) => got.tools?.[t]?.approval_mode === 'prompt');
}

/**
 * Put our block at the end of config.toml, replacing an older block or a hand-written table, and
 * refuse unless the result parses with our entry in it and everything else unchanged.
 * @param {string | null} text the current file, null when it does not exist
 * @param {{ parse: (s: string) => any }} toml smol-toml
 * @returns {{ text: string, changed: boolean }}
 */
export function mergeCodexConfig(text, entry, toml) {
  const src = text ?? '';
  let before;
  try {
    before = toml.parse(src);
  } catch (e) {
    throw new RegisterError(`~/.codex/config.toml 格式有誤，沒有修改它（${firstLine(e.message)}）`);
  }
  // Codex edits this file too (toml_edit appends new tables such as [projects."…"] after ours): an
  // entry that already reads right stays as it is, so an update neither quits ChatGPT nor backs up
  if (codexEntryMatches(before, entry)) return { text, changed: false };
  // a table Codex appended lands before the file's trailing comment, our end marker: keep a block
  // with someone else's table in it, and take only our own tables out of it below
  const onlyOurs = (block) => block.split('\n').every((l) => !HEADER_RE.test(l) || OWN_HEADER_RE.test(l));
  let rest = src.replace(BLOCK_RE, (block) => (onlyOurs(block) ? '' : block)).replace(STRAY_MARK_RE, '');
  if (ownServer(parseOrNull(toml, rest)) !== undefined) rest = removeOwnTables(rest);
  const restDoc = parseOrNull(toml, rest);
  if (!restDoc || ownServer(restDoc) !== undefined) {
    throw new RegisterError('請手動刪除 ~/.codex/config.toml 裡的 [mcp_servers.research_workbench] 後重跑安裝指令（安裝程式只會自動取代它自己寫的區塊與 [表格] 寫法），沒有修改它');
  }
  const trimmed = rest.replace(/\s+$/, '');
  const out = `${trimmed}${trimmed ? '\n\n' : ''}${codexBlock(entry)}\n`;

  let after;
  try {
    after = toml.parse(out);
  } catch (e) {
    throw new RegisterError(`無法安全地合併 ~/.codex/config.toml（${firstLine(e.message)}；例如 mcp_servers 用了 { … } 行內寫法），沒有修改它`);
  }
  if (!codexEntryMatches(after, entry)) throw new RegisterError('合併後讀不到 [mcp_servers.research_workbench]，沒有修改 ~/.codex/config.toml');
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k !== 'mcp_servers' && !deepEqual(before[k], after[k])) throw new RegisterError(`合併會改到 ~/.codex/config.toml 的「${k}」，沒有修改它`);
  }
  const bs = isPlainObject(before.mcp_servers) ? before.mcp_servers : {};
  const as = isPlainObject(after.mcp_servers) ? after.mcp_servers : {};
  for (const k of new Set([...Object.keys(bs), ...Object.keys(as)])) {
    if (k !== SERVER_TOML && !deepEqual(bs[k], as[k])) throw new RegisterError(`合併會改到 ~/.codex/config.toml 的 [mcp_servers.${k}]，沒有修改它`);
  }
  return { text: out, changed: out !== src };
}

// ------------------------------------------------------------ files

/** `<file>.bak-YYYYMMDD-HHmmss` (local time), with -2, -3 … when one already exists. */
export function backupName(file, date = new Date(), exists = fs.existsSync) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  let name = `${file}.bak-${stamp}`;
  for (let i = 2; exists(name); i++) name = `${file}.bak-${stamp}-${i}`;
  return name;
}

/** The file's text, or null when it does not exist (permission errors are thrown). */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

/** `~/…` for a path under home, also one resolved through a symlink above home (macOS temp: /var → /private/var). */
function homeTilde(p, home) {
  const short = tilde(p, home);
  if (short !== p) return short;
  try {
    return tilde(p, fs.realpathSync(home));
  } catch {
    return p;
  }
}

/** The file itself when it is a symlink (dotfiles repos), so writing does not replace the link. */
function realFile(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/** Copy the file aside next to itself; null when there is nothing to back up. */
function backupFile(file, now) {
  const real = realFile(file);
  if (!fs.existsSync(real)) return null;
  const backup = backupName(real, now);
  fs.copyFileSync(real, backup);
  return backup;
}

/**
 * Back up, write a temporary file with the original's mode, rename it over, then read it back and
 * `validate` it; a failed check puts the backup back.
 * @returns {string | null} the backup's path (null for a new file)
 */
export function writeWithBackup(file, text, { now = new Date(), validate } = {}) {
  const real = realFile(file);
  const had = fs.existsSync(real);
  const mode = had ? fs.statSync(real).mode & 0o777 : 0o644;
  const backup = had ? backupFile(real, now) : null;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = `${real}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, real);
  try {
    validate?.(fs.readFileSync(real, 'utf8'));
  } catch (e) {
    if (backup) fs.copyFileSync(backup, real);
    else fs.rmSync(real, { force: true });
    throw new RegisterError(`寫入後檢查失敗，已還原原本的檔案（${firstLine(e.message)}）`);
  }
  return backup;
}

/** `tokens` of <dataDir>/tokens.json (written by the server at start-up), or null. */
export function readTokens(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8'));
    return isPlainObject(j?.tokens) ? j.tokens : null;
  } catch {
    return null;
  }
}
const hasToken = (tokens, client) => typeof tokens?.[client] === 'string' && tokens[client].length > 0;

/** Parse a JSON config that is not ours to judge (null when missing or unreadable). */
function readJson(file) {
  try {
    const t = readOrNull(file);
    return t === null ? null : JSON.parse(t);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ side effects

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = { claude: { process: 'Claude', label: 'Claude 桌面版' }, chatgpt: { process: 'ChatGPT', label: 'ChatGPT 桌面版' } };

/** @returns {Promise<'not-running' | 'quit' | 'declined' | 'timeout'>} */
async function quitApp(ctx, app) {
  const running = () => ctx.run('pgrep', ['-x', app.process]).status === 0;
  if (!ctx.layout.mac || !running()) return 'not-running';
  if (!ctx.ask(`${app.label} 正在執行，要先結束它才能登記（重新打開即可，對話不會不見）。現在結束它嗎？/ Quit ${app.process} now to register?`, true)) return 'declined';
  ctx.run('osascript', ['-e', `tell application "${app.process}" to quit`]);
  for (let waited = 0; waited < ctx.quitTimeoutMs; waited += 500) {
    await ctx.sleep(500);
    if (!running()) return 'quit';
  }
  return 'timeout';
}

/** Merge; when the file cannot be parsed, keep a copy next to it and refuse. */
function mergeFile(ctx, file, merge) {
  const text = readOrNull(file);
  try {
    return merge(text);
  } catch (e) {
    if (!(e instanceof RegisterError) || text === null) throw e;
    const backup = backupFile(file, ctx.now());
    throw new RegisterError(`${e.message}。原檔已備份到 ${ctx.t(backup)}；請修正或刪除這個檔案後重跑安裝指令`);
  }
}

/** The shared flow of the two apps with a config file: merge, quit the app, merge again, write. */
async function registerConfigFile(ctx, { file, app, merge, validate, done }) {
  let m = mergeFile(ctx, file, merge);
  if (!m.changed) return { status: 'unchanged', file, message: '沒有變更' };
  const q = await quitApp(ctx, app);
  if (q === 'declined') return { status: 'skipped', file, message: `${app.label} 還開著，沒有登記；之後再執行一次安裝指令即可` };
  if (q === 'timeout') return { status: 'failed', file, message: `${app.label} 沒有在 ${ctx.quitTimeoutMs / 1000} 秒內結束；請手動結束它後再執行一次安裝指令` };
  if (q === 'quit') {
    m = mergeFile(ctx, file, merge); // the app may have rewritten the file while quitting
    if (!m.changed) return { status: 'unchanged', file, message: '沒有變更' };
  }
  const backup = writeWithBackup(file, m.text, { now: ctx.now(), validate });
  const reopen = q === 'quit' ? `請重新打開 ${app.label}` : `下次打開 ${app.label} 就能使用`;
  return { status: 'registered', file, backup, message: `${reopen}${done ? `；${done}` : ''}${backup ? `（原檔備份 ${ctx.t(backup)}）` : ''}` };
}

/** Per client: `detect` says whether the app is on this Mac, `register` does the work, `status` is for --doctor. */
const IMPL = {
  'claude-desktop': {
    file: (ctx) => claudeDesktopConfigPath(ctx.layout.home),
    detect: (ctx) => (ctx.exists(path.dirname(claudeDesktopConfigPath(ctx.layout.home))) ? null : '沒有找到 Claude 桌面版（~/Library/Application Support/Claude 不存在）'),
    register: (ctx, entry) =>
      registerConfigFile(ctx, {
        file: claudeDesktopConfigPath(ctx.layout.home),
        app: APP.claude,
        merge: (text) => mergeClaudeDesktopConfig(text, entry),
        validate: (text) => {
          if (!deepEqual(JSON.parse(text).mcpServers?.[SERVER_JSON], entry)) throw new Error('mcpServers.research-workbench is missing');
        },
        done: '用 Chat 分頁（不是 Cowork）',
      }),
    status: (ctx, entry) => {
      const file = claudeDesktopConfigPath(ctx.layout.home);
      if (!ctx.exists(file)) return { status: 'missing', file };
      const doc = readJson(file);
      if (!isPlainObject(doc)) return { status: 'unreadable', file, detail: '不是有效的 JSON / not valid JSON' };
      return judge(doc.mcpServers?.[SERVER_JSON], entry, file);
    },
  },
  'claude-code': {
    file: (ctx) => claudeCodeUserConfigPath(ctx.layout.home),
    detect: (ctx) => (findClaudeCli({ home: ctx.layout.home, exists: ctx.exists }) ? null : '沒有找到 claude 指令（Claude Code 沒有安裝）'),
    register: async (ctx, entry) => {
      const cli = findClaudeCli({ home: ctx.layout.home, exists: ctx.exists });
      const file = claudeCodeUserConfigPath(ctx.layout.home);
      if (sameServer(readJson(file)?.mcpServers?.[SERVER_JSON], entry)) return { status: 'unchanged', file, message: '沒有變更' };
      const backup = backupFile(file, ctx.now());
      const a = claudeCodeArgs(entry);
      const opts = { timeout: 60_000 };
      ctx.run(cli, a.remove, opts);
      const r = ctx.run(cli, a.add, opts);
      if (r.status !== 0) return { status: 'failed', file, backup, message: `claude mcp add-json 失敗：${firstLine(r.stderr || r.stdout) || `exit ${r.status}`}` };
      const g = ctx.run(cli, a.get, opts);
      if (!(g.status === 0 && g.stdout.includes(entry.args[0])) && !sameServer(readJson(file)?.mcpServers?.[SERVER_JSON], entry)) {
        return { status: 'failed', file, backup, message: `claude mcp get 找不到剛登記的 ${SERVER_JSON}：${firstLine(g.stderr || g.stdout)}` };
      }
      return { status: 'registered', file, backup, message: `新開的 Claude Code 對話就能使用（輸入 /mcp 可確認）${backup ? `（原檔備份 ${ctx.t(backup)}）` : ''}` };
    },
    status: (ctx, entry) => {
      const file = claudeCodeUserConfigPath(ctx.layout.home);
      const doc = readJson(file);
      if (doc === null) return { status: ctx.exists(file) ? 'unreadable' : 'missing', file };
      return judge(doc.mcpServers?.[SERVER_JSON], entry, file);
    },
  },
  chatgpt: {
    file: (ctx) => codexConfigPath({ home: ctx.layout.home, env: ctx.env }),
    detect: (ctx) =>
      chatgptApps(ctx.layout.home).some(ctx.exists) || ctx.exists(path.dirname(codexConfigPath({ home: ctx.layout.home, env: ctx.env })))
        ? null
        : '沒有找到 ChatGPT 桌面版（也沒有 ~/.codex）',
    register: (ctx, entry) => {
      const toml = ctx.loadToml();
      return registerConfigFile(ctx, {
        file: codexConfigPath({ home: ctx.layout.home, env: ctx.env }),
        app: APP.chatgpt,
        merge: (text) => mergeCodexConfig(text, entry, toml),
        validate: (text) => {
          if (!codexEntryMatches(toml.parse(text), entry)) throw new Error('mcp_servers.research_workbench is missing');
        },
        done: `用 Work 模式、不在專案裡的對話；${PROMPT_TOOLS.join('、')} 每次會先問你`,
      });
    },
    status: (ctx, entry) => {
      const file = codexConfigPath({ home: ctx.layout.home, env: ctx.env });
      const text = readOrNull(file);
      if (text === null) return { status: 'missing', file };
      let doc;
      try {
        doc = ctx.loadToml().parse(text);
      } catch (e) {
        return { status: 'unreadable', file, detail: firstLine(e.message) };
      }
      const got = ownServer(doc);
      if (got !== undefined && sameServer(got, entry) && !codexEntryMatches(doc, entry)) return { status: 'stale-paths', file, detail: '寫入工具沒有設成每次詢問 / write tools are not set to prompt' };
      return judge(got, entry, file);
    },
  },
};

function judge(got, entry, file) {
  if (got === undefined || got === null) return { status: 'missing', file };
  if (sameServer(got, entry)) return { status: 'ok', file };
  const current = isPlainObject(got) ? [got.command, ...(Array.isArray(got.args) ? got.args : [])].join(' ') : JSON.stringify(got);
  return { status: 'stale-paths', file, detail: `目前登記的是 / registered: ${current}` };
}

function context(o) {
  const L = o.layout;
  return {
    env: process.env,
    exists: fs.existsSync,
    now: () => new Date(),
    sleep: defaultSleep,
    quitTimeoutMs: 15_000,
    log: {},
    t: (p) => homeTilde(p, L.home),
    ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
  };
}

/** Which apps registerAll would touch (the dry run prints this). */
export function detectTargets(o) {
  const ctx = context(o);
  return TARGETS.map((t) => {
    const why = ctx.layout.mac ? IMPL[t.client].detect(ctx) : '只在 macOS 上登記';
    return { ...t, found: why === null, file: IMPL[t.client].file(ctx), message: why ?? '' };
  });
}

/**
 * Register with every AI app found on this Mac. Runs after the health check passed, so the server has
 * written tokens.json; never throws, each app gets its own result.
 * @param {{ layout: ReturnType<typeof import('./layout.mjs').layout>, port: number, loadToml: () => { parse: (s: string) => any },
 *   run: (cmd: string, args: string[], opts?: object) => { status: number, stdout: string, stderr: string },
 *   ask: (question: string, defaultYes: boolean) => boolean, log?: { ok?: Function, warn?: Function, info?: Function },
 *   now?: () => Date, env?: Record<string, string | undefined>, exists?: (p: string) => boolean, sleep?: (ms: number) => Promise<void>, quitTimeoutMs?: number }} o
 * @returns {Promise<{ target: string, label: string, status: 'registered' | 'unchanged' | 'skipped' | 'failed', message: string, file?: string, backup?: string | null }[]>}
 */
export async function registerAll(o) {
  const ctx = context(o);
  const L = ctx.layout;
  const tokens = readTokens(L.dataDir);
  const results = [];
  for (const t of TARGETS) {
    let r;
    try {
      const why = L.mac ? IMPL[t.client].detect(ctx) : '只在 macOS 上登記';
      if (why !== null) r = { status: 'skipped', message: why };
      else if (!ctx.exists(path.join(L.current, ADAPTER))) r = { status: 'failed', message: `找不到 AI 連線程式 ${ctx.t(path.join(L.current, ADAPTER))}（npm run build 應該要產生它）；請再執行一次安裝指令` };
      else if (!hasToken(tokens, t.client)) r = { status: 'failed', message: `${ctx.t(path.join(L.dataDir, 'tokens.json'))} 裡沒有 ${t.client} 的連線憑證（伺服器啟動時會產生）；請再執行一次安裝指令` };
      else r = await IMPL[t.client].register(ctx, mcpEntry({ node: L.node, appCurrent: L.current, dataDir: L.dataDir, port: o.port, client: t.client }));
    } catch (e) {
      r = { status: 'failed', message: e instanceof RegisterError ? e.message : `${firstLine(e?.message ?? e)}` };
    }
    const res = { target: t.client, label: t.label, ...r };
    results.push(res);
    const line = `${t.label}：${STATUS_ZH[res.status]}${res.message ? `，${res.message}` : ''}`;
    if (res.status === 'failed') ctx.log.warn?.(line, `${t.client} not registered`);
    else if (res.status === 'skipped') ctx.log.info?.(line, `${t.client} skipped`);
    else ctx.log.ok?.(line, `${t.client} ${res.status}`);
  }
  return results;
}

/**
 * For --doctor: per client, whether its config has our entry with the current paths and port
 * ('ok' | 'missing' | 'stale-paths' | 'unreadable' | 'absent' when the app is not on this Mac) and
 * whether tokens.json has its token.
 * @returns {{ target: string, label: string, status: string, token: boolean, file?: string, detail?: string }[]}
 */
export function registrationStatus(o) {
  const ctx = context(o);
  const L = ctx.layout;
  const tokens = readTokens(L.dataDir);
  return TARGETS.map((t) => {
    const base = { target: t.client, label: t.label, token: hasToken(tokens, t.client) };
    try {
      const why = IMPL[t.client].detect(ctx);
      if (why !== null) return { ...base, status: 'absent', detail: why };
      return { ...base, ...IMPL[t.client].status(ctx, mcpEntry({ node: L.node, appCurrent: L.current, dataDir: L.dataDir, port: o.port, client: t.client })) };
    } catch (e) {
      return { ...base, status: 'unreadable', detail: firstLine(e?.message ?? e) };
    }
  });
}
