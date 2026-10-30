import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setValue } from '../domain/model/ops';
import { SCALAR_KEY, type ModelState } from '../domain/model/types';
import { fill, idByName } from '../domain/testing/sample';
import type { TokenName } from '../shared/actors';
import type {
  AiSessionDTO,
  AuditEntryDTO,
  BarsResponse,
  CommitPreviewDTO,
  DiagnosticsDTO,
  DraftMetaDTO,
  DraftOpRowDTO,
  DraftOpsResponse,
  DraftPendingDTO,
  EvidenceDTO,
  ProjectBundleDTO,
  RevisionFull,
  RevisionMeta,
  SeriesPoint,
  SessionDTO,
  TradeCloseResponse,
  TradeDTO,
  TradeRecordResponse,
} from '../shared/api';
import { buildApp, type AppContext } from './app';
import { DemoProvider } from './market/demo';
import { listAiSessions, recordAiActions, saveSessionSummary } from './repos/aiSessions';
import { rotateDbGeneration } from './repos/meta';
import { journalRef, normalizeSourceText } from './services/agentRecords';
import { CommitPreviewStore } from './services/commitPreviews';
import { localToday } from './util';

let ctx: AppContext;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agent-'));
  ctx = await buildApp({ dataDir: dir, providers: [new DemoProvider(() => '2026-09-25')] });
});
afterEach(async () => {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ErrorBody = { error: string; code: string | null; details: Record<string, unknown> | null };

/** Any request; `who` null sends no credentials. */
async function call(who: TokenName | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method, url, payload: payload as object | undefined, headers: { ...(who ? { authorization: `Bearer ${ctx.tokens.tokens[who]}` } : {}), ...headers } });
  return { status: res.statusCode, body: res.body ? (res.json() as unknown) : null, headers: res.headers };
}

