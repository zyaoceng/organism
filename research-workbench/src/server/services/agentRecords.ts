/**
 * Records an AI writes outside the draft: trades (new, imported from an old journal, closed),
 * companies, and the cross-company security lookup. The rules are the server's, not the tool's:
 * share counts (1 張 = 1000 股), no future dates, prices inside the day's bar unless confirmed,
 * a journal excerpt imported twice gives back the same trade, and an import that looks like a trade
 * already on record (another excerpt, or typed in by hand) waits for the user's word.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Bar } from '../../domain/market/indicators';
import type { SecurityMatchDTO, TradeCloseResponse, TradeDTO, TradeRecordResponse } from '../../shared/api';
import { noteAiAction, quietRequest } from '../actor';
import type { DB } from '../db/connection';
import type { MarketService } from '../market/service';
import { getBars } from '../repos/market';
import { getProject, primarySecurity } from '../repos/projects';
import { createTrade, getTrade, tradeByExternalRef, updateTrade } from '../repos/records';
import { badRequest, conflict, localToday } from '../util';

// ---------------------------------------------------------------- journal identity

/**
 * The canonical form of a journal excerpt, so the same text pasted twice (other line endings,
 * spacing or Unicode composition) is recognised: NFC; CRLF and lone CR become LF; on each line,
 * runs of spaces and tabs become one space and the line is trimmed; then the whole text is trimmed.
 */
export function normalizeSourceText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
}

/** external_ref of a trade imported from a journal excerpt: unique across all companies. */
export function journalRef(s: string): string {
  return `jrnl:${crypto.createHash('sha256').update(normalizeSourceText(s)).digest('hex').slice(0, 32)}`;
}

/** Shortest journal excerpt accepted for an import (shorter text cannot identify a trade). */
export const MIN_SOURCE_TEXT = 10;
/** Longest excerpt kept (normalised): one trade's entry, not a whole journal pasted at once. */
export const MAX_SOURCE_TEXT = 4000;

/** Relative price difference under which an imported trade is taken for one already on record. */
const DUPLICATE_PRICE_TOLERANCE = 0.005;

// ---------------------------------------------------------------- securities across companies

const bareTicker = (t: string) =>
  t
    .trim()
    .toUpperCase()
    .replace(/\.(TW|TWO)$/, '');

/** Every company holding this security: by ticker, or by provider symbol with or without .TW/.TWO. */
export function findSecurities(db: DB, ticker: string): SecurityMatchDTO[] {
  const t = bareTicker(ticker);
  if (!t) return [];
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.ticker, s.exchange, s.api_symbol, s.currency, p.name AS project_name, p.archived_at
       FROM securities s JOIN projects p ON p.id = s.project_id
       WHERE UPPER(s.ticker) = @t OR UPPER(s.api_symbol) IN (@t, @t || '.TW', @t || '.TWO')
       ORDER BY p.archived_at IS NOT NULL, p.updated_at DESC`,
    )
    .all({ t }) as { id: string; project_id: string; ticker: string; exchange: string; api_symbol: string; currency: string; project_name: string; archived_at: string | null }[];
  return rows.map((r) => ({
    securityId: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    ticker: r.ticker,
    exchange: r.exchange,
    apiSymbol: r.api_symbol,
    currency: r.currency,
    archived: r.archived_at !== null,
  }));
}

/** An AI may create a company only after asking the user, and only if no company holds the security yet. */
export function checkAgentProjectCreate(db: DB, b: { confirmedByUser?: unknown; security?: { ticker?: string } }) {
  if (b.confirmedByUser !== true) throw badRequest('AI 建立公司前要先問使用者，同意後帶 confirmedByUser: true', { code: 'CONFIRM_REQUIRED' });
  const matches = findSecurities(db, b.security?.ticker ?? '');
  if (matches.length) {
    throw conflict(`已經有公司使用這個代號：${matches.map((m) => `${m.projectName}（${m.ticker}）`).join('、')}；請把交易記在那家公司`, { code: 'SECURITY_EXISTS', matches });
  }
}

// ---------------------------------------------------------------- trades

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const price = z.number().positive().finite();

const RecordTradeSchema = z.object({
  side: z.enum(['long', 'short']),
  entryDate: isoDate,
  entryPrice: price,
  quantityShares: z.number().positive().finite(),
  entryReason: z.string().max(10_000).optional(),
  stopAtEntry: price.nullable().optional(),
  targetPriceAtEntry: price.nullable().optional(),
  fees: z.number().min(0).finite().optional(),
  notes: z.string().max(10_000).optional(),
  exitDate: isoDate.optional(),
  exitPrice: price.optional(),
  exitReason: z.string().max(10_000).optional(),
  confirmPrice: z.boolean().optional(),
  source: z.enum(['entry', 'import']).default('entry'),
  sourceText: z.string().max(20_000).optional(),
  /** Import again an excerpt whose trade was deleted. */
  allowReimport: z.boolean().optional(),
  /** Import although a trade with the same side, date, shares and price is already on record. */
  allowDuplicate: z.boolean().optional(),
  /** Run every check and return the trade that would be recorded, writing nothing. */
  dryRun: z.boolean().optional(),
});

/** Thrown inside the dry run's transaction to roll it back. */
class DryRun {
  constructor(readonly trade: TradeDTO) {}
}

const CloseTradeSchema = z.object({
  exitDate: isoDate,
  exitPrice: price,
  exitReason: z.string().max(10_000).optional(),
  fees: z.number().min(0).finite().optional(),
  confirmPrice: z.boolean().optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`);
    throw badRequest(`參數有誤：${issues.join('；')}`, { code: 'INVALID_INPUT', issues });
  }
  return r.data;
}

