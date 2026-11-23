import { describe, expect, it } from 'vitest';
import { launchAgent, renderPlist } from './launchd.mjs';
import {
  NOT_INSTALLED_LINES,
  TAILSCALE_PLACES,
  cleanHost,
  cleanLogin,
  decideTailscale,
  detectTailscale,
  doctorChecks,
  findTailscale,
  parseServeStatus,
  parseStatus,
  phoneLines,
  planServe,
  savedRemote,
  serveArgs,
  startServe,
} from './tailscale.mjs';

const HOST = 'erics-macbook.tail1234.ts.net';
const LOGIN = 'eric@example.com';
/** The parts of `tailscale status --json` that are read (the real output has many more fields). */
const statusJson = (over = {}) =>
  JSON.stringify({
    Version: '1.80.2',
    BackendState: 'Running',
    Self: { ID: 'n1', HostName: 'Erics-MacBook', DNSName: 'Erics-MacBook.tail1234.ts.net.', UserID: 12345, Online: true },
    MagicDNSSuffix: 'tail1234.ts.net',
    CertDomains: ['erics-macbook.tail1234.ts.net'],
    User: { 12345: { ID: 12345, LoginName: 'Eric@Example.com', DisplayName: 'Eric' }, 777: { ID: 777, LoginName: 'other@example.com' } },
    Peer: {},
    ...over,
  });
const serveJson = (port = 4310, host = HOST) =>
  JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });

