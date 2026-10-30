import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addThesis, setValue, updateValuation } from '../domain/model/ops';
import { SCALAR_KEY, type ModelState } from '../domain/model/types';
import { fill, idByName } from '../domain/testing/sample';
import type { Bar } from '../domain/market/indicators';
import type { BarsResponse, DashboardDTO, EvidenceDTO, ProjectBundleDTO, QuoteResponse, RefreshRunDTO, RevisionFull, RevisionMeta, SeriesPoint, TradeDTO, TradesJournalDTO } from '../shared/api';
import type { TokenName } from '../shared/actors';
import { currentActor } from './actor';
import { buildApp, type AppContext } from './app';
import { openDatabase } from './db/connection';
import { MIGRATIONS, SCHEMA_VERSION } from './db/migrations';
import { CsvProvider } from './market/csv';
import { DemoProvider } from './market/demo';
import { MarketDataError, type MarketDataProvider } from './market/provider';
import { SymbolSearch } from './market/symbols';
import { APP_ROOT, readVersion } from './version';

let ctx: AppContext;
let dir: string;

class FailingProvider implements MarketDataProvider {
  id = 'flaky';
  label = 'Flaky';
  description = 'Always rate-limited';
  synthetic = false;
  fetches = true;
  async getQuote(): Promise<never> {
    throw new MarketDataError('RATE_LIMITED', 'Too many requests', 30);
  }
  async getHistoricalPrices(): Promise<Bar[]> {
    throw new MarketDataError('NOT_FOUND', 'Unknown symbol');
  }
}

/** History is rate-limited (after a short wait, so a refresh run is still going when polled); counts calls. */
class LimitedProvider implements MarketDataProvider {
  id = 'limited';
  label = 'Limited';
  description = 'Rate-limited history';
  synthetic = false;
  fetches = true;
  calls = 0;
  /** Who the server thinks is acting during the call. */
  actor: string | null = null;
  async getQuote(): Promise<never> {
    throw new MarketDataError('RATE_LIMITED', 'Too many requests', 60);
  }
  async getHistoricalPrices(): Promise<Bar[]> {
    this.calls++;
    this.actor = currentActor();
    await new Promise((r) => setTimeout(r, 30));
    throw new MarketDataError('RATE_LIMITED', 'Too many requests', 60);
  }
}

class OfflineProvider implements MarketDataProvider {
  id = 'offline';
  label = 'Offline';
  description = 'No network';
  synthetic = false;
  fetches = true;
  calls = 0;
  async getQuote(): Promise<never> {
    throw new MarketDataError('NETWORK', 'Could not reach Offline: getaddrinfo ENOTFOUND');
  }
  async getHistoricalPrices(): Promise<Bar[]> {
    this.calls++;
    throw new MarketDataError('NETWORK', 'Could not reach Offline: getaddrinfo ENOTFOUND');
  }
}

