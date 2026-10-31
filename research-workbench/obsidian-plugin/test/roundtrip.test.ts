/**
 * The plugin engine against the real server: notes rendered by the workbench land in the (fake)
 * vault, a reflection written there comes back to the project, a deleted trade's note stays and
 * says so, and the status report shows up in GET /api/vault/status.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setValue } from '../../src/domain/model/ops';
import { SCALAR_KEY, type ModelState } from '../../src/domain/model/types';
import { fill, idByName } from '../../src/domain/testing/sample';
import type { ProjectBundleDTO, ReflectionDTO, TradeDTO, VaultStatusDTO } from '../../src/shared/api';
import { buildApp, type AppContext } from '../../src/server/app';
import { DemoProvider } from '../../src/server/market/demo';
import { QUIET_MS, SyncEngine } from '../src/engine';
import { DEFAULT_STATE } from '../src/ports';
import { FakeVault } from './fakeVault';
import { injectServer } from './injectServer';

let ctx: AppContext;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-obsidian-'));
  ctx = await buildApp({ dataDir: dir, providers: [new DemoProvider(() => '2026-09-25')] });
});
afterEach(async () => {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function user<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const res = await ctx.app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${ctx.tokens.tokens.user}` } });
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

function populate(s: ModelState): ModelState {
  s = fill(s, idByName(s, 'Business A'), { FY2024: 800, FY2025: 1000 });
  s = fill(s, idByName(s, 'YoY Growth', 'Business A'), { FY2026: 0.2, FY2027: 0.2, FY2028: 0.35 });
  const same = (v: number) => ({ FY2024: v, FY2025: v, FY2026: v, FY2027: v, FY2028: v });
  s = fill(s, idByName(s, 'Gross Margin'), same(0.2));
  s = fill(s, idByName(s, 'Opex % of Revenue'), same(0.08));
  s = fill(s, idByName(s, 'Tax Rate'), same(0.2));
  s = fill(s, idByName(s, 'Diluted Shares'), same(22));
  return setValue(s, idByName(s, 'Target P/E'), SCALAR_KEY, 'base', 25);
}

/** The vault path of the file carrying this wb_id. */
function fileOf(vault: FakeVault, id: string): string {
  const hits = vault.paths().filter((p) => vault.wbIdOf(p) === id);
  expect(hits, id).toHaveLength(1);
  return hits[0];
}

