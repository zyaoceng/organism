import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenName } from '../shared/actors';
import type { AuditEntryDTO, WorkbookViewDTO, WorkbookWriteRequest } from '../shared/api';
import { runAs } from './actor';
import { buildApp, type AppContext } from './app';
import { DemoProvider } from './market/demo';
import { defaultFileDeps, excelLockPath, sha256Hex } from './xlsx/file';
import { readWorkbook } from './xlsx/read';
import { loadWorkbook } from './xlsx/view';
import { BACKUPS_KEPT, backupDirFor, backupOriginal, tempPathFor, writeBack, type WriteContext } from './xlsx/write';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xlsx', 'fixtures');
const CRWD = 'CRWD_簡明損益表.xlsx';
const REL = `個股/CRWD/${CRWD}`;
const MODEL = '營收模型';

let ctx: AppContext;
let dir: string;
let vault: string;
let dataDir: string;
let file: string;
let original: Buffer;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-write-'));
  vault = path.join(dir, '股票');
  dataDir = path.join(dir, 'data');
  file = path.join(vault, REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, CRWD), file);
  fs.writeFileSync(path.join(vault, '筆記.md'), '# 筆記');
  fs.writeFileSync(path.join(vault, '個股', 'CRWD', '研究筆記.md'), 'CRWD');
  original = fs.readFileSync(file);
  ctx = await buildApp({ dataDir, providers: [new DemoProvider(() => '2026-11-20')], market: { minIntervalMs: 0 }, vaultDir: vault });
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
const call = (who: TokenName | null, method: Method, url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, payload: payload as object | undefined, headers: who ? { authorization: `Bearer ${ctx.tokens.tokens[who]}` } : {} });
async function api<T>(method: Method, url: string, payload?: unknown, status = 200): Promise<T> {
  const res = await call('user', method, url, payload);
  if (res.statusCode !== status) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
const newProject = async () => (await api<{ id: string }>('POST', '/api/projects', { name: 'CrowdStrike', year: 2026, security: { ticker: 'CRWD', exchange: 'NASDAQ', apiSymbol: 'CRWD', currency: 'USD', priceSource: 'demo' } })).id;
const link = (pid: string) => api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/link`, { path: REL });
const view = (pid: string) => api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`);
const write = (pid: string, body: Partial<WorkbookWriteRequest>) => api<WorkbookViewDTO>('POST', `/api/projects/${pid}/workbook/write`, body);
const refused = (pid: string, body: unknown, status: number) => api<Failure>('POST', `/api/projects/${pid}/workbook/write`, body, status);