async function as<T>(who: TokenName, method: Method, url: string, payload?: unknown): Promise<T> {
  const r = await call(who, method, url, payload);
  if (r.status !== 200) throw new Error(`${who} ${method} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** Expect an error response; returns its body. */
async function fails(who: TokenName | null, method: Method, url: string, payload: unknown, status: number, code?: string): Promise<ErrorBody> {
  const r = await call(who, method, url, payload);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  const b = r.body as ErrorBody;
  if (code) expect(b.code).toBe(code);
  return b;
}

const user = <T>(method: Method, url: string, payload?: unknown) => as<T>('user', method, url, payload);
const claude = <T>(method: Method, url: string, payload?: unknown) => as<T>('claude-desktop', method, url, payload);

async function newProject(ticker = '2301'): Promise<ProjectBundleDTO> {
  const { id } = await user<{ id: string }>('POST', '/api/projects', {
    name: 'Lite-On Technology',
    year: 2026,
    security: { ticker, exchange: 'TWSE', apiSymbol: `${ticker}.TW`, currency: 'TWD', priceSource: 'demo' },
  });
  return bundle(id);
}

const bundle = (id: string) => user<ProjectBundleDTO>('GET', `/api/projects/${id}`);

function populate(s: ModelState): ModelState {
  s = fill(s, idByName(s, 'Business A'), { FY2024: 800, FY2025: 1000 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business A'), { FY2026: 0.2, FY2027: 0.2, FY2028: 0.35 });
  s = fill(s, idByName(s, 'Business B'), { FY2024: 500, FY2025: 550 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business B'), { FY2026: 0.05, FY2027: 0.05, FY2028: 0.05 });
  s = fill(s, idByName(s, 'Business C'), { FY2024: 100, FY2025: 120 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business C'), { FY2026: 0.5, FY2027: 0.5, FY2028: 0.5 });
  const same = (v: number) => ({ FY2024: v, FY2025: v, FY2026: v, FY2027: v, FY2028: v });
  s = fill(s, idByName(s, 'Gross Margin'), same(0.2));
  s = fill(s, idByName(s, 'Opex % of Revenue'), same(0.08));
  s = fill(s, idByName(s, 'Non-Operating Items'), same(20));
  s = fill(s, idByName(s, 'Tax Rate'), same(0.2));
  s = fill(s, idByName(s, 'Diluted Shares'), same(22));
  s = fill(s, idByName(s, 'Invested Capital'), same(600));
  s = setValue(s, idByName(s, 'Target P/E'), SCALAR_KEY, 'base', 25);
  return s;
}

/** A company with an initiation committed by the user on 2026-09-20. */
async function initiated() {
  const b = await newProject();
  const pid = b.project.id;
  const d = await user<{ version: number }>('PUT', `/api/projects/${pid}/draft`, { state: populate(b.draft.state), version: b.draft.version });
  await user<RevisionFull>('POST', `/api/projects/${pid}/revisions`, { title: 'Initiation', reason: 'Initial model', asOfDate: '2026-09-20', draftVersion: d.version });
  return bundle(pid);
}

const ops = (pid: string, body: unknown, who: TokenName = 'claude-desktop') => as<DraftOpsResponse>(who, 'POST', `/api/projects/${pid}/draft/ops`, body);
const opFails = (pid: string, ops: unknown[], version: number, code = 'OP_FAILED') => fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/ops`, { ops, expectedVersion: version }, code === 'VERSION_MISMATCH' ? 409 : 400, code);
const value = (s: ModelState, id: string, key: string) => s.nodes.find((n) => n.id === id)!.values[key];

// ---------------------------------------------------------------- identity

describe('who is acting', () => {
  it('refuses writes from an unidentified caller; the browser gets a cookie from /api/session', async () => {
    const payload = { name: 'X', security: { ticker: '1', priceSource: 'demo' } };
    const e = await fails(null, 'POST', '/api/projects', payload, 401, 'NO_ACTOR');
    expect(e.error).toMatch(/could not be identified/);
    await fails(null, 'POST', '/api/projects', payload, 401, 'NO_ACTOR');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/projects', payload, headers: { authorization: 'Bearer not-a-token' } })).statusCode).toBe(401);
    expect((await call(null, 'GET', '/api/projects')).status).toBe(200); // reads stay open

    // the browser: an HttpOnly, SameSite=Strict cookie with the user token
    const s = await call(null, 'GET', '/api/session', undefined, { 'sec-fetch-site': 'same-origin' });
    expect(s.status).toBe(200);
    const cookie = String(s.headers['set-cookie']);
    expect(cookie).toMatch(/^wb_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31536000$/);
    expect((s.body as SessionDTO).actor).toBe('user');
    const created = await ctx.app.inject({ method: 'POST', url: '/api/projects', payload, headers: { cookie: `other=1; ${cookie.split(';')[0]}` } });
    expect(created.statusCode).toBe(200);
    const { id } = created.json() as { id: string };
    expect((await user<AuditEntryDTO[]>('GET', `/api/projects/${id}/audit`))[0]).toMatchObject({ action: 'create', entity: 'project', actor: 'user' });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/projects', payload, headers: { cookie: `wb_session=${ctx.tokens.tokens['claude-desktop']}` } })).statusCode).toBe(401);

    // another site cannot get it, and a caller with a token never does
    const cross = await call(null, 'GET', '/api/session', undefined, { 'sec-fetch-site': 'cross-site' });
    expect(cross.status).toBe(403);
    expect(cross.headers['set-cookie']).toBeUndefined();
    const agent = await call('claude-desktop', 'GET', '/api/session');
    expect(agent.headers['set-cookie']).toBeUndefined();
    expect(agent.body).toMatchObject({ actor: 'agent:claude-desktop', dbGeneration: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect((await call('user', 'GET', '/api/session')).headers['set-cookie']).toBeUndefined();

    // tokens.json: one token per caller, readable only by this user
    const file = path.join(dir, 'tokens.json');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).tokens)).toEqual(['user', 'claude-desktop', 'claude-code', 'chatgpt']);
  });

  it('refuses an unidentified write whatever its path looks like', async () => {
    const b = await newProject();
    const t = await user<TradeDTO>('POST', `/api/projects/${b.project.id}/trades`, { side: 'long', entryDate: '2026-09-15', entryPrice: 100, quantity: 1000 });
    // /%61pi/ routes to /api/: the trade must not be deleted by a caller nobody is named for
    await fails(null, 'DELETE', `/%61pi/trades/${t.id}`, undefined, 401, 'NO_ACTOR');
    await fails(null, 'PATCH', `/%61pi/trades/${t.id}`, { notes: 'x' }, 401, 'NO_ACTOR');
    expect((await user<TradeDTO[]>('GET', `/api/projects/${b.project.id}/trades`)).map((x) => [x.id, x.notes])).toEqual([[t.id, '']]);
    expect((await user<AuditEntryDTO[]>('GET', `/api/projects/${b.project.id}/audit`)).every((a) => a.actor === 'user')).toBe(true);
  });

  it('records the author of every created record and audits creates', async () => {
    const b = await newProject();
    const pid = b.project.id;
    // an AI uploading a file (multipart: the actor survives body parsing)
    const boundary = '----wbagent';
    const part = (name: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${v}\r\n`;
    const upload = (fields: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${pid}/evidence`,
        payload: Buffer.concat([Buffer.from(fields), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nPNG\r\n--${boundary}--\r\n`)]),
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${ctx.tokens.tokens['claude-desktop']}` },
      });
    const noDate = await upload(part('title', 'Slide'));
    expect(noDate.statusCode).toBe(400);
    expect(noDate.json().code).toBe('PUBLISHED_AT_REQUIRED');
    const up = await upload(part('title', 'Slide') + part('publishedAt', '2026-09-01'));
    expect(up.json()).toMatchObject({ createdBy: 'agent:claude-desktop', publishedAtSource: 'agent-asserted' });

    await fails('claude-desktop', 'POST', `/api/projects/${pid}/evidence`, { title: 'Later', publishedAt: '2999-01-01' }, 400, 'FUTURE_DATE');
    expect(await user<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { title: 'Mine', publishedAt: '2026-09-02' })).toMatchObject({ createdBy: 'user', publishedAtSource: 'user' });
    const undated = await user<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { title: 'Undated' });
    expect(undated.publishedAtSource).toBeNull();
    // the AI giving a date to the user's evidence makes the date an AI assertion
    expect(await claude<EvidenceDTO>('PATCH', `/api/evidence/${undated.id}`, { publishedAt: '2026-09-03' })).toMatchObject({ publishedAtSource: 'agent-asserted', createdBy: 'user' });

    expect(await claude<{ createdBy: string }>('POST', `/api/projects/${pid}/notes`, { body: 'AI note' })).toMatchObject({ createdBy: 'agent:claude-desktop' });
    expect(await user<{ createdBy: string }>('POST', `/api/projects/${pid}/catalysts`, { title: 'Earnings' })).toMatchObject({ createdBy: 'user' });
    expect(await as<{ createdBy: string }>('chatgpt', 'POST', `/api/projects/${pid}/reviews`, { title: 'Review' })).toMatchObject({ createdBy: 'agent:chatgpt' });
    const audit = await user<AuditEntryDTO[]>('GET', `/api/projects/${pid}/audit`);
    const creates = audit.filter((a) => a.action === 'create').map((a) => `${a.entity}:${a.actor}`);
    expect(creates.sort()).toEqual(
      ['project:user', 'evidence:agent:claude-desktop', 'evidence:user', 'evidence:user', 'note:agent:claude-desktop', 'catalyst:user', 'review:agent:chatgpt'].sort(),
    );

    // an AI creates a company only with the user's consent, and never a second one for the same security
    const company = { name: 'Delta', security: { ticker: '2308', currency: 'TWD', priceSource: 'demo' } };
    await fails('claude-desktop', 'POST', '/api/projects', company, 400, 'CONFIRM_REQUIRED');
    const dup = await fails('claude-desktop', 'POST', '/api/projects', { ...company, confirmedByUser: true, security: { ticker: '2301.TW', priceSource: 'demo' } }, 409, 'SECURITY_EXISTS');
    expect((dup.details!.matches as { projectId: string }[])[0].projectId).toBe(pid);
    const { id } = await claude<{ id: string }>('POST', '/api/projects', { ...company, confirmedByUser: true });
    expect((await bundle(id)).head.createdBy).toBe('agent:claude-desktop');
    expect((await user<{ projectId: string }[]>('GET', '/api/securities/lookup?ticker=2301')).map((m) => m.projectId)).toEqual([pid]);
  });
});

// ---------------------------------------------------------------- draft history

