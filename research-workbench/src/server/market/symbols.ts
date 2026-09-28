import type { SymbolMatchDTO, SymbolSearchDTO } from '../../shared/api';
import type { FinMindProvider } from './finmind';
import { MarketDataError } from './provider';
import type { YahooSearchQuote } from './yahoo';

export interface TaiwanEntry {
  code: string;
  name: string;
  board: 'listed' | 'otc' | 'emerging';
  industry?: string;
}

const BOARD_EXCHANGE = { listed: 'TWSE', otc: 'TPEx', emerging: 'Emerging' } as const;
const BOARD_SUFFIX = { listed: '.TW', otc: '.TWO', emerging: '.TWO' } as const;

/** Map FinMind's TaiwanStockInfo `type` to a board. */
export function finmindBoard(type: string | undefined): TaiwanEntry['board'] | null {
  const t = (type ?? '').toLowerCase();
  if (t === 'twse') return 'listed';
  if (t === 'tpex') return 'otc';
  if (t.includes('emerging') || t === 'esb' || t === 'rotc') return 'emerging';
  return null;
}

export async function loadFinMindDirectory(finmind: FinMindProvider): Promise<TaiwanEntry[]> {
  const rows = await finmind.stockInfo();
  const out = new Map<string, TaiwanEntry>();
  for (const r of rows) {
    const board = finmindBoard(r.type);
    if (!board || !r.stock_id || out.has(r.stock_id)) continue;
    out.set(r.stock_id, { code: r.stock_id, name: r.stock_name, board, industry: r.industry_category });
  }
  return [...out.values()];
}

/**
 * TWSE's public ISIN code lists (isin.twse.com.tw, Big5 HTML): strMode 2 = listed, 4 = OTC,
 * 5 = emerging. Used when FinMind is unavailable. Rows look like
 * `<td>2330　台積電</td><td>TW0002330008</td><td>1994/09/05</td><td>上市</td><td>半導體業</td>`.
 */
export function parseIsinPage(html: string, board: TaiwanEntry['board']): TaiwanEntry[] {
  const out: TaiwanEntry[] = [];
  const row = /<tr[^>]*>\s*<td[^>]*>\s*([0-9A-Z]{4,6})[　\s]+([^<]+?)\s*<\/td>\s*<td[^>]*>\s*(TW[0-9A-Z]+)\s*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>([^<]*)<\/td>/gi;
  for (const m of html.matchAll(row)) {
    const code = m[1].toUpperCase();
    // Stocks and ETFs have 4–5 digit codes (plus an optional letter); 6-digit codes are warrants.
    if (!/^\d{4,5}[A-Z]?$/.test(code)) continue;
    out.push({ code, name: m[2].trim(), board, industry: m[4].trim() || undefined });
  }
  return out;
}

