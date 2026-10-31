import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compute, freeze } from '../calc/engine';
import { findByRole } from '../model/tree';
import { sampleModel } from '../testing/sample';
import { frozenTargets } from '../valuation/targets';
import { scanBlock } from './block';
import { findFrontmatter } from './frontmatter';
import { resolveNote } from './links';
import { createNoteText, mergeNote } from './merge';
import { extractReflection } from './reflection';
import {
  cell,
  frozenHeadline,
  num,
  pct,
  quote,
  renderAiSessionNote,
  renderCompanyNote,
  renderIndexNote,
  renderResearchUpdateNote,
  renderTradeNote,
  type AiSessionIn,
  type CompanyNoteInput,
  type Headline,
  type NoteContext,
  type ResearchUpdateNoteInput,
  type RevisionIn,
  type TradeIn,
  type TradeNoteInput,
} from './render';
import { parseDoc } from './text';
import type { RenderedNote } from './types';

const ctx: NoteContext = {
  publicUrl: 'http://127.0.0.1:4310',
  localDate: (iso) => iso.slice(0, 10),
  actorLabel: (a) => (a === 'agent:claude-desktop' ? 'Claude 桌面版' : a === 'user' ? '你' : String(a)),
  clientLabel: (c) => (c === 'claude-desktop' ? 'Claude 桌面版' : c),
};

const company = { id: 'prj_tsmc00000001', ticker: '2330', name: '台積電' };
const headline = (epsBase: number | null, tpBase: number | null): Headline => ({
  basis: 'FY2027',
  basisLabel: 'FY2027',
  eps: { bear: epsBase === null ? null : epsBase - 5, base: epsBase, bull: epsBase === null ? null : epsBase + 5 },
  targetPrice: { bear: tpBase === null ? null : tpBase - 200, base: tpBase, bull: tpBase === null ? null : tpBase + 300 },
});
const rev = (seq: number, over: Partial<RevisionIn> = {}): RevisionIn => ({
  id: `rev_r${seq}000000000`,
  seq,
  kind: seq === 1 ? 'initial' : 'update',
  title: `第 ${seq} 次`,
  reason: '法說會上修',
  notes: '',
  asOfDate: `2026-09-${String(10 + seq).padStart(2, '0')}`,
  committedAt: `2026-09-${String(10 + seq).padStart(2, '0')}T02:00:00.000Z`,
  createdBy: 'user',
  excludedFromCalibration: false,
  headline: headline(40 + seq, 1000 + seq * 100),
  ...over,
});
const trade = (over: Partial<TradeIn> = {}): TradeIn => ({
  id: 'trd_t10000000001',
  projectId: company.id,
  side: 'long',
  entryDate: '2026-10-01',
  entryPrice: 1000,
  quantity: 1000,
  entryReason: '基本面轉強',
  targetPriceAtEntry: 1200,
  stopAtEntry: 950,
  atrMultiple: null,
  revisionId: 'rev_r2000000000',
  exitDate: null,
  exitPrice: null,
  exitReason: '',
  fees: 0,
  notes: '',
  createdBy: 'user',
  source: 'entry',
  sourceText: null,
  ...over,
});
const session = (over: Partial<AiSessionIn> = {}): AiSessionIn => ({
  id: 'ais_s10000000001',
  client: 'claude-desktop',
  startedAt: '2026-10-02T01:00:00.000Z',
  lastAt: '2026-10-02T02:00:00.000Z',
  projectIds: [company.id],
  actions: [{ at: '2026-10-02T01:05:00.000Z', kind: 'trade', summary: '記錄一筆交易' }],
  summary: '看了台積電\n第二行',
  decisions: '維持看法',
  todo: null,
  ...over,
});

const companyInput = (over: Partial<CompanyNoteInput> = {}): CompanyNoteInput => ({
  company: { ...company, archived: false },
  security: { ticker: '2330', exchange: 'TWSE', currency: 'TWD' },
  revisions: [rev(2), rev(1), rev(3, { excludedFromCalibration: true })],
  headMarket: { price: 1000, currency: 'TWD', asOf: '2026-09-13' },
  targetCurrency: 'TWD',
  trades: [trade(), trade({ id: 'trd_t20000000002', exitDate: '2026-10-20', exitPrice: 1050 })],
  catalysts: [
    { id: 'cat_1', title: '法說會', type: 'earnings', expectedDate: '2026-11-15', datePrecision: 'day', status: 'upcoming', expectedOutcome: '毛利率回升' },
    { id: 'cat_2', title: '新廠', type: 'factory_ramp', expectedDate: '2026-12-01', datePrecision: 'quarter', status: 'delayed', expectedOutcome: '' },
    { id: 'cat_3', title: '已發生', type: 'other', expectedDate: '2026-01-01', datePrecision: 'day', status: 'occurred', expectedOutcome: '' },
    { id: 'cat_4', title: '取消', type: 'other', expectedDate: null, datePrecision: 'day', status: 'cancelled', expectedOutcome: '' },
  ],
  aiSessions: [session()],
  ...over,
});

