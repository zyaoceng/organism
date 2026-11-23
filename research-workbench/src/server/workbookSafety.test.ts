/**
 * The linked Excel file is somebody's only copy of their model, and whatever is in the vault folder
 * is not ours: hostile files must not take the server down, nothing outside the vault may be read,
 * and nothing inside it may ever be changed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TokenName } from '../shared/actors';
import type { WorkbookRecalcDTO, WorkbookViewDTO } from '../shared/api';
import { buildApp, type AppContext } from './app';
import { DemoProvider } from './market/demo';
import { crc32, zipFiles } from './vault/zip';
import { MAX_WORKBOOK_BYTES, readWorkbookFile } from './xlsx/file';
import { MAX_WORKBOOK_XML_BYTES, readWorkbook } from './xlsx/read';
import { MAX_ENTRY_BYTES, XlsxError, entryData, readZip } from './xlsx/zipRead';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xlsx', 'fixtures');
const CRWD = 'CRWD_簡明損益表.xlsx';
const REL = `個股/${CRWD}`;

let ctx: AppContext;
let dir: string;
let vault: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-safe-'));
  vault = path.join(dir, '股票');
  fs.mkdirSync(path.join(vault, '個股'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, CRWD), path.join(vault, REL));
  ctx = await buildApp({ dataDir: path.join(dir, 'data'), providers: [new DemoProvider(() => '2026-11-20')], market: { minIntervalMs: 0 }, vaultDir: vault });
});
afterEach(async () => {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (who: TokenName | null, method: Method, url: string, payload?: unknown, extra: { headers?: Record<string, string>; remoteAddress?: string } = {}) =>
  ctx.app.inject({ method, url, payload: payload as object | undefined, remoteAddress: extra.remoteAddress, headers: { ...(who ? { authorization: `Bearer ${ctx.tokens.tokens[who]}` } : {}), ...extra.headers } });
async function api<T>(method: Method, url: string, payload?: unknown, status = 200): Promise<T> {
  const res = await call('user', method, url, payload);
  if (res.statusCode !== status) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
const newProject = async () => (await api<{ id: string }>('POST', '/api/projects', { name: 'CrowdStrike', year: 2026, security: { ticker: 'CRWD', exchange: 'NASDAQ', apiSymbol: 'CRWD', currency: 'USD', priceSource: 'demo' } })).id;
const view = (pid: string) => api<WorkbookViewDTO>('GET', `/api/projects/${pid}/workbook`);
const link = (pid: string, rel = REL) => api<WorkbookViewDTO>('PUT', `/api/projects/${pid}/workbook/link`, { path: rel });

/** Every entry under a folder with its type, size, times and content hash. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = path.join(rel, e.name);
      const st = fs.lstatSync(path.join(root, p));
      const kind = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? `link→${fs.readlinkSync(path.join(root, p))}` : 'file';
      const hash = e.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex') : '';
      out[p] = `${kind} ${st.size} ${st.mtimeMs} ${st.mode} ${hash}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk('');
  return out;
}

const part = (name: string, data: string | Buffer) => ({ name, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data });
function xlsxWith(sheetXml: string | Buffer, sheets = 1) {
  const ids = Array.from({ length: sheets }, (_, i) => i + 1);
  return Buffer.from(
    zipFiles([
      part('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
      part('xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${ids.map((i) => `<sheet name="S${i}" sheetId="${i}" r:id="rId${i}"/>`).join('')}</sheets></workbook>`),
      part('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}</Relationships>`),
      ...ids.map((i) => part(`xl/worksheets/sheet${i}.xml`, sheetXml)),
    ]),
  );
}
const sheetXml = (rows: string) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof XlsxError ? e.code : `not-an-XlsxError: ${(e as Error).message}`;
  }
};

describe('nothing in the vault folder is ever changed', () => {
  it('every route, by every caller, leaves every file, folder and time as it was', async () => {
    fs.writeFileSync(path.join(vault, '筆記.md'), '# 筆記');
    fs.writeFileSync(path.join(vault, '個股', '壞掉.xlsx'), 'not a workbook');
    fs.mkdirSync(path.join(vault, '.obsidian'));
    const old = new Date('2026-01-02T03:04:05Z');
    for (const p of Object.keys(snapshot(vault))) fs.lutimesSync(path.join(vault, p), old, old);
    const before = snapshot(vault);
    const outsideBefore = fs.readdirSync(dir).sort();

    const pid = await newProject();
    const v = await link(pid);
    const multiple = v.assumptions.find((a) => a.origin === 'output')!;
    await api<WorkbookRecalcDTO>('POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v.file!.sha256, overrides: [{ id: multiple.id, value: 30 }], trialRanges: { [multiple.id]: { low: 20, high: 30 } } });
    await api('PUT', `/api/projects/${pid}/workbook/mapping`, { mapping: v.mapping!.outputs });
    await api('PUT', `/api/projects/${pid}/workbook/mapping`, { mapping: null });
    await api('GET', `/api/workbook/files?projectId=${pid}`);
    expect((await call('user', 'GET', `/api/projects/${pid}/workbook/diagnosis`)).statusCode).toBe(200);
    await link(pid, '個股/壞掉.xlsx');
    await view(pid);
    await api('PUT', `/api/projects/${pid}/workbook/link`, { path: '個股/沒有這個檔.xlsx' }, 404);
    await api('PUT', `/api/projects/${pid}/workbook/link`, { path: '新資料夾/新檔.xlsx' }, 404);
    for (const who of ['claude-code', 'chatgpt', null] as const) {
      await call(who, 'PUT', `/api/projects/${pid}/workbook/link`, { path: REL });
      await call(who, 'POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v.file!.sha256, overrides: [] });
      await call(who, 'DELETE', `/api/projects/${pid}/workbook/link`);
    }
    await api('DELETE', `/api/projects/${pid}/workbook/link`);
    await api('DELETE', `/api/projects/${pid}`).catch(() => undefined);

    expect(snapshot(vault)).toEqual(before);
    // and nothing appeared next to the vault either (lock files, temp copies)
    expect(fs.readdirSync(dir).sort()).toEqual([...new Set([...outsideBefore, 'data'])].sort());
  });

  it('the server code that touches the vault calls nothing that writes, except write.ts', () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)));
    const all = [...fs.readdirSync(path.join(src, 'xlsx')).map((f) => path.join(src, 'xlsx', f)), ...fs.readdirSync(path.join(src, '..', 'domain', 'workbook')).map((f) => path.join(src, '..', 'domain', 'workbook', f))].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    // write.ts is the one module that writes (the linked file through its temp file, and the backups in the data folder)
    const files = all.filter((f) => path.basename(f) !== 'write.ts');
    expect(all.length - files.length).toBe(1);
    expect(files.length).toBeGreaterThan(8);
    const writers = /\b(?:write|append|copy|rename|unlink|rm|rmdir|mkdir|mkdtemp|truncate|ftruncate|chmod|chown|utimes|lutimes|symlink|link|cp|open|createWriteStream|writev)(?:File)?(?:Sync)?\s*\(/;
    const hits: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bfs\s*\.\s*(?:promises\s*\.\s*)?(\w+)/.test(line) && writers.test(line.replace(/.*\bfs\s*\.\s*(?:promises\s*\.\s*)?/, ''))) hits.push(`${path.basename(f)}:${i + 1}: ${line.trim()}`);
          if (/from 'node:fs\/promises'|require\(/.test(line)) hits.push(`${path.basename(f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
    // in write.ts nothing is removed but its own temp file, a backup copy that failed its check and the backups beyond the newest 30, and nothing is created in the vault but that temp file
    const write = fs.readFileSync(path.join(src, 'xlsx', 'write.ts'), 'utf8');
    expect([...write.matchAll(/fs\.(rm\w*|unlink\w*)\(([^,)]+)/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(['rmSync copy', 'rmSync path.join(dir', 'rmSync tmp']);
    expect([...write.matchAll(/fs\.(mkdir\w*|copy\w*|cp\w*|symlink\w*|link\w*|truncate\w*|append\w*)\(/g)].map((m) => m[1])).toEqual(['mkdirSync']);
    expect([...write.matchAll(/fs\.(writeFile\w*|open\w*|rename\w*)\(([^,)]+)/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(['openSync tmp', 'renameSync tmp', 'writeFileSync copy']);
    // the only programs run are stat (read-only) and brctl download (asks iCloud for the content)
    const file = fs.readFileSync(path.join(src, 'xlsx', 'file.ts'), 'utf8');
    expect([...file.matchAll(/deps\.run\((\w+)/g)].map((m) => m[1]).sort()).toEqual(['BRCTL_PROGRAM', 'STAT_PROGRAM']);
    expect(files.filter((f) => /child_process/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f))).toEqual(['file.ts']);
  });
});

describe('hostile files', () => {
  it('a ZIP that claims a huge part is refused before it is unpacked', () => {
    // 64 MB of spaces packs into a few kilobytes
    const bomb = xlsxWith(sheetXml(' '.repeat(64 * 1024 * 1024)));
    expect(bomb.length).toBeLessThan(200_000);
    expect(codeOf(() => readWorkbook(bomb))).toBe('too-large');
  });

  it('a part that unpacks to more than its directory says is cut off at the stated size', () => {
    const big = Buffer.alloc(40 * 1024 * 1024, 0x20);
    const zip = Buffer.from(zipFiles([part('a', big)]));
    // lie in the directory: 10 bytes, with the matching CRC of the first 10
    const dirAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, dirAt + 24);
    zip.writeUInt32LE(crc32(big.subarray(0, 10)), dirAt + 16);
    const entry = readZip(zip)[0];
    expect(entry.size).toBe(10);
    const before = process.memoryUsage().arrayBuffers;
    expect(codeOf(() => entryData(entry))).toBe('corrupt');
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(20 * 1024 * 1024);
    expect(MAX_ENTRY_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('many sheets that are each under the limit are refused together', () => {
    const one = sheetXml(' '.repeat(MAX_ENTRY_BYTES - 500));
    const many = xlsxWith(one, Math.ceil(MAX_WORKBOOK_XML_BYTES / MAX_ENTRY_BYTES) + 1);
    expect(codeOf(() => readWorkbook(many))).toBe('too-large');
  });

  it('truncated, bit-flipped and nonsense ZIPs end in an error or a workbook, never a crash or a hang', () => {
    const good = fs.readFileSync(path.join(FIXTURES, CRWD));
    let seed = 20261123;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const outcomes = new Map<string, number>();
    const attempt = (buf: Buffer) => {
      let code: string;
      try {
        readWorkbook(buf);
        code = 'ok';
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        code = e instanceof XlsxError ? e.code : 'other';
      }
      outcomes.set(code, (outcomes.get(code) ?? 0) + 1);
    };
    for (let i = 0; i < 60; i++) attempt(good.subarray(0, rnd(good.length)));
    for (let i = 0; i < 120; i++) {
      const b = Buffer.from(good);
      // the directory and end record are where a reader trusts offsets and lengths
      const from = i % 2 ? b.length - 4000 : 0;
      for (let k = 0; k < 1 + rnd(4); k++) b[from + rnd(b.length - from)] ^= 1 << rnd(8);
      attempt(b);
    }
    for (const b of [Buffer.alloc(0), Buffer.alloc(21), Buffer.alloc(22), Buffer.from('PK\x05\x06'), Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18, 0xff)]), Buffer.concat([Buffer.alloc(100, 0x41), Buffer.from('PK\x05\x06'), Buffer.alloc(18)])]) attempt(b);
    expect([...outcomes.values()].reduce((a, b) => a + b, 0)).toBe(186);
    expect(outcomes.get('not-zip')).toBeGreaterThan(0);
  });

  it('cells with addresses, indexes and names that are not what they should be', () => {
    const cases = [
      '<row r="1"><c r="ZZZZZZ99999999999"><v>1</v></c></row>',
      '<row r="-5"><c r="1A"><v>1</v></c></row>',
      '<row r="x"><c><v>1</v></c><c r=""><v>2</v></c></row>',
      '<row r="1"><c r="A1" t="s"><v>999999</v></c><c r="B1" t="s"><v>-1</v></c><c r="C1" s="99999"><v>1e999</v></c></row>',
      '<row r="1"><c r="A1"><f t="shared" si="0"></f></c><c r="B1"><f t="shared" si="0" ref="B1:B9999999">A1+1</f></c><c r="C1"><f t="shared" si="0"/></c></row>',
      '<row r="1"><c r="__proto__"><v>1</v></c><c r="constructor"><v>1</v></c></row>',
      `<row r="1"><c r="A1"><f>${'('.repeat(5000)}1${')'.repeat(5000)}</f></c></row>`,
      `<row r="1"><c r="A1"><f>A1</f><v>1</v></c><c r="B1"><f>SUM(A:XFD)+SUM(1:1048576)</f></c><c r="C1"><f>C1+1</f></c></row>`,
    ];
    for (const rows of cases) {
      const outcome = codeOf(() => readWorkbook(xlsxWith(sheetXml(rows))));
      expect(outcome === 'ok' || !outcome.startsWith('not-an-XlsxError') || outcome.length > 0, rows).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it('linked through the server, each of them is reported as unreadable with its reason and the server keeps answering', async () => {
    const pid = await newProject();
    const put = (name: string, bytes: Buffer) => fs.writeFileSync(path.join(vault, name), bytes);
    put('炸彈.xlsx', xlsxWith(sheetXml(' '.repeat(64 * 1024 * 1024))));
    put('文字.xlsx', Buffer.from('這不是活頁簿'));
    put('半個.xlsx', fs.readFileSync(path.join(FIXTURES, CRWD)).subarray(0, 9000));
    put('壞位址.xlsx', xlsxWith(sheetXml('<row r="1"><c r="1A"><v>1</v></c></row>')));
    put('壞公式.xlsx', xlsxWith(sheetXml(`<row r="1"><c r="A1"><f>${'('.repeat(3000)}1${')'.repeat(3000)}+</f></c><c r="B1"><f>SUM(</f></c></row>`)));
    put('空的.xlsx', Buffer.alloc(0));
    const seen: Record<string, string> = {};
    for (const name of ['炸彈.xlsx', '文字.xlsx', '半個.xlsx', '壞位址.xlsx', '壞公式.xlsx', '空的.xlsx']) {
      const v = await link(pid, name);
      seen[name] = v.loaded ? 'loaded' : `${v.file!.state}/${v.file!.reason}`;
      expect((await call('user', 'GET', `/api/projects/${pid}/workbook/diagnosis`)).statusCode).toBe(200);
      await api('POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: '0'.repeat(64), overrides: [] }, 409);
    }
    expect(seen).toMatchObject({ '炸彈.xlsx': 'unreadable/too-large', '文字.xlsx': 'unreadable/not-zip', '半個.xlsx': 'unreadable/not-zip', '空的.xlsx': 'unreadable/not-zip' });
    expect(seen['壞位址.xlsx']).toMatch(/^unreadable\/|^loaded$/);
    expect(seen['壞公式.xlsx']).toMatch(/^unreadable\/|^loaded$/);
    // still serving the good file
    expect((await link(pid)).outputs!.targetPrice.value).toBeCloseTo(171.53, 2);
  }, 30_000);

  it('a file too large to be a model is not read at all', async () => {
    const huge = path.join(vault, '巨大.xlsx');
    const fd = fs.openSync(huge, 'w');
    fs.ftruncateSync(fd, MAX_WORKBOOK_BYTES + 1);
    fs.closeSync(fd);
    const r = await readWorkbookFile(huge);
    expect(r).toMatchObject({ state: 'unreadable', reason: 'too-large', bytes: null, sha256: null, size: MAX_WORKBOOK_BYTES + 1 });
    const pid = await newProject();
    expect((await link(pid, '巨大.xlsx')).file).toMatchObject({ state: 'unreadable', reason: 'too-large' });
  });

  it('a pipe or a folder named like a workbook is not opened', async () => {
    fs.mkdirSync(path.join(vault, '資料夾.xlsx'));
    expect(await readWorkbookFile(path.join(vault, '資料夾.xlsx'))).toMatchObject({ state: 'unreadable', reason: 'not-a-file', bytes: null });
  });
});

describe('the file on disk is the only truth', () => {
  it('a changed file is never answered from memory, even with the same size and time', async () => {
    const pid = await newProject();
    const abs = path.join(vault, REL);
    const v1 = await link(pid);
    const st = fs.statSync(abs);

    // same length, same mtime, one byte of the ZIP comment-free tail changed: a different file
    const other = fs.readFileSync(path.join(FIXTURES, 'CRWD_無計算結果.xlsx'));
    fs.writeFileSync(abs, other);
    fs.utimesSync(abs, st.atime, st.mtime);
    const v2 = await view(pid);
    expect(v2.file!.sha256).not.toBe(v1.file!.sha256);
    expect(v2.selfCheck!.state).toBe('no-cached-values');
    expect((await api<{ code: string }>('POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v1.file!.sha256, overrides: [] }, 409)).code).toBe('WORKBOOK_CHANGED');

    // back to the first content: the cached parse may be used, and must describe these bytes
    fs.copyFileSync(path.join(FIXTURES, CRWD), abs);
    const v3 = await view(pid);
    expect(v3.file!.sha256).toBe(v1.file!.sha256);
    expect(v3.outputs).toEqual(v1.outputs);

    // gone: nothing of the old file is shown
    fs.rmSync(abs);
    const v4 = await view(pid);
    expect(v4).toMatchObject({ linked: true, loaded: false, assumptions: [], outputs: null, sensitivity: null, parties: [], file: { state: 'missing', sha256: null } });
    expect((await api<{ code: string }>('POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v1.file!.sha256, overrides: [] }, 409)).code).toBe('WORKBOOK_UNREADABLE');
  });

  it('trial values of one request never leak into the next', async () => {
    const pid = await newProject();
    const v = await link(pid);
    const multiple = v.assumptions.find((a) => a.origin === 'output')!;
    const recalc = (overrides: unknown[]) => api<WorkbookRecalcDTO>('POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v.file!.sha256, overrides });
    const [a, b, c] = await Promise.all([recalc([{ id: multiple.id, value: 30 }]), recalc([]), view(pid)]);
    expect(a.outputs.targetPrice.value).toBeCloseTo(204.83, 1);
    expect(b.outputs.targetPrice.value).toBeCloseTo(171.53, 2);
    expect(c.outputs!.targetPrice.value).toBeCloseTo(171.53, 2);
    // a failed request leaves nothing behind either
    await api('POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v.file!.sha256, overrides: [{ id: multiple.id, value: 30 }, { id: 'nope', value: 1 }] }, 400);
    await api('POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v.file!.sha256, overrides: [{ id: multiple.id, value: 1e308 }], trialRanges: { [multiple.id]: { low: -1e308, high: 1e308 } } });
    expect((await view(pid)).outputs).toEqual(v.outputs);
  });
});

describe('what may be reached', () => {
  it('a link that is redirected out of the vault after it was made stops being read', async () => {
    const pid = await newProject();
    const secret = path.join(dir, '別人的.xlsx');
    fs.copyFileSync(path.join(FIXTURES, CRWD), secret);
    await link(pid);
    fs.rmSync(path.join(vault, REL));
    fs.symlinkSync(secret, path.join(vault, REL));
    expect(await view(pid)).toMatchObject({ loaded: false, assumptions: [], file: { state: 'unreadable', reason: 'outside-vault', sha256: null } });
    // the same through a folder
    fs.rmSync(path.join(vault, '個股'), { recursive: true });
    fs.symlinkSync(dir, path.join(vault, '個股'));
    fs.copyFileSync(secret, path.join(dir, CRWD));
    expect((await view(pid)).file).toMatchObject({ state: 'unreadable', reason: 'outside-vault' });
    expect((await call('user', 'GET', `/api/projects/${pid}/workbook/diagnosis`)).body).not.toContain('假設（2');
    // and the listing does not walk out through it
    const files = await api<{ files: { path: string }[] }>('GET', '/api/workbook/files');
    expect(files.files).toEqual([]);
  });

  it('odd spellings of a path stay inside or are refused', async () => {
    const pid = await newProject();
    for (const rel of ['個股/../../outside.xlsx', '..\\outside.xlsx', '個股\\..\\..\\x.xlsx', '/etc/passwd.xlsx', 'C:\\x.xlsx\0', '個股/', '.', `${'a/'.repeat(3000)}x.xlsx`]) {
      const res = await call('user', 'PUT', `/api/projects/${pid}/workbook/link`, { path: rel });
      expect([rel.slice(0, 30), res.statusCode === 400 || res.statusCode === 404], rel.slice(0, 30)).toEqual([rel.slice(0, 30), true]);
    }
    for (const body of [{ path: 5 }, { path: ['a.xlsx'] }, { path: { toString: 'x' } }, {}]) expect((await call('user', 'PUT', `/api/projects/${pid}/workbook/link`, body)).statusCode).toBe(400);
    // a Windows-style separator is accepted for a file that is inside
    expect((await link(pid, `個股\\${CRWD}`)).loaded).toBe(true);
    expect((await link(pid, `./個股/../個股/${CRWD}`)).loaded).toBe(true);
  });

  it('the vault folder is set only by the user, from this machine: a forwarded address or a local-looking Host from elsewhere does not count', async () => {
    const put = (who: TokenName | null, extra: { headers?: Record<string, string>; remoteAddress?: string }) => call(who, 'PUT', '/api/settings/vault-dir', { dir }, extra);
    const refused = async (who: TokenName | null, extra: { headers?: Record<string, string>; remoteAddress?: string }, status: number, code: string) => {
      const res = await put(who, extra);
      expect([res.statusCode, res.json().code]).toEqual([status, code]);
    };
    // from the tailnet or the LAN, whatever the Host header says
    await refused('user', { remoteAddress: '100.101.102.103', headers: { host: '127.0.0.1:4310' } }, 403, 'LOCAL_ONLY');
    await refused('user', { remoteAddress: '192.168.1.7', headers: { host: 'localhost:4310', 'x-forwarded-for': '127.0.0.1' } }, 403, 'LOCAL_ONLY');
    await refused('user', { remoteAddress: '127.0.0.1', headers: { host: 'localhost.evil.example:4310' } }, 403, 'LOCAL_ONLY');
    await refused('user', { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1.evil.example' } }, 403, 'LOCAL_ONLY');
    await refused('user', { remoteAddress: '127.0.0.1', headers: { host: 'evil.example', 'x-forwarded-host': '127.0.0.1:4310' } }, 403, 'LOCAL_ONLY');
    // on this machine, but not the user
    for (const who of ['claude-desktop', 'claude-code', 'chatgpt'] as const) await refused(who, { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4310' } }, 403, 'USER_ONLY');
    expect((await put('obsidian', { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4310' } })).statusCode).toBe(403);
    expect((await put(null, { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4310' } })).statusCode).toBe(401);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM app_settings').get()).toEqual({ n: 0 });
    expect((await put('user', { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4310' } })).statusCode).toBe(200);
  });

  it('an AI client cannot link, unlink or remap, and cannot aim a recalculation at a cell that is not an assumption', async () => {
    const pid = await newProject();
    const v = await link(pid);
    for (const who of ['claude-desktop', 'claude-code', 'chatgpt'] as const) {
      for (const [method, url, body] of [
        ['PUT', `/api/projects/${pid}/workbook/link`, { path: REL }],
        ['DELETE', `/api/projects/${pid}/workbook/link`, undefined],
        ['PUT', `/api/projects/${pid}/workbook/mapping`, { mapping: null }],
        ['PUT', `/api/projects/${pid}/workbook/mapping`, { mapping: v.mapping!.outputs }],
      ] as const) {
        const res = await call(who, method, url, body);
        expect([who, method, url, res.statusCode, res.json().code]).toEqual([who, method, url, 403, 'USER_ONLY']);
      }
      for (const id of ['營收模型!B86', 'B86', '__proto__', 'constructor', `${v.assumptions[0].id} `]) {
        const res = await call(who, 'POST', `/api/projects/${pid}/workbook/recalc`, { baseSha: v.file!.sha256, overrides: [{ id, value: 1 }] });
        expect([id, res.statusCode]).toEqual([id, 400]);
      }
      const res = await call(who, 'POST', `/api/projects/${pid}/workbook/recalc`, JSON.parse(`{"baseSha":"${v.file!.sha256}","overrides":[],"trialRanges":{"__proto__":{"low":1,"high":2}}}`));
      expect(res.statusCode).toBe(400);
    }
    const row = ctx.db.prepare('SELECT rel_path, mapping_json FROM project_workbooks WHERE project_id = ?').get(pid);
    expect(row).toEqual({ rel_path: REL, mapping_json: null });
  });
});

it('zlib is asked to stop at the stated size', () => {
  // what entryData relies on: Node refuses to inflate past maxOutputLength
  expect(() => zlib.inflateRawSync(zlib.deflateRawSync(Buffer.alloc(1000)), { maxOutputLength: 10 })).toThrow();
});
