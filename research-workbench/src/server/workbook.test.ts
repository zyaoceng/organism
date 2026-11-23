import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutputMapping } from '../domain/workbook/types';
import type { TokenName } from '../shared/actors';
import type { VaultDirDTO, WorkbookFilesDTO, WorkbookRecalcDTO, WorkbookViewDTO } from '../shared/api';
import { buildApp, type AppContext } from './app';
import { openDatabase } from './db/connection';
import { MIGRATIONS, SCHEMA_VERSION } from './db/migrations';
import { DemoProvider } from './market/demo';
import { BRCTL_PROGRAM, STAT_PROGRAM, defaultFileDeps, excelLockPath, inspectFile, legacyPlaceholderPath, listVaultXlsx, readWorkbookFile, resolveInVault, sha256Hex, type FileDeps } from './xlsx/file';
import { maskFormula } from './xlsx/view';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xlsx', 'fixtures');
const CRWD = 'CRWD_簡明損益表.xlsx';
const COMPANY = '03 個股研究/個股深度分析/CRWD';
const REL = `${COMPANY}/${CRWD}`;
const MODEL = '營收模型';

let ctx: AppContext;
let dir: string;
let vault: string;

const build = (over: Parameters<typeof buildApp>[0] | object = {}) =>
  buildApp({ dataDir: path.join(dir, 'data'), providers: [new DemoProvider(() => '2026-11-20')], market: { minIntervalMs: 0 }, vaultDir: vault, ...over });

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-xlsx-'));
  vault = path.join(dir, '股票');
  fs.mkdirSync(path.join(vault, COMPANY), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, CRWD), path.join(vault, REL));
  ctx = await build();
});
afterEach(async () => {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface Failure {
  error: string;
  code: string | null;
  details: Record<string, unknown> | null;
}

async function call(who: TokenName | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method, url, payload: payload as object | undefined, headers: { ...(who ? { authorization: `Bearer ${ctx.tokens.tokens[who]}` } : {}), ...headers } });
}
async function as<T>(who: TokenName | null, method: Method, url: string, payload?: unknown, expectStatus = 200): Promise<T> {
  const res = await call(who, method, url, payload);
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
const api = <T>(method: Method, url: string, payload?: unknown, expectStatus = 200) => as<T>('user', method, url, payload, expectStatus);

async function newProject(ticker = 'CRWD'): Promise<string> {
  return (await api<{ id: string }>('POST', '/api/projects', { name: 'CrowdStrike', year: 2026, security: { ticker, exchange: 'NASDAQ', apiSymbol: ticker, currency: 'USD', priceSource: 'demo' } })).id;
}
const link = (pid: string, rel = REL) => api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/link`, { path: rel });
const multipleOf = (v: WorkbookViewDTO) => v.assumptions.find((a) => a.origin === 'output')!;

describe('linking and reading the CRWD workbook', () => {
  it('shows nothing until a file is linked, then the file, the self-check and the results', async () => {
    const pid = await newProject();
    const before = await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`);
    expect(before).toMatchObject({ linked: false, file: null, loaded: false, assumptions: [], outputs: null, vault: { dir: vault, source: 'env', readable: true } });

    const v = await link(pid);
    const bytes = fs.readFileSync(path.join(vault, REL));
    expect(v.file).toEqual({ path: REL, name: CRWD, state: 'ok', reason: null, size: bytes.length, modifiedAt: expect.any(String), sha256: sha256Hex(bytes), excelOpen: false });
    expect(v.selfCheck).toMatchObject({ state: 'verified', formulaCells: 242, compared: 242, mismatchCount: 0 });

    const o = v.outputs!;
    expect(o.revenueQuarters.map((q) => q.period)).toEqual(['3Q27', '4Q27', '1Q28', '2Q28']);
    expect(o.revenueQuarters.map((q) => Math.round(q.value!))).toEqual([1556, 1663, 1768, 1873]);
    expect(o.revenueQuarters.map((q) => `${q.cell!.sheet}!${q.cell!.address}`)).toEqual(['B67', 'C67', 'D67', 'E67'].map((a) => `${MODEL}!${a}`));
    expect(o.revenueTotal).toMatchObject({ cell: { sheet: MODEL, address: 'F67' } });
    expect(o.revenueTotal.value).toBeCloseTo(6861.0, 1);
    expect(o.targetPrice.cell).toEqual({ sheet: MODEL, address: 'B86' });
    expect(o.targetPrice.value).toBeCloseTo(171.53, 2);
    expect(o.multiple.value).toBe(25);
    expect(o.shareCount.value).toBe(1030);
    expect(o.netCash.value).toBe(5150);
    expect(o.eps.map((e) => e.period)).toEqual(['3Q27', '4Q27', 'FY27', 'FY28']);
    expect(o.epsPeriod).toBe('FY27');
    // nothing is overridden: the trial value is the file's
    for (const x of [o.revenueTotal, o.targetPrice, ...o.eps]) expect(x.value).toBe(x.fileValue);
  });

  it('lists the assumptions with their range, basis, status and whether the value is a formula', async () => {
    const v = await link(await newProject());
    expect(v.assumptions).toHaveLength(27);
    expect(v.needsDecision).toBe(8);
    expect(v.assumptions.filter((a) => a.status === 'needs-decision')).toHaveLength(8);
    const units = v.assumptions.find((a) => a.label.includes('台數') && a.low === 0.12)!;
    expect(units).toMatchObject({ sheet: MODEL, value: 0.16, low: 0.12, high: 0.2, valueIsFormula: false, origin: 'table' });
    expect(units.basis).toEqual(expect.any(String));
    expect(units.cell).toMatch(/^B\d+$/);
    expect(units.id).toBe(`${MODEL}!${units.label}#1`);
    const multiple = multipleOf(v);
    expect(multiple).toMatchObject({ value: 25, low: null, high: null, status: null, valueIsFormula: false, cell: 'B82' });
    for (const a of v.assumptions) expect(typeof a.valueIsFormula).toBe('boolean');
  });

  it('ranks the assumptions by how far they move the target price, and leaves out those without a range', async () => {
    const v = await link(await newProject());
    const s = v.sensitivity!;
    expect(s.withoutRange).toContain(multipleOf(v).id);
    expect(s.rows.length).toBeGreaterThan(5);
    const sizes = s.rows.map((r) => Math.abs(r.targetPrice.delta!));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(s.rows[0]).toMatchObject({ rangeSource: 'sheet', low: 0.12, high: 0.2 });
    expect(s.rows[0].targetPrice.delta).toBeCloseTo(3.4, 1);
    expect(s.rows[0].revenue.delta).not.toBeNull();
    expect(s.rows[0].eps.delta).not.toBeNull();
  });

  it('puts the parties side by side and flags figures more than 10% from 我的預估', async () => {
    const v = await link(await newProject());
    expect(v.gapThreshold).toBe(0.1);
    const main = v.parties.find((t) => t.sheet === 'CRWD 簡明損益表')!;
    expect(main.periods.map((p) => p.period)).toEqual(['3Q27', '4Q27', 'FY27', 'FY28']);
    for (const p of main.periods) expect(p.columns.map((c) => c.party)).toEqual(['mine', 'consensus', 'funda', 'allen', 'guidance', 'actual']);
    expect(main.periods[0].columns[0]).toEqual({ party: 'mine', label: '我的預估' });
    expect(main.rows.map((r) => r.label)).toContain('調整後 EPS');
    const cells = main.rows.flatMap((r) => r.cells.flat());
    for (const row of main.rows) {
      expect(row.cells.map((c) => c.length)).toEqual([6, 6, 6, 6]);
      for (const period of row.cells) {
        const mine = period[0];
        expect(mine.gap).toBeNull();
        for (const c of period) {
          if (c === mine || c.value === null || mine.value === null || mine.value === 0) continue;
          expect(c.gap).toBeCloseTo((c.value - mine.value) / Math.abs(mine.value), 12);
          expect(c.flagged).toBe(Math.abs(c.gap!) > 0.1);
        }
      }
    }
    expect(cells.some((c) => c.gap !== null && !c.flagged)).toBe(true);
    expect(cells.some((c) => c.flagged)).toBe(true);
  });

  it('reads a file without stored results and says the engine could not be checked', async () => {
    fs.copyFileSync(path.join(FIXTURES, 'CRWD_無計算結果.xlsx'), path.join(vault, 'CRWD_無計算結果.xlsx'));
    const v = await link(await newProject(), 'CRWD_無計算結果.xlsx');
    expect(v.selfCheck!.state).toBe('no-cached-values');
    expect(v.outputs!.targetPrice.value).toBeCloseTo(171.53, 2);
    expect(v.assumptions).toHaveLength(27);
  });

  it('reports the state of a file that is gone, not a workbook, or open in Excel', async () => {
    const pid = await newProject();
    const file = path.join(vault, REL);
    await link(pid);
    fs.writeFileSync(excelLockPath(file), '');
    expect((await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`)).file).toMatchObject({ state: 'ok', excelOpen: true });
    fs.writeFileSync(file, 'not a zip');
    expect(await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`)).toMatchObject({ linked: true, loaded: false, outputs: null, file: { state: 'unreadable', reason: 'not-zip', size: 9 } });
    fs.rmSync(file);
    expect(await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`)).toMatchObject({ linked: true, loaded: false, file: { state: 'missing', sha256: null } });
    await api('DELETE', `/api/projects/${pid}/workbook/link`);
    expect(await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`)).toMatchObject({ linked: false, file: null });
  });

  it('keeps the link, the file facts and a count in the database, and no assumption value', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const row = ctx.db.prepare('SELECT * FROM project_workbooks WHERE project_id = ?').get(pid) as Record<string, unknown>;
    expect(row).toMatchObject({ rel_path: REL, mapping_json: null, file_sha256: v.file!.sha256, file_size: v.file!.size, linked_by: 'user' });
    expect(JSON.parse(row.summary_json as string)).toEqual({ assumptions: 27, needsDecision: 8, selfCheck: 'verified' });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM workbook_writes').get()).toEqual({ n: 0 });
    // the vault holds exactly what it held: nothing was written next to the file
    expect(fs.readdirSync(path.join(vault, COMPANY))).toEqual([CRWD]);
  });
});