const updateInput = (over: Partial<ResearchUpdateNoteInput> = {}): ResearchUpdateNoteInput => ({
  company,
  revision: {
    ...rev(2),
    changes: [{ type: 'notes_changed', nodeId: 'n_1', name: '營收' } as never],
    citedEvidenceIds: ['ev_1', 'ev_gone'],
  },
  before: headline(41, 1100),
  periods: [{ id: 'FY2027', label: 'FY2027' }],
  evidence: [{ id: 'ev_1', title: '法說會簡報 [Q3]', url: 'https://example.com/a b', publishedAt: '2026-09-11T00:00:00Z' }],
  ...over,
});

const tradeInput = (over: Partial<TradeNoteInput> = {}): TradeNoteInput => ({
  company,
  trade: trade(),
  revision: { id: 'rev_r2000000000', seq: 2, asOfDate: '2026-09-12', title: '法說後上修' },
  reviews: [
    { id: 'rvw_1', subjectType: 'trade', subjectId: 'trd_t10000000001', title: '', thesisVerdict: 'right', executionVerdict: 'poor', lessons: '太早進場', createdAt: '2026-10-21' },
    { id: 'rvw_2', subjectType: 'trade', subjectId: 'trd_other', title: '別筆', thesisVerdict: null, executionVerdict: null, lessons: '', createdAt: '2026-10-21' },
  ],
  deletedAt: null,
  ...over,
});

const keys = (n: RenderedNote) => n.frontmatter.map(([k]) => k);
const fm = (n: RenderedNote) => Object.fromEntries(n.frontmatter);
const noLinks = () => null;

describe('formatting helpers', () => {
  it('quote', () => {
    expect(quote('a\n\nb')).toBe('> a\n>\n> b');
    expect(quote('')).toBe('> —');
    expect(quote(null)).toBe('> —');
    expect(quote('  \n ')).toBe('> —');
    expect(quote('<!-- wb:end -->')).toBe('> &lt;!-- wb:end --&gt;');
    expect(quote('a\r\nb')).toBe('> a\n> b');
    const long = quote(Array.from({ length: 250 }, (_, i) => `l${i}`).join('\n')).split('\n');
    expect(long).toHaveLength(201);
    expect(long.at(-1)).toBe('> …');
  });

  it('cell, num, pct', () => {
    expect(cell('a|b\nc <!-- x -->')).toBe('a\\|b c &lt;!-- x --&gt;');
    expect(num(null)).toBe('—');
    expect(num(NaN)).toBe('—');
    expect(num(1234567.123456)).toBe('1,234,567.1235');
    expect(num(1.5, 0)).toBe('2');
    expect(pct(0.05)).toBe('+5.0%');
    expect(pct(-0.1234)).toBe('-12.3%');
    expect(pct(-0.00001)).toBe('+0.0%');
    expect(pct(null)).toBe('—');
  });
});

describe('frozenHeadline', () => {
  it('reads EPS at the basis period and the frozen targets', () => {
    const state = sampleModel(2026);
    const frozen = freeze(compute(state));
    const h = frozenHeadline(state, frozen);
    const eps = findByRole(state, 'eps')!;
    expect(h.basis).not.toBeNull();
    expect(h.eps.base).toBe(frozen.values.base[eps.id][h.basis!]);
    expect(h.targetPrice).toEqual(frozenTargets(state, frozen));
    expect(h.basisLabel).toBe(state.periods.find((p) => p.id === h.basis)!.label);
  });
});

