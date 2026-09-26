import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setValue } from '../domain/model/ops';
import { SCALAR_KEY, type ModelState } from '../domain/model/types';
import { fill, idByName } from '../domain/testing/sample';
import type { Bar } from '../domain/market/indicators';
import type { BarsResponse, EvidenceDTO, ProjectBundleDTO, QuoteResponse, RevisionFull, RevisionMeta, SeriesPoint, TradeDTO } from '../shared/api';
import { buildApp, type AppContext } from './app';
import { openDatabase } from './db/connection';
import { CsvProvider } from './market/csv';
import { DemoProvider } from './market/demo';
import { MarketDataError, type MarketDataProvider } from './market/provider';

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

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  ctx = await buildApp({ dataDir: dir, providers: [new DemoProvider(() => '2026-09-25'), new CsvProvider(), new FailingProvider()] });
});
afterEach(async () => {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, expectStatus = 200): Promise<T> {
  const res = await ctx.app.inject({ method, url, payload: payload as object | undefined });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

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
    const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${pid}/evidence`, payload: mp.payload, headers: mp.headers });
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
    const r2 = await ctx.app.inject({ method: 'POST', url: `/api/projects/${pid}/evidence`, payload: html.payload, headers: html.headers });
    const ev2 = r2.json() as EvidenceDTO;
    expect(ev2.kind).toBe('file');
    const c2 = await ctx.app.inject({ method: 'GET', url: ev2.attachments[0].url });
    expect(c2.headers['content-type']).toBe('application/octet-stream');
    expect(String(c2.headers['content-disposition'])).toMatch(/^attachment/);
    expect(String(c2.headers['content-security-policy'])).toContain('sandbox');

    // same bytes uploaded twice share storage but keep their own names
    const again = multipart({}, [{ name: 'file', filename: 'copy.png', type: 'image/png', data: png }]);
    const r3 = await ctx.app.inject({ method: 'POST', url: `/api/evidence/${ev.id}/files`, payload: again.payload, headers: again.headers });
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
    const imp = await ctx.app.inject({ method: 'POST', url: `/api/securities/${sec.id}/bars/import`, payload: mp.payload, headers: mp.headers });
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
    const d = await saveDraft(pid, populate(b.draft.state), b.draft.version);
    const r = await commit(pid, d.version);
    expect(r.market!.provider).toBe('demo');
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
    const log = await api<{ action: string }[]>('GET', `/api/projects/${pid}/audit?entityId=${t.id}`);
    expect(log).toHaveLength(1);
    // a trade before any knowledge-dated research has no snapshot
    const t3 = await api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-01', entryPrice: 100, quantity: 1 });
    expect(t3.revisionId).toBeNull();
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
    const rows = b.prepare('SELECT version FROM schema_migrations').all();
    expect(rows).toEqual([{ version: 1 }]);
    const tables = (b.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['projects', 'revisions', 'drafts', 'evidence', 'attachments', 'catalysts', 'trades', 'price_bars', 'quotes', 'audit_log']));
    b.close();
  });
});