describe('recalculating trial values', () => {
  it('recomputes the results for an override and ranks a trial range, without touching the file', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const file = path.join(vault, REL);
    const mtime = fs.statSync(file).mtimeMs;
    const multiple = multipleOf(v);
    const o = v.outputs!;
    const r = await api<WorkbookRecalcDTO>('POST', `/api/projects/${pid}/workbook/recalc`, {
      baseSha: v.file!.sha256,
      overrides: [{ id: multiple.id, value: 30 }],
      trialRanges: { [multiple.id]: { low: 20, high: 30 } },
    });
    expect(r.baseSha).toBe(v.file!.sha256);
    expect(r.outputs.multiple).toMatchObject({ value: 30, fileValue: 25 });
    expect(r.outputs.targetPrice.value).toBeCloseTo((30 * o.revenueTotal.value! + o.netCash.value!) / o.shareCount.value!, 6);
    expect(r.outputs.targetPrice.fileValue).toBeCloseTo(171.53, 2);
    expect(r.outputs.revenueTotal.value).toBe(o.revenueTotal.value);
    expect(r.sensitivity.rows[0]).toMatchObject({ id: multiple.id, rangeSource: 'trial', low: 20, high: 30 });
    expect(r.sensitivity.rows[0].targetPrice.delta).toBeCloseTo(66.6, 1);
    expect(r.sensitivity.withoutRange).not.toContain(multiple.id);

    // an assumption that feeds revenue moves revenue, EPS and the target price
    const units = v.assumptions.find((a) => a.low === 0.12 && a.high === 0.2)!;
    const r2 = await api<WorkbookRecalcDTO>('POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v.file!.sha256, overrides: [{ id: units.id, value: 0.2 }] });
    expect(r2.outputs.revenueTotal.value!).toBeGreaterThan(o.revenueTotal.value!);
    expect(r2.outputs.targetPrice.value!).toBeGreaterThan(o.targetPrice.value!);
    expect(r2.outputs.multiple.value).toBe(25);

    // the next load is the file again: trial values stay with the caller
    const again = await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`);
    expect(again.outputs).toEqual(v.outputs);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(sha256Hex(fs.readFileSync(file))).toBe(v.file!.sha256);
  });

  it('refuses with 409 when the file changed after it was loaded', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const body = { baseSha: v.file!.sha256, overrides: [] };
    await api('POST', `/api/projects/${pid}/workbook/recalc`, body);
    fs.copyFileSync(path.join(FIXTURES, 'CRWD_無計算結果.xlsx'), path.join(vault, REL));
    const changed = await api<Failure>('POST', `/api/projects/${pid}/workbook/recalc`, body, 409);
    expect(changed.code).toBe('WORKBOOK_CHANGED');
    expect(changed.details!.sha256).toBe(sha256Hex(fs.readFileSync(path.join(vault, REL))));
    fs.rmSync(path.join(vault, REL));
    expect((await api<Failure>('POST', `/api/projects/${pid}/workbook/recalc`, body, 409)).code).toBe('WORKBOOK_UNREADABLE');
  });

  it('refuses unknown assumptions and malformed requests', async () => {
    const pid = await newProject();
    const recalc = (payload: unknown, status: number) => api<Failure>('POST', `/api/projects/${pid}/workbook/recalc`, payload, status);
    const sha = 'a'.repeat(64);
    expect((await recalc({ baseSha: sha, overrides: [] }, 404)).code).toBe('WORKBOOK_NOT_LINKED');
    const v = await link(pid);
    const good = v.file!.sha256;
    expect((await recalc({ baseSha: good, overrides: [{ id: `${MODEL}!沒有這個假設#1`, value: 1 }] }, 400)).code).toBe('UNKNOWN_ASSUMPTION');
    const id = multipleOf(v).id;
    await recalc({ overrides: [] }, 400);
    await recalc({ baseSha: good }, 400);
    await recalc({ baseSha: good, overrides: [{ id, value: '30' }] }, 400);
    await recalc({ baseSha: good, overrides: [{ id, value: 30 }, { id, value: 31 }] }, 400);
    await recalc({ baseSha: good, overrides: [], trialRanges: { [id]: { low: 20 } } }, 400);
  });

  it('is not listed as AI activity', async () => {
    const pid = await newProject();
    const v = await link(pid);
    await as<WorkbookRecalcDTO>('claude-desktop', 'POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v.file!.sha256, overrides: [{ id: multipleOf(v).id, value: 28 }] });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM ai_sessions').get()).toEqual({ n: 0 });
  });
});

