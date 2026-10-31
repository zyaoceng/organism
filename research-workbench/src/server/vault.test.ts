import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setValue } from '../domain/model/ops';
import { SCALAR_KEY, type ModelState } from '../domain/model/types';
import { fill, idByName } from '../domain/testing/sample';
import { reflectionHash } from '../domain/vault/hash';
import type { RenderedNote, VaultNotesResponse, VaultStatusReport } from '../domain/vault/types';
import type { TokenName } from '../shared/actors';
import type { AuditEntryDTO, DiagnosticsDTO, ProjectBundleDTO, ReflectionDTO, ReflectionVersionDTO, RevisionFull, TradeDTO, TradesJournalDTO, VaultStatusDTO } from '../shared/api';
import { buildApp, type AppContext } from './app';
import { openDatabase } from './db/connection';
import { MIGRATIONS } from './db/migrations';
import { DemoProvider } from './market/demo';
import { crc32 } from './vault/zip';

let ctx: AppContext;
let dir: string;
let pluginDir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vault-'));
  pluginDir = path.join(dir, 'plugin');
  ctx = await buildApp({ dataDir: path.join(dir, 'data'), providers: [new DemoProvider(() => '2026-09-25')], market: { minIntervalMs: 0 }, pluginDir, publicUrl: 'http://127.0.0.1:4310' });
});
afterEach(async () => {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function call(who: TokenName | null, method: Method, url: string, payload?: unknown) {
  return ctx.app.inject({ method, url, payload: payload as object | undefined, headers: who ? { authorization: `Bearer ${ctx.tokens.tokens[who]}` } : {} });
}
async function as<T>(who: TokenName, method: Method, url: string, payload?: unknown, expectStatus = 200): Promise<T> {
  const res = await call(who, method, url, payload);
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
const api = <T>(method: Method, url: string, payload?: unknown, expectStatus = 200) => as<T>('user', method, url, payload, expectStatus);
const obs = <T>(method: Method, url: string, payload?: unknown, expectStatus = 200) => as<T>('obsidian', method, url, payload, expectStatus);

function populate(s: ModelState): ModelState {
  s = fill(s, idByName(s, 'Business A'), { FY2024: 800, FY2025: 1000 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business A'), { FY2026: 0.2, FY2027: 0.2, FY2028: 0.35 });
  s = fill(s, idByName(s, 'Business B'), { FY2024: 500, FY2025: 550 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business B'), { FY2026: 0.05, FY2027: 0.05, FY2028: 0.05 });
  s = fill(s, idByName(s, 'Business C'), { FY2024: 100, FY2025: 120 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business C'), { FY2026: 0.5, FY2027: 0.5, FY2028: 0.5 });
  const same = (v: number) => Object.fromEntries(['FY2024', 'FY2025', 'FY2026', 'FY2027', 'FY2028'].map((k) => [k, v]));
  s = fill(s, idByName(s, 'Gross Margin'), same(0.2));
  s = fill(s, idByName(s, 'Opex % of Revenue'), same(0.08));
  s = fill(s, idByName(s, 'Non-Operating Items'), same(20));
  s = fill(s, idByName(s, 'Tax Rate'), same(0.2));
  s = fill(s, idByName(s, 'Diluted Shares'), same(22));
  s = fill(s, idByName(s, 'Invested Capital'), same(600));
  s = setValue(s, idByName(s, 'Target P/E'), SCALAR_KEY, 'base', 25);
  return s;
}

async function newProject(name = 'Lite-On Technology', ticker = '2301'): Promise<ProjectBundleDTO> {
  const { id } = await api<{ id: string }>('POST', '/api/projects', {
    name,
    year: 2026,
    security: { ticker, exchange: 'TWSE', apiSymbol: `${ticker}.TW`, currency: 'TWD', priceSource: 'demo' },
  });
  return api<ProjectBundleDTO>('GET', `/api/projects/${id}`);
}

async function commitUpdate(pid: string, title = 'Initiation'): Promise<RevisionFull> {
  const b = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
  const d = await api<{ version: number }>('PUT', `/api/projects/${pid}/draft`, { state: populate(b.draft.state), version: b.draft.version });
  return api<RevisionFull>('POST', `/api/projects/${pid}/revisions`, { title, reason: 'Because', asOfDate: '2026-09-20', draftVersion: d.version });
}

const newTrade = (pid: string, over: Record<string, unknown> = {}) =>
  api<TradeDTO>('POST', `/api/projects/${pid}/trades`, { side: 'long', entryDate: '2026-09-21', entryPrice: 100, quantity: 1000, entryReason: '法說後上修', ...over });

const lastSeq = () => (ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM vault_changes').get() as { m: number }).m;

/** The (kind:id:op) rows a call adds to vault_changes. */
async function queued(fn: () => Promise<unknown>): Promise<string[]> {
  const before = lastSeq();
  await fn();
  const rows = ctx.db.prepare('SELECT note_kind, note_id, op FROM vault_changes WHERE seq > ? ORDER BY seq').all(before) as { note_kind: string; note_id: string; op: string }[];
  return [...new Set(rows.map((r) => `${r.note_kind}:${r.note_id}:${r.op}`))].sort();
}
const up = (kind: string, id: string) => `${kind}:${id}:upsert`;

const fm = (n: RenderedNote) => Object.fromEntries(n.frontmatter) as Record<string, unknown>;

async function allNotes(limit = 200): Promise<{ pages: VaultNotesResponse[]; notes: Map<string, RenderedNote> }> {
  const pages: VaultNotesResponse[] = [];
  const notes = new Map<string, RenderedNote>();
  let after = 0;
  for (let i = 0; i < 100; i++) {
    const p = await obs<VaultNotesResponse>('GET', `/api/vault/notes?after=${after}&limit=${limit}`);
    pages.push(p);
    for (const n of p.notes) notes.set(n.wbId, n);
    after = p.nextAfter;
    if (!p.more) break;
  }
  return { pages, notes };
}

const report = (over: Partial<VaultStatusReport> = {}): VaultStatusReport => ({
  protocol: 1,
  pluginVersion: '0.1.0',
  vaultName: '投資筆記',
  cursor: lastSeq(),
  pending: 0,
  skippedOpen: 0,
  missing: 0,
  conflicts: [],
  errors: [],
  ...over,
});

// ---------------------------------------------------------------- schema

/** A database exactly as v2 shipped it, built from the migration SQL itself. */
function makeV2Database(file: string) {
  const d = new Database(file);
  for (const m of MIGRATIONS.filter((x) => x.version <= 2)) d.exec(m.sql);
  d.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const v of [1, 2]) d.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, '2026-10-01T00:00:00.000Z');
  const T = '2026-10-01T00:00:00.000Z';
  d.prepare("INSERT INTO projects (id, name, description, created_at, updated_at) VALUES ('prj_aaaa0001', 'Lite-On', '', ?, ?)").run(T, T);
  d.prepare("INSERT INTO securities (id, project_id, name, ticker, exchange, api_symbol, currency, price_source) VALUES ('sec_1', 'prj_aaaa0001', 'Lite-On', '2301', 'TWSE', '2301.TW', 'TWD', 'demo')").run();
  const rev = d.prepare(
    `INSERT INTO revisions (id, project_id, seq, parent_id, kind, title, reason, notes, as_of_date, committed_at, state_json, computed_json, changes_json, impact_json, market_json, engine_version)
     VALUES (?, 'prj_aaaa0001', ?, ?, ?, ?, 'r', '', ?, ?, '{}', '{}', '[]', 'null', NULL, '1.0.0')`,
  );
  rev.run('rev_aaaa0001', 1, null, 'initial', 'Created', null, T);
  rev.run('rev_aaaa0002', 2, 'rev_aaaa0001', 'update', 'Initiation', '2026-09-30', T);
  d.prepare("INSERT INTO trades (id, project_id, security_id, side, entry_date, entry_price, quantity, created_at, updated_at) VALUES ('trd_aaaa0001', 'prj_aaaa0001', 'sec_1', 'long', '2026-10-01', 100, 1000, ?, ?)").run(T, T);
  d.prepare("INSERT INTO ai_sessions (id, client, started_at, last_at, summary_md) VALUES ('ais_aaaa0001', 'claude-desktop', ?, ?, '摘要')").run(T, T);
  d.prepare("INSERT INTO ai_sessions (id, client, started_at, last_at) VALUES ('ais_aaaa0002', 'chatgpt', ?, ?)").run(T, T);
  d.close();
}

describe('schema v3', () => {
  it('upgrades a v2 database: backup, backfilled change queue, triggers from then on', () => {
    const file = path.join(dir, 'old', 'workbench.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    makeV2Database(file);
    const backupDir = path.join(dir, 'old', 'backups');
    const db = openDatabase(file, { backupDir });
    try {
      expect((db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version)).toEqual(expect.arrayContaining([1, 2, 3]));
      expect(fs.readdirSync(backupDir).filter((f) => /^pre-v\d+-.+\.db$/.test(f))).toHaveLength(1);
      // every note once, companies first, the initial snapshot and summary-less sessions excluded
      expect(db.prepare('SELECT note_kind, note_id, op, tombstone_json FROM vault_changes ORDER BY seq').all()).toEqual([
        { note_kind: 'company', note_id: 'prj_aaaa0001', op: 'upsert', tombstone_json: null },
        { note_kind: 'research_update', note_id: 'rev_aaaa0002', op: 'upsert', tombstone_json: null },
        { note_kind: 'trade', note_id: 'trd_aaaa0001', op: 'upsert', tombstone_json: null },
        { note_kind: 'ai_session', note_id: 'ais_aaaa0001', op: 'upsert', tombstone_json: null },
        { note_kind: 'index', note_id: 'index-companies', op: 'upsert', tombstone_json: null },
        { note_kind: 'index', note_id: 'index-trades', op: 'upsert', tombstone_json: null },
        { note_kind: 'index', note_id: 'index-ai', op: 'upsert', tombstone_json: null },
      ]);
      db.prepare("UPDATE trades SET exit_date = '2026-10-20', exit_price = 110 WHERE id = 'trd_aaaa0001'").run();
      expect(db.prepare('SELECT note_id FROM vault_changes WHERE seq > 7 ORDER BY seq').all()).toEqual([
        { note_id: 'trd_aaaa0001' },
        { note_id: 'prj_aaaa0001' },
        { note_id: 'index-trades' },
        { note_id: 'index-companies' },
      ]);
    } finally {
      db.close();
    }
    // opening again backfills nothing more
    const again = openDatabase(file, { backupDir });
    try {
      expect(again.prepare('SELECT COUNT(*) AS n FROM vault_changes').get()).toEqual({ n: 11 });
    } finally {
      again.close();
    }
  });

  it('keeps reflection versions append-only', async () => {
    const b = await newProject();
    const ins = ctx.db.prepare(
      "INSERT INTO reflection_versions (note_kind, note_id, project_id, body_md, body_hash, source_path, received_at) VALUES ('company', ?, ?, 'x', 'h', 'p.md', '2026-10-01')",
    );
    ins.run(b.project.id, b.project.id);
    expect(() => ctx.db.prepare("UPDATE reflection_versions SET body_md = ''").run()).toThrow(/append-only/);
    expect(() => ctx.db.prepare('DELETE FROM reflection_versions').run()).toThrow(/append-only/);
    expect(() => ins.run('prj_nowhere', 'prj_nowhere')).toThrow(/FOREIGN KEY/);
  });

  it('queues exactly the notes each write changes', async () => {
    let pid = '';
    const created = await queued(async () => {
      pid = (await newProject()).project.id;
    });
    expect(created).toEqual([up('company', pid), up('index', 'index-companies')]);

    // a PATCH with the same values, a draft save, a quote and bars refresh, a note: nothing
    const b = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
    const sec = b.securities[0];
    expect(await queued(() => api('PATCH', `/api/projects/${pid}`, { name: b.project.name, description: b.project.description }))).toEqual([]);
    expect(await queued(() => api('PUT', `/api/projects/${pid}/draft`, { state: populate(b.draft.state), version: b.draft.version }))).toEqual([]);
    expect(await queued(() => api('GET', `/api/securities/${sec.id}/quote?refresh=1`))).toEqual([]);
    expect(await queued(() => api('GET', `/api/securities/${sec.id}/bars?refresh=1`))).toEqual([]);
    expect(await queued(() => api('POST', `/api/projects/${pid}/notes`, { body: 'hello' }))).toEqual([]);

    let rid = '';
    const committed = await queued(async () => {
      const d = await api<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
      rid = (await api<RevisionFull>('POST', `/api/projects/${pid}/revisions`, { title: 'Initiation', reason: 'r', asOfDate: '2026-09-20', draftVersion: d.draft.version })).id;
    });
    expect(committed).toEqual([up('company', pid), up('index', 'index-companies'), up('research_update', rid)].sort());

    let tid = '';
    expect(
      await queued(async () => {
        tid = (await newTrade(pid)).id;
      }),
    ).toEqual([up('company', pid), up('index', 'index-companies'), up('index', 'index-trades'), up('trade', tid)].sort());
    expect(await queued(() => api('PATCH', `/api/trades/${tid}`, { exitDate: '2026-10-10', exitPrice: 110 }))).toEqual(
      [up('company', pid), up('index', 'index-companies'), up('index', 'index-trades'), up('trade', tid)].sort(),
    );

    // reviews: of a trade queue the trade, of the project nothing
    expect(await queued(() => api('POST', `/api/projects/${pid}/reviews`, { title: 'Sold early', subjectType: 'trade', subjectId: tid, executionVerdict: 'poor' }))).toEqual([up('trade', tid)]);
    expect(await queued(() => api('POST', `/api/projects/${pid}/reviews`, { title: 'Thesis', subjectType: 'project', thesisVerdict: 'mixed' }))).toEqual([]);

    // catalysts
    let cid = '';
    expect(
      await queued(async () => {
        cid = (await api<{ id: string }>('POST', `/api/projects/${pid}/catalysts`, { title: 'Q3 earnings', type: 'earnings', expectedDate: '2026-11-10' })).id;
      }),
    ).toEqual([up('company', pid)]);
    expect(await queued(() => api('PATCH', `/api/catalysts/${cid}`, { status: 'delayed' }))).toEqual([up('company', pid)]);
    expect(await queued(() => api('DELETE', `/api/catalysts/${cid}`))).toEqual([up('company', pid)]);

    // marking an update wrong
    expect(await queued(() => api('POST', `/api/projects/${pid}/revisions/${rid}/annotations`, { kind: 'excluded', note: 'wrong' }))).toEqual(
      [up('company', pid), up('research_update', rid)].sort(),
    );

    // an AI session summary queues the session, the AI index and its companies
    const s = await as<{ id: string }>('claude-desktop', 'POST', '/api/ai/sessions/summary', { summary: '調高稅率假設', projectIds: [pid] });
    expect(ctx.db.prepare("SELECT DISTINCT note_kind, note_id FROM vault_changes WHERE note_kind = 'ai_session'").all()).toEqual([{ note_kind: 'ai_session', note_id: s.id }]);
    // later writes of that client update the session's action list (and its note)
    expect(await queued(() => as('claude-desktop', 'POST', `/api/projects/${pid}/notes`, { body: 'AI note' }))).toEqual([up('ai_session', s.id), up('company', pid), up('index', 'index-ai')].sort());

    // a ticker change re-renders everything that shows the company
    const ticker = await queued(() => api('PATCH', `/api/securities/${sec.id}`, { ticker: '2301A' }));
    expect(ticker).toEqual(
      [up('company', pid), up('index', 'index-companies'), up('index', 'index-trades'), up('index', 'index-ai'), up('research_update', rid), up('trade', tid), up('ai_session', s.id)].sort(),
    );
    expect(await queued(() => api('PATCH', `/api/projects/${pid}`, { name: 'Lite-On' }))).toEqual(ticker);

    // delete: a tombstone with the trade as it was
    const deleted = await queued(() => api('DELETE', `/api/trades/${tid}`));
    expect(deleted).toEqual([up('company', pid), up('index', 'index-companies'), up('index', 'index-trades'), `trade:${tid}:delete`].sort());
    const tomb = JSON.parse((ctx.db.prepare("SELECT tombstone_json FROM vault_changes WHERE op = 'delete'").get() as { tombstone_json: string }).tombstone_json);
    expect(tomb).toMatchObject({ id: tid, projectId: pid, side: 'long', entryDate: '2026-09-21', entryPrice: 100, quantity: 1000, entryReason: '法說後上修', exitDate: '2026-10-10', exitPrice: 110, createdBy: 'user' });
    expect(tomb.deletedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // a review of the deleted trade changes no note
    const rv = (ctx.db.prepare("SELECT id FROM reviews WHERE subject_type = 'trade'").get() as { id: string }).id;
    expect(await queued(() => api('DELETE', `/api/reviews/${rv}`))).toEqual([]);
  });
});

// ---------------------------------------------------------------- routes

describe('who may call the vault routes', () => {
  it('answers the plugin routes only to the Obsidian token, and keeps that token inside /api/vault', async () => {
    const b = await newProject();
    const plugin: [Method, string, unknown?][] = [
      ['GET', '/api/vault/ping'],
      ['GET', '/api/vault/notes?after=0'],
      ['GET', '/api/vault/reflections/hashes'],
      ['POST', '/api/vault/reflections', { items: [{ wbId: b.project.id, text: 'x', path: 'a.md', mtime: 0 }] }],
      ['POST', '/api/vault/status', report()],
    ];
    for (const [method, url, payload] of plugin) {
      expect((await call(null, method, url, payload)).statusCode, `${method} ${url}`).toBe(401);
      const cookie = await ctx.app.inject({ method, url, payload: payload as object | undefined, headers: { cookie: `wb_session=${ctx.tokens.tokens.user}` } });
      expect(cookie.statusCode, `${method} ${url} (cookie)`).toBe(403);
      expect((await call('user', method, url, payload)).statusCode).toBe(403);
      expect((await call('claude-desktop', method, url, payload)).statusCode).toBe(403);
      expect((await call('obsidian', method, url, payload)).statusCode, `${method} ${url} (obsidian)`).toBe(200);
    }
    // the Obsidian token cannot use anything else, not even reads or encoded paths
    for (const [method, url] of [
      ['GET', '/api/projects'],
      ['GET', `/api/projects/${b.project.id}/reflections`],
      ['POST', `/api/projects/${b.project.id}/revisions`],
      ['GET', '/api/%70rojects'],
      ['GET', '/api/session'],
    ] as [Method, string][]) {
      const res = await call('obsidian', method, url, method === 'POST' ? {} : undefined);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('OBSIDIAN_SCOPE');
    }
    expect((await call('obsidian', 'GET', '/api/vault/status')).statusCode).toBe(200);
    // the zip holds the token: the browser user only
    expect((await call(null, 'GET', '/api/vault/plugin.zip')).statusCode).toBe(401);
    expect((await call('obsidian', 'GET', '/api/vault/plugin.zip')).statusCode).toBe(403);
    expect((await call('claude-code', 'GET', '/api/vault/plugin.zip')).statusCode).toBe(403);
  });

  it('gives existing installs an Obsidian token', async () => {
    const file = path.join(dir, 'data', 'tokens.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete doc.tokens.obsidian;
    fs.writeFileSync(file, JSON.stringify(doc));
    await ctx.app.close();
    ctx = await buildApp({ dataDir: path.join(dir, 'data'), providers: [new DemoProvider(() => '2026-09-25')] });
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).tokens;
    expect(after.user).toBe(doc.tokens.user);
    expect(after.obsidian).toEqual(expect.any(String));
    expect(after.obsidian.length).toBeGreaterThanOrEqual(32);
    expect(ctx.tokens.tokens.obsidian).toBe(after.obsidian);
  });
});

describe('GET /api/vault/notes', () => {
  async function seed() {
    const b = await newProject();
    const pid = b.project.id;
    const rev = await commitUpdate(pid);
    const open = await newTrade(pid);
    const closed = await newTrade(pid, { entryDate: '2026-09-22', exitDate: '2026-10-10', exitPrice: 120 });
    const s = await as<{ id: string }>('claude-desktop', 'POST', '/api/ai/sessions/summary', { summary: '看了法說', projectIds: [pid] });
    return { pid, rid: rev.id, open: open.id, closed: closed.id, sid: s.id };
  }

  it('pages through every note once, deterministically', async () => {
    const { pid, rid, open, closed, sid } = await seed();
    const first = await obs<VaultNotesResponse>('GET', '/api/vault/notes?after=0');
    expect(first).toMatchObject({ protocol: 1, generation: expect.stringMatching(/^[0-9a-f]{32}$/), publicUrl: 'http://127.0.0.1:4310', more: false, missing: [] });
    expect(first.latestSeq).toBe(lastSeq());
    expect(first.nextAfter).toBe(first.latestSeq);
    const ids = first.notes.map((n) => n.wbId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([pid, rid, open, closed, sid, 'index-companies', 'index-trades', 'index-ai'].sort());

    const company = first.notes.find((n) => n.wbId === pid)!;
    expect(company).toMatchObject({ kind: 'company', deleted: false, path: '公司/2301 Lite-On Technology.md' });
    expect(fm(company)).toMatchObject({ wb_id: pid, wb_type: 'company', wb_ticker: '2301', wb_open_trades: 1, wb_url: `http://127.0.0.1:4310/#/p/${pid}/model` });
    expect(company.block).toContain(`[[wb:${rid}`);
    expect(company.body).toContain('## 反思');
    const t = first.notes.find((n) => n.wbId === closed)!;
    expect(fm(t)).toMatchObject({ wb_status: 'closed', wb_return_pct: 0.2, wb_created_by: 'user' });
    expect(fm(first.notes.find((n) => n.wbId === open)!)).toMatchObject({ wb_status: 'open', wb_return_pct: null });
    expect(first.notes.find((n) => n.wbId === sid)!.block).toContain('Claude 桌面版');

    // small pages give the same notes; `more` flips on the last one
    const { pages, notes } = await allNotes(2);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.slice(0, -1).every((p) => p.more)).toBe(true);
    expect(pages.at(-1)!.more).toBe(false);
    expect([...notes.keys()].sort()).toEqual([...ids].sort());
    for (const n of first.notes) expect(notes.get(n.wbId)).toEqual(n);
    // linked notes that are not in a page come with their default path
    const withLinks = pages.find((p) => Object.keys(p.names).length)!;
    for (const [id, p] of Object.entries(withLinks.names)) expect(p).toBe(first.notes.find((n) => n.wbId === id)!.path);

    // rendering twice gives the same output, and nothing new after the cursor
    expect(await obs('GET', '/api/vault/notes?after=0')).toEqual(first);
    expect(await obs<VaultNotesResponse>('GET', `/api/vault/notes?after=${first.nextAfter}`)).toMatchObject({ notes: [], more: false, nextAfter: first.nextAfter });
  });

  it('renders deleted trades from the tombstone and fetches notes by id', async () => {
    const { pid, closed } = await seed();
    const seq = lastSeq();
    await api('DELETE', `/api/trades/${closed}`);
    const page = await obs<VaultNotesResponse>('GET', `/api/vault/notes?after=${seq}`);
    expect(page.notes.map((n) => n.wbId).sort()).toEqual([pid, closed, 'index-companies', 'index-trades'].sort());
    const gone = page.notes.find((n) => n.wbId === closed)!;
    expect(gone.deleted).toBe(true);
    expect(fm(gone)).toMatchObject({ wb_status: 'deleted', wb_url: null, wb_entry_price: 100 });
    expect(gone.block).toContain('這筆交易已在研究工作台刪除');
    expect(page.notes.find((n) => n.wbId === 'index-trades')!.block).not.toContain(closed);

    const byId = await obs<VaultNotesResponse>('GET', `/api/vault/notes?ids=${closed},${pid},trd_nowhere1,ais_nowhere1`);
    expect(byId.notes.map((n) => n.wbId)).toEqual([closed, pid]);
    expect(byId.notes[0]).toEqual(gone);
    expect(byId.missing).toEqual(['trd_nowhere1', 'ais_nowhere1']);
    expect(byId).toMatchObject({ more: false, latestSeq: lastSeq() });

    for (const bad of ['ids=', 'ids=../x', `ids=${pid}&after=0`, 'after=-1', 'after=x', 'limit=0', 'limit=501', `ids=${Array.from({ length: 201 }, (_, i) => `trd_${String(i).padStart(4, '0')}`).join(',')}`]) {
      expect((await call('obsidian', 'GET', `/api/vault/notes?${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it('reports a changed note whose entity no longer exists as missing', async () => {
    ctx.db.prepare("INSERT INTO vault_changes (note_kind, note_id, op, at) VALUES ('research_update', 'rev_gone0001', 'upsert', '2026-10-01')").run();
    const p = await obs<VaultNotesResponse>('GET', '/api/vault/notes?after=0');
    expect(p.missing).toEqual(['rev_gone0001']);
  });
});

describe('reflections', () => {
  const post = (items: unknown[]) => obs<{ results: { wbId: string; status: string; versionId?: number; error?: string }[] }>('POST', '/api/vault/reflections', { items });
  const item = (wbId: string, text: string, p = '研究工作台/公司/2301.md') => ({ wbId, text, path: p, mtime: Date.parse('2026-10-30T10:00:00Z') });

  it('stores what changed, keeps every version and never lets a blank replace the text', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const statuses = async (items: unknown[]) => (await post(items)).results.map((r) => r.status);

    // an empty template is not a reflection
    expect(await statuses([item(pid, '')])).toEqual(['unchanged']);
    expect(await statuses([item(pid, '看錯了毛利率\r\n')])).toEqual(['stored']);
    expect(await statuses([item(pid, '看錯了毛利率')])).toEqual(['unchanged']);
    // trailing spaces and blank lines are the same text
    expect(await statuses([item(pid, '看錯了毛利率  \n\n')])).toEqual(['unchanged']);
    // the same text read from a renamed file
    expect(await statuses([item(pid, '看錯了毛利率', '研究工作台/公司/改名.md')])).toEqual(['unchanged']);
    // X → Y → X from one file stores three versions
    expect(await statuses([item(pid, '其實是匯率')])).toEqual(['stored']);
    expect(await statuses([item(pid, '看錯了毛利率')])).toEqual(['stored']);
    // a conflict copy sends its own text; afterwards neither file flips the value back by resending
    expect(await statuses([item(pid, '副本的版本', '研究工作台/公司/改名.md')])).toEqual(['stored']);
    expect(await statuses([item(pid, '看錯了毛利率')])).toEqual(['unchanged']);
    expect(await statuses([item(pid, '副本的版本', '研究工作台/公司/改名.md')])).toEqual(['unchanged']);
    // cleared in Obsidian: stored as '', the previous text stays visible
    expect(await statuses([item(pid, '\n')])).toEqual(['stored']);

    const versions = await api<ReflectionVersionDTO[]>('GET', `/api/reflections/${pid}/versions`);
    expect(versions.map((v) => v.text)).toEqual(['', '副本的版本', '看錯了毛利率', '其實是匯率', '看錯了毛利率']);
    expect(versions[2]).toMatchObject({ actor: 'obsidian', sourcePath: '研究工作台/公司/2301.md', fileMtime: '2026-10-30T10:00:00.000Z', hash: reflectionHash('看錯了毛利率') });

    const [r] = await api<ReflectionDTO[]>('GET', `/api/projects/${pid}/reflections`);
    expect(r).toMatchObject({ noteId: pid, kind: 'company', projectId: pid, text: '副本的版本', versionCount: 5, cleared: { at: versions[0].receivedAt }, conflict: null });
    expect(r.receivedAt).toBe(versions[1].receivedAt);

    const audit = await api<AuditEntryDTO[]>('GET', `/api/projects/${pid}/audit?entityId=${pid}`);
    const rows = audit.filter((a) => a.entity === 'reflection');
    expect(rows).toHaveLength(5);
    expect(rows.every((a) => a.actor === 'obsidian' && a.action === 'create')).toBe(true);
    expect(rows[0].after).toMatchObject({ cleared: true, chars: 0, versionId: versions[0].id });

    // the plugin's view: latest hash and the latest per path
    const { notes } = await obs<{ notes: Record<string, { latest: string; byPath: Record<string, string> }> }>('GET', '/api/vault/reflections/hashes');
    expect(notes[pid]).toEqual({
      latest: reflectionHash(''),
      byPath: { '研究工作台/公司/2301.md': reflectionHash(''), '研究工作台/公司/改名.md': reflectionHash('副本的版本') },
    });
  });

  it('rejects what is not a reflection of a known note', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const ais = 'ais_abcdef12';
    const res = await post([
      item('prj_nowhere1', 'x'),
      item(ais, 'x'),
      item('index-trades', 'x'),
      item(b.head.id, 'x'), // the starting snapshot has no note
      item(pid, 'x'.repeat(100_001)),
      item(pid, 'x', '/abs/path.md'),
      item(pid, 'x', '研究工作台/../x.md'),
      { wbId: pid, text: 42, path: 'a.md', mtime: 0 },
      item(pid, 'ok'),
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'stored']);
    expect(res.results[0].error).toBe('unknown note');
    for (const body of [{}, { items: [] }, { items: Array.from({ length: 201 }, () => item(pid, 'x')) }, { items: ['x'] }]) {
      expect((await call('obsidian', 'POST', '/api/vault/reflections', body)).statusCode).toBe(400);
    }
  });

  it('accepts a reflection on a deleted trade and shows it with the project; the trade log carries excerpts', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const rev = await commitUpdate(pid);
    const t = await newTrade(pid, { exitDate: '2026-10-10', exitPrice: 120 });
    const other = await newTrade(pid);
    await post([item(t.id, '進場太早', '研究工作台/交易/t.md'), item(rev.id, '法說解讀正確', '研究工作台/研究更新/r.md')]);
    const journal = await api<TradesJournalDTO>('GET', '/api/trades');
    expect(journal.trades.find((x) => x.id === t.id)!.reflection).toMatchObject({ excerpt: '進場太早', cleared: false, receivedAt: expect.any(String) });
    expect(journal.trades.find((x) => x.id === other.id)!.reflection).toBeNull();

    await api('DELETE', `/api/trades/${t.id}`);
    expect((await post([item(t.id, '進場太早，而且停損太寬', '研究工作台/交易/t.md')])).results[0].status).toBe('stored');

    // paths reported by the plugin give "open in Obsidian"; conflicts come from the latest report
    await obs('POST', '/api/vault/status', report({ paths: { reset: true, set: { [other.id]: '研究工作台/交易/other.md', [pid]: '研究工作台/公司/2301 Lite-On.md' }, removed: [] }, conflicts: [{ wbId: other.id, reason: 'hand-edited', paths: ['研究工作台/交易/other.md'] }] }));
    const list = await api<ReflectionDTO[]>('GET', `/api/projects/${pid}/reflections`);
    expect(list.map((r) => [r.noteId, r.kind, r.versionCount])).toEqual([
      [pid, 'company', 0],
      [rev.id, 'research_update', 1],
      [other.id, 'trade', 0],
      [t.id, 'trade', 2],
    ]);
    const byId = Object.fromEntries(list.map((r) => [r.noteId, r]));
    expect(byId[t.id]).toMatchObject({ text: '進場太早，而且停損太寬', cleared: null, obsidianUrl: `obsidian://open?vault=${encodeURIComponent('投資筆記')}&file=${encodeURIComponent('研究工作台/交易/t.md')}` });
    expect(byId[other.id]).toMatchObject({ text: '', receivedAt: null, conflict: 'hand-edited', obsidianUrl: `obsidian://open?vault=${encodeURIComponent('投資筆記')}&file=${encodeURIComponent('研究工作台/交易/other.md')}` });
    expect(byId[pid].obsidianUrl).toContain(encodeURIComponent('2301 Lite-On.md'));

    // the export keeps every version
    const exported = await api<{ reflections: { noteId: string; text: string }[] }>('GET', `/api/projects/${pid}/export`);
    expect(exported.reflections.map((r) => r.text)).toEqual(['進場太早', '法說解讀正確', '進場太早，而且停損太寬']);
  });
});

describe('status reports', () => {
  it('saves the latest report per vault and shows it in the settings page and diagnostics', async () => {
    const b = await newProject();
    const pid = b.project.id;
    expect(await api('GET', '/api/vault/status')).toBeNull();
    expect((await api<DiagnosticsDTO>('GET', '/api/diagnostics')).vault).toBeNull();

    await obs('POST', '/api/vault/status', report({ cursor: 1, pending: 2, skippedOpen: 1, missing: 3, conflicts: [{ wbId: pid, reason: 'missing-markers', paths: ['研究工作台/公司/a.md'] }], errors: ['x'.repeat(900)] }));
    const s = await api<VaultStatusDTO>('GET', '/api/vault/status');
    expect(s).toMatchObject({ connected: true, pluginVersion: '0.1.0', vaultName: '投資筆記', cursor: 1, latestSeq: lastSeq(), behind: lastSeq() - 1, pending: 2, skippedOpen: 1, missing: 3 });
    expect(s.conflicts).toEqual([{ wbId: pid, reason: 'missing-markers', paths: ['研究工作台/公司/a.md'], title: '2301 Lite-On Technology' }]);
    expect(s.errors[0]).toHaveLength(500);
    expect((await api<DiagnosticsDTO>('GET', '/api/diagnostics')).vault).toEqual(s);
    // diagnostics `clients` stays agent-only
    expect((await api<DiagnosticsDTO>('GET', '/api/diagnostics')).clients.map((c) => c.client)).toEqual(['claude-desktop', 'claude-code', 'chatgpt']);

    // paths: reset replaces, set adds, removed deletes
    const paths = () => ctx.db.prepare('SELECT vault_name, note_id, path FROM vault_note_paths ORDER BY note_id').all();
    await obs('POST', '/api/vault/status', report({ paths: { reset: true, set: { [pid]: 'a.md', 'index-trades': 'b.md' }, removed: [] } }));
    await obs('POST', '/api/vault/status', report({ paths: { reset: false, set: { 'index-ai': 'c.md' }, removed: ['index-trades'] } }));
    expect(paths()).toEqual([
      { vault_name: '投資筆記', note_id: 'index-ai', path: 'c.md' },
      { vault_name: '投資筆記', note_id: pid, path: 'a.md' },
    ]);
    await obs('POST', '/api/vault/status', report({ paths: { reset: true, set: {}, removed: [] } }));
    expect(paths()).toEqual([]);
    // a second vault is another row; the most recent one is shown
    await obs('POST', '/api/vault/status', report({ vaultName: '第二個', cursor: 0 }));
    expect(ctx.db.prepare('SELECT client FROM vault_clients ORDER BY client').all()).toEqual([{ client: 'obsidian:投資筆記' }, { client: 'obsidian:第二個' }]);
    expect((await api<VaultStatusDTO>('GET', '/api/vault/status')).vaultName).toBe('第二個');

    // bad reports are refused; unknown conflict reasons and bad paths are dropped
    for (const bad of [{}, report({ vaultName: '' }), report({ cursor: -1 }), { ...report(), conflicts: 'x' }, report({ paths: { reset: true, set: [] as never, removed: [] } })]) {
      expect((await call('obsidian', 'POST', '/api/vault/status', bad)).statusCode).toBe(400);
    }
    await obs('POST', '/api/vault/status', { ...report(), conflicts: [{ wbId: pid, reason: 'weird', paths: [] }, { wbId: pid, reason: 'hand-edited', paths: ['/abs', 'ok.md'] }] });
    expect((await api<VaultStatusDTO>('GET', '/api/vault/status')).conflicts).toEqual([{ wbId: pid, reason: 'hand-edited', paths: ['ok.md'], title: '2301 Lite-On Technology' }]);
  });

  it('answers ping with the protocol, the current generation and the latest change', async () => {
    const p = await obs<{ ok: boolean; protocol: number; generation: string; publicUrl: string; latestSeq: number; serverTime: string }>('GET', '/api/vault/ping');
    expect(p).toMatchObject({ ok: true, protocol: 1, publicUrl: 'http://127.0.0.1:4310', latestSeq: lastSeq() });
    // the generation is read on every request (a data import changes it)
    ctx.db.prepare("UPDATE db_meta SET db_generation = 'ffffffffffffffffffffffffffffffff'").run();
    expect((await obs<{ generation: string }>('GET', '/api/vault/ping')).generation).toBe('ffffffffffffffffffffffffffffffff');
    expect((await obs<VaultNotesResponse>('GET', '/api/vault/notes?after=0')).generation).toBe('ffffffffffffffffffffffffffffffff');
  });
});

// ---------------------------------------------------------------- zip

/** Our own reader: end of central directory → central entries → local headers → inflate and CRC. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    expect(buf.readUInt16LE(p + 8) & 0x0800).toBe(0x0800);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    expect(buf.readUInt32LE(off)).toBe(0x04034b50);
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const data = zlib.inflateRawSync(buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

describe('GET /api/vault/plugin.zip', () => {
  it('packs the built plugin with this server and the Obsidian token', async () => {
    const missing = await call('user', 'GET', '/api/vault/plugin.zip');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('The Obsidian plugin is not built (npm run build)');

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'main.js'), 'module.exports = class 研究工作台 {};\n'.repeat(50));
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), '{"id":"research-workbench-sync","version":"0.1.0"}\n');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/vault/plugin.zip', headers: { cookie: `wb_session=${ctx.tokens.tokens.user}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="research-workbench-sync.zip"');
    expect(res.headers['cache-control']).toBe('no-store');
    const files = unzip(res.rawPayload);
    expect([...files.keys()]).toEqual(['research-workbench-sync/main.js', 'research-workbench-sync/manifest.json', 'research-workbench-sync/data.json']);
    expect(files.get('research-workbench-sync/main.js')!.toString()).toBe(fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8'));
    expect(JSON.parse(files.get('research-workbench-sync/data.json')!.toString())).toEqual({
      serverUrl: 'http://127.0.0.1:4310',
      token: ctx.tokens.tokens.obsidian,
      rootFolder: '研究工作台',
      intervalSec: 60,
    });
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

// ---------------------------------------------------------------- review: adversarial inputs

describe('adversarial inputs (review)', () => {
  it('keeps the Obsidian token in /api/vault whatever else the request carries', async () => {
    const b = await newProject();
    const hdr = { authorization: `Bearer ${ctx.tokens.tokens.obsidian}` };
    const probes: [Method | 'OPTIONS' | 'HEAD', string, Record<string, string>?][] = [
      ['GET', '/api/vault/../projects'],
      ['GET', '/api/vault/ping/../../projects'],
      ['GET', '/api/vault%2F..%2Fprojects'],
      ['GET', '/API/vault/ping'],
      ['GET', '/api/Vault/ping'],
      ['OPTIONS', '/api/projects'],
      ['HEAD', '/api/projects'],
      ['GET', '/api/diagnostics'],
      ['GET', `/api/projects/${b.project.id}/export`],
      ['PATCH', `/api/projects/${b.project.id}`],
      // a user cookie next to the Obsidian bearer does not make it the user
      ['DELETE', `/api/projects/${b.project.id}`, { cookie: `wb_session=${ctx.tokens.tokens.user}` }],
      ['GET', '/api/projects', { cookie: `wb_session=${ctx.tokens.tokens.user}` }],
    ];
    for (const [method, url, extra] of probes) {
      const res = await ctx.app.inject({ method: method as 'GET', url, headers: { ...hdr, ...(extra ?? {}) }, payload: method === 'PATCH' || method === 'DELETE' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // the percent-encoded vault path itself is a vault route
    expect((await call('obsidian', 'GET', '/api/%76ault/ping')).statusCode).toBe(200);
    // and nothing it tried wrote anything
    expect((await api<ProjectBundleDTO>('GET', `/api/projects/${b.project.id}`)).project.name).toBe('Lite-On Technology');
  });

  it('answers a repeated query parameter with 400, not 500', async () => {
    const b = await newProject();
    for (const q of [`ids=${b.project.id}&ids=index-ai`, 'after=1&after=2', 'limit=1&limit=2', `ids=${b.project.id}&after=0`]) {
      const res = await call('obsidian', 'GET', `/api/vault/notes?${q}`);
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('shows the vault that reported last, even within the same millisecond', async () => {
    const { saveStatus, parseReport, vaultStatus } = await import('./vault/status');
    const now = '2026-10-31T00:00:00.000Z';
    // 投資筆記 sorts before 第二個 and before Zeta; the order of the reports decides
    for (const order of [
      ['投資筆記', '第二個'],
      ['第二個', '投資筆記'],
      ['Zeta', 'Alpha', 'Zeta'],
    ]) {
      ctx.db.prepare('DELETE FROM vault_clients').run();
      for (const v of order) saveStatus(ctx.db, parseReport(report({ vaultName: v })), now);
      expect(vaultStatus(ctx.db, Date.parse(now))!.vaultName, order.join(' → ')).toBe(order.at(-1));
    }
  });

  it('takes nothing from a rolled-back dry run: the change queue continues without a gap', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const bars = (await api<{ bars: { date: string; close: number }[] }>('GET', `/api/securities/${b.securities[0].id}/bars`)).bars;
    const bar = bars.find((x) => x.date === '2026-09-15')!;
    const seq0 = lastSeq();
    const dry = await as<{ status: string }>('claude-desktop', 'POST', `/api/projects/${pid}/trades`, {
      side: 'long',
      entryDate: bar.date,
      entryPrice: bar.close,
      quantityShares: 1000,
      source: 'import',
      sourceText: '2026/9/15 買進一張 光寶科',
      dryRun: true,
    });
    expect(dry.status).toBe('would-create');
    expect(lastSeq()).toBe(seq0);
    const seqRow = () => (ctx.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'vault_changes'").get() as { seq: number }).seq;
    expect(seqRow()).toBe(seq0);
    await newTrade(pid);
    expect((ctx.db.prepare('SELECT MIN(seq) AS m FROM vault_changes WHERE seq > ?').get(seq0) as { m: number }).m).toBe(seq0 + 1);
  });

  it('stores only vault paths as duplicate paths of a reflection', async () => {
    const b = await newProject();
    const pid = b.project.id;
    await obs('POST', '/api/vault/reflections', {
      items: [{ wbId: pid, text: '想法', path: 'a.md', mtime: 0, duplicatePaths: ['b.md', '/etc/passwd', '../x.md', 'x'.repeat(5000), 42] }],
    });
    const row = ctx.db.prepare("SELECT after_json FROM audit_log WHERE entity = 'reflection'").get() as { after_json: string };
    expect(JSON.parse(row.after_json).duplicatePaths).toEqual(['b.md']);
  });

  it('refuses a reflection id that only looks like a note of another kind', async () => {
    const b = await newProject();
    const t = await newTrade(b.project.id);
    // a trade id sent as a company, a project id with a trade prefix: unknown notes
    const res = await obs<{ results: { status: string }[] }>('POST', '/api/vault/reflections', {
      items: [
        { wbId: t.id.replace(/^trd_/, 'prj_'), text: 'x', path: 'a.md', mtime: 0 },
        { wbId: b.project.id.replace(/^prj_/, 'trd_'), text: 'x', path: 'a.md', mtime: 0 },
        { wbId: b.project.id.replace(/^prj_/, 'rev_'), text: 'x', path: 'a.md', mtime: 0 },
      ],
    });
    expect(res.results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM reflection_versions').get()).toEqual({ n: 0 });
  });
});
