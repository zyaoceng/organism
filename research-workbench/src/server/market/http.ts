import { MarketDataError } from './provider';

/** GET a JSON document, mapping transport and HTTP failures to typed market-data errors. */
export async function getJson<T>(
  fetchImpl: typeof fetch,
  source: string,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (research-workbench)', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new MarketDataError('NETWORK', `Could not reach ${source}: ${(e as Error).message}`);
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new MarketDataError('RATE_LIMITED', `${source} rate limit reached. Try again later.`, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch {
    throw new MarketDataError('PROVIDER', `${source} returned a non-JSON response (HTTP ${res.status})`);
  }
  return { status: res.status, body };
}

/** Taiwan stock code without a Yahoo suffix: "7899.TWO" → "7899", "2330" → "2330". Null for non-Taiwan symbols. */
export function taiwanCode(symbol: string): string | null {
  const m = /^(\d{4,6}[A-Z]?)(\.TWO?)?$/i.exec(symbol.trim());
  return m ? m[1].toUpperCase() : null;
}