describe('who may do what', () => {
  it('lets an AI client read and recalculate but not link, unlink or remap', async () => {
    const pid = await newProject();
    for (const who of ['claude-desktop', 'claude-code', 'chatgpt'] as const) {
      const refused = await as<Failure>(who, 'PUT', `/api/projects/${pid}/workbook/link`, { path: REL }, 403);
      expect(refused.code).toBe('USER_ONLY');
    }
    expect((await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`)).linked).toBe(false);
    const v = await link(pid);
    const seen = await as<WorkbookViewDTO>('claude-desktop', 'GET', `/api/projects/${pid}/workbook`);
    expect(seen.outputs).toEqual(v.outputs);
    expect((await as<WorkbookFilesDTO>('chatgpt', 'GET', '/api/workbook/files')).files).toHaveLength(1);
    await as<Failure>('claude-desktop', 'DELETE', `/api/projects/${pid}/workbook/link`, undefined, 403);
    await as<Failure>('claude-desktop', 'PUT', `/api/projects/${pid}/workbook/mapping`, { mapping: null }, 403);
    await as<Failure>('claude-desktop', 'PUT', '/api/settings/vault-dir', { dir: dir }, 403);
    // a caller nobody can name may read, never write
    expect((await as<WorkbookViewDTO>(null, 'GET', `/api/projects/${pid}/workbook`)).linked).toBe(true);
    expect((await call(null, 'PUT', `/api/projects/${pid}/workbook/link`, { path: REL })).statusCode).toBe(401);
    expect((await call('obsidian', 'GET', `/api/projects/${pid}/workbook`)).statusCode).toBe(403);
    expect((await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`)).linked).toBe(true);
  });

  it('refuses a path that leaves the vault folder or is not an .xlsx', async () => {
    const pid = await newProject();
    const outside = path.join(dir, 'outside.xlsx');
    fs.copyFileSync(path.join(FIXTURES, CRWD), outside);
    fs.symlinkSync(outside, path.join(vault, 'link.xlsx'));
    fs.symlinkSync(dir, path.join(vault, 'up'));
    fs.writeFileSync(path.join(vault, 'notes.md'), '# x');
    fs.writeFileSync(path.join(vault, '~$CRWD.xlsx'), '');
    const refuse = async (rel: string, reason: string) => {
      const r = await api<Failure>('PUT', `/api/projects/${pid}/workbook/link`, { path: rel }, 400);
      expect([rel, r.code, r.details!.reason]).toEqual([rel, 'WORKBOOK_PATH', reason]);
    };
    await refuse('../outside.xlsx', 'outside-vault');
    await refuse(`${COMPANY}/../../../../outside.xlsx`, 'outside-vault');
    await refuse(outside, 'outside-vault');
    await refuse('link.xlsx', 'outside-vault');
    await refuse('up/outside.xlsx', 'outside-vault');
    await refuse('up/not-there.xlsx', 'outside-vault');
    await refuse('notes.md', 'not-xlsx');
    await refuse('~$CRWD.xlsx', 'not-xlsx');
    await api<Failure>('PUT', `/api/projects/${pid}/workbook/link`, {}, 400);
    expect((await api<Failure>('PUT', `/api/projects/${pid}/workbook/link`, { path: 'nowhere/x.xlsx' }, 404)).code).toBe('WORKBOOK_MISSING');
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_workbooks').get()).toEqual({ n: 0 });
    await api('GET', '/api/projects/prj_nowhere/workbook', undefined, 404);
  });
});