export async function loadIsinDirectory(fetchImpl: typeof fetch = fetch, baseUrl = 'https://isin.twse.com.tw/isin/C_public.jsp'): Promise<TaiwanEntry[]> {
  const pages: [string, TaiwanEntry['board']][] = [
    ['2', 'listed'],
    ['4', 'otc'],
    ['5', 'emerging'],
  ];
  const all: TaiwanEntry[] = [];
  for (const [mode, board] of pages) {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}?strMode=${mode}`, { signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new MarketDataError('NETWORK', `Could not reach the TWSE ISIN list: ${(e as Error).message}`);
    }
    if (!res.ok) throw new MarketDataError('PROVIDER', `TWSE ISIN list HTTP ${res.status}`);
    const html = new TextDecoder('big5').decode(await res.arrayBuffer());
    all.push(...parseIsinPage(html, board));
  }
  if (!all.length) throw new MarketDataError('PROVIDER', 'The TWSE ISIN list could not be parsed');
  return all;
}

function taiwanMatch(e: TaiwanEntry, source: string): SymbolMatchDTO {
  return {
    ticker: e.code,
    name: e.name,
    exchange: BOARD_EXCHANGE[e.board],
    board: e.board,
    currency: 'TWD',
    apiSymbol: `${e.code}${BOARD_SUFFIX[e.board]}`,
    suggestedProvider: 'finmind',
    industry: e.industry,
    source,
  };
}

const US_EXCHANGES: Record<string, string> = { NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NYQ: 'NYSE', ASE: 'NYSE American', PCX: 'NYSE Arca', BTS: 'Cboe' };

export function yahooMatch(q: YahooSearchQuote): SymbolMatchDTO {
  const ex = q.exchange ?? '';
  const code = /^(\d{4,6}[A-Z]?)\.(TWO?)$/i.exec(q.symbol);
  if (code) {
    const board = code[2].toUpperCase() === 'TW' ? 'listed' : 'otc';
    return {
      ticker: code[1],
      name: q.longname ?? q.shortname ?? q.symbol,
      exchange: board === 'listed' ? 'TWSE' : 'TPEx',
      board,
      currency: 'TWD',
      apiSymbol: q.symbol.toUpperCase(),
      suggestedProvider: 'finmind',
      source: 'yahoo-search',
    };
  }
  const us = US_EXCHANGES[ex];
  return {
    ticker: q.symbol,
    name: q.longname ?? q.shortname ?? q.symbol,
    exchange: us ?? q.exchDisp ?? ex,
    board: 'other',
    currency: us ? 'USD' : '',
    apiSymbol: q.symbol,
    suggestedProvider: 'yahoo',
    source: 'yahoo-search',
  };
}

/** Rank a directory entry against the query; 0 = no match. */
function score(e: TaiwanEntry, q: string): number {
  const name = e.name.toLowerCase();
  if (e.code === q.toUpperCase()) return 100;
  if (name === q) return 95;
  if (e.code.startsWith(q.toUpperCase())) return 80 - e.code.length;
  if (name.startsWith(q)) return 70;
  if (name.includes(q)) return 50;
  return 0;
}

export interface SymbolSearchSources {
  /** Full Taiwan directory; called at most once per `directoryTtlMs`. */
  taiwanDirectory?: () => Promise<TaiwanEntry[]>;
  yahooSearch?: (q: string) => Promise<YahooSearchQuote[]>;
  directoryTtlMs?: number;
  now?: () => number;
}

/** Find a security by code or company name (Chinese or English) across the configured sources. */
export class SymbolSearch {
  private directory: { at: number; entries: TaiwanEntry[] } | null = null;
  private directoryError: { at: number; message: string } | null = null;
  private loading: Promise<TaiwanEntry[]> | null = null;

  constructor(private readonly src: SymbolSearchSources) {}

  private now() {
    return this.src.now?.() ?? Date.now();
  }

  private async taiwan(): Promise<TaiwanEntry[]> {
    if (!this.src.taiwanDirectory) return [];
    const ttl = this.src.directoryTtlMs ?? 12 * 3600_000;
    if (this.directory && this.now() - this.directory.at < ttl) return this.directory.entries;
    // After a failure, wait a few minutes before hitting the sources again.
    if (this.directoryError && this.now() - this.directoryError.at < 5 * 60_000) throw new Error(this.directoryError.message);
    this.loading ??= this.src.taiwanDirectory().finally(() => (this.loading = null));
    try {
      const entries = await this.loading;
      this.directory = { at: this.now(), entries };
      this.directoryError = null;
      return entries;
    } catch (e) {
      this.directoryError = { at: this.now(), message: (e as Error).message };
      if (this.directory) return this.directory.entries;
      throw e;
    }
  }

  async search(query: string, limit = 15): Promise<SymbolSearchDTO> {
    const q = query.trim().toLowerCase();
    if (!q) return { query, results: [], errors: [] };
    const errors: string[] = [];
    const results: SymbolMatchDTO[] = [];

    let twFound = 0;
    try {
      const ranked = (await this.taiwan())
        .map((e) => ({ e, s: score(e, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.e.code.localeCompare(b.e.code))
        .slice(0, limit);
      twFound = ranked.length;
      results.push(...ranked.map((x) => taiwanMatch(x.e, 'taiwan-directory')));
    } catch (e) {
      errors.push(`Taiwan stock list: ${(e as Error).message}`);
    }

    // Yahoo knows US and other markets by ticker or English name; it is also the fallback for
    // Taiwan codes when the Taiwan list is unavailable.
    const wantYahoo = /[a-z]/.test(q) || (twFound === 0 && /^\d/.test(q));
    if (wantYahoo && this.src.yahooSearch) {
      try {
        for (const hit of await this.src.yahooSearch(query.trim())) {
          const m = yahooMatch(hit);
          if (!results.some((r) => r.ticker === m.ticker && r.currency === m.currency)) results.push(m);
        }
      } catch (e) {
        errors.push(`Yahoo search: ${(e as Error).message}`);
      }
    }
    return { query, results: results.slice(0, limit), errors };
  }
}