it('syncs notes, reads a reflection back, keeps a deleted trade and reports status', async () => {
  const { id: pid } = await user<{ id: string }>('POST', '/api/projects', {
    name: '光寶科',
    year: 2026,
    security: { ticker: '2301', exchange: 'TWSE', apiSymbol: '2301.TW', currency: 'TWD', priceSource: 'demo' },
  });
  const b = await user<ProjectBundleDTO>('GET', `/api/projects/${pid}`);
  const d = await user<{ version: number }>('PUT', `/api/projects/${pid}/draft`, { state: populate(b.draft.state), version: b.draft.version });
  await user('POST', `/api/projects/${pid}/revisions`, { title: '首次覆蓋', reason: '建立模型', asOfDate: '2026-09-20', draftVersion: d.version });
  const t = await user<TradeDTO>('POST', `/api/projects/${pid}/trades`, { side: 'long', entryDate: '2026-09-22', entryPrice: 100, quantity: 1000 });

  const vault = new FakeVault();
  const server = injectServer(ctx);
  const engine = new SyncEngine({
    vault,
    server,
    rootFolder: () => '研究工作台',
    state: { ...DEFAULT_STATE },
    save: async () => {},
    pluginVersion: '0.1.0',
    vaultName: 'Research',
    now: () => vault.t,
  });
  const sync = async (gap = 6_000) => {
    vault.advance(gap);
    const s = await engine.runOnce();
    expect(s.state, s.message ?? '').toBe('synced');
    return s;
  };

  await sync();
  const companyPath = fileOf(vault, pid);
  const tradePath = fileOf(vault, t.id);
  expect(companyPath.startsWith('研究工作台/公司/')).toBe(true);
  expect(tradePath.startsWith('研究工作台/交易/2301/')).toBe(true);
  expect(vault.paths().some((p) => p.startsWith('研究工作台/研究更新/2301/'))).toBe(true);
  expect(vault.paths().some((p) => p.startsWith('研究工作台/_索引/'))).toBe(true);
  // links between notes point at the files just created
  expect(vault.content(tradePath)).toContain(`[[${companyPath.replace(/\.md$/, '')}|`);
  const created = vault.writes.length;
  await sync();
  expect(vault.writes.length).toBe(created);

  // a reflection written in Obsidian comes back to the project
  vault.userEdit(tradePath, (s) => s.replace(/## 反思\n[\s\S]*$/, '## 反思\n進場價太高，應該等拉回。\n'));
  await sync(QUIET_MS + 1000);
  const refl = await user<ReflectionDTO[]>('GET', `/api/projects/${pid}/reflections`);
  expect(refl.find((r) => r.noteId === t.id)).toMatchObject({ text: '進場價太高，應該等拉回。', versionCount: 1, cleared: null });

  // deleting the trade keeps the note, marked deleted, with the reflection
  await user('DELETE', `/api/trades/${t.id}`);
  await sync();
  const after = vault.content(tradePath);
  expect(after).toContain('wb_status: "deleted"');
  expect(after).toContain('進場價太高，應該等拉回。');

  // a hand edit becomes a conflict the workbench can show
  vault.userEdit(companyPath, (s) => s.replace(/(<!-- wb:begin[^\n]*\n)/, '$1我在自動產生區裡打字\n'));
  await user('POST', `/api/projects/${pid}/catalysts`, { title: '法說會', status: 'upcoming' });
  await sync();
  const status = await user<VaultStatusDTO>('GET', '/api/vault/status');
  expect(status).toMatchObject({ connected: true, vaultName: 'Research', pluginVersion: '0.1.0', behind: 0 });
  expect(status.conflicts).toEqual([expect.objectContaining({ wbId: pid, reason: 'hand-edited', paths: [companyPath] })]);
});

it('re-creating a deleted note brings its reflection back and does not record it as cleared; an indented first line is kept', async () => {
  const { id: pid } = await user<{ id: string }>('POST', '/api/projects', {
    name: '光寶科',
    year: 2026,
    security: { ticker: '2301', exchange: 'TWSE', apiSymbol: '2301.TW', currency: 'TWD', priceSource: 'demo' },
  });
  const t = await user<TradeDTO>('POST', `/api/projects/${pid}/trades`, { side: 'long', entryDate: '2026-09-22', entryPrice: 100, quantity: 1000 });
  const vault = new FakeVault();
  const engine = new SyncEngine({
    vault,
    server: injectServer(ctx),
    rootFolder: () => '研究工作台',
    state: { ...DEFAULT_STATE },
    save: async () => {},
    pluginVersion: '0.1.0',
    vaultName: 'Research',
    now: () => vault.t,
  });
  const sync = async (gap = QUIET_MS + 1000) => {
    vault.advance(gap);
    const s = await engine.runOnce();
    expect(s.state, s.message ?? '').toBe('synced');
  };
  await sync();
  const tradePath = fileOf(vault, t.id);
  const text = '    縮排的程式碼\n\n## 小標\n第二段';
  vault.userEdit(tradePath, (s) => s.replace(/## 反思\n[\s\S]*$/, `# 反思\n${text}\n`));
  await sync();
  const versions = () => user<{ text: string }[]>('GET', `/api/reflections/${t.id}/versions`);
  expect((await versions()).map((v) => v.text)).toEqual([text]);

  // the user deletes the note, then asks for deleted notes to be re-created
  vault.remove(tradePath);
  await sync();
  expect(await engine.recreateDeleted()).toBe(1);
  await sync();
  await sync();
  expect(vault.content(fileOf(vault, t.id))).toContain(text);
  expect((await versions()).map((v) => v.text)).toEqual([text]);
  const refl = await user<ReflectionDTO[]>('GET', `/api/projects/${pid}/reflections`);
  expect(refl.find((r) => r.noteId === t.id)).toMatchObject({ text, cleared: null, versionCount: 1 });
});