/** Bars of the company's price source, fetched first if none are cached (fetch errors are ignored). */
async function barsFor(db: DB, market: MarketService, projectId: string): Promise<{ bars: Bar[]; provider: string; currency: string } | null> {
  const sec = primarySecurity(db, projectId);
  if (!sec) return null;
  try {
    await market.bars(sec);
  } catch {
    /* checked below against whatever is cached */
  }
  return { bars: getBars(db, sec.id, sec.priceSource), provider: sec.priceSource, currency: sec.currency };
}

/** The price must lie within the day's bar (0.2% tolerance) unless the AI confirms it with the user. */
function checkPrice(which: '進場' | '出場', date: string, p: number, data: Awaited<ReturnType<typeof barsFor>>, confirm: boolean, warnings: string[]) {
  const bars = data?.bars ?? [];
  if (!bars.length) {
    warnings.push(`沒有股價資料，無法檢查${which}價`);
    return;
  }
  const bar = bars.find((b) => b.date === date);
  if (bar) {
    if ((p < bar.low * 0.998 || p > bar.high * 1.002) && !confirm) {
      throw conflict(`${which}價 ${p} 不在 ${date} 的價格區間 ${bar.low}–${bar.high}（${data!.provider}）。請和使用者確認後帶 confirm_price=true`, {
        code: 'PRICE_OUT_OF_RANGE',
        which: which === '進場' ? 'entry' : 'exit',
        date,
        low: bar.low,
        high: bar.high,
        price: p,
        provider: data!.provider,
      });
    }
    return;
  }
  if (date < bars[0].date) warnings.push(`沒有那麼早的股價（最早 ${bars[0].date}），無法檢查${which}價`);
  else if (date > bars[bars.length - 1].date) warnings.push(`股價只到 ${bars[bars.length - 1].date}，無法檢查 ${date} 的${which}價`);
  else warnings.push(`${date} 沒有交易資料（休市？），無法檢查${which}價`);
}

function quantityWarnings(t: TradeDTO, currency: string): string[] {
  const out: string[] = [];
  if (currency === 'TWD') {
    out.push(t.quantity % 1000 === 0 ? `${t.quantity.toLocaleString('en-US')} 股 = ${(t.quantity / 1000).toLocaleString('en-US')} 張` : `台股 1 張 = 1000 股；這筆是 ${t.quantity.toLocaleString('en-US')} 股（含零股）`);
  }
  out.push(`成交金額約 ${Math.round(t.quantity * t.entryPrice).toLocaleString('en-US')} ${currency}`);
  return out;
}

