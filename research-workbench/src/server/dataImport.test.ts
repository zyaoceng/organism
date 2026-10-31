import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setValue } from '../domain/model/ops';
import { SCALAR_KEY } from '../domain/model/types';
import { idByName } from '../domain/testing/sample';
import type { EvidenceDTO, ProjectBundleDTO } from '../shared/api';
import { buildApp, type AppContext } from './app';
import { SCHEMA_VERSION } from './db/migrations';
import { DemoProvider } from './market/demo';
import { ImportError, importData, type ImportSummary } from './services/dataImport';
import { APP_ROOT } from './version';

let dir: string;
/** Archive made the way the user guide says: online backup wb.db + data/attachments. */
let archive: string;
/** Raw copy of data/ taken while the server was running (workbench.db + -wal), one level deeper. */
let rawArchive: string;
/** Staged trees the archives were made from, for tampered variants. */
let codespace: string;
let png: Buffer;
let n = 0;

const providers = () => [new DemoProvider(() => '2026-09-25')];
const fresh = (name: string) => path.join(dir, `${name}-${++n}`);
const tar = (cwd: string, out: string, members: string[]) => execFileSync('tar', ['czf', out, ...members], { cwd });

async function api<T>(ctx: AppContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const res = await ctx.app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${ctx.tokens.tokens.user}` } });
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

async function upload(ctx: AppContext, url: string, filename: string, data: Buffer): Promise<EvidenceDTO> {
  const boundary = '----wbimport';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="publishedAt"\r\n\r\n2026-09-01\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await ctx.app.inject({ method: 'POST', url, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${ctx.tokens.tokens.user}` } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json() as EvidenceDTO;
}

async function newProject(ctx: AppContext, name: string, ticker: string): Promise<string> {
  const { id } = await api<{ id: string }>(ctx, 'POST', '/api/projects', { name, year: 2026, security: { ticker, currency: 'TWD', priceSource: 'demo' } });
  return id;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-import-test-'));
  codespace = path.join(dir, 'codespace');
  const dataDir = path.join(codespace, 'data');
  png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const ctx = await buildApp({ dataDir, providers: providers() });
  try {
    const pid = await newProject(ctx, 'Lite-On Technology', '2301');
    await upload(ctx, `/api/projects/${pid}/evidence`, '客戶認證截圖.png', png);
    const b = await api<ProjectBundleDTO>(ctx, 'GET', `/api/projects/${pid}`);
    const s = setValue(b.draft.state, idByName(b.draft.state, 'Target P/E'), SCALAR_KEY, 'base', 25);
    const d = await api<{ version: number }>(ctx, 'PUT', `/api/projects/${pid}/draft`, { state: s, version: b.draft.version });
    await api(ctx, 'POST', `/api/projects/${pid}/revisions`, { title: 'Initiation', reason: 'Initial model', asOfDate: '2026-09-20', draftVersion: d.version });
    await api(ctx, 'POST', `/api/projects/${pid}/trades`, { entryDate: '2026-09-21', entryPrice: 100, quantity: 1000, stopAtEntry: 90 });

    await ctx.db.backup(path.join(codespace, 'wb.db'));
    archive = path.join(dir, 'wb-data.tgz');
    tar(codespace, archive, ['wb.db', 'data/attachments']);

    // copied while open: the latest changes are still in the write-ahead log
    const raw = path.join(dir, 'raw', 'workspaces', 'research-workbench', 'data');
    fs.mkdirSync(raw, { recursive: true });
    for (const f of ['workbench.db', 'workbench.db-wal', 'workbench.db-shm']) fs.copyFileSync(path.join(dataDir, f), path.join(raw, f));
    expect(fs.statSync(path.join(raw, 'workbench.db-wal')).size).toBeGreaterThan(0);
    fs.cpSync(path.join(dataDir, 'attachments'), path.join(raw, 'attachments'), { recursive: true });
    rawArchive = path.join(dir, 'raw.tgz');
    tar(path.join(dir, 'raw'), rawArchive, ['workspaces']);
  } finally {
    await ctx.app.close();
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const expectedProject = { name: 'Lite-On Technology', ticker: '2301', revisions: 2, lastAsOfDate: '2026-09-20', trades: 1, evidence: 1 };

/** Open the imported data directory the way the server does and read the attachment back. */
async function readBack(dataDir: string) {
  const ctx = await buildApp({ dataDir, providers: providers() });
  try {
    const projects = await api<{ id: string; name: string }[]>(ctx, 'GET', '/api/projects');
    const evidence = await api<EvidenceDTO[]>(ctx, 'GET', `/api/projects/${projects[0].id}/evidence`);
    const content = await ctx.app.inject({ method: 'GET', url: evidence[0].attachments[0].url });
    return { projects: projects.map((p) => p.name), filename: evidence[0].attachments[0].originalFilename, bytes: content.rawPayload };
  } finally {
    await ctx.app.close();
  }
}

/** Make an archive from a modified copy of the Codespaces tree. */
function tampered(change: (root: string) => void, members = ['wb.db', 'data/attachments']): string {
  const root = fresh('tampered');
  fs.cpSync(codespace, root, { recursive: true });
  change(root);
  const out = `${root}.tgz`;
  tar(root, out, members.filter((m) => fs.existsSync(path.join(root, m))));
  return out;
}

async function rejection(p: Promise<unknown>): Promise<ImportError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ImportError);
  return e as ImportError;
}

