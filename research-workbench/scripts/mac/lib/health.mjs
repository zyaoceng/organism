/**
 * Polling /api/health after (re)starting the service. fetch, sleep and the clock are injectable so the
 * timing logic is unit-tested without a server.
 */

export const healthUrl = (port) => `http://127.0.0.1:${port}/api/health`;
export const appUrl = (port) => `http://127.0.0.1:${port}/`;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const describeError = (e) => e?.cause?.code ?? e?.code ?? e?.name ?? e?.message ?? String(e);

/** One request. @returns {Promise<{ ok: boolean, status?: number, ms: number, error?: string, body?: string }>} */
export async function checkHealth(url, { fetch = globalThis.fetch, now = Date.now, timeoutMs = 2000 } = {}) {
  const t0 = now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, ms: now() - t0, body, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  } catch (e) {
    return { ok: false, ms: now() - t0, error: describeError(e) };
  }
}

/**
 * Poll until the endpoint answers 2xx or `timeoutMs` passes. `stop()` may return a reason to give up
 * early (the server process already exited).
 * @returns {Promise<{ ok: boolean, attempts: number, elapsedMs: number, lastError?: string }>}
 */
export async function waitForHealth({ url, timeoutMs = 60_000, intervalMs = 1000, fetch = globalThis.fetch, sleep = defaultSleep, now = Date.now, onWait, stop } = {}) {
  const start = now();
  let attempts = 0;
  let lastError;
  for (;;) {
    attempts++;
    const r = await checkHealth(url, { fetch, now, timeoutMs: Math.min(2000, timeoutMs) });
    if (r.ok) return { ok: true, attempts, elapsedMs: now() - start };
    lastError = r.error;
    const elapsed = now() - start;
    const reason = stop?.();
    if (reason) return { ok: false, attempts, elapsedMs: elapsed, lastError: reason };
    if (elapsed + intervalMs > timeoutMs) return { ok: false, attempts, elapsedMs: elapsed, lastError };
    onWait?.({ attempts, elapsedMs: elapsed, lastError });
    await sleep(intervalMs);
  }
}