describe('draft history', () => {
  it('logs browser saves, discards and restores, and recovers a discarded draft', async () => {
    const b = await initiated();
    const pid = b.project.id;
    const gm = idByName(b.draft.state, 'Gross Margin');
    const s1 = setValue(b.draft.state, gm, 'FY2026', 'base', 0.25);
    const d1 = await user<{ version: number }>('PUT', `/api/projects/${pid}/draft`, { state: s1, version: b.draft.version });
    const s2 = setValue(s1, gm, 'FY2027', 'base', 0.26);
    const d2 = await user<{ version: number }>('PUT', `/api/projects/${pid}/draft`, { state: s2, version: d1.version });
    // an autosave burst is one row; a save that changes nothing writes none
    await user('PUT', `/api/projects/${pid}/draft`, { state: s2, version: d2.version });
    let rows = await user<DraftOpRowDTO[]>('GET', `/api/projects/${pid}/draft/ops`);
    const saves = rows.filter((r) => r.kind === 'save' && r.baseRevisionId === b.head.id);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ actor: 'user', changeCount: 2, versionAfter: d2.version, hasBefore: true });

    let meta = await user<DraftMetaDTO>('GET', `/api/projects/${pid}/draft/meta`);
    expect(meta).toMatchObject({ version: d2.version + 1, baseRevisionId: b.head.id, headSeq: 2, lastOp: { actor: 'user', kind: 'save', changeCount: 2 } });
    const seq0 = meta.auditSeq;
    await user('POST', `/api/projects/${pid}/notes`, { body: 'n' });
    meta = await user<DraftMetaDTO>('GET', `/api/projects/${pid}/draft/meta`);
    expect(meta.auditSeq).toBeGreaterThan(seq0); // records changed

    const discarded = await user<{ state: ModelState; version: number }>('POST', `/api/projects/${pid}/draft/discard`, { version: meta.version });
    expect(discarded.state).toEqual(b.head.state);
    rows = await user<DraftOpRowDTO[]>('GET', `/api/projects/${pid}/draft/ops`);
    expect(rows[0]).toMatchObject({ kind: 'discard', actor: 'user', changeCount: 2, hasBefore: true });
    const recovered = await user<{ state: ModelState; version: number }>('POST', `/api/projects/${pid}/draft/recover`, { opId: rows[0].id, version: discarded.version });
    expect(value(recovered.state, gm, 'FY2027')).toBe(0.26);
    expect((await user<DraftOpRowDTO[]>('GET', `/api/projects/${pid}/draft/ops?limit=1`))[0]).toMatchObject({ kind: 'recover', changeCount: 2 });
    await fails('user', 'POST', `/api/projects/${pid}/draft/recover`, { opId: rows[0].id, version: discarded.version }, 409, 'VERSION');
    const restored = await user<{ version: number }>('POST', `/api/projects/${pid}/draft/restore`, { revisionId: b.head.id, version: recovered.version });
    expect((await user<DraftOpRowDTO[]>('GET', `/api/projects/${pid}/draft/ops?limit=1`))[0].kind).toBe('restore');

    // a tab opened before the data was replaced cannot save over it
    rotateDbGeneration(ctx.db);
    await fails('user', 'PUT', `/api/projects/${pid}/draft`, { state: s1, version: restored.version, dbGeneration: meta.dbGeneration }, 409, 'DB_GENERATION');
  });

  it('attributes pending changes and keeps an AI away from the user’s uncommitted edits', async () => {
    const b = await initiated();
    const pid = b.project.id;
    const gm = idByName(b.draft.state, 'Gross Margin');
    const r = await ops(pid, { ops: [{ op: 'set_value', node: 'Tax Rate', period: '2026', value: '21%' }], expectedVersion: b.draft.version });
    const after = await bundle(pid);
    await user('PUT', `/api/projects/${pid}/draft`, { state: setValue(after.draft.state, gm, 'FY2026', 'base', 0.3), version: r.version });
    const pending = await user<DraftPendingDTO>('GET', `/api/projects/${pid}/draft/pending`);
    expect(pending.counts).toEqual({ 'agent:claude-desktop': 1, user: 1 });
    expect(pending.changes.find((c) => c.actor === 'user')!.text).toMatch(/Gross Margin 2026E：20\.0% → 30\.0%/);

    // an AI may not save whole drafts, nor throw away or replace the user's edits
    await fails('claude-desktop', 'PUT', `/api/projects/${pid}/draft`, { state: after.draft.state, version: r.version + 1 }, 403, 'USE_DRAFT_OPS');
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/discard`, {}, 400, 'EXPECTED_VERSION_REQUIRED');
    const blocked = await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/discard`, { version: r.version + 1 }, 409, 'USER_CHANGES');
    expect(blocked.details!.changes).toHaveLength(1);
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/restore`, { revisionId: b.head.id, version: r.version + 1 }, 409, 'USER_CHANGES');
  });
});

describe('recovering a draft', () => {
  it('lets an AI bring back its own edits but not the user’s discarded ones under its name', async () => {
    const b = await initiated();
    const pid = b.project.id;
    const tax = idByName(b.draft.state, 'Tax Rate');
    const d1 = await user<{ version: number }>('PUT', `/api/projects/${pid}/draft`, { state: setValue(b.draft.state, tax, 'FY2026', 'base', 0.21), version: b.draft.version });
    const gone = await user<{ version: number }>('POST', `/api/projects/${pid}/draft/discard`, { version: d1.version });
    const [userDiscard] = await user<DraftOpRowDTO[]>('GET', `/api/projects/${pid}/draft/ops`);
    const refused = await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/recover`, { opId: userDiscard.id, version: gone.version }, 409, 'USER_CHANGES');
    expect(refused.details!.changes).toEqual(['Tax Rate 2026E：20.0% → 21.0%']);
    expect((await bundle(pid)).draft.version).toBe(gone.version); // nothing written
    const p = await claude<CommitPreviewDTO>('POST', `/api/projects/${pid}/revisions/preview`, {});
    expect(p.changeCount).toBe(0);

    // its own discarded edit comes back, and stays its own
    const r = await ops(pid, { expectedVersion: gone.version, ops: [{ op: 'set_value', node: 'Gross Margin', period: '2027', value: '22%' }] });
    const mine = await claude<{ version: number }>('POST', `/api/projects/${pid}/draft/discard`, { version: r.version });
    const [agentDiscard] = await user<DraftOpRowDTO[]>('GET', `/api/projects/${pid}/draft/ops`);
    await claude('POST', `/api/projects/${pid}/draft/recover`, { opId: agentDiscard.id, version: mine.version });
    expect((await user<DraftPendingDTO>('GET', `/api/projects/${pid}/draft/pending`)).counts).toEqual({ 'agent:claude-desktop': 1 });
    // the user may recover their own discard
    const now = await bundle(pid);
    await user('POST', `/api/projects/${pid}/draft/recover`, { opId: userDiscard.id, version: now.draft.version });
    expect(value((await bundle(pid)).draft.state, tax, 'FY2026')).toBe(0.21);
  });
});

