/**
 * Phone access through Tailscale. The server keeps listening on 127.0.0.1 only; `tailscale serve`
 * on this Mac forwards https://<mac>.<tailnet>.ts.net to that port and tells the server which
 * Tailscale account is calling (the Tailscale-User-Login header). The server then accepts that host
 * name and only the listed accounts (WORKBENCH_HTTPS_HOSTS, WORKBENCH_TAILSCALE_LOGINS in the
 * LaunchAgent). Parsing and decisions are pure; commands go through an injected `run`.
 */
import path from 'node:path';
import { ONE_LINER } from './layout.mjs';

/** Where the CLI is when it is not in PATH: Homebrew (Intel, Apple Silicon) and the app itself. */
export const TAILSCALE_PLACES = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

export const NOT_INSTALLED_LINES = [
  '要用手機打開研究工作台，先在這台 Mac 和手機都安裝 Tailscale（https://tailscale.com/download），兩邊用同一個帳號登入。',
  `裝好之後在終端機再貼一次安裝指令，最後加上 -- --tailscale：${ONE_LINER} -- --tailscale`,
];
export const NOT_LOGGED_IN_LINES = [
  '這台 Mac 的 Tailscale 還沒有登入（或沒有連線）。請打開 Tailscale、登入，並確認狀態是已連線。',
  `登入後在終端機再貼一次安裝指令，最後加上 -- --tailscale：${ONE_LINER} -- --tailscale`,
];
/** How to stop the Tailscale side; the installer never changes another serve setting on its own. */
export const SERVE_OFF_HINT = 'tailscale serve --https=443 off';

/**
 * The first `tailscale` in PATH, else one of TAILSCALE_PLACES; null when there is none.
 * @param {{ env?: Record<string, string | undefined>, exists: (p: string) => boolean }} o
 */
export function findTailscale({ env = {}, exists }) {
  const dirs = String(env.PATH ?? '').split(':').filter((d) => d && path.isAbsolute(d));
  for (const p of [...dirs.map((d) => path.join(d, 'tailscale')), ...TAILSCALE_PLACES]) if (exists(p)) return p;
  return null;
}

/** 'Mac.Tail1234.ts.net.' → 'mac.tail1234.ts.net'; null for anything that is not a bare host name. */
export function cleanHost(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/\.$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
}

/** A Tailscale account name ('me@example.com', 'me@github'); null for tagged devices and odd text. */
export function cleanLogin(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[^\s,@]+@[^\s,@]+$/.test(s) ? s : null;
}

/**
 * `tailscale status --json`.
 * @returns {{ state: 'running' | 'needs-login' | 'stopped' | 'unknown', host: string | null, login: string | null, https: boolean, error: string | null }}
 *   host: this Mac's MagicDNS name; login: the account this Mac is signed in with; https: the tailnet
 *   issues HTTPS certificates for that name (false also when the field is absent).
 */