describe('company note', () => {
  const n = renderCompanyNote(companyInput(), ctx);

  it('frontmatter keys and values', () => {
    expect(keys(n)).toEqual([
      'wb_id', 'wb_type', 'wb_name', 'wb_ticker', 'wb_exchange', 'wb_currency', 'wb_tp_bear', 'wb_tp_base', 'wb_tp_bull',
      'wb_last_update', 'wb_last_update_seq', 'wb_price_at_update', 'wb_price_at_update_date', 'wb_upside_base_at_update',
      'wb_open_trades', 'wb_archived', 'wb_url',
    ]);
    const v = fm(n);
    expect(v.wb_type).toBe('company');
    expect(v.wb_ticker).toBe('2330');
    expect(v.wb_tp_base).toBe(1300);
    expect(v.wb_last_update).toEqual({ date: '2026-09-13' });
    expect(v.wb_last_update_seq).toBe(3);
    expect(v.wb_upside_base_at_update).toBe(0.3);
    expect(v.wb_open_trades).toBe(1);
    expect(v.wb_archived).toBe(false);
    expect(v.wb_url).toBe('http://127.0.0.1:4310/#/p/prj_tsmc00000001/model');
    expect(n.path).toBe('公司/2330 台積電.md');
    expect(n.body).toContain('## 反思');
  });

  it('upside is null when the target and price currencies differ', () => {
    const m = renderCompanyNote(companyInput({ targetCurrency: 'USD' }), ctx);
    expect(fm(m).wb_upside_base_at_update).toBeNull();
    expect(m.block).toContain('幣別不同');
    expect(fm(renderCompanyNote(companyInput({ headMarket: null }), ctx)).wb_upside_base_at_update).toBeNull();
  });

  it('lists updates newest first with deltas and flags, trades, upcoming and delayed catalysts, AI sessions', () => {
    const b = n.block;
    expect(b.indexOf('#3 2026-09-13')).toBeLessThan(b.indexOf('#1 2026-09-11'));
    expect(b).toContain('基準目標價 1,200 → 1,300 · 已標記錯誤');
    expect(b).toMatch(/#1 2026-09-11 第 1 次\]\] · 基準 EPS（FY2027） 41 · 基準目標價 1,100\n/);
    expect(b).toContain('持有中');
    expect(b).toContain('已出場 +5.0%');
    expect(b).toContain('2026-11-15 · 財報 · 法說會 — 預期：毛利率回升');
    expect(b).toContain('2026 Q4 · 工廠量產爬坡 · 新廠（延後）');
    expect(b).not.toContain('已發生');
    expect(b).not.toContain('取消');
    expect(b).toContain('[[wb:ais_s10000000001|2026-10-02 Claude 桌面版]] · 看了台積電');
    expect(b).not.toContain('第二行');
    expect(b).toContain('| 最新研究更新 | [[wb:rev_r3000000000\\|#3 2026-09-13 第 3 次]] |');
    expect(b).not.toMatch(/^# /m);
  });

  it('caps the update list at 50', () => {
    const revisions = Array.from({ length: 60 }, (_, k) => rev(k + 1));
    const m = renderCompanyNote(companyInput({ revisions }), ctx);
    expect(m.block).toContain('…另有 10 筆');
    expect(m.block.match(/\[\[wb:rev_/g)!.length).toBe(51); // 50 lines + the summary table
  });

  it('a company with nothing yet', () => {
    const m = renderCompanyNote(companyInput({ revisions: [], trades: [], catalysts: [], aiSessions: [], security: null, headMarket: null, targetCurrency: null }), ctx);
    expect(fm(m).wb_ticker).toBe('2330'); // from the CompanyRef
    expect(fm(m).wb_tp_base).toBeNull();
    expect(fm(m).wb_last_update).toBeNull();
    expect(m.block).toContain('| 最新研究更新 | 無 |');
  });
});

describe('research update note', () => {
  const n = renderResearchUpdateNote(updateInput(), ctx);

  it('frontmatter keys and values', () => {
    expect(keys(n)).toEqual([
      'wb_id', 'wb_type', 'wb_company', 'wb_ticker', 'wb_seq', 'wb_kind', 'wb_title', 'wb_as_of_date', 'wb_committed_at',
      'wb_eps_period', 'wb_eps_base_before', 'wb_eps_base_after', 'wb_tp_base_before', 'wb_tp_base_after', 'wb_created_by',
      'wb_flagged_error', 'wb_url',
    ]);
    const v = fm(n);
    expect(v.wb_company).toEqual({ link: company.id, alias: '2330 台積電' });
    expect(v.wb_eps_base_before).toBe(41);
    expect(v.wb_eps_base_after).toBe(42);
    expect(v.wb_tp_base_before).toBe(1100);
    expect(v.wb_tp_base_after).toBe(1200);
    expect(v.wb_url).toBe('http://127.0.0.1:4310/#/p/prj_tsmc00000001/history/rev_r2000000000');
    expect(n.path).toBe('研究更新/2330/2330 2026-09-12 ＃2 第 2 次.md');
  });

  it('block: changes, frozen impact table, cited evidence with safe links', () => {
    expect(n.block).toContain('**變動**\n\n- 營收');
    expect(n.block).toContain('| 基準 | 41 | 42 | 1,100 | 1,200 |');
    expect(n.block).toContain('- （證據已刪除）');
    // a URL with a space is not linked; brackets in the title are escaped
    expect(n.block).toContain('- 法說會簡報 \\[Q3\\]（發布 2026-09-11）');
    const ok = renderResearchUpdateNote(updateInput({ evidence: [{ id: 'ev_1', title: 'x', url: 'https://example.com/a', publishedAt: null }] }), ctx);
    expect(ok.block).toContain('- [x](<https://example.com/a>)');
    const js = renderResearchUpdateNote(updateInput({ evidence: [{ id: 'ev_1', title: 'x', url: 'javascript:alert(1)', publishedAt: null }] }), ctx);
    expect(js.block).not.toContain('javascript:');
  });

  it('the first update has no before values', () => {
    const m = renderResearchUpdateNote(updateInput({ before: null }), ctx);
    expect(fm(m).wb_eps_base_before).toBeNull();
    expect(m.block).toContain('| 基準 | — | 42 | — | 1,200 |');
  });
});

describe('trade note', () => {
  it('open trade', () => {
    const n = renderTradeNote(tradeInput(), ctx);
    expect(keys(n)).toEqual([
      'wb_id', 'wb_type', 'wb_company', 'wb_ticker', 'wb_side', 'wb_entry_date', 'wb_entry_price', 'wb_quantity', 'wb_stop_at_entry',
      'wb_target_at_entry', 'wb_research_update', 'wb_exit_date', 'wb_exit_price', 'wb_fees', 'wb_return_pct', 'wb_r_multiple',
      'wb_holding_days', 'wb_status', 'wb_source', 'wb_created_by', 'wb_url',
    ]);
    const v = fm(n);
    expect(v.wb_status).toBe('open');
    expect(v.wb_return_pct).toBeNull();
    expect(v.wb_holding_days).toBeNull();
    expect(v.wb_research_update).toEqual({ link: 'rev_r2000000000', alias: '#2 2026-09-12 法說後上修' });
    expect(v.wb_url).toBe('http://127.0.0.1:4310/#/p/prj_tsmc00000001/trades/trd_t10000000001');
    expect(n.block).toContain('| 出場 | 持有中 |');
    expect(n.block).not.toContain('| 報酬 |');
    expect(n.block).not.toContain('**出場理由**');
    expect(n.block).toContain('| 進場 | 2026-10-01 @ 1,000（1,000 股） |');
    expect(n.block).toContain('| 進場依據的研究 | [[wb:rev_r2000000000\\|#2 2026-09-12 法說後上修]] |');
    expect(n.block).toContain('- 論點：正確 · 執行：不佳 · 教訓：太早進場');
    expect(n.block).not.toContain('別筆');
    expect(n.block).toContain('| 來源 | 手動 |');
    expect(n.path).toBe('交易/2330/2330 2026-10-01 做多 t10000.md');
  });

  it('closed trade: return, R and holding days', () => {
    const n = renderTradeNote(tradeInput({ trade: trade({ exitDate: '2026-10-20', exitPrice: 1050, exitReason: '到價' }) }), ctx);
    const v = fm(n);
    expect(v.wb_status).toBe('closed');
    expect(v.wb_return_pct).toBe(0.05);
    expect(v.wb_r_multiple).toBe(1);
    expect(v.wb_holding_days).toBe(19);
    expect(n.block).toContain('| 出場 | 2026-10-20 @ 1,050 |');
    expect(n.block).toContain('| 報酬 | +5.0%（R 1，持有 19 天） |');
    expect(n.block).toContain('**出場理由**\n\n> 到價');
  });

  it('deleted trade (tombstone)', () => {
    const n = renderTradeNote(tradeInput({ deletedAt: '2026-10-25T03:00:00.000Z' }), ctx);
    expect(n.deleted).toBe(true);
    expect(fm(n).wb_status).toBe('deleted');
    expect(fm(n).wb_url).toBeNull();
    expect(n.block.startsWith('> [!warning] 這筆交易已在研究工作台刪除（2026-10-25），以下是刪除前的紀錄。')).toBe(true);
    expect(n.block).not.toContain('在研究工作台開啟');
  });

  it('imported trade shows the quoted source text; AI trades name the client', () => {
    const n = renderTradeNote(tradeInput({ trade: trade({ source: 'import', sourceText: '10/1 買 2330 一張\n<!-- 註解 -->' }) }), ctx);
    expect(fm(n).wb_source).toBe('import');
    expect(n.block).toContain('**原始日誌**\n\n> 10/1 買 2330 一張\n> &lt;!-- 註解 --&gt;');
    expect(n.block).toContain('| 來源 | 匯入舊日誌 |');
    const ai = renderTradeNote(tradeInput({ trade: trade({ createdBy: 'agent:claude-desktop' }) }), ctx);
    expect(ai.block).toContain('| 來源 | AI（Claude 桌面版） |');
    expect(ai.block).not.toContain('**原始日誌**');
  });
});

describe('AI session and index notes', () => {
  it('AI session', () => {
    const n = renderAiSessionNote({ session: session(), companies: [company] }, ctx);
    expect(keys(n)).toEqual(['wb_id', 'wb_type', 'wb_client', 'wb_started_at', 'wb_last_at']);
    expect(fm(n).wb_client).toBe('claude-desktop');
    expect(n.path).toBe('AI 對話/2026-10-02 Claude 桌面版 s10000.md');
    expect(n.body).toBe('');
    expect(n.block).toContain('公司：[[wb:prj_tsmc00000001|2330 台積電]]');
    expect(n.block).toContain('**決定**');
    expect(n.block).not.toContain('**待辦**');
    expect(n.block).toContain('- 2026-10-02 · trade · 記錄一筆交易');
  });

  it('indexes', () => {
    const c = renderIndexNote({ id: 'index-companies', companies: [{ company, tpBase: 1300, lastUpdate: '2026-09-13', openTrades: 1 }] }, ctx);
    expect(keys(c)).toEqual(['wb_id', 'wb_type']);
    expect(c.path).toBe('_索引/公司總表.md');
    expect(c.body).toBe('');
    expect(c.block).toContain('| [[wb:prj_tsmc00000001\\|2330 台積電]] | 2330 | 1,300 | 2026-09-13 | 1 |');
    const t = renderIndexNote({ id: 'index-trades', trades: [{ trade: trade(), company }] }, ctx);
    expect(t.block).toContain('| 2026-10-01 | [[wb:prj_tsmc00000001\\|2330 台積電]] | 做多 | 1,000 | 1,000 | — | — | 持有中 | [[wb:trd_t10000000001\\|開啟]] |');
    const a = renderIndexNote({ id: 'index-ai', sessions: [{ session: session(), companies: [company] }] }, ctx);
    expect(a.path).toBe('_索引/AI 對話總表.md');
    expect(a.block).toContain('| 2026-10-02 | Claude 桌面版 |');
  });
});

describe('determinism and hostile text', () => {
  it('rendering twice gives deep-equal output', () => {
    expect(renderCompanyNote(companyInput(), ctx)).toEqual(renderCompanyNote(companyInput(), ctx));
    expect(renderTradeNote(tradeInput(), ctx)).toEqual(renderTradeNote(tradeInput(), ctx));
    expect(renderResearchUpdateNote(updateInput(), ctx)).toEqual(renderResearchUpdateNote(updateInput(), ctx));
  });

  const PIECES = ['<!--', '-->', '```', '~~~', '## 反思', '# 反思', '|', '\n', '\r\n', '[[', ']]', '[[wb:prj_abcd|x]]', '---', '...', '> ', '"', "'", ':', '#', 'wb_id: x', '<!-- wb:end -->', '<!-- wb:begin h=0123456789abcdef -->', ' ', '台積電', 'é', '\t', '\\'];
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const hostile = () => Array.from({ length: 1 + Math.floor(rand() * 12) }, () => PIECES[Math.floor(rand() * PIECES.length)]).join('');

  /** Every rendered note, written fresh, has one block, valid frontmatter, an empty reflection and merges onto itself. */
  function check(n: RenderedNote) {
    const r = resolveNote(n, noLinks);
    const text = createNoteText(r);
    const lines = parseDoc(text).lines;
    const f = findFrontmatter(lines);
    expect(f.kind).toBe('ok');
    if (f.kind !== 'ok') return;
    expect(lines.slice(1, f.close).every((l) => /^wb_[a-z_]+: /.test(l))).toBe(true);
    expect(scanBlock(lines, f.close + 1).kind).toBe('one');
    const refl = extractReflection(text);
    if (n.body) expect(refl).toEqual({ found: true, text: '', sections: 1 });
    else expect(refl.found).toBe(false);
    const again = mergeNote(text, r);
    expect(again).toEqual({ ok: true, text, changed: false });
  }

  it('fixed hostile strings in names, titles, reasons', () => {
    const evil = '```\n## 反思\n<!-- wb:end -->\n| x |\n---\n反思';
    const c = { id: 'prj_evil00000001', ticker: `A|B${evil}`, name: evil };
    check(renderCompanyNote(companyInput({ company: { ...c, archived: true }, security: { ticker: evil, exchange: evil, currency: evil } }), ctx));
    check(renderTradeNote(tradeInput({ company: c, trade: trade({ entryReason: evil, exitReason: evil, notes: evil, source: 'import', sourceText: evil }) }), ctx));
    check(renderResearchUpdateNote(updateInput({ company: c, revision: { ...updateInput().revision, title: evil, reason: evil, notes: evil } }), ctx));
    check(renderAiSessionNote({ session: session({ summary: evil, decisions: evil, todo: evil, actions: [{ at: '2026-10-02T00:00:00Z', kind: evil, summary: evil }] }), companies: [c] }, ctx));
  });

  it('200 generated hostile cases', () => {
    for (let k = 0; k < 200; k++) {
      const c = { id: 'prj_fuzz00000001', ticker: hostile(), name: hostile() };
      const t = trade({ entryReason: hostile(), exitReason: hostile(), notes: hostile(), source: k % 2 ? 'import' : 'entry', sourceText: hostile(), exitDate: k % 3 ? null : '2026-10-20', exitPrice: k % 3 ? null : 900 });
      const kind = k % 4;
      if (kind === 0) {
        check(renderTradeNote(tradeInput({ company: c, trade: t, revision: { id: 'rev_r1000000000', seq: 1, asOfDate: null, title: hostile() }, deletedAt: k % 5 ? null : '2026-10-25T00:00:00Z' }), ctx));
      } else if (kind === 1) {
        check(
          renderCompanyNote(
            companyInput({
              company: { ...c, archived: false },
              revisions: [rev(1, { title: hostile() }), rev(2, { title: hostile(), reason: hostile() })],
              trades: [t],
              catalysts: [{ id: 'cat_x', title: hostile(), type: hostile(), expectedDate: '2026-11-01', datePrecision: 'month', status: 'upcoming', expectedOutcome: hostile() }],
              aiSessions: [session({ summary: hostile() })],
            }),
            ctx,
          ),
        );
      } else if (kind === 2) {
        const u = updateInput();
        check(renderResearchUpdateNote({ ...u, company: c, revision: { ...u.revision, title: hostile(), reason: hostile(), notes: hostile() }, evidence: [{ id: 'ev_1', title: hostile(), url: hostile(), publishedAt: null }] }, ctx));
      } else {
        check(renderAiSessionNote({ session: session({ summary: hostile(), decisions: hostile(), todo: hostile() }), companies: [c] }, ctx));
        check(renderIndexNote({ id: 'index-trades', trades: [{ trade: t, company: c }] }, ctx));
      }
    }
  });
});

describe('layering', () => {
  it('render.ts imports neither src/server nor src/shared', () => {
    const src = readFileSync(new URL('./render.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const p of imports) expect(p).not.toMatch(/server|shared|client|node:/);
  });

  it('the plugin-facing modules use no Node built-ins and do not import render.ts', () => {
    for (const f of ['types', 'hash', 'text', 'frontmatter', 'block', 'links', 'merge', 'reflection', 'filename']) {
      const src = readFileSync(new URL(`./${f}.ts`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/from '([^']+)'/g)) expect(m[1]).toMatch(/^\.\/(types|hash|text|frontmatter|block|links|merge|reflection|filename)$/);
    }
  });
});
