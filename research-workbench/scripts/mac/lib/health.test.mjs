import { describe, expect, it } from 'vitest';
import { appUrl, checkHealth, healthUrl, waitForHealth } from './health.mjs';

/** A fake clock: sleep advances it. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms), advance: (ms) => void (t += ms) };
}
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const response = (status) => ({ ok: status >= 200 && status < 300, status, text: async () => '{"ok":true}' });

describe('URLs', () => {
  it('uses 127.0.0.1 and the port', () => {
    expect(healthUrl(4310)).toBe('http://127.0.0.1:4310/api/health');
    expect(appUrl(4320)).toBe('http://127.0.0.1:4320/');
  });
});

describe('checkHealth', () => {
  it('reports status, body and connection errors', async () => {
    expect(await checkHealth('u', { fetch: async () => response(200) })).toMatchObject({ ok: true, status: 200, body: '{"ok":true}' });
    expect(await checkHealth('u', { fetch: async () => response(503) })).toMatchObject({ ok: false, status: 503, error: 'HTTP 503' });
    expect(await checkHealth('u', { fetch: async () => Promise.reject(refused()) })).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
  });
});

describe('waitForHealth', () => {
  it('returns as soon as the server answers', async () => {
    const c = clock();
    let calls = 0;
    const fetch = async () => (++calls < 4 ? Promise.reject(refused()) : response(200));
    const waits = [];
    const r = await waitForHealth({ url: 'u', fetch, sleep: c.sleep, now: c.now, onWait: (w) => waits.push(w.attempts) });
    expect(r).toEqual({ ok: true, attempts: 4, elapsedMs: 3000 });
    expect(waits).toEqual([1, 2, 3]);
  });

  it('gives up after the timeout with the last error', async () => {
    const c = clock();
    const r = await waitForHealth({ url: 'u', fetch: async () => response(502), sleep: c.sleep, now: c.now, timeoutMs: 60_000, intervalMs: 1000 });
    expect(r).toEqual({ ok: false, attempts: 61, elapsedMs: 60_000, lastError: 'HTTP 502' });
  });

  it('stops early when told the server is gone', async () => {
    const c = clock();
    let exited = false;
    const fetch = async () => {
      if (c.now() >= 3000) exited = true;
      throw refused();
    };
    const r = await waitForHealth({ url: 'u', fetch, sleep: c.sleep, now: c.now, stop: () => (exited ? 'the server exited (1)' : null) });
    expect(r).toEqual({ ok: false, attempts: 4, elapsedMs: 3000, lastError: 'the server exited (1)' });
  });

  it('counts slow requests against the timeout', async () => {
    const c = clock();
    const fetch = async () => {
      c.advance(2000);
      throw refused();
    };
    const r = await waitForHealth({ url: 'u', fetch, sleep: c.sleep, now: c.now, timeoutMs: 10_000, intervalMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(4);
    expect(r.elapsedMs).toBeLessThanOrEqual(11_000);
  });
});
