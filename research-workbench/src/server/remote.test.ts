import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiagnosticsDTO } from '../shared/api';
import { bareHost, buildApp, envList, type AppContext } from './app';
import { DemoProvider } from './market/demo';

/**
 * Phone access: `tailscale serve` forwards https://mac.tailnet.ts.net to the loopback server, keeps the
 * Host (without a port) and sets Tailscale-User-Login after stripping any incoming copy.
 */
const HTTPS = 'mac.tail1234.ts.net';
const LOCAL = '127.0.0.1:4310';
const LOGIN = 'Owner@Example.com';

let dir: string;
let g: AppContext;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-remote-'));
  g = await buildApp({
    dataDir: dir,
    providers: [new DemoProvider()],
    allowedHosts: [LOCAL, 'localhost:4310'],
    allowedOrigins: ['app://obsidian.md'],
    httpsHosts: [HTTPS.toUpperCase()],
    tailscaleLogins: [LOGIN],
  });
});
afterAll(async () => {
  await g.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string>, remoteAddress?: string) => g.app.inject({ method: 'GET', url, headers, remoteAddress });

describe('requests through the HTTPS host (tailscale serve)', () => {
  it('lets the listed Tailscale account in, whatever the letter case', async () => {
    for (const login of ['owner@example.com', 'OWNER@EXAMPLE.COM', ' Owner@Example.com ']) {
      const res = await get('/api/health', { host: HTTPS, 'tailscale-user-login': login, 'x-forwarded-proto': 'https' });
      expect(res.statusCode, login).toBe(200);
    }
    expect((await get('/api/projects', { host: HTTPS.toUpperCase(), 'tailscale-user-login': LOGIN })).statusCode).toBe(200);
  });

  it('refuses a request without a login on every route, with a message that says why', async () => {
    for (const url of ['/api/health', '/api/session', '/api/projects', '/api/diagnostics', '/api/vault/status', '/api/no-such-route']) {
      const res = await get(url, { host: HTTPS });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toMatchObject({ code: 'TAILSCALE_LOGIN_REQUIRED' });
      expect(res.json().error).toContain('Tailscale');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    // the page itself: plain text a phone browser shows as is
    const page = await get('/', { host: HTTPS });
    expect(page.statusCode).toBe(403);
    expect(page.headers['content-type']).toContain('text/plain');
    expect(page.body).toContain('Tailscale 帳號');
    const post = await g.app.inject({ method: 'POST', url: '/api/projects', headers: { host: HTTPS, authorization: `Bearer ${g.tokens.tokens.user}` }, payload: {} });
    expect(post.statusCode).toBe(403);
  });

  it('refuses another Tailscale account and an empty login', async () => {
    const other = await get('/api/health', { host: HTTPS, 'tailscale-user-login': 'guest@example.com' });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ code: 'TAILSCALE_LOGIN_NOT_ALLOWED' });
    expect(other.json().error).toContain('guest@example.com');
    expect((await get('/api/health', { host: HTTPS, 'tailscale-user-login': '' })).json()).toMatchObject({ code: 'TAILSCALE_LOGIN_REQUIRED' });
    // a prefix or a longer name is not a match
    expect((await get('/api/health', { host: HTTPS, 'tailscale-user-login': 'owner@example.com.evil.example' })).statusCode).toBe(403);
    // the user token does not replace the Tailscale login
    expect((await get('/api/projects', { host: HTTPS, authorization: `Bearer ${g.tokens.tokens.user}` })).statusCode).toBe(403);
  });

  it('only accepts the host name without a port', async () => {
    expect((await get('/api/health', { host: `${HTTPS}:443`, 'tailscale-user-login': LOGIN })).json()).toEqual({ error: 'Host not allowed' });
    expect((await get('/api/health', { host: `${HTTPS}:4310`, 'tailscale-user-login': LOGIN })).statusCode).toBe(403);
    expect((await get('/api/health', { host: `evil.${HTTPS}`, 'tailscale-user-login': LOGIN })).statusCode).toBe(403);
  });

  it('refuses the HTTPS host name when the connection is not from this Mac', async () => {
    const res = await get('/api/health', { host: HTTPS, 'tailscale-user-login': LOGIN }, '192.168.1.20');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TAILSCALE_ONLY' });
    expect((await get('/api/health', { host: HTTPS, 'tailscale-user-login': LOGIN }, '::1')).statusCode).toBe(200);
  });

  it('checks the origin: https://<host> is accepted, http://<host> and other sites are not', async () => {
    const withOrigin = (host: string, origin: string) => get('/api/health', { host, origin, 'tailscale-user-login': LOGIN });
    expect((await withOrigin(HTTPS, `https://${HTTPS}`)).statusCode).toBe(200);
    expect((await withOrigin(HTTPS, `HTTPS://${HTTPS.toUpperCase()}`)).statusCode).toBe(200);
    for (const origin of [`http://${HTTPS}`, `https://${HTTPS}:8443`, 'https://evil.example', 'null', `https://${LOCAL}`]) {
      const res = await withOrigin(HTTPS, origin);
      expect(res.statusCode, origin).toBe(403);
      expect(res.json(), origin).toEqual({ error: 'Origin not allowed' });
    }
    // the loopback page keeps its http:// origin
    expect((await get('/api/health', { host: LOCAL, origin: `http://${LOCAL}` })).statusCode).toBe(200);
    expect((await get('/api/health', { host: LOCAL, origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('sets a Secure session cookie through the HTTPS host and a plain one on loopback', async () => {
    const remote = await get('/api/session', { host: HTTPS, 'tailscale-user-login': LOGIN, 'sec-fetch-site': 'same-origin' });
    expect(remote.statusCode).toBe(200);
    const cookie = String(remote.headers['set-cookie']);
    expect(cookie).toMatch(/; Secure$/);
    expect(cookie).toContain('HttpOnly; SameSite=Strict');
    const local = await get('/api/session', { host: LOCAL });
    expect(String(local.headers['set-cookie'])).not.toContain('Secure');
    // X-Forwarded-Proto on a loopback host gets no cookie at all (see "forwarded requests" below)
    const spoofed = await get('/api/session', { host: LOCAL, 'x-forwarded-proto': 'https' });
    expect(spoofed.statusCode).toBe(403);
    expect(spoofed.headers['set-cookie']).toBeUndefined();

    // the cookie works for writes through the HTTPS host, still together with the Tailscale login
    const value = cookie.split(';')[0];
    const write = (headers: Record<string, string>) =>
      g.app.inject({ method: 'POST', url: '/api/projects', headers: { host: HTTPS, origin: `https://${HTTPS}`, cookie: value, ...headers }, payload: { name: 'Phone', security: { ticker: '1', priceSource: 'demo' } } });
    expect((await write({ 'tailscale-user-login': LOGIN })).statusCode).toBe(200);
    expect((await write({})).statusCode).toBe(403);
  });
});

/**
 * `tailscale serve` chooses the forwarding by the TLS server name and passes the Host header on as the
 * caller wrote it (ipn/ipnlocal/serve.go: `r.Out.Host = r.In.Host`), then adds X-Forwarded-Host, -Proto
 * and -For, and Tailscale-User-* for a signed-in user's device. So a tailnet device that is not the
 * owner's (a shared node, a tagged device, another member) can send "Host: 127.0.0.1:4310".
 */
describe('forwarded requests that name a local host', () => {
  const viaServe = (host: string, extra: Record<string, string> = {}) => ({ host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.9', ...extra });

  it('are refused on every route, whoever Tailscale says is calling', async () => {
    for (const host of [LOCAL, 'localhost:4310', 'LOCALHOST:4310']) {
      const extras: Record<string, string>[] = [{}, { 'tailscale-user-login': 'guest@example.com' }, { 'tailscale-user-login': LOGIN }, { 'tailscale-funnel-request': '?1' }];
      for (const extra of extras) {
        for (const url of ['/api/health', '/api/session', '/api/projects', '/api/diagnostics', '/api/settings/vault-dir', '/api/vault/status', '/%61pi/projects', '/', '/index.html', '/no-such-page']) {
          const res = await g.app.inject({ method: 'GET', url, headers: viaServe(host, extra) });
          expect(res.statusCode, `${host} ${url}`).toBe(403);
          expect(res.body, `${host} ${url}`).toContain('Tailscale');
          expect(res.headers['set-cookie']).toBeUndefined();
        }
      }
    }
    expect((await get('/api/health', viaServe(LOCAL))).json()).toMatchObject({ code: 'FORWARDED_LOCAL_HOST' });
    for (const method of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE'] as const) {
      const res = await g.app.inject({ method, url: '/api/projects', headers: { ...viaServe(LOCAL), authorization: `Bearer ${g.tokens.tokens.user}` } });
      expect(res.statusCode, method).toBe(403);
    }
  });

  it('cannot set the vault folder or fetch the user cookie, even with the user token', async () => {
    const put = await g.app.inject({
      method: 'PUT',
      url: '/api/settings/vault-dir',
      headers: { ...viaServe(LOCAL, { 'tailscale-user-login': LOGIN }), authorization: `Bearer ${g.tokens.tokens.user}` },
      payload: { dir: dir },
    });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({ code: 'FORWARDED_LOCAL_HOST' });
    // through the HTTPS host the owner is let in, and the folder still cannot be set from the phone
    const phone = await g.app.inject({
      method: 'PUT',
      url: '/api/settings/vault-dir',
      headers: { ...viaServe(HTTPS, { 'tailscale-user-login': LOGIN }), authorization: `Bearer ${g.tokens.tokens.user}` },
      payload: { dir: dir },
    });
    expect(phone.statusCode).toBe(403);
    expect(phone.json()).toMatchObject({ code: 'LOCAL_ONLY' });
    expect((await get('/api/settings/vault-dir', { host: LOCAL })).json()).toMatchObject({ dir: null });
  });

  it('any one of the proxy headers is enough, in any spelling', async () => {
    for (const h of ['x-forwarded-host', 'X-Forwarded-For', 'x-forwarded-proto', 'Forwarded', 'tailscale-user-login', 'Tailscale-User-Name', 'tailscale-headers-info', 'Tailscale_User_Login', 'tailscale-app-capabilities']) {
      const res = await get('/api/projects', { host: LOCAL, [h]: 'x' });
      expect(res.statusCode, h).toBe(403);
    }
    // an empty value still counts: the header is there
    expect((await get('/api/projects', { host: LOCAL, 'x-forwarded-host': '' })).statusCode).toBe(403);
  });

  it('a request from the internet through Funnel is refused: it carries no Tailscale account', async () => {
    const res = await get('/api/projects', viaServe(HTTPS, { 'tailscale-funnel-request': '?1' }));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TAILSCALE_LOGIN_REQUIRED' });
  });

  it('host spellings other than the exact name are not the HTTPS host', async () => {
    for (const host of [`${HTTPS}.`, `${HTTPS}:443`, ` ${HTTPS}`, `${HTTPS}@127.0.0.1:4310`, `127.0.0.1:4310.${HTTPS}`, '']) {
      const res = await get('/api/health', viaServe(host, { 'tailscale-user-login': LOGIN }));
      expect(res.statusCode, host).toBe(403);
    }
    // X-Forwarded-Host does not replace Host
    const res = await get('/api/health', { host: 'attacker.example', 'x-forwarded-host': HTTPS, 'tailscale-user-login': LOGIN });
    expect(res.json()).toEqual({ error: 'Host not allowed' });
  });

  it('without phone access the headers mean nothing, as before', async () => {
    const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-remote-plain-'));
    const plain = await buildApp({ dataDir: d4, providers: [new DemoProvider()], allowedHosts: [LOCAL] });
    try {
      expect((await plain.app.inject({ method: 'GET', url: '/api/health', headers: viaServe(LOCAL) })).statusCode).toBe(200);
    } finally {
      await plain.app.close();
      fs.rmSync(d4, { recursive: true, force: true });
    }
  });
});

describe('requests on loopback hosts', () => {
  it('need no Tailscale login', async () => {
    expect((await get('/api/health', { host: LOCAL })).statusCode).toBe(200);
    expect((await get('/api/projects', { host: 'localhost:4310' })).statusCode).toBe(200);
    expect((await get('/api/projects', { host: LOCAL, origin: `http://${LOCAL}`, cookie: 'x=1', 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    // a spoofed login does not make a foreign host acceptable either
    expect((await get('/api/health', { host: 'attacker.example', 'tailscale-user-login': LOGIN })).json()).toEqual({ error: 'Host not allowed' });
  });

  it('reports the phone address and the allowed accounts in /api/diagnostics', async () => {
    const d = (await get('/api/diagnostics', { host: LOCAL })).json() as DiagnosticsDTO;
    expect(d.remote).toEqual({ url: `https://${HTTPS}`, logins: ['owner@example.com'] });
  });
});

describe('without the HTTPS settings', () => {
  it('refuses a ts.net host like any other and reports no phone address', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-remote-off-'));
    const plain = await buildApp({ dataDir: d2, providers: [new DemoProvider()], allowedHosts: [LOCAL] });
    try {
      const res = await plain.app.inject({ method: 'GET', url: '/api/health', headers: { host: HTTPS, 'tailscale-user-login': LOGIN } });
      expect(res.json()).toEqual({ error: 'Host not allowed' });
      const d = (await plain.app.inject({ method: 'GET', url: '/api/diagnostics', headers: { host: LOCAL } })).json() as DiagnosticsDTO;
      expect(d.remote).toEqual({ url: null, logins: [] });
    } finally {
      await plain.app.close();
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });

  it('refuses everyone through an HTTPS host when no account is listed', async () => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-remote-nologin-'));
    const open = await buildApp({ dataDir: d3, providers: [new DemoProvider()], allowedHosts: [LOCAL], httpsHosts: [HTTPS], tailscaleLogins: [] });
    try {
      const res = await open.app.inject({ method: 'GET', url: '/api/health', headers: { host: HTTPS, 'tailscale-user-login': LOGIN } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'TAILSCALE_LOGIN_NOT_ALLOWED' });
    } finally {
      await open.app.close();
      fs.rmSync(d3, { recursive: true, force: true });
    }
  });
});

describe('WORKBENCH_HTTPS_HOSTS parsing', () => {
  it('accepts bare host names only', () => {
    expect(bareHost(' Mac.Tail1234.ts.net. ')).toBe('mac.tail1234.ts.net');
    for (const bad of ['https://mac.ts.net', 'mac.ts.net:443', 'mac.ts.net/x', '', '*.ts.net', 'a b.ts.net', '-x.ts.net']) expect(bareHost(bad), bad).toBe('');
    expect(envList(' a.ts.net, ,b.ts.net ')).toEqual(['a.ts.net', 'b.ts.net']);
    expect(envList(undefined)).toEqual([]);
  });
});
