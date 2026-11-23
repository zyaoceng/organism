import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardDTO, WorkbookViewDTO } from '../shared/api';
import { buildApp, type AppContext } from './app';
import { DemoProvider } from './market/demo';
import { workbookBrief } from './repos/portfolio';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xlsx', 'fixtures');
const CRWD = 'CRWD_簡明損益表.xlsx';

let ctx: AppContext;
let dir: string;
let vault: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dash-'));
  vault = path.join(dir, '股票');
  fs.mkdirSync(vault, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, CRWD), path.join(vault, CRWD));
  ctx = await buildApp({ dataDir: path.join(dir, 'data'), providers: [new DemoProvider(() => '2026-11-20')], market: { minIntervalMs: 0 }, vaultDir: vault });
});
afterEach(async () => {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const res = await ctx.app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${ctx.tokens.tokens.user}` } });
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
const newProject = async (name: string, ticker: string) =>
  (await api<{ id: string }>('POST', '/api/projects', { name, year: 2026, security: { ticker, exchange: 'NASDAQ', apiSymbol: ticker, currency: 'USD', priceSource: 'demo' } })).id;
const rowOf = async (pid: string) => (await api<DashboardDTO>('GET', '/api/dashboard')).rows.find((r) => r.projectId === pid)!;

describe('the dashboard’s 待判斷 count', () => {
  it('is the number of 要 cells of the linked Excel as last read, and nothing for a company without one', async () => {
    const crwd = await newProject('CrowdStrike', 'CRWD');
    const other = await newProject('Other', 'OTHR');
    expect((await rowOf(crwd)).workbook).toEqual({ linked: false, pending: null, checkedAt: null });

    const view = await api<WorkbookViewDTO>('PUT', `/api/projects/${crwd}/workbook/link`, { path: CRWD });
    expect(view.needsDecision).toBe(8);
    const w = (await rowOf(crwd)).workbook;
    expect(w).toEqual({ linked: true, pending: view.needsDecision, checkedAt: expect.any(String) });
    expect(w.pending).toBe(view.assumptions.filter((a) => a.status === 'needs-decision').length);
    expect(Number.isNaN(Date.parse(w.checkedAt!))).toBe(false);
    expect((await rowOf(other)).workbook).toEqual({ linked: false, pending: null, checkedAt: null });

    await api('DELETE', `/api/projects/${crwd}/workbook/link`);
    expect((await rowOf(crwd)).workbook).toEqual({ linked: false, pending: null, checkedAt: null });
  });

  it('does not open the file: the count stays what the last reading found', async () => {
    const pid = await newProject('CrowdStrike', 'CRWD');
    const view = await api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/link`, { path: CRWD });
    const before = (await rowOf(pid)).workbook;
    const bytes = fs.readFileSync(path.join(vault, CRWD));
    fs.rmSync(path.join(vault, CRWD));
    expect((await rowOf(pid)).workbook).toEqual(before);
    // reading the workbook again finds no file and keeps the earlier count
    expect((await api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`)).file?.state).toBe('missing');
    expect((await rowOf(pid)).workbook).toEqual({ linked: true, pending: view.needsDecision, checkedAt: before.checkedAt });
    fs.writeFileSync(path.join(vault, CRWD), bytes);
    expect(fs.readdirSync(vault)).toEqual([CRWD]);
  });

  it('is unknown for a linked file that was never read', async () => {
    const pid = await newProject('CrowdStrike', 'CRWD');
    fs.writeFileSync(path.join(vault, 'CRWD_壞檔.xlsx'), 'not a zip');
    await api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/link`, { path: 'CRWD_壞檔.xlsx' });
    expect((await rowOf(pid)).workbook).toEqual({ linked: true, pending: null, checkedAt: null });
  });

  it('follows the stored summary when the count changes', async () => {
    const pid = await newProject('CrowdStrike', 'CRWD');
    await api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/link`, { path: CRWD });
    ctx.db.prepare('UPDATE project_workbooks SET summary_json = ?, checked_at = ? WHERE project_id = ?').run(JSON.stringify({ assumptions: 20, needsDecision: 0, selfCheck: 'verified' }), '2026-11-23T01:00:00.000Z', pid);
    expect((await rowOf(pid)).workbook).toEqual({ linked: true, pending: 0, checkedAt: '2026-11-23T01:00:00.000Z' });
  });
});

describe('workbookBrief', () => {
  it('reads only a whole, non-negative count out of the summary', () => {
    const at = '2026-11-23T01:00:00.000Z';
    expect(workbookBrief(undefined)).toEqual({ linked: false, pending: null, checkedAt: null });
    expect(workbookBrief({ summary_json: null, checked_at: null })).toEqual({ linked: true, pending: null, checkedAt: null });
    expect(workbookBrief({ summary_json: '{"needsDecision":4}', checked_at: at })).toEqual({ linked: true, pending: 4, checkedAt: at });
    for (const bad of ['{', '{"needsDecision":"4"}', '{"needsDecision":-1}', '{"needsDecision":1.5}', '[]', 'null']) {
      expect(workbookBrief({ summary_json: bad, checked_at: at })).toEqual({ linked: true, pending: null, checkedAt: null });
    }
  });
});