describe('the vault folder', () => {
  it('comes from the setting unless WORKBENCH_VAULT_DIR is given, and is set only from this Mac', async () => {
    await ctx.app.close();
    ctx = await build({ vaultDir: undefined });
    const put = (payload: unknown, headers: Record<string, string> = {}, who: TokenName | null = 'user') => call(who, 'PUT', '/api/settings/vault-dir', payload, headers);
    expect(await api<VaultDirDTO>('GET', '/api/settings/vault-dir')).toEqual({ dir: null, source: null, readable: false, reason: null });
    const pid = await newProject();
    expect((await api<Failure>('PUT', `/api/projects/${pid}/workbook/link`, { path: REL }, 409)).code).toBe('NO_VAULT');
    expect(await api<WorkbookFilesDTO>('GET', '/api/workbook/files')).toMatchObject({ vault: { dir: null }, files: [] });

    for (const host of ['mac.tail1234.ts.net', 'evil.example:4310', '192.168.1.5:4310']) {
      const res = await put({ dir: vault }, { host });
      expect([host, res.statusCode, res.json().code]).toEqual([host, 403, 'LOCAL_ONLY']);
    }
    expect((await put({ dir: vault }, {}, null)).statusCode).toBe(401);
    expect((await put({ dir: 'relative/股票' })).statusCode).toBe(400);
    expect((await put({ dir: path.join(dir, 'nowhere') })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
    expect(await api<VaultDirDTO>('GET', '/api/settings/vault-dir')).toMatchObject({ dir: null });

    for (const host of ['127.0.0.1:4310', 'localhost:4310', '[::1]:4310']) expect((await put({ dir: `${vault}/` }, { host })).statusCode).toBe(200);
    expect(await api<VaultDirDTO>('GET', '/api/settings/vault-dir')).toEqual({ dir: vault, source: 'settings', readable: true, reason: null });
    expect(ctx.db.prepare('SELECT key, value FROM app_settings').all()).toEqual([{ key: 'vault_dir', value: vault }]);
    expect((await link(pid)).outputs!.targetPrice.value).toBeCloseTo(171.53, 2);

    // the override wins, and the saved value is kept for when it is gone
    await ctx.app.close();
    const other = path.join(dir, '別的筆記庫');
    fs.mkdirSync(other);
    ctx = await build({ vaultDir: other });
    expect(await api<VaultDirDTO>('GET', '/api/settings/vault-dir')).toEqual({ dir: other, source: 'env', readable: true, reason: null });
    expect((await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`)).file).toMatchObject({ state: 'missing' });
    expect((await put({ dir: null })).json()).toMatchObject({ dir: other, source: 'env' });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM app_settings').get()).toEqual({ n: 0 });
  });

  it('lists the .xlsx files, the company’s ticker first, without lock files or hidden folders', async () => {
    const pid = await newProject();
    const put = (rel: string, mtime: number) => {
      const file = path.join(vault, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
      fs.utimesSync(file, mtime, mtime);
    };
    fs.utimesSync(path.join(vault, REL), 1_000, 1_000);
    put('PLTR_簡明損益表.xlsx', 3_000);
    put('舊資料/crwd 舊版.XLSX', 2_000);
    put(`${COMPANY}/~$${CRWD}`, 4_000);
    put('.obsidian/plugins/x.xlsx', 4_000);
    put('.trash/CRWD_刪掉的.xlsx', 4_000);
    put('筆記.md', 4_000);
    fs.writeFileSync(legacyPlaceholderPath(path.join(vault, 'CRWD_雲端.xlsx')), '');
    const all = await api<WorkbookFilesDTO>('GET', '/api/workbook/files');
    expect(all.files.map((f) => f.path).sort()).toEqual(['CRWD_雲端.xlsx', 'PLTR_簡明損益表.xlsx', REL, '舊資料/crwd 舊版.XLSX'].sort());
    expect(all.files.every((f) => !f.matchesTicker)).toBe(true);
    const mine = await api<WorkbookFilesDTO>('GET', `/api/workbook/files?projectId=${pid}`);
    expect(mine.truncated).toBe(false);
    expect(mine.files.map((f) => [f.path, f.matchesTicker, f.dataless])).toEqual([
      ['舊資料/crwd 舊版.XLSX', true, false],
      [REL, true, false],
      ['CRWD_雲端.xlsx', true, true],
      ['PLTR_簡明損益表.xlsx', false, false],
    ]);
    expect(mine.files[1]).toMatchObject({ name: CRWD, size: fs.statSync(path.join(vault, REL)).size, modifiedAt: '1970-01-01T00:16:40.000Z' });
    expect(listVaultXlsx(vault, defaultFileDeps, 2)).toMatchObject({ truncated: true, files: [{ path: 'PLTR_簡明損益表.xlsx' }, { path: '舊資料/crwd 舊版.XLSX' }] });
    await api('GET', '/api/workbook/files?projectId=prj_nowhere', undefined, 404);
  });
});

describe('result mapping', () => {
  it('saves label anchors, reports the ones the file no longer has, and goes back to detection', async () => {
    const pid = await newProject();
    const v = await link(pid);
    expect(v.mapping!.saved).toBe(false);
    expect(v.mapping!.outputs.targetPrice).toEqual({ sheet: MODEL, labelText: expect.any(String), occurrence: 1 });
    expect(v.mapping!.candidates.some((c) => c.output === 'targetPrice' && c.chosen)).toBe(true);

    // read the multiple where the target price is, and point the share count at a label that is not there
    const mapping: OutputMapping = { ...v.mapping!.outputs, multiple: v.mapping!.outputs.targetPrice, shareCount: { sheet: MODEL, labelText: '沒有這個標籤', occurrence: 1 } };
    const saved = await api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/mapping`, { mapping });
    expect(saved.mapping).toMatchObject({ saved: true, outputs: mapping });
    expect(saved.outputs!.multiple).toMatchObject({ cell: { sheet: MODEL, address: 'B86' } });
    expect(saved.outputs!.shareCount).toEqual({ cell: null, value: null, fileValue: null });
    expect(saved.warnings.filter((w) => w.code === 'mapping-unresolved')).toEqual([{ code: 'mapping-unresolved', sheet: MODEL, message: expect.stringContaining('沒有這個標籤') }]);
    expect(JSON.parse((ctx.db.prepare('SELECT mapping_json FROM project_workbooks').get() as { mapping_json: string }).mapping_json)).toEqual(mapping);

    for (const bad of [{}, { mapping: 'x' }, { mapping: { ...mapping, targetPrice: { sheet: MODEL } } }, { mapping: { ...mapping, eps: 'x' } }, { mapping: { ...mapping, revenueQuarters: [{ anchor: mapping.targetPrice }] } }]) {
      await api('PUT', `/api/projects/${pid}/workbook/mapping`, bad, 400);
    }
    const reset = await api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/mapping`, { mapping: null });
    expect(reset.mapping).toEqual(v.mapping);
    expect(reset.outputs).toEqual(v.outputs);

    // linking another file drops the mapping made for this one
    await api('PUT', `/api/projects/${pid}/workbook/mapping`, { mapping });
    fs.copyFileSync(path.join(FIXTURES, CRWD), path.join(vault, 'CRWD_另一份.xlsx'));
    expect((await link(pid, 'CRWD_另一份.xlsx')).mapping!.saved).toBe(false);
    await api('PUT', `/api/projects/${await newProject('PLTR')}/workbook/mapping`, { mapping: null }, 404);
  });
});

describe('diagnosis text', () => {
  it('names sheets, headers, labels and addresses, and no figure of the workbook', async () => {
    const pid = await newProject();
    const none = await call('user', 'GET', `/api/projects/${pid}/workbook/diagnosis`);
    expect(none.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(none.body).toContain('還沒有連結 Excel');
    const v = await link(pid);
    const text = (await call('claude-desktop', 'GET', `/api/projects/${pid}/workbook/diagnosis`)).body;
    for (const want of [CRWD, '狀態：ok', '分頁（4 個）', '- 營收模型：範圍 A1:', '未來四季營收', '說明', '假設表（7 張）', '營收模型 第 5 列：標籤 A5、取用值 B5、下緣 C5、上緣 D5、依據 E5、要／已定 F5', '假設（27 個，標「要」8 個）', '目標價：營收模型!B86', '3Q27 營收：營收模型!B67', '各方並列表', '我的預估', '自我檢查：verified', '公式 242 格']) {
      expect(text).toContain(want);
    }
    for (const a of v.assumptions) expect(text).toContain(`${a.sheet}!${a.cell}「${a.label}」`);
    // none of the workbook's figures: results, assumption values, bases
    const o = v.outputs!;
    const figures = [o.targetPrice.value!.toFixed(2), o.revenueTotal.value!.toFixed(1), '6861', '6,861', '5841', '5,841', '1030', '5150', '229.44', ...o.revenueQuarters.map((q) => q.value!.toFixed(1))];
    for (const f of figures) expect(text).not.toContain(f);
    for (const a of v.assumptions) if (a.basis) expect(text).not.toContain(a.basis);
    expect(text).not.toContain(vault);

    fs.writeFileSync(path.join(vault, REL), 'not a zip');
    expect((await call('user', 'GET', `/api/projects/${pid}/workbook/diagnosis`)).body).toContain('狀態：unreadable（not-zip）');
  });

  it('masks the constants of a formula and keeps its references', () => {
    expect(maskFormula('B5*1.16+SUM($C$3:C12)/4*0.9845')).toBe('B5*n+SUM($C$3:C12)/n*n');
    expect(maskFormula(`IF('CRWD 簡明損益表'!AB12>1e3,"要",Sheet2!A1&"x""y")`)).toBe(`IF('CRWD 簡明損益表'!AB12>n,"…",Sheet2!A1&"…")`);
    expect(maskFormula('SUM(5:5)+A1^2')).toBe('SUM(5:5)+A1^n');
  });
});

describe('file states', () => {
  const calls: string[] = [];
  const deps = (over: Partial<FileDeps> = {}): FileDeps => ({ ...defaultFileDeps, platform: 'darwin', sleep: async () => {}, downloadTimeoutMs: 2_000, pollMs: 500, run: async () => ({ status: 0, stdout: '-\n' }), ...over });
  const file = () => path.join(vault, REL);
  beforeEach(() => {
    calls.length = 0;
  });

  it('reads a downloaded file with its size, time and SHA-256', async () => {
    const r = await readWorkbookFile(file(), deps({ run: async (cmd, args) => (calls.push([cmd, ...args].join(' ')), { status: 0, stdout: 'compressed\n' }) }));
    const bytes = fs.readFileSync(file());
    expect(r).toMatchObject({ state: 'ok', reason: null, size: bytes.length, mtimeMs: fs.statSync(file()).mtimeMs, sha256: sha256Hex(bytes), excelOpen: false });
    expect(r.bytes!.equals(bytes)).toBe(true);
    expect(calls).toEqual([`${STAT_PROGRAM} -f %Sf ${file()}`]);
    // off macOS nothing is run
    expect((await inspectFile(file(), deps({ platform: 'linux', run: async () => Promise.reject(new Error('not called')) }))).state).toBe('ok');
  });

  it('asks iCloud for a dataless file and waits until its content is there', async () => {
    let polls = 0;
    const run: FileDeps['run'] = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === BRCTL_PROGRAM) return { status: 0, stdout: '' };
      return { status: 0, stdout: polls++ < 2 ? 'compressed,dataless\n' : '-\n' };
    };
    const slept: number[] = [];
    const r = await readWorkbookFile(file(), deps({ run, sleep: async (ms) => void slept.push(ms) }));
    expect(r.state).toBe('ok');
    expect(r.sha256).toBe(sha256Hex(fs.readFileSync(file())));
    expect(calls[1]).toBe(`${BRCTL_PROGRAM} download ${file()}`);
    expect(calls.filter((c) => c.startsWith(BRCTL_PROGRAM))).toHaveLength(1);
    expect(slept).toEqual([500, 500]);
  });

  it('stays dataless when the download does not arrive in time, without reading', async () => {
    const run: FileDeps['run'] = async (cmd) => (calls.push(cmd), { status: 0, stdout: 'dataless\n' });
    const r = await readWorkbookFile(file(), deps({ run }));
    expect(r).toMatchObject({ state: 'dataless', bytes: null, sha256: null, size: fs.statSync(file()).size });
    expect(calls.filter((c) => c === STAT_PROGRAM)).toHaveLength(5);
  });

  it('falls back to "full size, no blocks" when stat cannot say, and knows the old placeholder name', async () => {
    const real = fs.statSync(file());
    const noBlocks = Object.assign(Object.create(Object.getPrototypeOf(real)), real, { blocks: 0 }) as fs.Stats;
    const failing = async () => ({ status: null, stdout: '' });
    expect((await inspectFile(file(), deps({ run: failing, stat: () => noBlocks }))).state).toBe('dataless');
    expect((await inspectFile(file(), deps({ run: failing }))).state).toBe('ok');
    expect((await inspectFile(file(), deps({ platform: 'linux', stat: () => noBlocks }))).state).toBe('ok');

    const cloud = path.join(vault, 'CRWD_雲端.xlsx');
    expect(await inspectFile(cloud, deps())).toMatchObject({ state: 'missing', reason: 'ENOENT' });
    fs.writeFileSync(legacyPlaceholderPath(cloud), '');
    expect(path.basename(legacyPlaceholderPath(cloud))).toBe('.CRWD_雲端.xlsx.icloud');
    expect(await inspectFile(cloud, deps())).toMatchObject({ state: 'dataless', size: null });
  });

  it('tells denied, locked and unreadable apart', async () => {
    const failing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(await inspectFile(file(), deps({ stat: failing('EPERM') }))).toMatchObject({ state: 'denied', reason: 'EPERM' });
    expect(await inspectFile(file(), deps({ stat: failing('EACCES') }))).toMatchObject({ state: 'denied', reason: 'EACCES' });
    expect(await inspectFile(file(), deps({ stat: failing('EIO') }))).toMatchObject({ state: 'unreadable', reason: 'EIO' });
    expect(await inspectFile(path.join(vault, COMPANY), deps())).toMatchObject({ state: 'unreadable', reason: 'not-a-file' });
    fs.writeFileSync(excelLockPath(file()), '');
    expect(path.basename(excelLockPath(file()))).toBe(`~$${CRWD}`);
    expect((await inspectFile(file(), deps())).excelOpen).toBe(true);

    // a file that keeps changing while it is read is being written by something else
    const real = fs.statSync(file());
    let n = 0;
    const moving = () => Object.assign(Object.create(Object.getPrototypeOf(real)), real, { mtimeMs: real.mtimeMs + n++ }) as fs.Stats;
    expect(await readWorkbookFile(file(), deps({ stat: moving }))).toMatchObject({ state: 'locked', reason: 'changing', bytes: null });
    if (process.getuid?.() !== 0) {
      fs.chmodSync(file(), 0o000);
      expect(await readWorkbookFile(file(), deps())).toMatchObject({ state: 'denied', reason: 'EACCES', sha256: null });
    }
  });

  it('keeps a linked path inside the vault folder', () => {
    expect(resolveInVault(vault, REL)).toBe(path.join(fs.realpathSync(vault), REL));
    expect(resolveInVault(vault, '還沒有/新的.XLSX')).toBe(path.join(fs.realpathSync(vault), '還沒有/新的.XLSX'));
    expect(() => resolveInVault(path.join(dir, 'nowhere'), REL)).toThrow(expect.objectContaining({ code: 'no-vault' }));
    for (const rel of ['', '..', '.', '../x.xlsx', `${COMPANY}/../../../../x.xlsx`, '/etc/x.xlsx', 'a\0.xlsx']) expect(() => resolveInVault(vault, rel), rel).toThrow(expect.objectContaining({ code: 'outside-vault' }));
    for (const rel of ['x.xls', 'x.xlsx.md', COMPANY, '~$x.xlsx']) expect(() => resolveInVault(vault, rel), rel).toThrow(expect.objectContaining({ code: 'not-xlsx' }));
  });
});

describe('schema v4', () => {
  it('upgrades a v3 database: backup first, the new tables empty, old rows untouched', () => {
    const file = path.join(dir, 'old', 'workbench.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new Database(file);
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) d.exec(m.sql);
    d.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const T = '2026-11-01T00:00:00.000Z';
    for (const v of [1, 2, 3]) d.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, T);
    d.prepare("INSERT INTO projects (id, name, description, created_at, updated_at) VALUES ('prj_aaaa0001', 'CrowdStrike', '', ?, ?)").run(T, T);
    const queued = (d.prepare('SELECT COUNT(*) AS n FROM vault_changes').get() as { n: number }).n;
    d.close();

    const backupDir = path.join(dir, 'old', 'backups');
    const db = openDatabase(file, { backupDir });
    try {
      expect(SCHEMA_VERSION).toBe(4);
      expect((db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version)).toEqual([1, 2, 3, 4]);
      expect(fs.readdirSync(backupDir).filter((f) => /^pre-v4-.+\.db$/.test(f))).toHaveLength(1);
      for (const t of ['app_settings', 'project_workbooks', 'workbook_writes']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT id, name FROM projects').all()).toEqual([{ id: 'prj_aaaa0001', name: 'CrowdStrike' }]);

      const now = '2026-11-23T00:00:00.000Z';
      const linkRow = db.prepare("INSERT INTO project_workbooks (project_id, rel_path, linked_at, linked_by, updated_at) VALUES (?, 'CRWD.xlsx', ?, 'user', ?)");
      linkRow.run('prj_aaaa0001', now, now);
      expect(() => linkRow.run('prj_aaaa0001', now, now)).toThrow(/UNIQUE/);
      expect(() => linkRow.run('prj_nowhere', now, now)).toThrow(/FOREIGN KEY/);
      db.prepare("INSERT INTO workbook_writes (project_id, rel_path, at, actor, cells_json, before_sha256, before_size, after_sha256, after_size) VALUES ('prj_aaaa0001', 'CRWD.xlsx', ?, 'user', '[]', 'a', 1, 'b', 2)").run(now);
      // none of the new tables is a note in Obsidian
      expect(db.prepare('SELECT COUNT(*) AS n FROM vault_changes').get()).toEqual({ n: queued });
    } finally {
      db.close();
    }
    const again = openDatabase(file, { backupDir });
    try {
      expect(fs.readdirSync(backupDir).filter((f) => f.startsWith('pre-v'))).toHaveLength(1);
      expect(again.prepare('SELECT COUNT(*) AS n FROM project_workbooks').get()).toEqual({ n: 1 });
    } finally {
      again.close();
    }
  });
});