/** Every entry under a folder with its type, size, mode and content hash. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = path.join(rel, e.name);
      const st = fs.lstatSync(path.join(root, p));
      out[p] = `${e.isDirectory() ? 'dir' : 'file'} ${e.isFile() ? st.size : 0} ${st.mode} ${e.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex') : ''}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk('');
  return out;
}
const backups = (pid: string) => (fs.existsSync(backupDirFor(dataDir, pid)) ? fs.readdirSync(backupDirFor(dataDir, pid)).sort() : []);
const writeRows = () => ctx.db.prepare('SELECT * FROM workbook_writes ORDER BY id').all() as Record<string, unknown>[];
const multipleOf = (v: WorkbookViewDTO) => v.assumptions.find((a) => a.origin === 'output')!;
const needing = (v: WorkbookViewDTO) => v.assumptions.find((a) => a.status === 'needs-decision')!;
const cellOf = (bytes: Buffer, address: string) => readWorkbook(bytes).sheets.find((s) => s.name === MODEL)!.cells[address];

describe('POST /api/projects/:id/workbook/write', () => {
  it('writes the cells into the file, backs the original up, records the write and answers with the new view', async () => {
    fs.chmodSync(file, 0o640);
    const before = snapshot(vault);
    const pid = await newProject();
    const v = await link(pid);
    const multiple = multipleOf(v);
    const yao = needing(v);
    expect(yao.statusCell).toMatch(/^F\d+$/);

    const after = await write(pid, {
      baseSha: v.file!.sha256!,
      changes: [{ sheet: multiple.sheet, address: multiple.cell, value: 30 }],
      statusChanges: [{ sheet: yao.sheet, address: yao.statusCell!, to: '已定' }],
    });

    // the answer is the file as it is now
    const now = fs.readFileSync(file);
    expect(after.file).toMatchObject({ state: 'ok', size: now.length, sha256: sha256Hex(now) });
    expect(after.file!.sha256).not.toBe(v.file!.sha256);
    expect(multipleOf(after).value).toBe(30);
    expect(after.assumptions.find((a) => a.id === yao.id)!.status).toBe('decided');
    expect(after.needsDecision).toBe(v.needsDecision - 1);
    expect(after.revert).toBeNull();
    // the results that depend on the multiple were recalculated into the file: nothing is stale
    expect(after.selfCheck).toMatchObject({ state: 'verified', mismatchCount: 0, compared: v.selfCheck!.compared });
    expect(after.outputs!.targetPrice.value).toBeGreaterThan(200);
    expect(cellOf(now, 'B86').value).toBeCloseTo(after.outputs!.targetPrice.value!, 9);
    expect(cellOf(now, multiple.cell)).toMatchObject({ type: 'number', value: 30 });
    expect(cellOf(now, yao.statusCell!).value).toBe('已定');

    // in the vault only that file changed: same names, no temp file, no lock file; its mode is kept
    const snap = snapshot(vault);
    expect(Object.keys(snap)).toEqual(Object.keys(before));
    expect(Object.keys(snap).filter((p) => snap[p] !== before[p])).toEqual([REL]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.existsSync(tempPathFor(file))).toBe(false);

    // the backup is the original, byte for byte
    const kept = backups(pid);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(new RegExp(`^\\d{8}-\\d{6}-${CRWD.replace('.', '\\.')}$`));
    expect(fs.readFileSync(path.join(backupDirFor(dataDir, pid), kept[0])).equals(original)).toBe(true);

    const rows = writeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ project_id: pid, rel_path: REL, actor: 'user', before_sha256: sha256Hex(original), before_size: original.length, after_sha256: sha256Hex(now), after_size: now.length, backup_file: `workbook-backups/${pid}/${kept[0]}` });
    expect(JSON.parse(rows[0].cells_json as string)).toEqual({
      changes: [{ sheet: MODEL, address: multiple.cell, label: multiple.label, before: 25, after: 30, wasFormula: false }],
      statusChanges: [{ sheet: MODEL, address: yao.statusCell, label: yao.label, before: '要', after: '已定' }],
    });
    const audit = await api<AuditEntryDTO[]>('GET', `/api/projects/${pid}/audit`);
    expect(audit.find((a) => a.entity === 'workbook')).toMatchObject({ action: 'update', actor: 'user', entityId: String(rows[0].id) });
  });

  it('replaces a formula with the number, and says so in the record', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const arr = v.assumptions.find((a) => a.valueIsFormula)!;
    expect(cellOf(original, arr.cell).formula).toEqual(expect.any(String));
    const after = await write(pid, { baseSha: v.file!.sha256!, changes: [{ sheet: arr.sheet, address: arr.cell, value: arr.value + 40 }], statusChanges: [] });
    const now = fs.readFileSync(file);
    expect(cellOf(now, arr.cell)).toMatchObject({ type: 'number', value: arr.value + 40 });
    expect(cellOf(now, arr.cell).formula).toBeUndefined();
    expect(after.assumptions.find((a) => a.id === arr.id)).toMatchObject({ value: arr.value + 40, valueIsFormula: false });
    expect(after.selfCheck!.state).toBe('verified');
    expect(after.selfCheck!.formulaCells).toBe(v.selfCheck!.formulaCells - 1);
    expect(after.outputs!.revenueTotal.value).not.toBe(v.outputs!.revenueTotal.value);
    expect(JSON.parse(writeRows()[0].cells_json as string).changes[0]).toMatchObject({ wasFormula: true, formula: cellOf(original, arr.cell).formula });
  });

  it('writes a file whose stored results could not be checked, and leaves those results alone', async () => {
    fs.copyFileSync(path.join(FIXTURES, 'CRWD_無計算結果.xlsx'), file);
    const pid = await newProject();
    const v = await link(pid);
    expect(v.selfCheck!.state).toBe('no-cached-values');
    const after = await write(pid, { baseSha: v.file!.sha256!, changes: [{ sheet: MODEL, address: multipleOf(v).cell, value: 30 }], statusChanges: [] });
    expect(multipleOf(after).value).toBe(30);
    expect(cellOf(fs.readFileSync(file), 'B86')).toMatchObject({ type: 'empty', hasCached: false });
  });

  it('refuses without touching anything when the file is not the one the page loaded (409 FILE_CHANGED)', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const multiple = multipleOf(v);
    // Excel, or an AI client, saved the file in the meantime
    await write(pid, { baseSha: v.file!.sha256!, changes: [{ sheet: MODEL, address: multiple.cell, value: 26 }], statusChanges: [] });
    const before = snapshot(dir);
    const r = await refused(pid, { baseSha: v.file!.sha256, changes: [{ sheet: MODEL, address: multiple.cell, value: 30 }], statusChanges: [] }, 409);
    expect(r).toMatchObject({ code: 'FILE_CHANGED', details: { sha256: sha256Hex(fs.readFileSync(file)) } });
    expect(snapshot(dir)).toEqual(before);
    expect(writeRows()).toHaveLength(1);
  });

  it('refuses while Excel has the file open (423 FILE_LOCKED), and writes once it is closed', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const body = { baseSha: v.file!.sha256!, changes: [{ sheet: MODEL, address: multipleOf(v).cell, value: 30 }], statusChanges: [] };
    fs.writeFileSync(excelLockPath(file), 'lock');
    const before = snapshot(dir);
    expect(await refused(pid, body, 423)).toMatchObject({ code: 'FILE_LOCKED' });
    expect(snapshot(dir)).toEqual(before);
    expect(backups(pid)).toEqual([]);
    fs.rmSync(excelLockPath(file));
    expect(multipleOf(await write(pid, body)).value).toBe(30);
  });

  it('refuses a file that cannot be read, cells that are not assumption cells, and malformed requests', async () => {
    const pid = await newProject();
    const unlinked = await refused(pid, { baseSha: 'a'.repeat(64), changes: [{ sheet: MODEL, address: 'B82', value: 1 }] }, 404);
    expect(unlinked.code).toBe('WORKBOOK_NOT_LINKED');
    const v = await link(pid);
    const baseSha = v.file!.sha256!;
    const multiple = multipleOf(v);
    const decided = v.assumptions.find((a) => a.status === 'decided')!;
    const before = snapshot(dir);
    const change = (address: string, value: unknown = 1, sheet = MODEL) => ({ baseSha, changes: [{ sheet, address, value }], statusChanges: [] });

    // a result cell, a label, an empty cell, another sheet: none is the value cell of an assumption
    for (const address of ['B86', 'A82', 'Z99']) expect((await refused(pid, change(address), 400)).code).toBe('NOT_AN_ASSUMPTION');
    expect((await refused(pid, change(multiple.cell, 1, '說明'), 400)).code).toBe('NOT_AN_ASSUMPTION');
    // a status cell that already says 已定, and a value cell given as a status cell
    expect((await refused(pid, { baseSha, changes: [], statusChanges: [{ sheet: MODEL, address: decided.statusCell, to: '已定' }] }, 400)).code).toBe('NOT_AN_ASSUMPTION');
    expect((await refused(pid, { baseSha, changes: [], statusChanges: [{ sheet: MODEL, address: multiple.cell, to: '已定' }] }, 400)).code).toBe('NOT_AN_ASSUMPTION');
    // one bad cell refuses the whole request
    expect((await refused(pid, { baseSha, changes: [{ sheet: MODEL, address: multiple.cell, value: 30 }, { sheet: MODEL, address: 'B86', value: 1 }], statusChanges: [] }, 400)).code).toBe('NOT_AN_ASSUMPTION');

    expect((await refused(pid, { baseSha, changes: [], statusChanges: [] }, 400)).code).toBe('NOTHING_TO_WRITE');
    for (const body of [
      {},
      { baseSha: 'nope', changes: [] },
      change(multiple.cell, '30'),
      change(multiple.cell, null),
      change('b82'),
      change('B0'),
      change('../B1'),
      { baseSha, changes: 'B82' },
      { baseSha, changes: [{ sheet: MODEL, address: multiple.cell, value: 1 }, { sheet: MODEL, address: multiple.cell, value: 2 }] },
      { baseSha, changes: [], statusChanges: [{ sheet: MODEL, address: needing(v).statusCell, to: '要' }] },
      { baseSha, changes: [], statusChanges: [{ sheet: MODEL, address: needing(v).statusCell, to: '隨便' }] },
    ]) {
      expect((await call('user', 'POST', `/api/projects/${pid}/workbook/write`, body)).statusCode).toBe(400);
    }

    fs.renameSync(file, `${file}.moved`);
    expect(await refused(pid, change(multiple.cell, 30), 409)).toMatchObject({ code: 'WORKBOOK_UNREADABLE', details: { state: 'missing' } });
    fs.renameSync(`${file}.moved`, file);
    expect(snapshot(dir)).toEqual(before);
    expect(writeRows()).toEqual([]);
  });

  it('is refused for every AI client and for a caller without a name', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const body = { baseSha: v.file!.sha256, changes: [{ sheet: MODEL, address: multipleOf(v).cell, value: 30 }], statusChanges: [] };
    // the vault and the backups; the database does note that an AI client connected
    const before = snapshot(vault);
    for (const who of ['claude-desktop', 'claude-code', 'chatgpt'] as const) {
      const res = await call(who, 'POST', `/api/projects/${pid}/workbook/write`, body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'USER_ONLY' });
    }
    expect((await call('obsidian', 'POST', `/api/projects/${pid}/workbook/write`, body)).statusCode).toBe(403);
    expect((await call(null, 'POST', `/api/projects/${pid}/workbook/write`, body)).statusCode).toBe(401);
    // an AI client is refused before its request is even looked at
    expect((await call('claude-code', 'POST', `/api/projects/${pid}/workbook/write`, {})).statusCode).toBe(403);
    expect(snapshot(vault)).toEqual(before);
    expect(backups(pid)).toEqual([]);
    expect(writeRows()).toEqual([]);
    // the same request from the user goes through
    expect(multipleOf(await write(pid, body as WorkbookWriteRequest)).value).toBe(30);
  });

  it('lets only one of two writes from the same page through', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const body = (value: number) => ({ baseSha: v.file!.sha256, changes: [{ sheet: MODEL, address: multipleOf(v).cell, value }], statusChanges: [] });
    const [a, b] = await Promise.all([call('user', 'POST', `/api/projects/${pid}/workbook/write`, body(30)), call('user', 'POST', `/api/projects/${pid}/workbook/write`, body(31))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(writeRows()).toHaveLength(1);
    expect([30, 31]).toContain(cellOf(fs.readFileSync(file), multipleOf(v).cell).value);
    expect(fs.existsSync(tempPathFor(file))).toBe(false);
  });
});

describe('when something fails after the new file is in place', () => {
  const context = (pid: string, afterRename: () => void): WriteContext => ({ db: ctx.db, dataDir, projectId: pid, relPath: REL, absPath: file, fileDeps: defaultFileDeps, load: loadWorkbook, afterRename });
  const request = (): WorkbookWriteRequest => ({ baseSha: sha256Hex(original), changes: [{ sheet: MODEL, address: 'B82', value: 30 }], statusChanges: [] });
  async function failure(run: Promise<unknown>) {
    try {
      await run;
    } catch (e) {
      return e as { status: number; message: string; details: { code: string; restored: boolean; backupFile: string; reason: string } };
    }
    throw new Error('the write went through');
  }

  it('puts the backup back and reports it; nothing is recorded', async () => {
    const pid = await newProject();
    let seen: Buffer | null = null;
    const e = await failure(
      runAs('user', () =>
        writeBack(
          context(pid, () => {
            // the new file really was in place
            seen = fs.readFileSync(file);
            throw new Error('the disk said no');
          }),
          request(),
        ),
      ),
    );
    expect(e.status).toBe(500);
    expect(e.details).toMatchObject({ code: 'WRITE_FAILED', restored: true, reason: 'the disk said no' });
    expect(e.message).toContain('put back as it was before');
    expect(cellOf(seen!, 'B82').value).toBe(30);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(fs.existsSync(tempPathFor(file))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, e.details.backupFile)).equals(original)).toBe(true);
    expect(writeRows()).toEqual([]);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'workbook'").get()).toEqual({ n: 0 });
  });

  it('also when the file read back is not the one written', async () => {
    const pid = await newProject();
    const e = await failure(runAs('user', () => writeBack(context(pid, () => fs.appendFileSync(file, 'x')), request())));
    expect(e.details).toMatchObject({ code: 'WRITE_FAILED', restored: true });
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(writeRows()).toEqual([]);
  });

  it('and when recording the write fails', async () => {
    const pid = await newProject();
    // no such project: the row cannot be inserted
    const e = await failure(runAs('user', () => writeBack({ ...context(pid, () => undefined), projectId: 'prj_missing' }, request())));
    expect(e.details).toMatchObject({ code: 'WRITE_FAILED', restored: true });
    expect(fs.readFileSync(file).equals(original)).toBe(true);
  });

  it('a check that fails before the rename leaves no temp file behind', async () => {
    const pid = await newProject();
    const e = await failure(runAs('user', () => writeBack(context(pid, () => undefined), { ...request(), baseSha: 'f'.repeat(64) })));
    expect(e).toMatchObject({ status: 409, details: { code: 'FILE_CHANGED' } });
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([CRWD, '研究筆記.md'].sort());
  });
});

describe('backups of the original', () => {
  it(`keep the newest ${BACKUPS_KEPT} of a company and never touch another company's`, () => {
    const other = backupOriginal(dataDir, 'prj_other', CRWD, Buffer.from('other'), new Date(2026, 0, 1, 0, 0, 0));
    const made: string[] = [];
    for (let i = 0; i < BACKUPS_KEPT + 5; i++) made.push(backupOriginal(dataDir, 'prj_a', CRWD, Buffer.from(`version ${i}`), new Date(2026, 10, 23, 9, 0, i)));
    const kept = fs.readdirSync(backupDirFor(dataDir, 'prj_a')).sort();
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept).toEqual(made.slice(5).map((f) => path.basename(f)));
    expect(fs.readFileSync(made[made.length - 1], 'utf8')).toBe(`version ${BACKUPS_KEPT + 4}`);
    expect(fs.readFileSync(other, 'utf8')).toBe('other');
    // a file that is not a backup of this kind is not rotated away
    fs.writeFileSync(path.join(backupDirFor(dataDir, 'prj_a'), '我自己放的.xlsx'), 'mine');
    backupOriginal(dataDir, 'prj_a', CRWD, Buffer.from('one more'), new Date(2026, 10, 23, 9, 5, 0));
    expect(fs.existsSync(path.join(backupDirFor(dataDir, 'prj_a'), '我自己放的.xlsx'))).toBe(true);
    expect(fs.readdirSync(backupDirFor(dataDir, 'prj_a'))).toHaveLength(BACKUPS_KEPT + 1);
  });

  it('two within one second get two files, the later one sorting last', () => {
    const at = new Date(2026, 10, 23, 9, 0, 0);
    const a = backupOriginal(dataDir, 'prj_a', CRWD, Buffer.from('a'), at);
    const b = backupOriginal(dataDir, 'prj_a', CRWD, Buffer.from('b'), at);
    expect(path.basename(a)).toBe(`20261123-090000-${CRWD}`);
    expect(path.basename(b)).toBe(`20261123-090000_02-${CRWD}`);
    expect([path.basename(b), path.basename(a)].sort()).toEqual([path.basename(a), path.basename(b)]);
    expect(fs.readFileSync(a, 'utf8')).toBe('a');
  });

  it('a project id cannot name a folder outside the backups', () => {
    expect(path.relative(dataDir, backupDirFor(dataDir, '../../etc'))).toBe(path.join('workbook-backups', '______etc'));
  });
});

describe('an older version of the file put back (iCloud)', () => {
  it('is noticed, and the cells of the lost write are offered again', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const multiple = multipleOf(v);
    const yao = needing(v);
    const written = await write(pid, { baseSha: v.file!.sha256!, changes: [{ sheet: MODEL, address: multiple.cell, value: 30 }], statusChanges: [{ sheet: MODEL, address: yao.statusCell!, to: '已定' }] });
    expect(written.revert).toBeNull();
    expect((await view(pid)).revert).toBeNull();

    // iCloud puts the version from before the write back
    fs.writeFileSync(file, original);
    const back = await view(pid);
    expect(multipleOf(back).value).toBe(25);
    expect(back.revert).toEqual({
      writtenAt: expect.any(String),
      writes: 1,
      changes: [{ id: multiple.id, sheet: MODEL, address: multiple.cell, label: multiple.label, value: 30 }],
      statusChanges: [{ id: yao.id, sheet: MODEL, address: yao.statusCell, label: yao.label }],
    });

    // writing them again clears the notice
    const again = await write(pid, { baseSha: back.file!.sha256!, changes: back.revert!.changes.map((c) => ({ sheet: c.sheet, address: c.address, value: c.value })), statusChanges: back.revert!.statusChanges.map((c) => ({ sheet: c.sheet, address: c.address, to: '已定' as const })) });
    expect(again.revert).toBeNull();
    expect(multipleOf(again).value).toBe(30);
    expect(again.file!.sha256).toBe(written.file!.sha256);
  });

  it('offers the cells of every write that is gone, the later value winning', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const multiple = multipleOf(v);
    const growth = v.assumptions.find((a) => a.label.includes('台數') && a.low === 0.12)!;
    const first = await write(pid, { baseSha: v.file!.sha256!, changes: [{ sheet: MODEL, address: multiple.cell, value: 28 }, { sheet: MODEL, address: growth.cell, value: 0.18 }], statusChanges: [] });
    const afterFirst = fs.readFileSync(file);
    await write(pid, { baseSha: first.file!.sha256!, changes: [{ sheet: MODEL, address: multiple.cell, value: 30 }], statusChanges: [] });

    fs.writeFileSync(file, original);
    const all = (await view(pid)).revert!;
    expect(all.writes).toBe(2);
    expect(all.changes.map((c) => [c.address, c.value])).toEqual([[multiple.cell, 30], [growth.cell, 0.18]]);

    // back to the state between the two writes: only the second is gone
    fs.writeFileSync(file, afterFirst);
    const one = (await view(pid)).revert!;
    expect(one.writes).toBe(1);
    expect(one.changes.map((c) => [c.address, c.value])).toEqual([[multiple.cell, 30]]);
  });

  it('says nothing for a file that was simply edited, or for another file', async () => {
    const pid = await newProject();
    const v = await link(pid);
    await write(pid, { baseSha: v.file!.sha256!, changes: [{ sheet: MODEL, address: multipleOf(v).cell, value: 30 }], statusChanges: [] });
    // saved again by Excel: neither the state before the write nor the one after
    fs.copyFileSync(path.join(FIXTURES, 'CRWD_無計算結果.xlsx'), file);
    expect((await view(pid)).revert).toBeNull();
    // the same bytes under another name were never written by this app
    fs.writeFileSync(path.join(vault, '個股', 'CRWD', '另一份.xlsx'), original);
    const other = await api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/link`, { path: '個股/CRWD/另一份.xlsx' });
    expect(other.revert).toBeNull();
  });
});

describe('a folder the server may read and not write', () => {
  it('a temp file that cannot be made is reported, with the file as it was and nothing of the user removed', async () => {
    const pid = await newProject();
    const v = await link(pid);
    // the user has a folder with exactly the temp file's name
    fs.mkdirSync(tempPathFor(file));
    fs.writeFileSync(path.join(tempPathFor(file), '我的檔.txt'), 'mine');
    const r = await refused(pid, { baseSha: v.file!.sha256, changes: [{ sheet: MODEL, address: multipleOf(v).cell, value: 30 }], statusChanges: [] }, 500);
    expect(r).toMatchObject({ code: 'WRITE_FAILED', details: { restored: true } });
    expect(r.error).toContain('The file was not changed');
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(fs.readFileSync(path.join(tempPathFor(file), '我的檔.txt'), 'utf8')).toBe('mine');
    expect(writeRows()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('is reported as 403 WRITE_DENIED, with the file as it was', async () => {
    const pid = await newProject();
    const v = await link(pid);
    fs.chmodSync(path.dirname(file), 0o555);
    try {
      const r = await refused(pid, { baseSha: v.file!.sha256, changes: [{ sheet: MODEL, address: multipleOf(v).cell, value: 30 }], statusChanges: [] }, 403);
      expect(r).toMatchObject({ code: 'WRITE_DENIED', details: { reason: 'EACCES' } });
      expect(fs.readFileSync(file).equals(original)).toBe(true);
      expect(writeRows()).toEqual([]);
    } finally {
      fs.chmodSync(path.dirname(file), 0o755);
    }
  });
});

describe('the temp file and the file itself', () => {
  const body = (v: WorkbookViewDTO) => ({ baseSha: v.file!.sha256!, changes: [{ sheet: MODEL, address: multipleOf(v).cell, value: 30 }], statusChanges: [] });
  afterEach(() => vi.restoreAllMocks());

  it('a file marked read-only is not replaced (403 FILE_READ_ONLY), and nothing is copied or left behind', async () => {
    const pid = await newProject();
    const v = await link(pid);
    fs.chmodSync(file, 0o444);
    const before = snapshot(vault);
    const r = await refused(pid, body(v), 403);
    expect(r).toMatchObject({ code: 'FILE_READ_ONLY' });
    expect(snapshot(vault)).toEqual(before);
    expect(backups(pid)).toEqual([]);
    expect(writeRows()).toEqual([]);
    // writable again: the same request goes through and the mode is kept
    fs.chmodSync(file, 0o600);
    await write(pid, body(v));
    expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
    expect(cellOf(fs.readFileSync(file), 'B82').value).toBe(30);
  });

  it('a link at the temp file\'s name is not written through: the file it points at, the link and the workbook stay as they were', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const outside = path.join(dir, '別的地方.txt');
    fs.writeFileSync(outside, 'not the workbench\'s');
    fs.symlinkSync(outside, tempPathFor(file));
    const r = await refused(pid, body(v), 500);
    expect(r).toMatchObject({ code: 'WRITE_FAILED', details: { restored: true } });
    expect(fs.readFileSync(outside, 'utf8')).toBe('not the workbench\'s');
    expect(fs.lstatSync(tempPathFor(file)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(writeRows()).toEqual([]);
    // a link to a file that does not exist yet is not followed either
    fs.rmSync(tempPathFor(file));
    fs.symlinkSync(path.join(dir, '還沒有.txt'), tempPathFor(file));
    await refused(pid, body(v), 500);
    expect(fs.existsSync(path.join(dir, '還沒有.txt'))).toBe(false);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
  });

  it('what an interrupted write left at the temp file\'s name is overwritten and gone after the next write', async () => {
    const pid = await newProject();
    const v = await link(pid);
    // a crash between writing the temp file and the rename leaves this
    fs.writeFileSync(tempPathFor(file), Buffer.concat([original, Buffer.alloc(50_000, 7)]));
    const names = fs.readdirSync(path.dirname(file)).filter((n) => n !== path.basename(tempPathFor(file))).sort();
    await write(pid, body(v));
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(names);
    const now = fs.readFileSync(file);
    expect(cellOf(now, 'B82').value).toBe(30);
    expect(fs.readFileSync(path.join(backupDirFor(dataDir, pid), backups(pid)[0])).equals(original)).toBe(true);
  });

  it('a write the disk takes in pieces is finished; one that ends up short never replaces the file', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const real = fs.writeSync.bind(fs) as (fd: number, buffer: Buffer, offset: number, length: number) => number;
    // the disk takes 1000 bytes per call
    const pieces = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) => real(fd, buffer, offset, Math.min(length, 1000))) as typeof fs.writeSync);
    const after = await write(pid, body(v));
    expect(pieces.mock.calls.length).toBeGreaterThan(20);
    const written = fs.readFileSync(file);
    expect(sha256Hex(written)).toBe(after.file!.sha256);
    expect(cellOf(written, 'B82').value).toBe(30);
    expect(after.selfCheck).toMatchObject({ state: 'verified' });
    pieces.mockRestore();

    // the disk says it took everything and kept half (full disk, a sync folder that lies): the copy of the original is checked first
    const next = { ...body(after), changes: [{ sheet: MODEL, address: 'B82', value: 31 }] };
    const lying = (only: (buffer: Buffer) => boolean) =>
      vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) => {
        if (!only(buffer)) return real(fd, buffer, offset, length);
        real(fd, buffer, offset, Math.floor(length / 2));
        return length;
      }) as typeof fs.writeSync);
    const all = lying(() => true);
    const kept = backups(pid);
    expect(await refused(pid, next, 500)).toMatchObject({ code: 'BACKUP_FAILED' });
    expect(backups(pid)).toEqual(kept);
    expect(fs.readFileSync(file).equals(written)).toBe(true);
    all.mockRestore();
    // and so is the new file, before it goes over the old one
    lying((buffer) => !buffer.equals(written));
    const before = snapshot(vault);
    const r = await refused(pid, { ...body(after), changes: [{ sheet: MODEL, address: 'B82', value: 31 }] }, 500);
    expect(r).toMatchObject({ code: 'WRITE_FAILED', details: { restored: true } });
    expect(r.error).toContain('The file was not changed');
    expect(snapshot(vault)).toEqual(before);
    expect(fs.readFileSync(file).equals(written)).toBe(true);
    expect(writeRows().length).toBe(1);
    expect(fs.readFileSync(path.join(backupDirFor(dataDir, pid), backups(pid).at(-1)!)).equals(written)).toBe(true);
  });
});