export function parseStatus(text) {
  const none = (state, error) => ({ state, host: null, login: null, https: false, error });
  let j;
  try {
    j = JSON.parse(String(text));
  } catch {
    return none('unknown', 'tailscale status --json 的輸出讀不懂 / not JSON');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return none('unknown', 'tailscale status --json 的輸出讀不懂 / not an object');
  const backend = typeof j.BackendState === 'string' ? j.BackendState : '';
  if (backend === 'NeedsLogin' || backend === 'NoState' || backend === 'NeedsMachineAuth') return none('needs-login', null);
  if (backend === 'Stopped') return none('stopped', null);
  if (backend !== 'Running') return none('unknown', `BackendState ${backend || '?'}`);
  const self = j.Self && typeof j.Self === 'object' ? j.Self : {};
  const host = cleanHost(self.DNSName);
  const user = j.User && typeof j.User === 'object' && self.UserID !== undefined ? j.User[String(self.UserID)] : null;
  const login = cleanLogin(user?.LoginName);
  const certs = Array.isArray(j.CertDomains) ? j.CertDomains.map(cleanHost) : [];
  return { state: 'running', host, login, https: !!host && certs.includes(host), error: null };
}

/**
 * `tailscale serve status --json`: the https addresses that are forwarded to our port.
 * @returns {{ urls: string[], others: string[], funnel: string[] }} others: what else is served (shown by --doctor);
 *   funnel: the host:port entries Tailscale Funnel opens to the public internet (the installer never turns that on)
 */
export function parseServeStatus(text, port) {
  let j;
  try {
    j = JSON.parse(String(text));
  } catch {
    return { urls: [], others: [], funnel: [] };
  }
  const urls = [];
  const others = [];
  const web = j && typeof j === 'object' && j.Web && typeof j.Web === 'object' ? j.Web : {};
  for (const [hostPort, site] of Object.entries(web)) {
    const m = /^(.+):(\d+)$/.exec(hostPort);
    const host = cleanHost(m ? m[1] : hostPort);
    const handlers = site && typeof site === 'object' && site.Handlers && typeof site.Handlers === 'object' ? site.Handlers : {};
    for (const [mount, h] of Object.entries(handlers)) {
      const proxy = typeof h?.Proxy === 'string' ? h.Proxy : '';
      const ours = mount === '/' && new RegExp(`^(http://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy);
      const https = !!j.TCP?.[m?.[2] ?? '']?.HTTPS;
      if (ours && host && https) urls.push(m[2] === '443' ? `https://${host}` : `https://${host}:${m[2]}`);
      else others.push(`${hostPort}${mount} → ${proxy || '?'}`);
    }
  }
  const allow = j && typeof j === 'object' && j.AllowFunnel && typeof j.AllowFunnel === 'object' ? j.AllowFunnel : {};
  const funnel = Object.entries(allow).filter(([, on]) => on === true).map(([hostPort]) => hostPort.toLowerCase());
  return { urls, others, funnel };
}

/** Forward https://<this Mac> (port 443, tailnet only) to http://127.0.0.1:<port>, kept across restarts. */
export const serveArgs = (port) => ['serve', '--bg', String(port)];

export const phoneUrl = (host) => `https://${host}`;

/** `settings.json` → { host, login } when phone access is set up, else null. */
export function savedRemote(saved) {
  const host = cleanHost(saved?.host);
  const login = cleanLogin(saved?.login);
  return host && login ? { host, login } : null;
}

/**
 * What the Tailscale step does before it looks at Tailscale itself.
 * @param {{ o: { tailscale?: boolean, noTailscale?: boolean }, saved: object | undefined, mac: boolean, launchd: boolean }} a
 * @returns {{ action: 'skip', status: string, message: string } | { action: 'off' } | { action: 'detect' }}
 */
export function decideTailscale({ o, saved, mac, launchd }) {
  if (o.noTailscale) return { action: 'off' };
  if (!mac) return { action: 'skip', status: 'skipped', message: '手機連線只在 macOS 上設定' };
  if (!launchd) return { action: 'skip', status: 'skipped', message: '沒有背景服務（--no-launchd），不設定手機連線' };
  if (saved?.declined && !o.tailscale) {
    return { action: 'skip', status: 'declined', message: `之前選擇不開放手機連線；要開放請執行 ${ONE_LINER} -- --tailscale` };
  }
  return { action: 'detect' };
}

/**
 * With Tailscale running: keep the saved setting, ask, or give up.
 * @param {{ o: { tailscale?: boolean, yes?: boolean }, saved: object | undefined, status: ReturnType<typeof parseStatus> }} a
 * @returns {{ action: 'serve', ask: boolean, host: string, login: string } | { action: 'skip', status: string, message: string }}
 */
export function planServe({ o, saved, status }) {
  if (!status.host) return { action: 'skip', status: 'failed', message: '讀不到這台 Mac 的 Tailscale 名稱（請在 Tailscale 管理頁打開 MagicDNS）' };
  if (!status.login) return { action: 'skip', status: 'failed', message: '這台 Mac 的 Tailscale 不是用個人帳號登入（加了標籤的裝置），無法限制只有你能連' };
  const prev = savedRemote(saved);
  const same = !!prev && prev.host === status.host && prev.login === status.login;
  if (same && !o.tailscale) return { action: 'serve', ask: false, host: status.host, login: status.login };
  if (o.yes && !o.tailscale) {
    return { action: 'skip', status: 'skipped', message: `--yes 不會替你開放手機連線；要開放請加上 --tailscale：${ONE_LINER} -- --tailscale` };
  }
  return { action: 'serve', ask: !o.tailscale, host: status.host, login: status.login };
}

/**
 * Find the CLI and read `tailscale status --json`.
 * @param {{ run: (cmd: string, args: string[], opts?: object) => { status: number | null, stdout: string, stderr: string }, env?: object, exists: (p: string) => boolean }} o
 * @returns {{ cli: string | null, status: ReturnType<typeof parseStatus> | null }}
 */
export function detectTailscale({ run, env, exists }) {
  const cli = findTailscale({ env, exists });
  if (!cli) return { cli: null, status: null };
  const r = run(cli, ['status', '--json'], { timeout: 15_000 });
  // not signed in: some versions exit 1 and still print the JSON
  const status = parseStatus(r.stdout);
  if (status.state === 'unknown' && r.status !== 0) status.error = (r.stderr || r.stdout).trim().split('\n')[0] || status.error;
  return { cli, status };
}

/**
 * Run `tailscale serve --bg <port>`. When HTTPS or Serve is not enabled for the tailnet the CLI prints
 * a link and waits; the time limit ends that, and the lines (with the link) are returned to be shown.
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function startServe({ cli, port, run }) {
  const r = run(cli, serveArgs(port), { timeout: 30_000 });
  const lines = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  return { ok: r.status === 0, lines };
}

/** What the installer prints once phone access is on. */
export function phoneLines({ host, login }) {
  return [
    `手機網址：${phoneUrl(host)}`,
    `手機要先安裝 Tailscale、用 ${login} 登入並保持連線，再用瀏覽器打開上面的網址（可以「加入主畫面」）。`,
    'Mac 必須開機、沒有睡眠，而且 Tailscale 開著，手機才連得到。',
  ];
}

/**
 * --doctor: the `tailscale serve` line and the phone address line.
 * @param {{ saved: object | undefined, cli: string | null, status: ReturnType<typeof parseStatus> | null, serve: ReturnType<typeof parseServeStatus> | null, remote: { url: string | null, logins: string[] } | null | undefined, port: number }} a
 *   remote: the `remote` block of the running server's /api/diagnostics (undefined when it did not answer)
 * @returns {{ status: string, label: string, detail: string, lines?: string[] }[]}
 */
export function doctorChecks({ saved, cli, status, serve, remote, port }) {
  const prev = savedRemote(saved);
  const rerun = `重新貼上安裝指令並加上 -- --tailscale / re-run: ${ONE_LINER} -- --tailscale`;
  const serveLabel = 'Tailscale serve';
  const urlLabel = '手機網址 / phone URL';
  if (!prev) {
    const why = saved?.declined ? '已選擇不開放 / declined' : '沒有設定 / not set up';
    return [
      { status: 'skip', label: serveLabel, detail: cli ? `${why}（Tailscale: ${cli}）` : `${why}；這台 Mac 沒有 Tailscale / Tailscale not installed` },
      { status: remote?.url ? 'warn' : 'skip', label: urlLabel, detail: remote?.url ? `伺服器仍接受 ${remote.url}，但安裝設定裡沒有 / the server still accepts it` : '沒有設定手機連線 / phone access is off', lines: remote?.url ? [rerun] : [`要開放：${rerun}`] },
    ];
  }
  const out = [];
  const url = phoneUrl(prev.host);
  if (!cli) out.push({ status: 'fail', label: serveLabel, detail: '找不到 tailscale 指令 / the tailscale CLI was not found', lines: NOT_INSTALLED_LINES });
  else if (!status || status.state !== 'running') out.push({ status: 'fail', label: serveLabel, detail: `Tailscale 沒有連線 / not connected (${status?.state ?? '?'}${status?.error ? `: ${status.error}` : ''})`, lines: ['打開 Tailscale 並登入 / open Tailscale and sign in'] });
  else if (serve?.funnel?.some((hp) => hp.replace(/:\d+$/, '') === prev.host)) {
    // the server refuses Funnel requests (they carry no Tailscale account), but the address should not be public at all
    out.push({
      status: 'fail',
      label: serveLabel,
      detail: `Tailscale Funnel 開著：${serve.funnel.join(', ')} 在網際網路上連得到 / Funnel is on: reachable from the public internet`,
      lines: ['安裝程式從不開啟 Funnel；伺服器仍會拒絕沒有你的 Tailscale 帳號的連線。 / the installer never turns Funnel on; the server still refuses requests without your Tailscale account', `關掉 Funnel、只留 tailnet 內的轉送：${rerun}`],
    });
  } else if (serve?.urls.includes(url)) out.push({ status: 'ok', label: serveLabel, detail: `${url} → http://127.0.0.1:${port}` });
  else {
    out.push({
      status: 'fail',
      label: serveLabel,
      detail: `沒有把 ${url} 轉到埠 ${port} / not forwarding to port ${port}`,
      lines: [...(serve?.urls.length ? [`目前轉送 / forwarding now: ${serve.urls.join(', ')}`] : []), ...(serve?.others ?? []).map((l) => `其他 / other: ${l}`), rerun],
    });
  }
  const lines = [`允許的 Tailscale 帳號 / allowed account: ${prev.login}`];
  if (status?.state === 'running' && status.host && status.host !== prev.host) {
    out.push({ status: 'fail', label: urlLabel, detail: `${url}（這台 Mac 現在的名稱是 ${status.host} / the Mac is now called ${status.host}）`, lines: [...lines, rerun] });
  } else if (remote === undefined) out.push({ status: 'info', label: urlLabel, detail: `${url}（伺服器沒有回應，無法確認 / the server is not answering）`, lines });
  else if (remote?.url !== url || !remote.logins.includes(prev.login)) {
    out.push({ status: 'fail', label: urlLabel, detail: `${url}（背景服務還沒有這個設定 / the running service does not have this setting）`, lines: [...lines, rerun] });
  } else out.push({ status: 'ok', label: urlLabel, detail: url, lines: [...lines, 'Mac 必須開機且沒有睡眠 / the Mac must be awake'] });
  return out;
}