describe('importing a data archive', () => {
  it('imports the archive from the user guide into an empty data directory', async () => {
    const dataDir = fresh('mac');
    const tmpDir = fresh('tmp');
    fs.mkdirSync(tmpDir);
    const r = await importData({ archive, dataDir, tmpDir });
    expect(r.imported).toBe(true);
    expect(r.backupFile).toBeNull();
    expect(r.copiedAttachments).toBe(1);
    expect(r.summary).toEqual({ projects: [{ ...expectedProject, lastCommitAt: expect.any(String) }], attachments: 1, schemaVersion: SCHEMA_VERSION, hadWal: false } satisfies ImportSummary);
    expect(fs.readdirSync(tmpDir)).toEqual([]); // staging removed
    expect(fs.readdirSync(dataDir).sort()).toEqual(['attachments', 'workbench.db']); // one file, no -wal/-shm
    // a new generation: browser tabs opened on the copied database reload instead of saving into this one
    const generation = (file: string) => {
      const db = new Database(file, { readonly: true });
      try {
        return (db.prepare('SELECT db_generation FROM db_meta').get() as { db_generation: string }).db_generation;
      } finally {
        db.close();
      }
    };
    expect(generation(path.join(dataDir, 'workbench.db'))).toMatch(/^[0-9a-f]{32}$/);
    expect(generation(path.join(dataDir, 'workbench.db'))).not.toBe(generation(path.join(codespace, 'wb.db')));
    const back = await readBack(dataDir);
    expect(back.projects).toEqual(['Lite-On Technology']);
    expect(back.filename).toBe('客戶認證截圖.png');
    expect(back.bytes.equals(png)).toBe(true);
  });

  it('applies the write-ahead log of a database copied while the server was running', async () => {
    const dataDir = fresh('mac');
    const r = await importData({ archive: rawArchive, dataDir });
    expect(r.summary.hadWal).toBe(true);
    expect(r.summary.projects).toEqual([{ ...expectedProject, lastCommitAt: expect.any(String) }]);
    expect((await readBack(dataDir)).bytes.equals(png)).toBe(true);
  });

  it('only summarises with summaryOnly', async () => {
    const dataDir = fresh('mac');
    const r = await importData({ archive, dataDir, summaryOnly: true });
    expect(r.imported).toBe(false);
    expect(r.summary.projects[0].name).toBe('Lite-On Technology');
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('rejects a damaged archive or database, a missing attachment and a hash mismatch', async () => {
    const dataDir = fresh('mac');
    const tmpDir = fresh('tmp');
    fs.mkdirSync(tmpDir);
    const truncated = fresh('truncated.tgz');
    fs.writeFileSync(truncated, fs.readFileSync(archive).subarray(0, 200));
    expect((await rejection(importData({ archive: truncated, dataDir, tmpDir }))).message).toMatch(/Could not extract/);

    const garbage = tampered((root) => fs.writeFileSync(path.join(root, 'wb.db'), 'not a database '.repeat(400)));
    expect((await rejection(importData({ archive: garbage, dataDir, tmpDir }))).message).toMatch(/wb\.db is damaged or is not a database/);

    const noFiles = tampered(() => {}, ['wb.db']);
    expect((await rejection(importData({ archive: noFiles, dataDir, tmpDir }))).message).toMatch(/1 attachment file\(s\) are missing from the archive: 客戶認證截圖\.png/);

    const changed = tampered((root) => {
      const [aa] = fs.readdirSync(path.join(root, 'data/attachments'));
      const [file] = fs.readdirSync(path.join(root, 'data/attachments', aa));
      fs.appendFileSync(path.join(root, 'data/attachments', aa, file), 'x');
    });
    expect((await rejection(importData({ archive: changed, dataDir, tmpDir }))).message).toMatch(/do not match their recorded SHA-256/);

    const empty = tampered((root) => fs.rmSync(path.join(root, 'wb.db')));
    expect((await rejection(importData({ archive: empty, dataDir, tmpDir }))).message).toMatch(/no database/);
    await rejection(importData({ archive: path.join(dir, 'nowhere.tgz'), dataDir, tmpDir }));

    expect(fs.readdirSync(tmpDir)).toEqual([]); // staging removed after every failure
    expect(fs.existsSync(dataDir)).toBe(false); // the target was never touched
  });

  it('keeps a data directory that already has companies unless forced, and backs it up first', async () => {
    const dataDir = fresh('mac');
    const other = Buffer.from('another file');
    const ctx = await buildApp({ dataDir, providers: providers() });
    const pid = await newProject(ctx, 'Delta Electronics', '2308');
    await upload(ctx, `/api/projects/${pid}/evidence`, 'delta.png', other);
    await ctx.app.close();

    const e = await rejection(importData({ archive, dataDir, now: () => new Date(2026, 9, 30, 12, 0, 0) }));
    expect(e.exitCode).toBe(2);
    expect(e.message).toMatch(/already holds 1 company.*--force/);
    expect((await readBack(dataDir)).projects).toEqual(['Delta Electronics']);

    const r = await importData({ archive, dataDir, force: true, now: () => new Date(2026, 9, 30, 12, 0, 0) });
    expect(r.backupFile).toBe(path.join(dataDir, 'backups', 'pre-import-20261030-120000.db'));
    const saved = new Database(r.backupFile!, { readonly: true });
    expect(saved.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'Delta Electronics' }]);
    saved.close();
    expect((await readBack(dataDir)).projects).toEqual(['Lite-On Technology']);
    // attachments already in the target are never deleted
    expect(fs.readdirSync(path.join(dataDir, 'attachments')).length).toBe(2);
    expect(fs.readdirSync(path.join(dataDir)).sort()).toEqual(['attachments', 'backups', 'tokens.json', 'workbench.db']);
  });

  it('refuses to replace a database that a running server still has open', async () => {
    const dataDir = fresh('mac');
    const ctx = await buildApp({ dataDir, providers: providers() });
    try {
      await newProject(ctx, 'Delta Electronics', '2308');
      const e = await rejection(importData({ archive, dataDir, force: true }));
      expect(e.exitCode).toBe(1);
      expect(e.message).toMatch(/open in another program/);
      expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false);
      expect((await api<{ name: string }[]>(ctx, 'GET', '/api/projects')).map((p) => p.name)).toEqual(['Delta Electronics']);
    } finally {
      await ctx.app.close();
    }
    // once it is stopped the import goes ahead
    expect((await importData({ archive, dataDir, force: true })).imported).toBe(true);
    expect((await readBack(dataDir)).projects).toEqual(['Lite-On Technology']);
  });
});

describe('import-data CLI', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/server/cli/import-data.ts', ...args], { cwd: APP_ROOT, encoding: 'utf8' });

  it('prints the summary as the last line and exits 2 for a data directory that has companies', () => {
    const dataDir = fresh('mac');
    const summary = cli('--archive', archive, '--summary-only');
    expect(summary.status).toBe(0);
    expect(JSON.parse(summary.stdout.trim()).projects[0].name).toBe('Lite-On Technology');

    const first = cli('--archive', archive, '--data-dir', dataDir);
    expect(first.status).toBe(0);
    const last = JSON.parse(first.stdout.trim().split('\n').at(-1)!) as ImportSummary;
    expect(last).toMatchObject({ attachments: 1, schemaVersion: SCHEMA_VERSION, hadWal: false, projects: [expectedProject] });

    const again = cli('--archive', archive, '--data-dir', dataDir);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already holds 1 company/);
    expect(cli('--archive', archive, '--data-dir', dataDir, '--force').status).toBe(0);
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toHaveLength(1);

    expect(cli('--data-dir', dataDir).status).toBe(1);
    expect(cli('--archive', path.join(dir, 'nowhere.tgz'), '--data-dir', dataDir).stderr).toMatch(/Archive not found/);
  }, 30_000);
});