// ---------------------------------------------------------------- draft ops

describe('AI draft operations', () => {
  it('needs the version it read, writes nothing on a dry run, and logs who wrote', async () => {
    const b = await initiated();
    const pid = b.project.id;
    const gm = idByName(b.draft.state, 'Gross Margin');
    const req = { ops: [{ op: 'set_value', node: 'Gross Margin', period: '2028E', value: '33%' }], rationale: 'Q3 guidance' };
    const dry = await ops(pid, { ...req, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, version: b.draft.version, previewHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(dry.results[0].cells).toEqual([{ period: '2028E', scenario: 'base', before: '20.0%', after: '33.0%', beforeRaw: 0.2, afterRaw: 0.33 }]);
    expect(dry.results[0].node!.path).toBe('EPS › Gross Margin');
    expect(dry.results[0].description).toEqual(['Gross Margin 2028E：20.0% → 33.0%']);
    expect(dry.keyOutputs.after.eps.base!).toBeGreaterThan(dry.keyOutputs.before.eps.base!);
    expect(dry.keyOutputs.basisPeriodId).toBe('FY2028');
    expect(dry.url).toBe(`/#/p/${pid}/model`);
    expect(value((await bundle(pid)).draft.state, gm, 'FY2028')).toBe(0.2);
    expect((await user<DraftOpRowDTO[]>('GET', `/api/projects/${pid}/draft/ops`)).filter((r) => r.kind === 'ops')).toEqual([]);

    await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/ops`, req, 400, 'EXPECTED_VERSION_REQUIRED');
    const stale = await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/ops`, { ...req, expectedVersion: b.draft.version - 1 }, 409, 'VERSION_MISMATCH');
    expect(stale.details).toMatchObject({ currentVersion: b.draft.version });
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/ops`, { ops: [{ op: 'set_value', node: 'Gross Margin', period: '2028E', value: '34%' }], expectedVersion: b.draft.version, previewHash: dry.previewHash }, 400, 'PREVIEW_MISMATCH');
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/ops`, { ops: [{ op: 'nope' }] }, 400, 'INVALID_OPS');

    const done = await ops(pid, { ...req, expectedVersion: dry.version, previewHash: dry.previewHash });
    expect(done).toMatchObject({ dryRun: false, version: b.draft.version + 1, draftOpId: expect.any(Number) });
    expect(value((await bundle(pid)).draft.state, gm, 'FY2028')).toBe(0.33);
    const [row] = await user<DraftOpRowDTO[]>('GET', `/api/projects/${pid}/draft/ops`);
    expect(row).toMatchObject({ id: done.draftOpId, kind: 'ops', actor: 'agent:claude-desktop', summary: 'Q3 guidance', changeCount: 1, hasBefore: true });
    expect((await user<DraftMetaDTO>('GET', `/api/projects/${pid}/draft/meta`)).lastOp).toMatchObject({ actor: 'agent:claude-desktop', kind: 'ops' });
    const stale2 = await fails('claude-desktop', 'POST', `/api/projects/${pid}/draft/ops`, { ...req, expectedVersion: b.draft.version }, 409, 'VERSION_MISMATCH');
    expect(stale2.details!.since).toEqual([expect.objectContaining({ actor: 'agent:claude-desktop', kind: 'ops' })]);

    // the user's own calls (e2e, scripts) may skip the version
    expect((await ops(pid, { ops: [{ op: 'set_value', node: 'Tax Rate', period: '2026', value: '20%' }] }, 'user')).dryRun).toBe(false);
  });

  it('insists on explicit units and converts them to the node’s scale', async () => {
    const b = await initiated();
    const pid = b.project.id;
    const v = b.draft.state;
    const pct = await opFails(pid, [{ op: 'set_value', node: 'Gross Margin', period: '2026', value: 0.4 }], b.draft.version);
    expect(pct.error).toMatch(/百分比.*18\.5%/);
    expect(pct.details).toMatchObject({ opIndex: 0, code: 'OP_FAILED' });
    expect((await opFails(pid, [{ op: 'set_value', node: 'Non-Operating Items', period: '2026', value: '2345' }], b.draft.version)).error).toMatch(/單位/);
    expect((await opFails(pid, [{ op: 'set_value', node: 'Non-Operating Items', period: '2026', value: 'US$5 億' }], b.draft.version)).error).toMatch(/幣別/);
    expect((await opFails(pid, [{ op: 'set_value', node: 'Target P/E', value: '25' }], b.draft.version)).error).toMatch(/倍數/);
    expect((await opFails(pid, [{ op: 'set_value', node: 'Diluted Shares', period: '2026', value: '22' }], b.draft.version)).error).toMatch(/股數/);
    expect((await opFails(pid, [{ op: 'set_value', node: 'Target P/E', period: '2026', value: '25x' }], b.draft.version)).error).toMatch(/單一數值/);
    expect((await opFails(pid, [{ op: 'set_value', node: 'Gross Margin', value: '25%' }], b.draft.version)).error).toMatch(/period/);

    const r = await ops(pid, {
      expectedVersion: b.draft.version,
      ops: [
        { op: 'set_value', node: 'Non-Operating Items', period: 'FY2026', value: '2,345 百萬' },
        { op: 'set_values', node: 'Diluted Shares', values: { '2026': '22.5 億股', '2027': '2,300,000,000 股', '2028': '230 萬張' } },
        { op: 'set_value', node: 'Target P/E', value: '28 倍' },
        { op: 'set_value', node: 'Target P/E', scenario: 'bull', value: '35x' },
        { op: 'add_node', parent: null, name: 'DPS', unit: { kind: 'per_share' } },
        { op: 'set_value', node: 'DPS', period: '2026', value: '3.5 元' },
        { op: 'set_value', node: 'Invested Capital', period: '2026', value: 'NT$61,000,000,000' },
        { op: 'add_peer', name: 'Delta', pe: '30x', roic: '18%' },
      ],
    });
    const s = (await bundle(pid)).draft.state;
    expect(value(s, idByName(v, 'Non-Operating Items'), 'FY2026')).toBe(23.45);
    expect(r.results[0].cells![0]).toMatchObject({ after: '23.45 TWD 億', note: '輸入「2,345 百萬」→ 存為 23.45（TWD 億）' });
    const shares = idByName(v, 'Diluted Shares');
    expect([value(s, shares, 'FY2026'), value(s, shares, 'FY2027'), value(s, shares, 'FY2028')]).toEqual([22.5, 23, 23]);
    const pe = s.nodes.find((n) => n.name === 'Target P/E')!;
    expect(pe.values[SCALAR_KEY]).toBe(28);
    expect(pe.overrides.bull![SCALAR_KEY]).toBe(35);
    const dps = s.nodes.find((n) => n.name === 'DPS')!;
    expect(r.results[4].createdId).toBe(dps.id);
    expect(dps).toMatchObject({ unit: { kind: 'per_share', currency: 'TWD', scale: 1 }, values: { FY2026: 3.5 } });
    expect(value(s, idByName(v, 'Invested Capital'), 'FY2026')).toBe(610);
    expect(s.valuation.peers[0]).toMatchObject({ name: 'Delta', pe: 30, roic: 0.18 });
    expect(r.issues.every((i) => typeof i.isNew === 'boolean')).toBe(true);

    // a 20× jump is written but flagged
    const jump = await ops(pid, { expectedVersion: r.version, dryRun: true, ops: [{ op: 'set_value', node: 'Non-Operating Items', period: '2027', value: '2,000 億' }] });
    expect(jump.warnings.join()).toMatch(/20 倍/);
  });

  it('protects actual periods and formulas, and resolves names, paths and ids', async () => {
    const b = await initiated();
    const pid = b.project.id;
    const ver = b.draft.version;
    const actual = await opFails(pid, [{ op: 'set_value', node: 'Gross Margin', period: '2024', scenario: 'bear', value: '18%' }], ver);
    expect(actual.error).toMatch(/2024A 是實際期.*scenario=base/);
    const ambiguous = await opFails(pid, [{ op: 'set_value', node: 'YoY Growth', period: '2026', value: '10%' }], ver);
    expect(ambiguous.details!.candidates).toEqual(['EPS › Revenue › Business A › YoY Growth', 'EPS › Revenue › Business B › YoY Growth', 'EPS › Revenue › Business C › YoY Growth']);
    const unknown = await opFails(pid, [{ op: 'set_value', node: 'Gross Marg', period: '2026', value: '10%' }], ver);
    expect(unknown.details!.candidates).toEqual(['EPS › Gross Margin']);
    const formula = await opFails(pid, [{ op: 'set_value', node: 'Business A', period: '2026', value: '1,200 億' }], ver);
    expect(formula.error).toMatch(/由公式計算.*allow_override_formula/);
    expect((await opFails(pid, [{ op: 'set_formula', node: 'Gross Margin', formula: '[Gross Profit] / [Revenue]' }], ver)).error).toMatch(/循環參照：Gross Profit → Gross Margin → Gross Profit，請用 PREV\(\)/);
    expect((await opFails(pid, [{ op: 'set_formula', node: 'Gross Margin', formula: '[Nothing] * 2' }], ver)).error).toMatch(/公式錯誤/);
    expect((await opFails(pid, [{ op: 'set_value', node: 'EPS', period: '2026', value: '1 元' }], ver)).error).toMatch(/由公式計算/);
    expect((await opFails(pid, [{ op: 'set_value', node: 'P/E', period: '2026', value: '1' }], ver)).error).toMatch(/標題列/);
    expect((await opFails(pid, [{ op: 'link_evidence', node: 'Gross Margin', evidence_id: 'ev_nope' }], ver, 'EVIDENCE_NOT_FOUND')).error).toMatch(/ev_nope/);

    const growthA = idByName(b.draft.state, 'YoY Growth', 'Business A');
    const ev = await user<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { title: 'Call', publishedAt: '2026-09-21' });
    const r = await ops(pid, {
      expectedVersion: ver,
      ops: [
        { op: 'set_value', node: 'Business A/YoY Growth', period: '2026', value: '25%' },
        { op: 'set_value', node: 'Business B › YoY Growth', period: '2026', scenario: 'bear', value: '1%' },
        { op: 'set_value', node: growthA, period: 'FY2027', scenario: 'bull', value: '40%' },
        { op: 'set_value', node: 'Business A', period: '2026', value: '1,200 億', allow_override_formula: true },
        { op: 'set_value', node: 'Gross Margin', period: '2024', value: '19%' },
        { op: 'link_evidence', node: 'Business A/YoY Growth', evidence_id: ev.id, locator: 'p.3' },
        { op: 'add_thesis', statement: 'Margins expand', nodes: ['Gross Margin'] },
        { op: 'set_rationale', scenario: 'base', text: 'Peers trade at 25x' },
        { op: 'delete_node', node: 'Opex % of Revenue' },
      ],
    });
    const s = (await bundle(pid)).draft.state;
    expect(value(s, growthA, 'FY2026')).toBe(0.25);
    expect(s.nodes.find((n) => n.id === growthA)!.overrides.bull!.FY2027).toBe(0.4);
    expect(s.links).toEqual([expect.objectContaining({ evidenceId: ev.id, nodeId: growthA, relation: 'supports', locator: 'p.3' })]);
    expect(s.theses[0]).toMatchObject({ statement: 'Margins expand', nodeIds: [idByName(s, 'Gross Margin')], status: 'active' });
    expect(r.results[6].createdId).toBe(s.theses[0].id);
    expect(s.valuation.rationale.base).toBe('Peers trade at 25x');
    expect(r.results[8].warnings.join()).toMatch(/1 個公式參照了被刪的節點：Operating Expenses/);
    expect(r.issues.some((i) => i.isNew && i.nodeName === 'Operating Expenses')).toBe(true);
    const upd = await ops(pid, { expectedVersion: r.version, ops: [{ op: 'update_thesis', thesis_id: s.theses[0].id, status: 'confirmed', review_by: '2027-01-31' }] });
    expect((await bundle(pid)).draft.state.theses[0]).toMatchObject({ status: 'confirmed', reviewBy: '2027-01-31' });
    expect(upd.version).toBe(r.version + 1);
  });
});