let limited: LimitedProvider;
let offline: OfflineProvider;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  limited = new LimitedProvider();
  offline = new OfflineProvider();
  ctx = await buildApp({
    dataDir: dir,
    providers: [new DemoProvider(() => '2026-09-25'), new CsvProvider(), new FailingProvider(), limited, offline],
    market: { minIntervalMs: 0 },
    symbolSearch: new SymbolSearch({ taiwanDirectory: async () => [{ code: '7899', name: '景美', board: 'emerging' }] }),
  });
});
afterEach(async () => {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A request as `who` (the user by default), with that caller's token from tokens.json. */
async function apiAs<T>(who: TokenName, method: Method, url: string, payload?: unknown, expectStatus = 200): Promise<T> {
  const res = await ctx.app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${ctx.tokens.tokens[who]}` } });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

const api = <T>(method: Method, url: string, payload?: unknown, expectStatus = 200) => apiAs<T>('user', method, url, payload, expectStatus);
const auth = () => ({ authorization: `Bearer ${ctx.tokens.tokens.user}` });

function multipart(fields: Record<string, string>, files: { name: string; filename: string; type: string; data: Buffer }[]) {
  const boundary = `----wbtest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function newProject(): Promise<ProjectBundleDTO> {
  const { id } = await api<{ id: string }>('POST', '/api/projects', {
    name: 'Lite-On Technology',
    year: 2026,
    security: { ticker: '2301', exchange: 'TWSE', apiSymbol: '2301.TW', currency: 'TWD', priceSource: 'demo' },
  });
  return api<ProjectBundleDTO>('GET', `/api/projects/${id}`);
}

function populate(s: ModelState): ModelState {
  s = fill(s, idByName(s, 'Business A'), { FY2024: 800, FY2025: 1000 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business A'), { FY2026: 0.2, FY2027: 0.2, FY2028: 0.35 });
  s = fill(s, idByName(s, 'Business B'), { FY2024: 500, FY2025: 550 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business B'), { FY2026: 0.05, FY2027: 0.05, FY2028: 0.05 });
  s = fill(s, idByName(s, 'Business C'), { FY2024: 100, FY2025: 120 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business C'), { FY2026: 0.5, FY2027: 0.5, FY2028: 0.5 });
  const all = { FY2024: 0, FY2025: 0, FY2026: 0, FY2027: 0, FY2028: 0 };
  const same = (v: number) => Object.fromEntries(Object.keys(all).map((k) => [k, v]));
  s = fill(s, idByName(s, 'Gross Margin'), same(0.2));
  s = fill(s, idByName(s, 'Opex % of Revenue'), same(0.08));
  s = fill(s, idByName(s, 'Non-Operating Items'), same(20));
  s = fill(s, idByName(s, 'Tax Rate'), same(0.2));
  s = fill(s, idByName(s, 'Diluted Shares'), same(22));
  s = fill(s, idByName(s, 'Invested Capital'), same(600));
  s = setValue(s, idByName(s, 'Target P/E'), SCALAR_KEY, 'base', 25);
  s = setValue(s, idByName(s, 'Target P/E'), SCALAR_KEY, 'bear', 18);
  s = setValue(s, idByName(s, 'Target P/E'), SCALAR_KEY, 'bull', 32);
  return s;
}

async function saveDraft(projectId: string, state: ModelState, version: number) {
  return api<{ version: number }>('PUT', `/api/projects/${projectId}/draft`, { state, version });
}

async function commit(projectId: string, version: number, extra: Record<string, unknown> = {}, expect = 200) {
  return api<RevisionFull>('POST', `/api/projects/${projectId}/revisions`, { title: 'Update', reason: 'Because', asOfDate: '2026-09-20', draftVersion: version, ...extra }, expect);
}

describe('projects, drafts and Research Updates', () => {
  it('creates a project from the standard template with an initial snapshot', async () => {
    const b = await newProject();
    expect(b.project.name).toBe('Lite-On Technology');
    expect(b.securities[0]).toMatchObject({ ticker: '2301', exchange: 'TWSE', apiSymbol: '2301.TW', currency: 'TWD' });
    expect(b.head.seq).toBe(1);
    expect(b.head.kind).toBe('initial');
    expect(b.head.asOfDate).toBeNull();
    expect(b.draft.state.periods.map((p) => p.id)).toEqual(['FY2024', 'FY2025', 'FY2026', 'FY2027', 'FY2028']);
    expect(b.draft.state.nodes.find((n) => n.role === 'eps')!.unit).toMatchObject({ kind: 'per_share', currency: 'TWD' });
    const list = await api<{ id: string; draftDirty: boolean }[]>('GET', '/api/projects');
    expect(list).toHaveLength(1);
    expect(list[0].draftDirty).toBe(false);
  });

  it('validates drafts and detects concurrent edits', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const s = populate(b.draft.state);
    const saved = await saveDraft(pid, s, b.draft.version);
    expect(saved.version).toBe(b.draft.version + 1);
    await api('PUT', `/api/projects/${pid}/draft`, { state: s, version: b.draft.version }, 409);
    const broken = JSON.parse(JSON.stringify(s));
    broken.nodes[0].parentId = 'n_nowhere';
    const err = await api<{ error: string; details: string[] }>('PUT', `/api/projects/${pid}/draft`, { state: broken, version: saved.version }, 400);
    expect(err.details.join()).toMatch(/parent/);
    const withLink = { ...s, links: [{ id: 'l1', evidenceId: 'ev_unknown', nodeId: s.nodes[0].id, relation: 'supports' }] };
    await api('PUT', `/api/projects/${pid}/draft`, { state: withLink, version: saved.version }, 400);
    const list = await api<{ draftDirty: boolean }[]>('GET', '/api/projects');
    expect(list[0].draftDirty).toBe(true);
  });

  it('commits a Research Update with changes, impact, frozen outputs and evidence', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const ev = await api<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { title: 'Q2 earnings call', sourceType: 'earnings_call', publishedAt: '2026-07-31', url: 'https://example.com/q2' });
    let s = populate(b.draft.state);
    s = { ...s, links: [{ id: 'l1', evidenceId: ev.id, nodeId: idByName(s, 'YoY Growth', 'Business A'), relation: 'supports', locator: 'p.13' }] };
    const d = await saveDraft(pid, s, b.draft.version);
    const r1 = await commit(pid, d.version, { title: 'Initiation', reason: 'Initial model', asOfDate: '2026-09-20', evidenceIds: [ev.id] });
    expect(r1.seq).toBe(2);
    expect(r1.kind).toBe('update');
    expect(r1.citedEvidenceIds).toEqual([ev.id]);
    expect(r1.changes.length).toBeGreaterThan(10);
    const eps = s.nodes.find((n) => n.role === 'eps')!.id;
    const tp = s.nodes.find((n) => n.role === 'target_price')!.id;
    expect(r1.computed.values.base[eps].FY2028).toBeGreaterThan(0);
    expect(r1.computed.values.base[tp][SCALAR_KEY]).toBeCloseTo(r1.computed.values.base[eps].FY2028! * 25);
    expect(r1.impact!.headline.targetPrice.find((h) => h.scenario === 'base')!.before).toBeNull();

    // second update: one piece of information changes several assumptions
    const bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    expect(bundle.head.id).toBe(r1.id);
    let s2 = bundle.draft.state;
    s2 = setValue(s2, idByName(s2, 'YoY Growth', 'Business A'), 'FY2028', 'base', 0.47);
    s2 = setValue(s2, idByName(s2, 'Gross Margin'), 'FY2028', 'base', 0.21);
    const d2 = await saveDraft(pid, s2, bundle.draft.version);
    const r2 = await commit(pid, d2.version, { title: 'Qualification confirmed', reason: 'Customer qualification + capacity guidance', asOfDate: '2026-09-26' });
    expect(r2.seq).toBe(3);
    expect(r2.changes.filter((c) => c.type === 'value_changed')).toHaveLength(2);
    const base = r2.impact!.headline.targetPrice.find((h) => h.scenario === 'base')!;
    expect(base.after!).toBeGreaterThan(base.before!);
    expect(base.before).toBeCloseTo(r1.computed.values.base[tp][SCALAR_KEY]!);
    const epsHead = r2.impact!.headline.eps.find((h) => h.scenario === 'base' && h.periodKey === 'FY2028')!;
    expect(epsHead.after!).toBeGreaterThan(epsHead.before!);
    expect(r2.impact!.attribution.map((a) => a.name).sort()).toEqual(['Gross Margin', 'YoY Growth']);

    // the earlier snapshot is still intact
    const old = await api<RevisionFull>('GET', `/api/projects/${pid}/revisions/${r1.id}`);
    expect(old.computed.values.base[tp][SCALAR_KEY]).toBe(r1.computed.values.base[tp][SCALAR_KEY]);
    expect(old.state.nodes.find((n) => n.id === idByName(s2, 'YoY Growth', 'Business A'))!.values.FY2028).toBe(0.35);

    // point-in-time estimate history
    const series = await api<SeriesPoint[]>('GET', `/api/projects/${pid}/series?nodeIds=${eps}`);
    expect(series.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(series[1].values[eps].base.FY2028).toBeLessThan(series[2].values[eps].base.FY2028!);
    const asOf = await api<RevisionMeta>('GET', `/api/projects/${pid}/as-of?date=2026-09-25`);
    expect(asOf.seq).toBe(2);

    // evidence knows where it was used; it can no longer be deleted
    const evNow = await api<EvidenceDTO>('GET', `/api/evidence/${ev.id}`);
    expect(evNow.revisionRefs.map((r) => `${r.seq}:${r.kind}`)).toEqual(['2:cited', '2:linked', '3:linked']);
    const del = await api<{ error: string }>('DELETE', `/api/evidence/${ev.id}`, undefined, 409);
    expect(del.error).toMatch(/Research Update #2/);
    const archived = await api<EvidenceDTO>('POST', `/api/evidence/${ev.id}/archive`, { archived: true });
    expect(archived.archivedAt).not.toBeNull();
  });

  it('guards against look-ahead: ordered knowledge dates and evidence publication dates', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const d = await saveDraft(pid, populate(b.draft.state), b.draft.version);
    await commit(pid, d.version, { asOfDate: '2026-09-20' });
    const bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    const s = setValue(bundle.draft.state, idByName(bundle.draft.state, 'Gross Margin'), 'FY2028', 'base', 0.3);
    const d2 = await saveDraft(pid, s, bundle.draft.version);
    const early = await api<{ error: string }>('POST', `/api/projects/${pid}/revisions`, { title: 't', reason: 'r', asOfDate: '2026-09-10', draftVersion: d2.version }, 400);
    expect(early.error).toMatch(/earlier than Research Update #2/);
    const future = await api<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { title: 'Later article', publishedAt: '2026-09-24' });
    const la = await api<{ error: string }>('POST', `/api/projects/${pid}/revisions`, { title: 't', reason: 'r', asOfDate: '2026-09-22', draftVersion: d2.version, evidenceIds: [future.id] }, 400);
    expect(la.error).toMatch(/look-ahead/);
    await api('POST', `/api/projects/${pid}/revisions`, { title: '', reason: 'r', asOfDate: '2026-09-22', draftVersion: d2.version }, 400);
    await api('POST', `/api/projects/${pid}/revisions`, { title: 't', reason: '', asOfDate: '2026-09-22', draftVersion: d2.version }, 400);
    await api('POST', `/api/projects/${pid}/revisions`, { title: 't', reason: 'r', asOfDate: '2026-09-22', draftVersion: d2.version - 1 }, 409);
    const ok = await commit(pid, d2.version, { asOfDate: '2026-09-24', evidenceIds: [future.id] });
    expect(ok.seq).toBe(3);
  });

  it('records a checkpoint when nothing changed, and restores old snapshots without rewriting history', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const d = await saveDraft(pid, populate(b.draft.state), b.draft.version);
    const r2 = await commit(pid, d.version, { asOfDate: '2026-09-20' });
    let bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    const cp = await commit(pid, bundle.draft.version, { title: 'Post-earnings review', reason: 'Nothing changes the thesis', asOfDate: '2026-09-21' });
    expect(cp.kind).toBe('checkpoint');
    expect(cp.changes).toEqual([]);
    bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    const s = setValue(bundle.draft.state, idByName(bundle.draft.state, 'Gross Margin'), 'FY2028', 'base', 0.35);
    const d3 = await saveDraft(pid, s, bundle.draft.version);
    const r4 = await commit(pid, d3.version, { asOfDate: '2026-09-22' });
    bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    const restored = await api<{ state: ModelState; version: number }>('POST', `/api/projects/${pid}/draft/restore`, { revisionId: r2.id, version: bundle.draft.version });
    expect(restored.state).toEqual(r2.state);
    const r5 = await commit(pid, restored.version, { kind: 'restore', title: 'Back to initiation', reason: 'Margin call was wrong', asOfDate: '2026-09-23' });
    expect(r5.kind).toBe('restore');
    expect(r5.changes.some((c) => c.type === 'value_changed')).toBe(true);
    const revs = await api<RevisionMeta[]>('GET', `/api/projects/${pid}/revisions`);
    expect(revs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(revs[3].id).toBe(r4.id);
    // snapshots are immutable at the database level
    expect(() => ctx.db.prepare('UPDATE revisions SET title = ? WHERE id = ?').run('x', r2.id)).toThrow(/immutable/);
    expect(() => ctx.db.prepare('DELETE FROM revisions WHERE id = ?').run(r2.id)).toThrow(/immutable/);
  });
});

describe('evidence attachments', () => {
  it('stores uploaded files persistently with their original names', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const mp = multipart({ notes: 'Qualification screenshot', publishedAt: '2026-09-25' }, [{ name: 'file', filename: '客戶認證截圖.png', type: 'image/png', data: png }]);
    const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${pid}/evidence`, payload: mp.payload, headers: { ...mp.headers, ...auth() } });
    expect(res.statusCode).toBe(200);
    const ev = res.json() as EvidenceDTO;
    expect(ev.kind).toBe('image');
    expect(ev.sourceType).toBe('screenshot');
    expect(ev.title).toBe('客戶認證截圖.png');
    expect(ev.attachments[0].originalFilename).toBe('客戶認證截圖.png');
    const stored = path.join(dir, 'attachments', ev.attachments[0].sha256.slice(0, 2), ev.attachments[0].sha256);
    expect(fs.readFileSync(stored).equals(png)).toBe(true);

    const content = await ctx.app.inject({ method: 'GET', url: ev.attachments[0].url });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toBe('image/png');
    expect(String(content.headers['content-disposition'])).toContain(`filename*=UTF-8''${encodeURIComponent('客戶認證截圖.png')}`);
    expect(content.rawPayload.equals(png)).toBe(true);

    // an HTML upload is never rendered inline on the app origin
    const html = multipart({ title: 'Saved page' }, [{ name: 'file', filename: 'page.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') }]);
    const r2 = await ctx.app.inject({ method: 'POST', url: `/api/projects/${pid}/evidence`, payload: html.payload, headers: { ...html.headers, ...auth() } });
    const ev2 = r2.json() as EvidenceDTO;
    expect(ev2.kind).toBe('file');
    const c2 = await ctx.app.inject({ method: 'GET', url: ev2.attachments[0].url });
    expect(c2.headers['content-type']).toBe('application/octet-stream');
    expect(String(c2.headers['content-disposition'])).toMatch(/^attachment/);
    expect(String(c2.headers['content-security-policy'])).toContain('sandbox');

    // same bytes uploaded twice share storage but keep their own names
    const again = multipart({}, [{ name: 'file', filename: 'copy.png', type: 'image/png', data: png }]);
    const r3 = await ctx.app.inject({ method: 'POST', url: `/api/evidence/${ev.id}/files`, payload: again.payload, headers: { ...again.headers, ...auth() } });
    const ev3 = r3.json() as EvidenceDTO;
    expect(ev3.attachments).toHaveLength(2);
    expect(ev3.attachments[1].sha256).toBe(ev3.attachments[0].sha256);
    expect(ev3.attachments[1].originalFilename).toBe('copy.png');

    // edits are audited; unreferenced evidence can be deleted
    await api('PATCH', `/api/evidence/${ev2.id}`, { title: 'Saved page (renamed)' });
    const log = await api<{ action: string }[]>('GET', `/api/projects/${pid}/audit?entityId=${ev2.id}`);
    expect(log[0].action).toBe('update');
    await api('DELETE', `/api/evidence/${ev2.id}`);
    // URL and note evidence
    const url = await api<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { url: 'https://example.com/report' });
    expect(url.kind).toBe('url');
    expect(url.title).toBe('example.com/report');
    const note = await api<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { title: 'Channel check', notes: 'Supplier says…', sourceType: 'conversation' });
    expect(note.kind).toBe('note');
    await api('POST', `/api/projects/${pid}/evidence`, { url: 'javascript:alert(1)' }, 400);
  });
});

describe('market data, snapshots and trades', () => {
  it('fetches, caches and imports prices with provenance', async () => {
    const b = await newProject();
    const sec = b.securities[0];
    const q = await api<QuoteResponse>('GET', `/api/securities/${sec.id}/quote`);
    expect(q.quote!.provider).toBe('demo');
    expect(q.quote!.price).toBeGreaterThan(0);
    const bars = await api<BarsResponse>('GET', `/api/securities/${sec.id}/bars`);
    expect(bars.bars.length).toBeGreaterThan(500);
    expect(bars.bars.at(-1)!.date <= '2026-09-25').toBe(true);
    expect(bars.lastFetchedAt).not.toBeNull();

    const failing = await api<QuoteResponse>('GET', `/api/securities/${sec.id}/quote?provider=flaky&refresh=1`);
    expect(failing.quote).toBeNull();
    expect(failing.stale).toBe(true);
    expect(failing.error).toMatch(/RATE_LIMITED/);
    const failingBars = await api<BarsResponse>('GET', `/api/securities/${sec.id}/bars?provider=flaky`);
    expect(failingBars.error).toMatch(/NOT_FOUND/);
    expect(failingBars.bars).toEqual([]);
    await api('GET', `/api/securities/${sec.id}/quote?provider=nope`, undefined, 400);

    const csv = 'Date,Open,High,Low,Close,Adj Close,Volume\n2026-09-01,270,275,268,272,272,1000\n2026/09/02,272,280,271,279,279,1200\nbad,row\n';
    const mp = multipart({}, [{ name: 'file', filename: '2301.csv', type: 'text/csv', data: Buffer.from(csv) }]);
    const imp = await ctx.app.inject({ method: 'POST', url: `/api/securities/${sec.id}/bars/import`, payload: mp.payload, headers: { ...mp.headers, ...auth() } });
    expect(imp.json()).toMatchObject({ imported: 2, skipped: 1, first: '2026-09-01', last: '2026-09-02' });
    const csvBars = await api<BarsResponse>('GET', `/api/securities/${sec.id}/bars?provider=csv`);
    expect(csvBars.bars.map((x) => x.close)).toEqual([272, 279]);
    const csvQuote = await api<QuoteResponse>('GET', `/api/securities/${sec.id}/quote?provider=csv`);
    expect(csvQuote.quote!.price).toBe(279);
  });

  it('keeps committed snapshots unchanged when market data updates', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const sec = b.securities[0];
    await api('GET', `/api/securities/${sec.id}/quote`);
    await api('GET', `/api/securities/${sec.id}/bars`);
    const d = await saveDraft(pid, populate(b.draft.state), b.draft.version);
    const r = await commit(pid, d.version);
    // a backdated knowledge date records that day's close, not today's quote
    expect(r.market).toMatchObject({ provider: 'demo', basis: 'bar' });
    expect(r.market!.asOf.slice(0, 10) <= '2026-09-20').toBe(true);
    const before = await api<RevisionFull>('GET', `/api/projects/${pid}/revisions/${r.id}`);
    // new market data arrives
    ctx.db.prepare('UPDATE quotes SET price = price * 2, fetched_at = ? WHERE security_id = ?').run(new Date().toISOString(), sec.id);
    await api('GET', `/api/securities/${sec.id}/bars?refresh=1`);
    const after = await api<RevisionFull>('GET', `/api/projects/${pid}/revisions/${r.id}`);
    expect(after.computed).toEqual(before.computed);
    expect(after.market).toEqual(before.market);
  });

  it('links a trade to the research snapshot valid on its entry date', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const sec = b.securities[0];
    await api('GET', `/api/securities/${sec.id}/bars`);
    const d = await saveDraft(pid, populate(b.draft.state), b.draft.version);
    const r2 = await commit(pid, d.version, { asOfDate: '2026-09-10' });
    const bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    const s = setValue(bundle.draft.state, idByName(bundle.draft.state, 'Target P/E'), SCALAR_KEY, 'base', 30);
    const d3 = await saveDraft(pid, s, bundle.draft.version);
    const r3 = await commit(pid, d3.version, { asOfDate: '2026-09-20' });
    const tpNode = s.nodes.find((n) => n.role === 'target_price')!.id;

    const t = await api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-15', entryPrice: 100, quantity: 1000, entryReason: 'Breakout after qualification news' });
    expect(t.revisionId).toBe(r2.id);
    expect(t.targetPriceAtEntry).toBeCloseTo(r2.computed.values.base[tpNode][SCALAR_KEY]!);
    expect(t.atrAtEntry).toBeGreaterThan(0);
    expect(t.atrMultiple).toBe(2);
    expect(t.stopAtEntry).toBeCloseTo(100 - 2 * t.atrAtEntry!);

    const t2 = await api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-21', entryPrice: 100, quantity: 10, stopAtEntry: 90 });
    expect(t2.revisionId).toBe(r3.id);
    expect(t2.stopAtEntry).toBe(90);
    const before = await api<TradeDTO[]>('GET', `/api/projects/${pid}/trades`);
    expect(before).toHaveLength(2);
    const closed = await api<TradeDTO>('PATCH', `/api/trades/${t.id}`, { exitDate: '2026-09-24', exitPrice: 110, exitReason: 'Trailing stop' });
    expect(closed.exitPrice).toBe(110);
    await api('PATCH', `/api/trades/${t.id}`, { exitDate: '2026-09-01' }, 400);
    const log = await api<{ action: string; actor: string }[]>('GET', `/api/projects/${pid}/audit?entityId=${t.id}`);
    expect(log.map((l) => l.action)).toEqual(['update', 'create']);
    expect(log.map((l) => l.actor)).toEqual(['user', 'user']);
    // a trade before any knowledge-dated research has no snapshot
    const t3 = await api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-01', entryPrice: 100, quantity: 1 });
    expect(t3.revisionId).toBeNull();
  });
});

describe('point-in-time guards on secondary paths', () => {
  it('rejects research, evidence and trade links that would look ahead', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const sec = b.securities[0];
    await api('GET', `/api/securities/${sec.id}/bars`);
    const d = await saveDraft(pid, populate(b.draft.state), b.draft.version);
    const r2 = await commit(pid, d.version, { asOfDate: '2026-09-10' });

    // linked (not cited) evidence published after the knowledge date
    const late = await api<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { title: 'Late article', publishedAt: '2026-09-18' });
    let bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    const node = bundle.draft.state.nodes.find((n) => n.name === 'Gross Margin')!.id;
    const withLink = { ...bundle.draft.state, links: [{ id: 'l9', evidenceId: late.id, nodeId: node, relation: 'supports' }] };
    const d2 = await saveDraft(pid, withLink as ModelState, bundle.draft.version);
    const err = await api<{ error: string }>('POST', `/api/projects/${pid}/revisions`, { title: 't', reason: 'r', asOfDate: '2026-09-15', draftVersion: d2.version }, 400);
    expect(err.error).toMatch(/Late article/);
    const r3 = await commit(pid, d2.version, { asOfDate: '2026-09-20' });

    // evidence dates cannot be moved after a revision that relies on them
    const moved = await api<{ error: string }>('PATCH', `/api/evidence/${late.id}`, { publishedAt: '2026-09-25' }, 400);
    expect(moved.error).toMatch(/Research Update #3/);
    await api('PATCH', `/api/evidence/${late.id}`, { publishedAt: '2026-09-17' });

    // trades: an explicit snapshot must be known on the entry date; moving the entry re-resolves it
    const bad = await api<{ error: string }>('POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-12', entryPrice: 100, quantity: 1, revisionId: r3.id }, 400);
    expect(bad.error).toMatch(/after the entry date/);
    const t = await api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-21', entryPrice: 100, quantity: 1 });
    expect(t.revisionId).toBe(r3.id);
    const moved2 = await api<TradeDTO>('PATCH', `/api/trades/${t.id}`, { entryDate: '2026-09-12' });
    expect(moved2.revisionId).toBe(r2.id);
    await api('PATCH', `/api/trades/${t.id}`, { revisionId: r3.id }, 400);
    bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    expect(bundle.head.id).toBe(r3.id);
  });
});

describe('catalysts, notes, reviews, templates, export, migrations', () => {
  it('supports the surrounding records', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const node = b.draft.state.nodes.find((n) => n.name === 'Business A')!.id;
    const c = await api<{ id: string; nodeIds: string[] }>('POST', `/api/projects/${pid}/catalysts`, {
      title: 'Hyperscaler qualification',
      type: 'customer_qualification',
      expectedDate: '2026-12-01',
      datePrecision: 'quarter',
      nodeIds: [node],
      expectedOutcome: 'Qualification passes; volume from Q2 FY27',
    });
    expect(c.nodeIds).toEqual([node]);
    const upd = await api<{ status: string; actualOutcome: string }>('PATCH', `/api/catalysts/${c.id}`, { status: 'occurred', actualDate: '2026-11-20', actualOutcome: 'Passed' });
    expect(upd.status).toBe('occurred');
    const log = await api<{ before: { expectedOutcome: string } }[]>('GET', `/api/projects/${pid}/audit?entityId=${c.id}`);
    expect(log[0].before.expectedOutcome).toMatch(/Qualification passes/);
    await api('POST', `/api/projects/${pid}/catalysts`, { title: '' }, 400);

    const n = await api<{ id: string }>('POST', `/api/projects/${pid}/notes`, { body: 'Management tone more confident.' });
    await api('PATCH', `/api/notes/${n.id}`, { body: 'Management tone much more confident.' });
    expect((await api<unknown[]>('GET', `/api/projects/${pid}/notes`)).length).toBe(1);

    const rv = await api<{ id: string; categories: { category: string }[] }>('POST', `/api/projects/${pid}/reviews`, {
      title: 'FY26 miss',
      subjectType: 'project',
      categories: [{ category: 'assumption_magnitude', notes: 'Share gain too fast' }],
      thesisVerdict: 'mixed',
    });
    expect(rv.categories[0].category).toBe('assumption_magnitude');

    const tpl = await api<{ id: string }>('POST', '/api/templates', { projectId: pid, name: 'Power supply template' });
    const tpls = await api<{ id: string; builtIn: boolean }[]>('GET', '/api/templates');
    expect(tpls.map((t) => t.builtIn)).toEqual([true, false]);
    const { id: p2 } = await api<{ id: string }>('POST', '/api/projects', { name: 'Delta', templateId: tpl.id, security: { ticker: '2308', currency: 'TWD', priceSource: 'demo' } });
    const b2 = await api<ProjectBundleDTO>('GET', `/api/projects/${p2}`);
    expect(b2.draft.state.nodes.map((x) => x.name)).toEqual(b.draft.state.nodes.map((x) => x.name));
    expect(b2.head.title).toContain('Power supply template');

    const exp = await ctx.app.inject({ method: 'GET', url: `/api/projects/${pid}/export` });
    const json = exp.json() as { format: string; revisions: unknown[]; catalysts: unknown[]; notes: unknown[]; reviews: unknown[] };
    expect(json.format).toBe('research-workbench/project');
    expect(json.revisions).toHaveLength(1);
    expect(json.catalysts).toHaveLength(1);
    expect(json.reviews).toHaveLength(1);
    expect(String(exp.headers['content-disposition'])).toContain('attachment');
  });

  it('migrations are idempotent', () => {
    const file = path.join(dir, 'm.db');
    const a = openDatabase(file);
    a.close();
    const b = openDatabase(file);
    const rows = b.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version })));
    const tables = (b.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'projects',
        'revisions',
        'drafts',
        'evidence',
        'attachments',
        'catalysts',
        'trades',
        'price_bars',
        'quotes',
        'audit_log',
        'draft_ops',
        'ai_sessions',
        'ai_clients',
        'revision_annotations',
        'db_meta',
      ]),
    );
    b.close();
  });
});

describe('dashboard, journal and price refresh', () => {
  async function company(name: string, ticker: string, currency: string, priceSource: string): Promise<ProjectBundleDTO> {
    const { id } = await api<{ id: string }>('POST', '/api/projects', { name, year: 2026, security: { ticker, exchange: 'TEST', apiSymbol: ticker, currency, priceSource } });
    return api<ProjectBundleDTO>('GET', `/api/projects/${id}`);
  }

  it('shows every company with price, targets, upside, research, positions, catalysts, theses and AI', async () => {
    const a = await newProject();
    const pid = a.project.id;
    const sec = a.securities[0];
    let s = updateValuation(populate(a.draft.state), { probabilities: { bear: 0.25, base: 0.5, bull: 0.25 } });
    s = addThesis(s, { statement: 'Hyperscaler share gains', reviewBy: '2020-01-01' }).state;
    s = addThesis(s, { statement: 'Margin recovery', reviewBy: '2099-06-30' }).state;
    s = addThesis(s, { statement: 'Retired idea', reviewBy: '2020-01-01', status: 'retired' }).state;
    const d = await saveDraft(pid, s, a.draft.version);
    const r2 = await commit(pid, d.version, { asOfDate: '2026-09-20' });
    const q = (await api<QuoteResponse>('GET', `/api/securities/${sec.id}/quote`)).quote!;
    const t = await api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-21', entryPrice: 100, quantity: 10, stopAtEntry: 90, fees: 5 });
    await api('POST', `/api/projects/${pid}/catalysts`, { title: 'Old earnings', type: 'earnings', expectedDate: '2020-01-01', datePrecision: 'day' });
    await api('POST', `/api/projects/${pid}/catalysts`, { title: 'Far launch', type: 'product_launch', expectedDate: '2099-01-01', datePrecision: 'quarter' });
    await api('POST', `/api/projects/${pid}/catalysts`, { title: 'Undated', type: 'other' });
    await api('POST', `/api/projects/${pid}/catalysts`, { title: 'Done', type: 'other', expectedDate: '2020-02-01', status: 'occurred', actualDate: '2020-02-01' });
    const b = await company('Fresh Co', 'FRSH', 'USD', 'demo');
    const c = await company('Old Co', 'OLD', 'TWD', 'demo');
    await api('PATCH', `/api/projects/${c.project.id}`, { archived: true });
    // an AI writes a note on B and saves a summary
    await apiAs('claude-desktop', 'POST', `/api/projects/${b.project.id}/notes`, { body: 'Checked the 10-Q' });
    await apiAs('claude-desktop', 'POST', '/api/ai/sessions/summary', { summary: '\nReviewed Fresh Co\nsecond line', projectIds: [b.project.id] });

    const dash = await api<DashboardDTO>('GET', '/api/dashboard');
    expect(dash.refresh).toBeNull();
    expect(dash.rows.map((r) => r.name)).toEqual(['Fresh Co', 'Lite-On Technology', 'Old Co']);
    const ra = dash.rows.find((r) => r.projectId === pid)!;
    const tp = s.nodes.find((n) => n.role === 'target_price')!.id;
    const tps = { bear: r2.computed.values.bear[tp][SCALAR_KEY]!, base: r2.computed.values.base[tp][SCALAR_KEY]!, bull: r2.computed.values.bull[tp][SCALAR_KEY]! };
    expect(ra.target).toMatchObject({ currency: 'TWD', ...tps, weightSum: 1, currencyMismatch: false });
    expect(ra.target.weighted).toBeCloseTo(0.25 * tps.bear + 0.5 * tps.base + 0.25 * tps.bull);
    expect(ra.target.upsideBase).toBeCloseTo(tps.base / q.price - 1);
    expect(ra.target.upsideWeighted).toBeCloseTo(ra.target.weighted! / q.price - 1);
    expect(ra.price).toMatchObject({ value: q.price, currency: 'TWD', provider: 'demo', synthetic: true, stale: false, marketDate: '2026-09-25' });
    expect(ra.security).toMatchObject({ id: sec.id, name: sec.name, ticker: '2301', priceSource: 'demo' });
    expect(ra.research).toMatchObject({ revisionId: r2.id, seq: 2, kind: 'update', asOfDate: '2026-09-20' });
    expect(ra.draftDirty).toBe(false);
    expect(ra.positions).toMatchObject({ open: 1, rCount: 1 });
    expect(ra.positions.avgR).toBeCloseTo((q.price - 100) / 10);
    expect(ra.positions.pnl).toEqual([{ currency: 'TWD', value: expect.closeTo((q.price - 100) * 10 - 5) }]);
    expect(ra.positions.items[0]).toMatchObject({ tradeId: t.id, side: 'long', markSource: 'quote' });
    expect(ra.catalysts).toMatchObject({ overdue: 1, upcoming: 1, undated: 1 });
    expect(ra.catalysts.oldestOverdue).toMatchObject({ title: 'Old earnings', windowEnd: '2020-01-01' });
    expect(ra.catalysts.next).toMatchObject({ title: 'Far launch', windowEnd: '2099-03-31' });
    expect(ra.theses).toEqual({ reviewDue: 1, nextReviewBy: '2099-06-30' });
    expect(ra.ai).toBeNull();

    const rb = dash.rows.find((r) => r.projectId === b.project.id)!;
    expect(rb.research).toBeNull();
    expect(rb.price).toBeNull();
    expect(rb.target).toMatchObject({ base: null, weighted: null, upsideBase: null });
    expect(rb.ai).toMatchObject({ client: 'claude-desktop', summary: 'Reviewed Fresh Co' });
    expect(dash.rows.find((r) => r.projectId === c.project.id)!.archivedAt).not.toBeNull();

    // uncommitted draft edit, and a quote fetched two days ago
    const bundle = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    await saveDraft(pid, setValue(bundle.draft.state, idByName(s, 'Target P/E'), SCALAR_KEY, 'base', 40), bundle.draft.version);
    ctx.db.prepare('UPDATE quotes SET fetched_at = ?').run(new Date(Date.now() - 2 * 86_400_000).toISOString());
    const dash2 = await api<DashboardDTO>('GET', '/api/dashboard');
    const ra2 = dash2.rows.find((r) => r.projectId === pid)!;
    expect(ra2.draftDirty).toBe(true);
    expect(ra2.target.base).toBe(tps.base); // still the committed head
    expect(ra2.price!.stale).toBe(true);
  });

  it('flags a target in another currency than the price', async () => {
    const a = await newProject();
    const sec = a.securities[0];
    const d = await saveDraft(a.project.id, populate(a.draft.state), a.draft.version);
    await commit(a.project.id, d.version);
    await api('GET', `/api/securities/${sec.id}/quote`);
    ctx.db.prepare("UPDATE quotes SET currency = 'USD'").run();
    const row = (await api<DashboardDTO>('GET', '/api/dashboard')).rows[0];
    expect(row.target.base).not.toBeNull();
    expect(row.target).toMatchObject({ currencyMismatch: true, upsideBase: null, upsideWeighted: null });
  });

  it('lists trades across companies with metrics, research snapshot, reviews and filters', async () => {
    const a = await newProject();
    const pid = a.project.id;
    const sec = a.securities[0];
    const d = await saveDraft(pid, populate(a.draft.state), a.draft.version);
    const r2 = await commit(pid, d.version, { asOfDate: '2026-08-20' });
    const u = await company('Credo Technology', 'CRDO', 'USD', 'demo');
    await api('GET', `/api/securities/${sec.id}/bars`);
    await api('GET', `/api/securities/${u.securities[0].id}/bars`);
    await api('GET', `/api/securities/${u.securities[0].id}/quote`);
    const closed = await api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-01', entryPrice: 100, quantity: 1000, exitDate: '2026-09-15', exitPrice: 110, fees: 50 });
    const open = await api<TradeDTO>('POST', `/api/projects/${u.project.id}/trades`, { entryDate: '2026-09-10', entryPrice: 50, quantity: 10, stopAtEntry: 45 });
    const old = await api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { entryDate: '2022-06-01', entryPrice: 80, quantity: 1, exitDate: '2022-07-01', exitPrice: 85 });
    await api('POST', `/api/projects/${pid}/reviews`, { title: 'Sold too early', subjectType: 'trade', subjectId: closed.id, categories: [{ category: 'trading_execution', notes: '' }], executionVerdict: 'poor' });

    const all = await api<TradesJournalDTO>('GET', '/api/trades');
    expect(all.trades.map((t) => t.id)).toEqual([open.id, closed.id, old.id]);
    const c = all.trades[1];
    expect(c.metrics).toMatchObject({ open: false, markSource: 'exit' });
    expect(c.metrics.pnl).toBeCloseTo(10 * 1000 - 50);
    expect(c.project).toEqual({ id: pid, name: 'Lite-On Technology', archived: false });
    expect(c.security).toMatchObject({ ticker: '2301', currency: 'TWD', priceSource: 'demo', synthetic: true });
    expect(c.research).toMatchObject({ revisionId: r2.id, seq: 2, asOfDate: '2026-08-20', kind: 'update' });
    expect(c.reviews).toMatchObject([{ title: 'Sold too early', executionVerdict: 'poor', categories: ['trading_execution'] }]);
    expect(c.barsCoverEntry).toBe(true);
    expect(c.createdBy).toBe('user');
    const o = all.trades[0];
    expect(o.metrics.markSource).toBe('quote');
    expect(o.metrics.rMultiple).not.toBeNull();
    expect(o.security.currency).toBe('USD');
    expect(o.research).toBeNull();
    const before = all.trades[2];
    expect(before.barsCoverEntry).toBe(false);
    expect(before.metrics.trailingExit).toBeNull();
    expect(before.metrics.mfe).toBeNull();

    expect((await api<TradesJournalDTO>('GET', '/api/trades?status=open')).trades.map((t) => t.id)).toEqual([open.id]);
    expect((await api<TradesJournalDTO>('GET', '/api/trades?status=closed')).trades).toHaveLength(2);
    expect((await api<TradesJournalDTO>('GET', '/api/trades?from=2026-09-05')).trades.map((t) => t.id)).toEqual([open.id]);
    expect((await api<TradesJournalDTO>('GET', '/api/trades?from=2026-01-01&to=2026-09-05')).trades.map((t) => t.id)).toEqual([closed.id]);
    expect((await api<TradesJournalDTO>(`GET`, `/api/trades?projectId=${pid}`)).trades).toHaveLength(2);
    await api('GET', '/api/trades?from=bad', undefined, 400);
    await api('GET', '/api/trades?status=mine', undefined, 400);
    await api('GET', '/api/trades?projectId=prj_nope', undefined, 404);
  });

  it('updates all prices in the background, per provider, with rate-limit and shutdown rules', async () => {
    expect(await api<RefreshRunDTO | null>('GET', '/api/market/refresh')).toBeNull();
    const demo = await newProject();
    const csv = await company('CSV Co', 'CSV1', 'TWD', 'csv');
    const flaky = await company('Flaky Co', 'FLK', 'TWD', 'flaky');
    const l1 = await company('Limited One', 'LIM1', 'USD', 'limited');
    const l2 = await company('Limited Two', 'LIM2', 'USD', 'limited');
    const archived = await company('Archived Co', 'ARC', 'TWD', 'demo');
    await api('PATCH', `/api/projects/${archived.project.id}`, { archived: true });
    const held = await company('Held Co', 'HLD', 'TWD', 'demo');
    await api('POST', `/api/projects/${held.project.id}/trades`, { entryDate: '2026-09-01', entryPrice: 10, quantity: 1 });
    await api('PATCH', `/api/projects/${held.project.id}`, { archived: true });

    const run = await api<RefreshRunDTO>('POST', '/api/market/refresh');
    expect(run.state).toBe('running');
    expect((await api<RefreshRunDTO>('POST', '/api/market/refresh')).id).toBe(run.id);
    await ctx.refresher.idle();
    const done = (await api<RefreshRunDTO>('GET', '/api/market/refresh'))!;
    expect(done.id).toBe(run.id);
    expect(done.state).toBe('done');
    expect(done.finishedAt).not.toBeNull();
    const item = (b: ProjectBundleDTO) => done.items.find((i) => i.projectId === b.project.id);
    expect(item(archived)).toBeUndefined();
    expect(item(held)).toMatchObject({ status: 'ok', lastDate: '2026-09-25' });
    expect(item(demo)).toMatchObject({ status: 'ok', lastDate: '2026-09-25' });
    expect(item(csv)).toMatchObject({ status: 'skipped', message: 'Imported prices only (CSV)' });
    expect(item(flaky)).toMatchObject({ status: 'failed', message: 'Unknown symbol' });
    expect([item(l1)!.status, item(l2)!.status].sort()).toEqual(['rate_limited', 'skipped']);
    expect([item(l1)!.message, item(l2)!.message]).toContain('Not updated: Limited rate limit reached');
    expect(limited.calls).toBe(1);
    // background work runs as the system, not as whoever pressed the button
    expect(limited.actor).toBe('system');
    expect(done.providers.find((p) => p.id === 'limited')).toMatchObject({ state: 'rate_limited', retryAfterSec: 60, total: 2 });
    expect(done.providers.find((p) => p.id === 'demo')).toMatchObject({ state: 'done', total: 2 });
    expect(done).toMatchObject({ total: 6, ok: 2, failed: 1, rateLimited: 1, skipped: 2, pending: 0 });
    const quote = ctx.db.prepare('SELECT as_of FROM quotes WHERE security_id = ? AND provider = ?').get(demo.securities[0].id, 'demo') as { as_of: string };
    expect(quote.as_of).toBe('2026-09-25T00:00:00.000Z');
    expect((await api<DashboardDTO>('GET', '/api/dashboard')).refresh?.id).toBe(run.id);

    // shutting down: no new runs
    await ctx.refresher.stop();
    await api('POST', '/api/market/refresh', undefined, 503);
  });

  it('gives up on a provider that cannot be reached', async () => {
    for (const n of [1, 2, 3, 4]) await company(`Offline ${n}`, `OFF${n}`, 'USD', 'offline');
    await api('POST', '/api/market/refresh');
    await ctx.refresher.idle();
    const run = (await api<RefreshRunDTO>('GET', '/api/market/refresh'))!;
    expect(run.items.map((i) => i.status)).toEqual(['failed', 'failed', 'failed', 'skipped']);
    expect(run.items[3].message).toBe('Not updated: Offline could not be reached');
    expect(run.providers[0]).toMatchObject({ id: 'offline', state: 'unreachable' });
    expect(offline.calls).toBe(3);
  });

  it('marks a source this server does not have as unavailable', async () => {
    const b = await company('Fugle Co', '2330', 'TWD', 'fugle');
    await api('POST', '/api/market/refresh');
    await ctx.refresher.idle();
    const run = (await api<RefreshRunDTO>('GET', '/api/market/refresh'))!;
    expect(run.items).toMatchObject([{ projectId: b.project.id, status: 'skipped', message: 'Unknown price source "fugle"' }]);
    expect(run.providers[0]).toMatchObject({ id: 'fugle', state: 'unavailable' });
  });
});

describe('symbol search and security identity', () => {
  it('searches by name and drops cached prices when the provider symbol changes', async () => {
    const r = await api<{ results: { ticker: string; apiSymbol: string; suggestedProvider: string }[] }>('GET', `/api/symbols/search?q=${encodeURIComponent('景美')}`);
    expect(r.results[0]).toMatchObject({ ticker: '7899', apiSymbol: '7899.TWO', suggestedProvider: 'finmind' });

    const b = await newProject();
    const sec = b.securities[0];
    expect((await api<BarsResponse>('GET', `/api/securities/${sec.id}/bars`)).bars.length).toBeGreaterThan(0);
    await api('PATCH', `/api/securities/${sec.id}`, { exchange: 'TPEx' });
    const kept = ctx.db.prepare('SELECT COUNT(*) AS n FROM price_bars WHERE security_id = ?').get(sec.id) as { n: number };
    expect(kept.n).toBeGreaterThan(0);
    await api('PATCH', `/api/securities/${sec.id}`, { apiSymbol: '2301.TWO' });
    const left = ctx.db.prepare('SELECT COUNT(*) AS n FROM price_bars WHERE security_id = ?').get(sec.id) as { n: number };
    expect(left.n).toBe(0);
  });
});

describe('host and origin check', () => {
  it('accepts any host and origin when allowedHosts is not set', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'anything.example:80', origin: 'https://elsewhere.example' } });
    expect(res.statusCode).toBe(200);
  });

  it('refuses other hosts (DNS rebinding) and cross-site origins', async () => {
    const g = await buildApp({ dataDir: path.join(dir, 'guarded'), providers: [new DemoProvider()], allowedHosts: ['127.0.0.1:4310', 'localhost:4310'], allowedOrigins: ['app://obsidian.md'] });
    try {
      const get = (host: string) => g.app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect((await get('127.0.0.1:4310')).statusCode).toBe(200);
      expect((await get('LOCALHOST:4310')).statusCode).toBe(200);
      const rebound = await get('attacker.example:4310');
      expect(rebound.statusCode).toBe(403);
      expect(rebound.json()).toEqual({ error: 'Host not allowed' });
      expect((await get('127.0.0.1:4311')).statusCode).toBe(403);

      const create = (origin: string) =>
        g.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: { host: '127.0.0.1:4310', origin, authorization: `Bearer ${g.tokens.tokens.user}` },
          payload: { name: 'X', security: { ticker: '1', priceSource: 'demo' } },
        });
      expect((await create('http://127.0.0.1:4310')).statusCode).toBe(200);
      expect((await create('http://localhost:4310')).statusCode).toBe(200);
      expect((await create('app://obsidian.md')).statusCode).toBe(200);
      const cross = await create('https://evil.example');
      expect(cross.statusCode).toBe(403);
      expect(cross.json()).toEqual({ error: 'Origin not allowed' });
      expect((await create('null')).statusCode).toBe(403);
      expect((await create('http://localhost:5173')).statusCode).toBe(403);
      const list = await g.app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'localhost:4310' } });
      expect(list.json()).toHaveLength(3);
    } finally {
      await g.app.close();
    }
  });
});

describe('version and diagnostics', () => {
  it('reports the installed version, data location, schema and backups', async () => {
    const appRoot = path.join(dir, 'app-abc123');
    fs.mkdirSync(appRoot);
    fs.writeFileSync(path.join(appRoot, 'version.json'), JSON.stringify({ commit: 'abc123', installedAt: '2026-10-30T08:00:00.000Z' }));
    const dataDir = path.join(dir, 'diag');
    const d = await buildApp({ dataDir, appRoot, startBackups: true, providers: [new DemoProvider()] });
    try {
      await d.backups.maybeBackup(); // the startup backup
      const version = { commit: 'abc123', installedAt: '2026-10-30T08:00:00.000Z' };
      expect((await d.app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ ok: true, version });
      const diag = (await d.app.inject({ method: 'GET', url: '/api/diagnostics' })).json();
      expect(diag).toMatchObject({
        version,
        node: process.version,
        platform: process.platform,
        dataDir,
        dbFile: path.join(dataDir, 'workbench.db'),
        schemaVersion: SCHEMA_VERSION,
        backups: { count: 1, dir: path.join(dataDir, 'backups'), lastError: null },
      });
      expect(diag.clients.map((c: { client: string }) => c.client)).toEqual(['claude-desktop', 'claude-code', 'chatgpt']);
      expect(diag.clients.every((c: { lastSeenAt: string | null }) => c.lastSeenAt === null)).toBe(true);
      expect(diag.backups.lastBackupAt).toEqual(expect.any(String));
      expect(diag.uptimeSec).toBeGreaterThanOrEqual(0);
    } finally {
      await d.app.close();
    }
    // a development checkout has no version.json; backups are off unless asked for
    expect(readVersion(path.join(dir, 'nowhere'))).toEqual({ commit: 'dev' });
    fs.writeFileSync(path.join(appRoot, 'version.json'), '{ broken');
    expect(readVersion(appRoot)).toEqual({ commit: 'dev' });
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    expect(ctx.backups.status().count).toBe(0);
  });
});

describe('main.ts', () => {
  it('closes the database and exits 0 on SIGTERM', async () => {
    const dataDir = path.join(dir, 'main');
    const port = 5300 + Math.floor(Math.random() * 600);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
      cwd: APP_ROOT,
      env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_PORT: String(port), WORKBENCH_QUIET: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (b: Buffer) => {
        output += b;
        if (output.includes('Research Workbench API on')) resolve();
      });
      child.stderr.on('data', (b: Buffer) => (output += b));
      void exited.then(() => reject(new Error(`server exited early: ${output}`)));
    });
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    const cross = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    // closed cleanly: the write-ahead log was checkpointed and removed; the startup backup is complete
    expect(fs.readdirSync(dataDir).sort()).toEqual(['attachments', 'backups', 'tokens.json', 'workbench.db']);
    expect(fs.readdirSync(path.join(dataDir, 'backups', 'daily'))).toEqual([expect.stringMatching(/^workbench-\d{8}-\d{6}\.db$/)]);
  }, 30_000);
});