/** POST /api/projects/:id/trades by an AI client. */
export async function recordAgentTrade(db: DB, market: MarketService, projectId: string, body: unknown): Promise<TradeRecordResponse> {
  getProject(db, projectId);
  if (body && typeof body === 'object' && 'quantity' in body) {
    throw badRequest('數量請用 quantityShares（股數；台股 1 張 = 1000 股），不要用 quantity', { code: 'QUANTITY_SHARES_REQUIRED' });
  }
  const b = parseBody(RecordTradeSchema, body);
  if (b.dryRun) quietRequest();
  const today = localToday();
  for (const d of [b.entryDate, b.exitDate]) if (d && d > today) throw badRequest(`日期 ${d} 在未來（今天是 ${today}）`, { code: 'FUTURE_DATE', today });
  if ((b.exitDate === undefined) !== (b.exitPrice === undefined)) throw badRequest('出場要同時填日期和價格', { code: 'INVALID_INPUT' });

  let sourceText: string | null = null;
  let ref: string | null = null;
  if (b.sourceText !== undefined) {
    sourceText = normalizeSourceText(b.sourceText) || null;
    if (sourceText && sourceText.length > MAX_SOURCE_TEXT) {
      throw badRequest(`原文 sourceText 太長（${sourceText.length} 字，上限 ${MAX_SOURCE_TEXT}）：只附這一筆交易的那段日誌`, { code: 'SOURCE_TEXT_TOO_LONG', length: sourceText.length, max: MAX_SOURCE_TEXT });
    }
    // a text too short to identify a trade ("買兩張") must not key it: the next trade quoting the
    // same words would come back as "existing" and never be recorded
    if (sourceText && sourceText.length >= MIN_SOURCE_TEXT) ref = journalRef(b.sourceText);
  }
  if (b.source === 'import' && (sourceText ?? '').length < MIN_SOURCE_TEXT) {
    throw badRequest(`匯入舊日誌要附上原文 sourceText（至少 ${MIN_SOURCE_TEXT} 個字）`, { code: 'SOURCE_TEXT_REQUIRED' });
  }
  if (ref) {
    const existing = tradeByExternalRef(db, ref);
    if (existing) return { status: 'existing', trade: existing, warnings: ['這段日誌已經匯入過，回傳既有的那筆交易（沒有新增）'] };
    const deleted = db
      .prepare("SELECT entity_id, at FROM audit_log WHERE entity = 'trade' AND action = 'delete' AND json_extract(before_json, '$.externalRef') = ? ORDER BY id DESC LIMIT 1")
      .get(ref) as { entity_id: string; at: string } | undefined;
    if (deleted && !b.allowReimport) {
      throw conflict(`這段日誌匯入的交易已在 ${deleted.at.slice(0, 10)} 被刪除。要重新匯入，請先問使用者，同意後帶 allow_reimport=true`, {
        code: 'IMPORT_DELETED',
        tradeId: deleted.entity_id,
        deletedAt: deleted.at,
      });
    }
  }
  if (b.source === 'import' && !b.allowDuplicate) {
    // the same trade written up twice in the journal (or already typed in by hand) has another
    // excerpt, so its key differs: catch it by what was traded
    const dup = db
      .prepare(
        `SELECT id, entry_price, quantity, source, created_by FROM trades
         WHERE project_id = ? AND side = ? AND entry_date = ? AND ABS(quantity - ?) < 1e-9
           AND ABS(entry_price - ?) <= ? * ? AND (external_ref IS NULL OR external_ref <> ?)
         ORDER BY created_at LIMIT 1`,
      )
      .get(projectId, b.side, b.entryDate, b.quantityShares, b.entryPrice, DUPLICATE_PRICE_TOLERANCE, b.entryPrice, ref ?? '') as
      | { id: string; entry_price: number; quantity: number; source: string; created_by: string }
      | undefined;
    if (dup) {
      throw conflict(
        `這家公司已經有一筆 ${b.entryDate} ${b.side === 'long' ? '買進' : '放空'} ${b.quantityShares.toLocaleString('en-US')} 股 @ ${dup.entry_price} 的交易（${dup.id}），可能是同一筆。請先問使用者；確定是另一筆交易才帶 allow_duplicate=true`,
        { code: 'PROBABLE_DUPLICATE', duplicateOf: dup.id, entryDate: b.entryDate, side: b.side, quantity: dup.quantity, entryPrice: dup.entry_price, source: dup.source, createdBy: dup.created_by },
      );
    }
  }

  const warnings: string[] = [];
  const data = await barsFor(db, market, projectId);
  checkPrice('進場', b.entryDate, b.entryPrice, data, !!b.confirmPrice, warnings);
  if (b.exitDate && b.exitPrice !== undefined) checkPrice('出場', b.exitDate, b.exitPrice, data, !!b.confirmPrice, warnings);

  const create = () =>
    createTrade(
      db,
      projectId,
      {
        side: b.side,
        entryDate: b.entryDate,
        entryPrice: b.entryPrice,
        quantity: b.quantityShares,
        entryReason: b.entryReason ?? '',
        stopAtEntry: b.stopAtEntry ?? null,
        targetPriceAtEntry: b.targetPriceAtEntry ?? null,
        fees: b.fees ?? 0,
        notes: b.notes ?? '',
        exitDate: b.exitDate ?? null,
        exitPrice: b.exitPrice ?? null,
        exitReason: b.exitReason ?? '',
      },
      { source: b.source, externalRef: ref, sourceText, noDefaults: b.source === 'import' },
    );
  if (b.dryRun) {
    // the real insert (defaults, validation, constraints) inside a transaction that is rolled back
    let trade: TradeDTO | null = null;
    try {
      db.transaction(() => {
        throw new DryRun(create());
      })();
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
      trade = e.trade;
    }
    warnings.push(...quantityWarnings(trade!, data?.currency ?? ''));
    if (b.source === 'import') warnings.push('匯入的交易只記日誌寫明的數字，不會自動補停損與目標價');
    warnings.push('這是預覽，沒有寫入；給使用者確認後，用同樣的內容、不帶 dry_run 再呼叫一次');
    // no id: nothing was stored, and the id drawn inside the rolled-back insert names nothing
    return { status: 'would-create', trade: { ...trade!, id: '' }, warnings };
  }

  let trade: TradeDTO;
  try {
    trade = create();
  } catch (e) {
    // the same excerpt sent twice at once: the second insert hits the unique index
    const existing = ref && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' ? tradeByExternalRef(db, ref) : null;
    if (existing) return { status: 'existing', trade: existing, warnings: ['這段日誌已經匯入過，回傳既有的那筆交易（沒有新增）'] };
    throw e;
  }
  warnings.push(...quantityWarnings(trade, data?.currency ?? ''));
  if (b.source === 'import') warnings.push('匯入的交易只記日誌寫明的數字，沒有自動補停損與目標價');
  noteAiAction({
    kind: 'trade',
    projectId,
    ref: trade.id,
    summary: `${b.source === 'import' ? '匯入' : '記錄'}交易：${trade.side === 'long' ? '買進' : '放空'} ${trade.quantity.toLocaleString('en-US')} 股 @ ${trade.entryPrice}（${trade.entryDate}）`,
  });
  return { status: 'created', trade, warnings };
}