// ---------------------------------------------------------------- commits

describe('commits by an AI', () => {
  it('previews, then commits only what was previewed, with confirmation for large moves', async () => {
    const b = await initiated();
    const pid = b.project.id;
    const today = localToday();
    const ev = await user<EvidenceDTO>('POST', `/api/projects/${pid}/evidence`, { title: 'Q3 call', publishedAt: '2026-09-21' });

    // knowledge-date rules for an AI
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/revisions/preview`, { asOfDate: '2999-01-01' }, 400, 'FUTURE_DATE');
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/revisions/preview`, { kind: 'restore' }, 400, 'KIND_NOT_ALLOWED');
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/revisions/preview`, { asOfDate: '2026-09-22' }, 400, 'BACKDATED_NEEDS_EVIDENCE');
    const backdated = await claude<CommitPreviewDTO>('POST', `/api/projects/${pid}/revisions/preview`, { asOfDate: '2026-09-22', evidenceIds: [ev.id] });
    expect(backdated).toMatchObject({ kind: 'checkpoint', changeCount: 0, needsConfirmation: false, blocked: null, citedEvidence: [{ id: ev.id, publishedAt: '2026-09-21' }] });
    expect(backdated.market).toMatchObject({ basis: 'bar', provider: 'demo' });
    expect(backdated.market!.asOf.slice(0, 10) <= '2026-09-22').toBe(true);

    await user('GET', `/api/securities/${b.securities[0].id}/quote`); // today's commit records the latest quote
    // target P/E 25 → 40 moves the target price by 60%
    await ops(pid, { expectedVersion: b.draft.version, ops: [{ op: 'set_value', node: 'Target P/E', value: '40x' }] });
    const p = await claude<CommitPreviewDTO>('POST', `/api/projects/${pid}/revisions/preview`, {});
    expect(p).toMatchObject({ asOfDate: today, today, kind: 'update', changeCount: 1, needsConfirmation: true, blocked: null, userChanges: [], previewId: expect.stringMatching(/^cpv_/) });
    expect(p.changes).toEqual([{ text: 'Target P/E 數值：25.0x → 40.0x', actor: 'agent:claude-desktop' }]);
    expect(p.largeMoves.map((m) => m.kind)).toEqual(['target_price', 'target_price', 'target_price']);
    expect(p.largeMoves[1].text).toMatch(/目標價（基準）.*\+60\.0%/);
    expect(await claude('GET', `/api/commit-previews/${p.previewId}`)).toEqual({ projectId: pid, expiresAt: p.expiresAt, needsConfirmation: true });
    await fails('user', 'GET', `/api/commit-previews/${p.previewId}`, undefined, 403, 'AGENT_ONLY');

    const commitReq = { title: 'Re-rating', reason: 'Peers re-rated' };
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/revisions`, { ...commitReq, asOfDate: today, draftVersion: p.draftVersion }, 400, 'PREVIEW_REQUIRED');
    const ask = await fails('claude-desktop', 'POST', `/api/projects/${pid}/revisions`, { ...commitReq, previewId: p.previewId }, 409, 'NEEDS_CONFIRMATION');
    expect(ask.details!.largeMoves).toHaveLength(3);
    await fails('claude-code', 'POST', `/api/projects/${pid}/revisions`, { ...commitReq, previewId: p.previewId, confirmedByUser: true }, 403, 'PREVIEW_OTHER_CLIENT');
    const rev = await claude<RevisionFull>('POST', `/api/projects/${pid}/revisions`, { ...commitReq, previewId: p.previewId, confirmedByUser: true });
    expect(rev).toMatchObject({ seq: 3, kind: 'update', asOfDate: today, createdBy: 'agent:claude-desktop', contributors: [{ actor: 'agent:claude-desktop', changes: 1 }] });
    expect(rev.market).toMatchObject({ basis: 'quote', provider: 'demo' });
    await fails('claude-desktop', 'POST', `/api/projects/${pid}/revisions`, { ...commitReq, previewId: p.previewId, confirmedByUser: true }, 409, 'PREVIEW_EXPIRED');
    const audit = await user<AuditEntryDTO[]>('GET', `/api/projects/${pid}/audit?entityId=${rev.id}`);
    expect(audit[0]).toMatchObject({ action: 'commit', actor: 'agent:claude-desktop' });
    // the user's own commit records them as its author
    expect((await user<RevisionMeta[]>('GET', `/api/projects/${pid}/revisions`)).map((r) => r.createdBy)).toEqual(['user', 'user', 'agent:claude-desktop']);
  });

  it('refuses to commit the user’s uncommitted edits', async () => {
    const b = await initiated();
    const pid = b.project.id;
    await user('PUT', `/api/projects/${pid}/draft`, { state: setValue(b.draft.state, idByName(b.draft.state, 'Tax Rate'), 'FY2026', 'base', 0.21), version: b.draft.version });
    const p = await claude<CommitPreviewDTO>('POST', `/api/projects/${pid}/revisions/preview`, {});
    expect(p.previewId).toBeNull();
    expect(p.blocked).toMatch(/使用者還沒提交/);
    expect(p.userChanges).toEqual(['Tax Rate 2026E：20.0% → 21.0%']);
    // the user may still preview (no id: the browser commits directly)
    expect((await user<CommitPreviewDTO>('POST', `/api/projects/${pid}/revisions/preview`, {})).userChanges).toEqual([]);
  });

  it('drops previews after 15 minutes', () => {
    let now = 1_000_000;
    const store = new CommitPreviewStore(15 * 60_000, 2, () => now);
    const base = { projectId: 'p', client: 'claude-desktop' as const, draftVersion: 1, baseRevisionId: 'r', dbGeneration: 'g', asOfDate: '2026-10-01', kind: 'update' as const, evidenceIds: [], needsConfirmation: false };
    const a = store.put(base);
    now += 14 * 60_000;
    expect(store.get(a.id)).not.toBeNull();
    now += 2 * 60_000;
    expect(store.get(a.id)).toBeNull();
    const ids = [store.put(base).id, store.put(base).id, store.put(base).id];
    expect(ids.map((id) => store.get(id) !== null)).toEqual([false, true, true]); // at most `max` kept
  });

  it('marks a Research Update wrong without changing it', async () => {
    const b = await initiated();
    const pid = b.project.id;
    const rid = b.head.id;
    await fails('user', 'POST', `/api/projects/${pid}/revisions/${rid}/annotations`, { kind: 'deleted' }, 400);
    const a = await user<{ kind: string; actor: string }>('POST', `/api/projects/${pid}/revisions/${rid}/annotations`, { kind: 'excluded', note: 'Units were wrong' });
    expect(a).toMatchObject({ kind: 'excluded', actor: 'user', note: 'Units were wrong' });
    const eps = b.draft.state.nodes.find((n) => n.role === 'eps')!.id;
    const series = () => user<SeriesPoint[]>('GET', `/api/projects/${pid}/series?nodeIds=${eps}`);
    expect((await series()).map((p) => p.excluded)).toEqual([false, true]);
    expect((await bundle(pid)).head.excludedFromCalibration).toBe(true);
    await claude('POST', `/api/projects/${pid}/revisions/${rid}/annotations`, { kind: 'included' });
    expect((await series()).map((p) => p.excluded)).toEqual([false, false]);
    expect((await user<{ kind: string; actor: string }[]>('GET', `/api/projects/${pid}/revision-annotations`)).map((x) => `${x.kind}:${x.actor}`)).toEqual(['excluded:user', 'included:agent:claude-desktop']);
    expect((await user<RevisionFull>('GET', `/api/projects/${pid}/revisions/${rid}`)).title).toBe('Initiation');
  });
});