describe('findTailscale', () => {
  it('prefers PATH, then Homebrew and the app', () => {
    const only = (...have) => (p) => have.includes(p);
    expect(findTailscale({ env: { PATH: '/usr/bin:/my/bin' }, exists: only('/my/bin/tailscale', TAILSCALE_PLACES[0]) })).toBe('/my/bin/tailscale');
    expect(findTailscale({ env: { PATH: '/usr/bin' }, exists: only(TAILSCALE_PLACES[1], TAILSCALE_PLACES[2]) })).toBe('/opt/homebrew/bin/tailscale');
    expect(findTailscale({ env: {}, exists: only('/Applications/Tailscale.app/Contents/MacOS/Tailscale') })).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(findTailscale({ env: { PATH: '/usr/bin' }, exists: () => false })).toBeNull();
    // a relative PATH entry is never used
    expect(findTailscale({ env: { PATH: '.:bin' }, exists: (p) => !p.startsWith('/') })).toBeNull();
    expect(TAILSCALE_PLACES).toEqual(['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
  });
});

describe('parseStatus', () => {
  it('reads this Mac’s name and the signed-in account', () => {
    expect(parseStatus(statusJson())).toEqual({ state: 'running', host: HOST, login: LOGIN, https: true, error: null });
    expect(parseStatus(statusJson({ CertDomains: null })).https).toBe(false);
    expect(parseStatus(statusJson({ CertDomains: ['other.tail1234.ts.net'] })).https).toBe(false);
  });

  it('tells not signed in and stopped apart from running', () => {
    expect(parseStatus(statusJson({ BackendState: 'NeedsLogin' }))).toMatchObject({ state: 'needs-login', host: null, login: null });
    expect(parseStatus(statusJson({ BackendState: 'NoState' })).state).toBe('needs-login');
    expect(parseStatus(statusJson({ BackendState: 'Stopped' })).state).toBe('stopped');
    expect(parseStatus(statusJson({ BackendState: 'Starting' }))).toMatchObject({ state: 'unknown', error: 'BackendState Starting' });
    for (const bad of ['', 'failed to connect to local Tailscale service', '[]', 'null', '"x"']) expect(parseStatus(bad).state, bad).toBe('unknown');
  });

  it('gives no login for a tagged device or a missing user, and no host without MagicDNS', () => {
    expect(parseStatus(statusJson({ User: { 12345: { LoginName: 'tagged-devices' } } }))).toMatchObject({ state: 'running', host: HOST, login: null });
    expect(parseStatus(statusJson({ User: {} })).login).toBeNull();
    expect(parseStatus(statusJson({ User: null })).login).toBeNull();
    expect(parseStatus(statusJson({ Self: { UserID: 12345, DNSName: '' } }))).toMatchObject({ host: null, login: LOGIN, https: false });
    expect(parseStatus(statusJson({ Self: null }))).toMatchObject({ state: 'running', host: null, login: null });
  });

  it('cleans hosts and logins', () => {
    expect(cleanHost('Mac.Tail1234.ts.net.')).toBe('mac.tail1234.ts.net');
    for (const bad of ['https://mac.ts.net', 'mac.ts.net:443', 'mac', '', 'a b.ts.net', 'mac.ts.net,evil.example', null, 5]) expect(cleanHost(bad), String(bad)).toBeNull();
    expect(cleanLogin(' Eric@GitHub ')).toBe('eric@github');
    for (const bad of ['tagged-devices', 'a@b,c@d', 'a b@c', '', '@x', 'x@', undefined]) expect(cleanLogin(bad), String(bad)).toBeNull();
  });
});

describe('parseServeStatus', () => {
  it('finds the https address forwarded to our port', () => {
    expect(parseServeStatus(serveJson(), 4310)).toEqual({ urls: [`https://${HOST}`], others: [], funnel: [] });
    expect(parseServeStatus(serveJson(4320), 4310)).toEqual({ urls: [], others: [`${HOST}:443/ → http://127.0.0.1:4320`], funnel: [] });
    expect(parseServeStatus(JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { [`${HOST}:8443`]: { Handlers: { '/': { Proxy: 'http://localhost:4310' } } } } }), 4310).urls).toEqual([`https://${HOST}:8443`]);
    // a sub-path or a plain-http listener is not the workbench address
    expect(parseServeStatus(JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/wb': { Proxy: 'http://127.0.0.1:4310' } } } } }), 4310).urls).toEqual([]);
    expect(parseServeStatus(JSON.stringify({ TCP: { 80: { HTTP: true } }, Web: { [`${HOST}:80`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4310' } } } } }), 4310).urls).toEqual([]);
    // the port must match exactly
    expect(parseServeStatus(serveJson(43100), 4310).urls).toEqual([]);
  });

  it('is empty when nothing is served or the output is not JSON', () => {
    for (const t of ['{}', '', 'No serve config', 'null', '{"Web":null}']) expect(parseServeStatus(t, 4310), t).toEqual({ urls: [], others: [], funnel: [] });
  });

  it('reports Tailscale Funnel (public internet) so --doctor can fail on it', () => {
    const withFunnel = (v) => JSON.stringify({ ...JSON.parse(serveJson()), AllowFunnel: { [`${HOST}:443`]: v } });
    expect(parseServeStatus(withFunnel(true), 4310).funnel).toEqual([`${HOST}:443`]);
    expect(parseServeStatus(withFunnel(false), 4310).funnel).toEqual([]);
    const saved = { host: HOST, login: LOGIN };
    const checks = doctorChecks({ saved, cli: '/t', status: parseStatus(statusJson()), serve: parseServeStatus(withFunnel(true), 4310), remote: { url: `https://${HOST}`, logins: [LOGIN] }, port: 4310 });
    expect(checks[0].status).toBe('fail');
    expect(checks[0].detail).toContain('Funnel');
    // Funnel on another machine name or none at all: the usual OK line
    const other = JSON.stringify({ ...JSON.parse(serveJson()), AllowFunnel: { 'other.tail1234.ts.net:443': true } });
    expect(doctorChecks({ saved, cli: '/t', status: parseStatus(statusJson()), serve: parseServeStatus(other, 4310), remote: { url: `https://${HOST}`, logins: [LOGIN] }, port: 4310 })[0].status).toBe('ok');
  });

  it('the installer only ever runs `serve`, never `funnel`', () => {
    expect(serveArgs(4310)).toEqual(['serve', '--bg', '4310']);
    const calls = [];
    startServe({ cli: '/t', port: 4310, run: (cmd, args) => (calls.push(args), { status: 0, stdout: '', stderr: '' }) });
    expect(calls.flat()).not.toContain('funnel');
  });
});

describe('decideTailscale and planServe', () => {
  const base = { o: {}, saved: undefined, mac: true, launchd: true };
  const status = parseStatus(statusJson());

  it('decides before looking at Tailscale', () => {
    expect(decideTailscale(base)).toEqual({ action: 'detect' });
    expect(decideTailscale({ ...base, o: { noTailscale: true } })).toEqual({ action: 'off' });
    expect(decideTailscale({ ...base, mac: false })).toMatchObject({ action: 'skip', status: 'skipped' });
    expect(decideTailscale({ ...base, launchd: false })).toMatchObject({ action: 'skip', status: 'skipped' });
    expect(decideTailscale({ ...base, saved: { declined: true } })).toMatchObject({ action: 'skip', status: 'declined' });
    expect(decideTailscale({ ...base, saved: { declined: true }, o: { tailscale: true } })).toEqual({ action: 'detect' });
    expect(decideTailscale({ ...base, saved: { host: HOST, login: LOGIN } })).toEqual({ action: 'detect' });
  });

  it('asks the first time, keeps a saved setting quietly, and never turns it on by --yes alone', () => {
    expect(planServe({ o: {}, saved: undefined, status })).toEqual({ action: 'serve', ask: true, host: HOST, login: LOGIN });
    expect(planServe({ o: {}, saved: { host: HOST, login: LOGIN }, status })).toEqual({ action: 'serve', ask: false, host: HOST, login: LOGIN });
    expect(planServe({ o: { yes: true }, saved: { host: HOST, login: LOGIN }, status })).toMatchObject({ action: 'serve', ask: false });
    expect(planServe({ o: { yes: true }, saved: undefined, status })).toMatchObject({ action: 'skip', status: 'skipped' });
    expect(planServe({ o: { yes: true, tailscale: true }, saved: undefined, status })).toEqual({ action: 'serve', ask: false, host: HOST, login: LOGIN });
    expect(planServe({ o: { tailscale: true }, saved: { declined: true }, status })).toMatchObject({ action: 'serve', ask: false });
  });

  it('asks again when the Mac’s name or the account changed', () => {
    expect(planServe({ o: {}, saved: { host: 'old-name.tail1234.ts.net', login: LOGIN }, status })).toMatchObject({ action: 'serve', ask: true, host: HOST });
    expect(planServe({ o: {}, saved: { host: HOST, login: 'someone@example.com' }, status })).toMatchObject({ action: 'serve', ask: true, login: LOGIN });
    expect(planServe({ o: { yes: true }, saved: { host: HOST, login: 'someone@example.com' }, status })).toMatchObject({ action: 'skip' });
  });

  it('gives up without a host name or a personal account', () => {
    expect(planServe({ o: { tailscale: true }, saved: undefined, status: { ...status, host: null } })).toMatchObject({ action: 'skip', status: 'failed' });
    expect(planServe({ o: { tailscale: true }, saved: undefined, status: { ...status, login: null } })).toMatchObject({ action: 'skip', status: 'failed' });
  });

  it('reads the saved setting strictly', () => {
    expect(savedRemote({ host: HOST, login: LOGIN, enabledAt: 'x' })).toEqual({ host: HOST, login: LOGIN });
    for (const bad of [undefined, null, {}, { declined: true }, { host: HOST }, { host: 'a,b', login: LOGIN }, { host: HOST, login: 'tagged-devices' }]) expect(savedRemote(bad)).toBeNull();
  });
});

describe('detectTailscale and startServe (injected run)', () => {
  it('runs `status --json` with the CLI it found', () => {
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return { status: 0, stdout: statusJson(), stderr: '' };
    };
    const r = detectTailscale({ run, env: { PATH: '/usr/bin' }, exists: (p) => p === '/opt/homebrew/bin/tailscale' });
    expect(r.cli).toBe('/opt/homebrew/bin/tailscale');
    expect(r.status).toMatchObject({ state: 'running', host: HOST, login: LOGIN });
    expect(calls).toEqual([['/opt/homebrew/bin/tailscale', ['status', '--json'], { timeout: 15_000 }]]);
  });

  it('runs nothing when Tailscale is not installed, and keeps the error when it is not running', () => {
    let ran = 0;
    expect(detectTailscale({ run: () => (ran++, { status: 0, stdout: '', stderr: '' }), env: {}, exists: () => false })).toEqual({ cli: null, status: null });
    expect(ran).toBe(0);
    const down = detectTailscale({ run: () => ({ status: 1, stdout: '', stderr: 'failed to connect to local Tailscale service; is Tailscale running?\n' }), env: {}, exists: (p) => p === TAILSCALE_PLACES[2] });
    expect(down.status).toMatchObject({ state: 'unknown', error: 'failed to connect to local Tailscale service; is Tailscale running?' });
    // not signed in: exit 1 with the JSON still printed
    const out = detectTailscale({ run: () => ({ status: 1, stdout: statusJson({ BackendState: 'NeedsLogin' }), stderr: '' }), env: {}, exists: (p) => p === TAILSCALE_PLACES[2] });
    expect(out.status.state).toBe('needs-login');
  });

  it('starts `tailscale serve --bg <port>` with a time limit and returns what it printed', () => {
    expect(serveArgs(4310)).toEqual(['serve', '--bg', '4310']);
    const calls = [];
    const good = startServe({ cli: '/t', port: 4320, run: (c, a, o) => (calls.push([c, a, o]), { status: 0, stdout: `Available within your tailnet:\n\nhttps://${HOST}/\n|-- proxy http://127.0.0.1:4320\n`, stderr: '' }) });
    expect(calls).toEqual([['/t', ['serve', '--bg', '4320'], { timeout: 30_000 }]]);
    expect(good.ok).toBe(true);
    expect(good.lines).toContain(`https://${HOST}/`);
    // Serve not enabled for the tailnet: the CLI prints a link and waits; the time limit ends it (status -1 or null)
    for (const status of [-1, null, 1]) {
      const bad = startServe({ cli: '/t', port: 4310, run: () => ({ status, stdout: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n', stderr: 'spawnSync /t ETIMEDOUT' }) });
      expect(bad.ok).toBe(false);
      expect(bad.lines.join('\n')).toContain('https://login.tailscale.com/f/serve?node=abc');
    }
  });
});

describe('what is printed', () => {
  it('says how to get Tailscale in two Chinese lines', () => {
    expect(NOT_INSTALLED_LINES).toHaveLength(2);
    expect(NOT_INSTALLED_LINES[0]).toContain('https://tailscale.com/download');
    expect(NOT_INSTALLED_LINES[1]).toContain('-- --tailscale');
    for (const l of NOT_INSTALLED_LINES) expect(l).toMatch(/[一-鿿]/);
  });

  it('prints the phone address, the account and the awake reminder', () => {
    const lines = phoneLines({ host: HOST, login: LOGIN });
    expect(lines[0]).toBe(`手機網址：https://${HOST}`);
    expect(lines.join('\n')).toContain(LOGIN);
    expect(lines.join('\n')).toContain('沒有睡眠');
  });
});

describe('doctorChecks', () => {
  const saved = { host: HOST, login: LOGIN };
  const running = parseStatus(statusJson());
  const serve = parseServeStatus(serveJson(), 4310);
  const remote = { url: `https://${HOST}`, logins: [LOGIN] };
  const statuses = (a) => doctorChecks({ saved, cli: '/t', status: running, serve, remote, port: 4310, ...a }).map((c) => c.status);

  it('is two OK lines when serve forwards to our port and the service accepts the address', () => {
    const checks = doctorChecks({ saved, cli: '/t', status: running, serve, remote, port: 4310 });
    expect(checks.map((c) => [c.status, c.label])).toEqual([['ok', 'Tailscale serve'], ['ok', '手機網址 / phone URL']]);
    expect(checks[0].detail).toBe(`https://${HOST} → http://127.0.0.1:4310`);
    expect(checks[1].detail).toBe(`https://${HOST}`);
    expect(checks[1].lines.join('\n')).toContain(LOGIN);
  });

  it('skips both lines when phone access was never set up', () => {
    expect(doctorChecks({ saved: undefined, cli: null, status: null, serve: null, remote: { url: null, logins: [] }, port: 4310 }).map((c) => c.status)).toEqual(['skip', 'skip']);
    expect(doctorChecks({ saved: { declined: true }, cli: '/t', status: running, serve, remote: undefined, port: 4310 }).map((c) => c.status)).toEqual(['skip', 'skip']);
    // an old server without the `remote` block
    expect(doctorChecks({ saved: undefined, cli: null, status: null, serve: null, remote: null, port: 4310 }).map((c) => c.status)).toEqual(['skip', 'skip']);
  });

  it('fails the serve line when Tailscale is gone, signed out or forwarding elsewhere', () => {
    expect(statuses({ cli: null, status: null, serve: null })).toEqual(['fail', 'ok']);
    expect(statuses({ status: parseStatus(statusJson({ BackendState: 'Stopped' })), serve: null })).toEqual(['fail', 'ok']);
    expect(statuses({ serve: parseServeStatus(serveJson(4320), 4310) })).toEqual(['fail', 'ok']);
    expect(statuses({ serve: parseServeStatus('{}', 4310) })).toEqual(['fail', 'ok']);
  });

  it('fails the address line when the service lacks the setting or the Mac was renamed', () => {
    expect(statuses({ remote: { url: null, logins: [] } })).toEqual(['ok', 'fail']);
    expect(statuses({ remote: null })).toEqual(['ok', 'fail']);
    expect(statuses({ remote: { url: `https://${HOST}`, logins: ['other@example.com'] } })).toEqual(['ok', 'fail']);
    expect(statuses({ remote: undefined })).toEqual(['ok', 'info']);
    const renamed = parseStatus(statusJson({ Self: { DNSName: 'new-name.tail1234.ts.net.', UserID: 12345 } }));
    expect(statuses({ status: renamed, serve: parseServeStatus(serveJson(4310, 'new-name.tail1234.ts.net'), 4310) })).toEqual(['fail', 'fail']);
  });
});

describe('the LaunchAgent with phone access', () => {
  const base = { node: '/n/bin/node', workingDirectory: '/w', dataDir: '/d', port: 4310, stdoutLog: '/l/o', stderrLog: '/l/e' };

  it('carries both variables only when phone access is on', () => {
    const off = launchAgent(base).EnvironmentVariables;
    expect(off).not.toHaveProperty('WORKBENCH_HTTPS_HOSTS');
    expect(off).not.toHaveProperty('WORKBENCH_TAILSCALE_LOGINS');
    expect(launchAgent({ ...base, remote: null }).EnvironmentVariables).toEqual(off);
    const on = launchAgent({ ...base, remote: { host: HOST, login: LOGIN } });
    expect(on.EnvironmentVariables).toEqual({ ...off, WORKBENCH_HTTPS_HOSTS: HOST, WORKBENCH_TAILSCALE_LOGINS: LOGIN });
    const xml = renderPlist(on);
    expect(xml).toContain(`<key>WORKBENCH_HTTPS_HOSTS</key>\n\t\t<string>${HOST}</string>`);
    expect(xml).toContain(`<key>WORKBENCH_TAILSCALE_LOGINS</key>\n\t\t<string>${LOGIN}</string>`);
    // the server stays on loopback: no WORKBENCH_HOST, and the ts.net name is not added to the plain-http hosts
    expect(on.EnvironmentVariables).not.toHaveProperty('WORKBENCH_HOST');
    expect(on.EnvironmentVariables).not.toHaveProperty('WORKBENCH_ALLOWED_HOSTS');
  });

  it('refuses a host or login that would split into several entries', () => {
    expect(() => launchAgent({ ...base, remote: { host: 'a.ts.net,evil.example', login: LOGIN } })).toThrow(/host/);
    expect(() => launchAgent({ ...base, remote: { host: 'https://a.ts.net', login: LOGIN } })).toThrow(/host/);
    expect(() => launchAgent({ ...base, remote: { host: HOST, login: 'a@b,c@d' } })).toThrow(/login/);
    expect(() => launchAgent({ ...base, remote: { host: HOST, login: '' } })).toThrow(/login/);
  });
});