/** PATCH /api/trades/:id by an AI client: only the exit (close_trade). */
export async function closeAgentTrade(db: DB, market: MarketService, tradeId: string, body: unknown): Promise<TradeCloseResponse> {
  const before = getTrade(db, tradeId);
  const allowed = new Set(['exitDate', 'exitPrice', 'exitReason', 'fees', 'confirmPrice']);
  const extra = Object.keys((body ?? {}) as object).filter((k) => !allowed.has(k));
  if (extra.length) throw badRequest(`AI 只能用 close_trade 填出場資料（不接受：${extra.join(', ')}）`, { code: 'AGENT_FIELDS' });
  const b = parseBody(CloseTradeSchema, body);
  const today = localToday();
  if (b.exitDate > today) throw badRequest(`出場日 ${b.exitDate} 在未來（今天是 ${today}）`, { code: 'FUTURE_DATE', today });
  const warnings: string[] = [];
  checkPrice('出場', b.exitDate, b.exitPrice, await barsFor(db, market, before.projectId), !!b.confirmPrice, warnings);
  const trade = updateTrade(db, tradeId, { exitDate: b.exitDate, exitPrice: b.exitPrice, ...(b.exitReason !== undefined ? { exitReason: b.exitReason } : {}), ...(b.fees !== undefined ? { fees: b.fees } : {}) });
  noteAiAction({ kind: 'trade_close', projectId: trade.projectId, ref: trade.id, summary: `出場：${trade.quantity.toLocaleString('en-US')} 股 @ ${trade.exitPrice}（${trade.exitDate}）` });
  return { trade, warnings };
}