// ---------------------------------------------------------------- trades

describe('trades by an AI', () => {
  it('checks shares, dates and prices, and imports a journal excerpt once', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const bars = (await user<BarsResponse>('GET', `/api/securities/${b.securities[0].id}/bars`)).bars;
    const bar = bars.find((x) => x.date === '2026-09-15')!;
    const url = `/api/projects/${pid}/trades`;
    const trade = { side: 'long', entryDate: bar.date, entryPrice: bar.close, quantityShares: 2000 };

    await fails('claude-desktop', 'POST', url, { ...trade, quantity: 2 }, 400, 'QUANTITY_SHARES_REQUIRED');
    await fails('claude-desktop', 'POST', url, { ...trade, entryDate: '2999-01-04' }, 400, 'FUTURE_DATE');
    await fails('claude-desktop', 'POST', url, { ...trade, entryPrice: -1 }, 400, 'INVALID_INPUT');
    const out = await fails('claude-desktop', 'POST', url, { ...trade, entryPrice: Math.round(bar.high * 1.1) }, 409, 'PRICE_OUT_OF_RANGE');
    expect(out.details).toMatchObject({ date: bar.date, low: bar.low, high: bar.high, provider: 'demo', which: 'entry' });
    const confirmed = await claude<TradeRecordResponse>('POST', url, { ...trade, entryPrice: Math.round(bar.high * 1.1), confirmPrice: true });
    expect(confirmed.status).toBe('created');
    const ok = await claude<TradeRecordResponse>('POST', url, { ...trade, quantityShares: 1500 });
    expect(ok.trade).toMatchObject({ quantity: 1500, createdBy: 'agent:claude-desktop', source: 'entry', externalRef: null });
    expect(ok.trade!.stopAtEntry).not.toBeNull(); // a live entry gets the usual defaults
    expect(ok.warnings.join()).toMatch(/1 張 = 1000 股；這筆是 1,500 股/);
    expect((await claude<TradeRecordResponse>('POST', url, { ...trade, entryDate: '2026-09-13' })).warnings.join()).toMatch(/沒有交易資料（休市？）/);

    // importing an old journal: only what it says, keyed by the excerpt
    await fails('claude-desktop', 'POST', url, { ...trade, source: 'import' }, 400, 'SOURCE_TEXT_REQUIRED');
    const text = '2026/9/15  買進 光寶科 2 張\r\n成本 ' + bar.close + '\t理由：突破';
    const imp = await claude<TradeRecordResponse>('POST', url, { ...trade, source: 'import', sourceText: text });
    expect(imp.status).toBe('created');
    expect(imp.trade).toMatchObject({ source: 'import', externalRef: journalRef(text), sourceText: `2026/9/15 買進 光寶科 2 張\n成本 ${bar.close} 理由：突破`, stopAtEntry: null, targetPriceAtEntry: null, atrAtEntry: null, atrMultiple: null });
    const again = await claude<TradeRecordResponse>('POST', url, { ...trade, source: 'import', sourceText: ` 2026/9/15 買進 光寶科 2 張\r成本 ${bar.close} 理由：突破 ` });
    expect(again).toMatchObject({ status: 'existing', trade: { id: imp.trade!.id } });
    // the same excerpt under another company is still the same trade
    const other = await claude<{ id: string }>('POST', '/api/projects', { name: 'Other', confirmedByUser: true, security: { ticker: '9999', priceSource: 'demo' } });
    expect((await claude<TradeRecordResponse>('POST', `/api/projects/${other.id}/trades`, { ...trade, source: 'import', sourceText: text, confirmPrice: true })).status).toBe('existing');

    await user('DELETE', `/api/trades/${imp.trade!.id}`);
    const gone = await fails('claude-desktop', 'POST', url, { ...trade, source: 'import', sourceText: text }, 409, 'IMPORT_DELETED');
    expect(gone.details).toMatchObject({ tradeId: imp.trade!.id, deletedAt: expect.any(String) });
    expect((await claude<TradeRecordResponse>('POST', url, { ...trade, source: 'import', sourceText: text, allowReimport: true })).status).toBe('created');

    // closing: only the exit, with the same price check
    const id = ok.trade!.id;
    await fails('claude-desktop', 'PATCH', `/api/trades/${id}`, { exitDate: '2026-09-24', exitPrice: 1, entryPrice: 1 }, 400, 'AGENT_FIELDS');
    const exitBar = bars.find((x) => x.date === '2026-09-24')!;
    await fails('claude-desktop', 'PATCH', `/api/trades/${id}`, { exitDate: exitBar.date, exitPrice: exitBar.low / 2 }, 409, 'PRICE_OUT_OF_RANGE');
    const closed = await claude<TradeCloseResponse>('PATCH', `/api/trades/${id}`, { exitDate: exitBar.date, exitPrice: exitBar.close, exitReason: 'Target' });
    expect(closed.trade).toMatchObject({ exitDate: exitBar.date, exitPrice: exitBar.close, exitReason: 'Target' });
    const log = await user<AuditEntryDTO[]>('GET', `/api/projects/${pid}/audit?entityId=${id}`);
    expect(log.map((l) => `${l.action}:${l.actor}`)).toEqual(['update:agent:claude-desktop', 'create:agent:claude-desktop']);
    expect((await user<TradeDTO[]>('GET', url)).length).toBe(4);
  });

  it('does not key a trade by a text too short to identify it', async () => {
    const b = await newProject();
    const pid = b.project.id;
    const bars = (await user<BarsResponse>('GET', `/api/securities/${b.securities[0].id}/bars`)).bars;
    const at = (date: string, q: number, sourceText: string) => ({ side: 'long', entryDate: date, entryPrice: bars.find((x) => x.date === date)!.close, quantityShares: q, sourceText });
    const a = await claude<TradeRecordResponse>('POST', `/api/projects/${pid}/trades`, at('2026-09-15', 1000, '買兩張'));
    const c = await claude<TradeRecordResponse>('POST', `/api/projects/${pid}/trades`, at('2026-09-16', 2000, ' 買兩張 '));
    expect([a.status, c.status]).toEqual(['created', 'created']);
    expect(c.trade!.id).not.toBe(a.trade!.id);
    expect([a.trade!.externalRef, a.trade!.sourceText]).toEqual([null, '買兩張']);
    expect((await claude<TradeRecordResponse>('POST', `/api/projects/${pid}/trades`, at('2026-09-17', 1000, ' \r\n '))).trade).toMatchObject({ sourceText: null, externalRef: null });
    expect((await user<TradeDTO[]>('GET', `/api/projects/${pid}/trades`)).length).toBe(3);
  });

  it('normalises journal excerpts the same way everywhere', () => {
    expect(normalizeSourceText('  a\t\tb  \r\nc\rd\n\n')).toBe('a b\nc\nd');
    expect(normalizeSourceText('Café')).toBe('Café');
    expect(journalRef('x  y\r\nz')).toBe(journalRef('x y\nz'));
    expect(journalRef('x  y\rz')).toBe(journalRef('x y\nz'));
    expect(journalRef('a')).toMatch(/^jrnl:[0-9a-f]{32}$/);
    expect(journalRef('a')).not.toBe(journalRef('b'));
  });
});

