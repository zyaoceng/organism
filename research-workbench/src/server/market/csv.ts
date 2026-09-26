import type { Bar } from '../../domain/market/indicators';
import { MarketDataError, type MarketDataProvider, type ProviderQuote } from './provider';

export interface CsvParseResult {
  bars: Bar[];
  skipped: number;
}

const HEADER_ALIASES: Record<string, keyof Bar> = {
  date: 'date',
  日期: 'date',
  open: 'open',
  開盤價: 'open',
  high: 'high',
  最高價: 'high',
  low: 'low',
  最低價: 'low',
  close: 'close',
  收盤價: 'close',
  'adj close': 'adjClose',
  adj_close: 'adjClose',
  adjclose: 'adjClose',
  volume: 'volume',
  成交股數: 'volume',
};

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normDate(s: string): string | null {
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(d)) ? null : d;
}

/** Parse a daily OHLCV CSV (Yahoo-style headers, or Chinese TWSE headers). */
export function parseOhlcvCsv(text: string): CsvParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new MarketDataError('PROVIDER', 'The CSV needs a header row and at least one data row');
  const header = splitLine(lines[0]).map((h) => HEADER_ALIASES[h.toLowerCase()] ?? HEADER_ALIASES[h] ?? null);
  for (const need of ['date', 'open', 'high', 'low', 'close'] as const) {
    if (!header.includes(need)) throw new MarketDataError('PROVIDER', `The CSV is missing a "${need}" column (expected headers like Date, Open, High, Low, Close, Volume)`);
  }
  const byDate = new Map<string, Bar>();
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = splitLine(line);
    const rec: Partial<Record<keyof Bar, string>> = {};
    header.forEach((h, i) => {
      if (h) rec[h] = cells[i];
    });
    const date = normDate(rec.date ?? '');
    const num = (s: string | undefined) => (s === undefined || s === '' ? NaN : Number(s.replace(/,/g, '')));
    const b = { open: num(rec.open), high: num(rec.high), low: num(rec.low), close: num(rec.close) };
    if (!date || Object.values(b).some((x) => !Number.isFinite(x) || x <= 0)) {
      skipped++;
      continue;
    }
    const vol = num(rec.volume);
    const adj = num(rec.adjClose);
    byDate.set(date, { date, ...b, volume: Number.isFinite(vol) ? vol : 0, adjClose: Number.isFinite(adj) ? adj : null });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!bars.length) throw new MarketDataError('PROVIDER', 'No valid rows found in the CSV');
  return { bars, skipped };
}

/** Holds user-imported bars only; it never fetches. Quotes come from the last imported close. */
export class CsvProvider implements MarketDataProvider {
  id = 'csv';
  label = 'CSV import';
  description = 'Daily OHLCV you import from a file. Provenance: file name and import time.';
  synthetic = false;
  fetches = false;

  async getQuote(): Promise<ProviderQuote> {
    throw new MarketDataError('UNSUPPORTED', 'CSV data is imported, not fetched. Import a newer file to update it.');
  }

  async getHistoricalPrices(): Promise<Bar[]> {
    throw new MarketDataError('UNSUPPORTED', 'CSV data is imported, not fetched. Import a newer file to update it.');
  }
}