// ---------------------------------------------------------------- AI activity

describe('AI sessions and connection status', () => {
  it('groups a client’s writes until it is idle for 30 minutes', () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const action = (projectId: string | null, summary: string) => ({ at: t0.toISOString(), tool: 'edit_draft', kind: 'draft_ops' as const, projectId, ref: null, summary });
    ctx.db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'A', 'x', 'x'), ('p2', 'B', 'x', 'x')").run();
    const s1 = recordAiActions(ctx.db, 'claude-desktop', [action('p1', 'one')], at(0));
    expect(recordAiActions(ctx.db, 'claude-desktop', [action('p2', 'two')], at(29))).toBe(s1);
    expect(recordAiActions(ctx.db, 'chatgpt', [action('p1', 'other client')], at(30))).not.toBe(s1);
    const s2 = recordAiActions(ctx.db, 'claude-desktop', [action(null, 'three')], at(60));
    expect(s2).not.toBe(s1);
    const [latest, first] = listAiSessions(ctx.db, { client: 'claude-desktop' });
    expect(first).toMatchObject({ id: s1, projectIds: ['p1', 'p2'], startedAt: at(0).toISOString(), lastAt: at(29).toISOString() });
    expect(first.actions.map((a) => a.summary)).toEqual(['one', 'two']);
    expect(latest.id).toBe(s2);

    // a summary attaches to the latest session while it is open, else starts one
    saveSessionSummary(ctx.db, 'claude-desktop', { summary: '結論', todo: '看 Q4', projectIds: ['p1'] }, at(70));
    expect(listAiSessions(ctx.db, { client: 'claude-desktop' })[0]).toMatchObject({ id: s2, summary: '結論', todo: '看 Q4', decisions: null, projectIds: ['p1'] });
    const late = saveSessionSummary(ctx.db, 'claude-desktop', { summary: 'later' }, at(200));
    expect(late.id).not.toBe(s2);
    expect(late.actions).toEqual([]);
    expect(listAiSessions(ctx.db, { projectId: 'p2' }).map((s) => s.id)).toEqual([s1]);
  });

  it('records heartbeats and AI writes, not previews', async () => {
    await fails('user', 'POST', '/api/ai/heartbeat', {}, 403, 'AGENT_ONLY');
    const hb = await claude<{ ok: boolean; actor: string; today: string }>('POST', '/api/ai/heartbeat', { clientInfo: { name: 'vitest', version: '1.0' }, adapterVersion: 'abc' });
    expect(hb).toMatchObject({ ok: true, actor: 'agent:claude-desktop', today: localToday() });
    const diag = await user<DiagnosticsDTO>('GET', '/api/diagnostics');
    expect(diag.clients[0]).toMatchObject({ client: 'claude-desktop', clientName: 'vitest', clientVersion: '1.0', adapterVersion: 'abc', lastHeartbeatAt: expect.any(String), lastSeenAt: expect.any(String), lastWriteAt: null });
    expect(diag.clients[2]).toMatchObject({ client: 'chatgpt', lastSeenAt: null });

    const b = await initiated();
    const pid = b.project.id;
    await claude('POST', `/api/projects/${pid}/revisions/preview`, {});
    await ops(pid, { dryRun: true, ops: [{ op: 'set_value', node: 'Tax Rate', period: '2026', value: '21%' }] });
    expect(await user<AiSessionDTO[]>('GET', '/api/ai/sessions')).toEqual([]); // heartbeat, preview, dry run: nothing changed

    await ops(pid, { expectedVersion: b.draft.version, ops: [{ op: 'set_value', node: 'Tax Rate', period: '2026', value: '21%' }] }, 'claude-desktop');
    await claude('PATCH', `/api/projects/${pid}`, { description: 'Power supplies' });
    const summary = await claude<AiSessionDTO>('POST', '/api/ai/sessions/summary', { summary: '調高稅率假設', decisions: '稅率 21%', projectIds: [pid] });
    await fails('claude-desktop', 'POST', '/api/ai/sessions/summary', { summary: '' }, 400);
    const [s] = await user<AiSessionDTO[]>('GET', `/api/ai/sessions?projectId=${pid}`);
    expect(s).toMatchObject({ id: summary.id, client: 'claude-desktop', summary: '調高稅率假設', decisions: '稅率 21%', projectIds: [pid] });
    expect(s.actions.map((a) => a.kind)).toEqual(['draft_ops', 'other', 'summary']);
    expect(s.actions[0].summary).toMatch(/改了 1 項：Tax Rate 2026E：20\.0% → 21\.0%/);
    expect(s.actions[1].summary).toBe('PATCH /api/projects/:id');
    expect((await user<DiagnosticsDTO>('GET', '/api/diagnostics')).clients[0].lastWriteAt).toBe(s.lastAt);
  });
});
