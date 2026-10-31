import { beforeEach, describe, expect, it } from 'vitest';
import { BEGIN_RE, END_LINE } from '../../src/domain/vault/block';
import { linkToken } from '../../src/domain/vault/links';
import { reflectionTemplate } from '../../src/domain/vault/reflection';
import { MAX_REFLECTION_CHARS, type RenderedNote } from '../../src/domain/vault/types';
import { QUIET_MS, SyncEngine } from '../src/engine';
import { DEFAULT_STATE, type PersistedState } from '../src/ports';
import { FakeServer } from './fakeServer';
import { FakeVault } from './fakeVault';

const ROOT = '研究工作台';
const PRJ = 'prj_aaaa1111';
const REV = 'rev_bbbb2222';
const TRD = 'trd_cccc3333';

const P_COMPANY = `${ROOT}/公司/2301 光寶科.md`;
const P_UPDATE = `${ROOT}/研究更新/2301/2301 2026-09-30 #1 法說會後.md`;
const P_TRADE = `${ROOT}/交易/2301/2301 2026-10-01 做多 cccc33.md`;
const P_INDEX = `${ROOT}/_索引/交易總表.md`;

function company(tp = 150, over: Partial<RenderedNote> = {}): RenderedNote {
  return {
    wbId: PRJ,
    kind: 'company',
    deleted: false,
    path: '公司/2301 光寶科.md',
    frontmatter: [
      ['wb_id', PRJ],
      ['wb_type', 'company'],
      ['wb_name', '光寶科'],
      ['wb_tp_base', tp],
    ],
    block: `## 摘要\n\n基準目標價 ${tp}\n\n最新研究更新：${linkToken(REV, '#1 法說會後')}\n\n交易：${linkToken(TRD, '2026-10-01 做多')}`,
    body: reflectionTemplate(),
    ...over,
  };
}

function update(): RenderedNote {
  return {
    wbId: REV,
    kind: 'research_update',
    deleted: false,
    path: '研究更新/2301/2301 2026-09-30 #1 法說會後.md',
    frontmatter: [
      ['wb_id', REV],
      ['wb_type', 'research_update'],
      ['wb_title', '法說會後'],
      ['wb_company', { link: PRJ, alias: '2301 光寶科' }],
      ['wb_as_of_date', { date: '2026-09-30' }],
    ],
    block: `## 研究更新\n\n公司：${linkToken(PRJ, '2301 光寶科')}`,
    body: reflectionTemplate(),
  };
}

function trade(qty = 1000, deleted = false): RenderedNote {
  return {
    wbId: TRD,
    kind: 'trade',
    deleted,
    path: '交易/2301/2301 2026-10-01 做多 cccc33.md',
    frontmatter: [
      ['wb_id', TRD],
      ['wb_type', 'trade'],
      ['wb_qty', qty],
      ['wb_deleted', deleted],
    ],
    block: deleted ? '> [!warning] 這筆交易已在研究工作台刪除' : `## 交易\n\n數量 ${qty}\n\n公司：${linkToken(PRJ, '2301 光寶科')}`,
    body: reflectionTemplate(),
  };
}

function index(n = 1): RenderedNote {
  return {
    wbId: 'index-trades',
    kind: 'index',
    deleted: false,
    path: '_索引/交易總表.md',
    frontmatter: [
      ['wb_id', 'index-trades'],
      ['wb_type', 'index'],
    ],
    block: `| 交易 | 數量 |\n|---|---|\n| ${linkToken(TRD, '2301 做多', true)} | ${n} |`,
    body: '',
  };
}

let vault: FakeVault;
let server: FakeServer;
let saved: PersistedState;
let engine: SyncEngine;

function newEngine(state: PersistedState = { ...DEFAULT_STATE }) {
  saved = state;
  engine = new SyncEngine({
    vault,
    server,
    rootFolder: () => ROOT,
    state,
    save: async (s) => {
      saved = s;
    },
    pluginVersion: '0.1.0',
    vaultName: 'Test',
    now: () => vault.t,
  });
  return engine;
}

/** One run, after enough time that nothing counts as just modified. */
async function sync(gap = 6_000) {
  vault.advance(gap);
  return engine.runOnce();
}

const writtenPaths = () => vault.writes.map((w) => w.path).sort();

beforeEach(() => {
  vault = new FakeVault();
  server = new FakeServer();
  newEngine();
});

/** The four notes, synced once. */
async function seeded() {
  server.put(company(), update(), trade(), index());
  await sync();
  vault.writes = [];
}

const writeReflection = (path: string, text: string) =>
  vault.userEdit(path, (s) => s.replace(/## 反思\n[\s\S]*$/, `## 反思\n${text}\n`));

describe('SyncEngine', () => {
  it('waits for the metadata cache before doing anything', async () => {
    vault.ready = false;
    server.put(company());
    const s = await sync();
    expect(s.state).toBe('waiting-index');
    expect(server.calls).toEqual([]);
    expect(vault.writes).toEqual([]);
    vault.ready = true;
    expect((await sync()).state).toBe('synced');
    expect(vault.files.has(P_COMPANY)).toBe(true);
  });

  it('creates every note at its path on the first sync, with markers and resolved links', async () => {
    server.put(company(), update(), trade(), index());
    const s = await sync();
    expect(s.state).toBe('synced');
    expect(vault.writes.every((w) => w.op === 'create')).toBe(true);
    expect(writtenPaths()).toEqual([P_INDEX, P_COMPANY, P_TRADE, P_UPDATE].sort());
    const c = vault.content(P_COMPANY);
    const lines = c.split('\n');
    expect(lines.filter((l) => BEGIN_RE.test(l))).toHaveLength(1);
    expect(lines.filter((l) => l === END_LINE)).toHaveLength(1);
    expect(c).toContain(`[[${P_TRADE.replace(/\.md$/, '')}|2026-10-01 做多]]`);
    expect(c).toContain(`[[${P_UPDATE.replace(/\.md$/, '')}|#1 法說會後]]`);
    expect(c).toContain('## 反思');
    expect(vault.content(P_UPDATE)).toContain(`wb_company: "[[${P_COMPANY.replace(/\.md$/, '')}|2301 光寶科]]"`);
    expect(vault.content(P_INDEX)).toContain(`[[${P_TRADE.replace(/\.md$/, '')}\\|2301 做多]]`);
    expect(saved.cursor).toBe(4);
    expect(saved.known.sort()).toEqual([PRJ, REV, TRD, 'index-trades'].sort());
    const st = server.lastStatus();
    expect(st.paths?.reset).toBe(true);
    expect(st.paths?.set[TRD]).toBe(P_TRADE);
    expect(st.conflicts).toEqual([]);
  });

  it('writes nothing on a second sync', async () => {
    await seeded();
    await sync();
    expect(vault.writes).toEqual([]);
    // the full set again (a resync from 0) changes nothing either
    newEngine({ ...saved, cursor: 0 });
    await sync();
    expect(vault.writes).toEqual([]);
  });

  it('rewrites only the changed notes and keeps user text and user frontmatter byte-identical', async () => {
    await seeded();
    vault.userEdit(P_TRADE, (s) =>
      s.replace('---\nwb_id', '---\n# 我的註解\nmood: calm # 心情\ntags:\n  - 光寶\nwb_id').concat('\n我的筆記：\n- 不要追高\n'),
    );
    const before = vault.content(P_TRADE);
    const companyBefore = vault.content(P_COMPANY);
    server.put(trade(2000), company(160), index(2));
    await sync();
    expect(writtenPaths()).toEqual([P_INDEX, P_COMPANY, P_TRADE].sort());
    const after = vault.content(P_TRADE);
    expect(after).toContain('數量 2000');
    expect(after).toContain('wb_qty: 2000');
    expect(after).toContain('---\n# 我的註解\nmood: calm # 心情\ntags:\n  - 光寶\nwb_id: "trd_cccc3333"');
    expect(after.endsWith('\n我的筆記：\n- 不要追高\n')).toBe(true);
    // outside the block and the wb_ keys nothing moved
    const outside = (s: string) => s.replace(/<!-- wb:begin[\s\S]*?<!-- wb:end -->/, '').replace(/^wb_.*$/gm, '');
    expect(outside(after)).toBe(outside(before));
    expect(outside(vault.content(P_COMPANY))).toBe(outside(companyBefore));
    expect(vault.writes.some((w) => w.path === P_UPDATE)).toBe(false);
  });

  it('marks a deleted trade as deleted and keeps the note and its reflection', async () => {
    await seeded();
    writeReflection(P_TRADE, '進場太早。');
    server.put(trade(1000, true));
    await sync();
    const t = vault.content(P_TRADE);
    expect(t).toContain('已在研究工作台刪除');
    expect(t).toContain('wb_deleted: true');
    expect(t).toContain('進場太早。');
    expect(vault.files.size).toBe(4);
  });

  it('skips a file open in an editor and writes it once it is closed', async () => {
    await seeded();
    vault.open.add(P_TRADE);
    server.put(trade(3000));
    await sync();
    expect(vault.writes).toEqual([]);
    expect(saved.pending).toContain(TRD);
    expect(server.lastStatus().skippedOpen).toBe(1);
    vault.open.clear();
    await sync();
    expect(writtenPaths()).toEqual([P_TRADE]);
    expect(vault.content(P_TRADE)).toContain('數量 3000');
    expect(saved.pending).toEqual([]);
    expect(server.lastStatus().skippedOpen).toBe(0);
  });

  it('does not rewrite a file the user modified a moment ago', async () => {
    await seeded();
    server.put(trade(4000));
    vault.advance(1000);
    vault.userEdit(P_TRADE, (s) => `${s}\n剛剛打的字\n`);
    await engine.runOnce();
    expect(vault.writes).toEqual([]);
    await sync();
    expect(vault.content(P_TRADE)).toContain('數量 4000');
    expect(vault.content(P_TRADE)).toContain('剛剛打的字');
  });

  it('reports a hand-edited block as a conflict; rebuilding keeps the old text', async () => {
    await seeded();
    vault.userEdit(P_TRADE, (s) => s.replace('數量 1000', '數量 1000（我改的）'));
    const edited = vault.content(P_TRADE);
    server.put(trade(5000));
    await sync();
    expect(vault.content(P_TRADE)).toBe(edited);
    expect(server.lastStatus().conflicts).toEqual([{ wbId: TRD, reason: 'hand-edited', paths: [P_TRADE] }]);
    expect(engine.getStatus().conflicts[0].title).toBe('2301 2026-10-01 做多 cccc33');
    // the conflict is reported again on the next run, and still nothing is written
    await sync();
    expect(vault.content(P_TRADE)).toBe(edited);
    expect(server.lastStatus().conflicts).toHaveLength(1);

    const r = await engine.rebuild(P_TRADE);
    expect(r.ok).toBe(true);
    const t = vault.content(P_TRADE);
    expect(t).toContain('數量 5000');
    expect(t).toContain('> [!note]- 你修改過的舊自動產生區');
    expect(t).toContain('> 數量 1000（我改的）');
    await sync();
    expect(server.lastStatus().conflicts).toEqual([]);
  });

  it('reports missing markers as a conflict', async () => {
    await seeded();
    vault.userEdit(P_TRADE, (s) => s.replace(/<!-- wb:begin.*-->\n/, '').replace('<!-- wb:end -->\n', ''));
    const edited = vault.content(P_TRADE);
    server.put(trade(6000));
    await sync();
    expect(vault.content(P_TRADE)).toBe(edited);
    expect(server.lastStatus().conflicts).toEqual([{ wbId: TRD, reason: 'missing-markers', paths: [P_TRADE] }]);
  });

  it('writes neither of two files with the same wb_id, sends both reflections, and resolves once the copy is gone', async () => {
    await seeded();
    const copy = vault.conflictCopy(P_TRADE);
    writeReflection(P_TRADE, '原本的反思');
    writeReflection(copy, 'iCloud 副本裡的反思');
    server.put(trade(7000));
    await sync(QUIET_MS + 1000);
    expect(vault.writes).toEqual([]);
    expect(server.lastStatus().conflicts).toEqual([{ wbId: TRD, reason: 'duplicate-id', paths: [P_TRADE, copy].sort() }]);
    const sent = server.callsOf('postReflections').flatMap((c) => c.arg as { wbId: string; path: string; duplicatePaths?: string[] }[]);
    expect(sent.map((s) => s.path).sort()).toEqual([P_TRADE, copy].sort());
    expect(sent.find((s) => s.path === copy)?.duplicatePaths).toEqual([P_TRADE]);
    expect(server.reflections.map((r) => r.text).sort()).toEqual(['iCloud 副本裡的反思', '原本的反思'].sort());

    vault.remove(copy);
    await sync();
    expect(writtenPaths()).toEqual([P_TRADE]);
    expect(vault.content(P_TRADE)).toContain('數量 7000');
    expect(server.lastStatus().conflicts).toEqual([]);
  });

  it('updates a renamed or moved note in place', async () => {
    await seeded();
    const moved = '封存/我的光寶交易.md';
    vault.move(P_TRADE, moved);
    server.put(trade(8000));
    await sync();
    expect(vault.writes).toEqual([{ op: 'process', path: moved }]);
    expect(vault.content(moved)).toContain('數量 8000');
    expect(vault.files.has(P_TRADE)).toBe(false);
    expect(server.lastStatus().paths).toEqual({ reset: false, set: { [TRD]: moved }, removed: [] });
    // notes linking to it point at the new place once they are rewritten
    server.put(company(170));
    await sync();
    expect(vault.content(P_COMPANY)).toContain('[[封存/我的光寶交易|2026-10-01 做多]]');
  });

  it('creates `… (2).md` when an unrelated file takes the path in another case', async () => {
    const other = `${ROOT}/公司/aapl apple.md`;
    vault.put(other, '我自己的蘋果筆記\n');
    server.put({ ...company(), wbId: 'prj_apple0001', path: '公司/AAPL Apple.md', frontmatter: [['wb_id', 'prj_apple0001']] });
    await sync();
    expect(writtenPaths()).toEqual([`${ROOT}/公司/AAPL Apple (2).md`]);
    expect(vault.content(other)).toBe('我自己的蘋果筆記\n');
  });

  it('adopts a file whose cache is stale when its content carries the wb_id', async () => {
    await seeded();
    // a fresh plugin install over an existing vault, before Obsidian has indexed the file
    vault.staleCache.add(P_TRADE);
    newEngine();
    server.put(trade(9000));
    await sync();
    expect(vault.writes.filter((w) => w.op === 'create')).toEqual([]);
    expect(vault.content(P_TRADE)).toContain('數量 9000');
    expect(vault.paths()).toHaveLength(4);
  });

  it('sends a reflection only after the file has been quiet, once per change', async () => {
    await seeded();
    await sync(QUIET_MS);
    expect(server.callsOf('postReflections')).toHaveLength(0); // empty templates are not reflections
    writeReflection(P_TRADE, '停損設太緊。');
    await sync(1000);
    expect(server.reflections).toHaveLength(0);
    await sync(QUIET_MS);
    expect(server.reflections.map((r) => r.text)).toEqual(['停損設太緊。']);
    await sync(QUIET_MS);
    expect(server.reflections).toHaveLength(1);

    writeReflection(P_TRADE, '停損設太緊，下次用 2 倍 ATR。');
    await sync(QUIET_MS + 1);
    expect(server.reflections.map((r) => r.text)).toEqual(['停損設太緊。', '停損設太緊，下次用 2 倍 ATR。']);

    writeReflection(P_TRADE, '');
    await sync(QUIET_MS + 1);
    expect(server.reflections[2]).toMatchObject({ wbId: TRD, text: '' });

    vault.userEdit(P_TRADE, (s) => s.replace(/## 反思[\s\S]*$/, '沒有反思段落了\n'));
    await sync(QUIET_MS + 1);
    expect(server.reflections).toHaveLength(3);
    expect(server.callsOf('postReflections')).toHaveLength(3);
  });

  it('resends a reflection whose upload failed', async () => {
    await seeded();
    writeReflection(P_COMPANY, '看好伺服器電源。');
    server.fail.postReflections = { ok: false, kind: 'offline', message: 'down' };
    await sync(QUIET_MS);
    expect(server.reflections).toHaveLength(0);
    delete server.fail.postReflections;
    await sync();
    expect(server.reflections.map((r) => r.wbId)).toEqual([PRJ]);
  });

  it('a reflection too long for the server is not sent and is reported on every run until it is shorter (regression)', async () => {
    await seeded();
    writeReflection(P_TRADE, '長'.repeat(MAX_REFLECTION_CHARS + 1));
    await sync(QUIET_MS + 1);
    expect(server.callsOf('postReflections')).toHaveLength(0);
    expect(server.lastStatus().errors.some((e) => e.includes('反思太長') && e.includes(P_TRADE))).toBe(true);
    await sync(QUIET_MS + 1);
    expect(server.lastStatus().errors.some((e) => e.includes('反思太長'))).toBe(true);
    writeReflection(P_TRADE, '短一點。');
    await sync(QUIET_MS + 1);
    expect(server.reflections.map((r) => r.text)).toEqual(['短一點。']);
    expect(server.lastStatus().errors).toEqual([]);
  });

  it('resets the cursor on a new database generation or when it is ahead of the server, without extra writes', async () => {
    await seeded();
    server.generation = 'gen-2';
    await sync();
    expect(server.callsOf('notesAfter').at(-1)?.arg).toEqual({ after: 0, limit: 200 });
    expect(vault.writes).toEqual([]);
    expect(saved.generation).toBe('gen-2');
    expect(saved.cursor).toBe(4);

    newEngine({ ...saved, cursor: 99 });
    await sync();
    expect(server.callsOf('notesAfter').at(-1)?.arg).toEqual({ after: 0, limit: 200 });
    expect(saved.cursor).toBe(4);
    expect(vault.writes).toEqual([]);
  });

  it('writes nothing when the protocol differs', async () => {
    server.protocol = 99;
    server.put(company());
    const s = await sync();
    expect(s.state).toBe('outdated');
    expect(vault.writes).toEqual([]);
    expect(server.callsOf('notesAfter')).toHaveLength(0);
  });

  it('reports auth and offline failures', async () => {
    server.put(company());
    server.fail.ping = { ok: false, kind: 'auth', status: 401, message: 'Obsidian token required' };
    expect((await sync()).state).toBe('auth');
    server.fail.ping = { ok: false, kind: 'offline', message: 'ECONNREFUSED' };
    const s = await sync();
    expect(s.state).toBe('offline');
    expect(s.message).toBe('ECONNREFUSED');
    expect(vault.writes).toEqual([]);
  });

  it('runs once when called concurrently', async () => {
    server.put(company(), trade());
    vault.advance(6000);
    await Promise.all([engine.runOnce(), engine.runOnce(), engine.runOnce()]);
    expect(server.callsOf('ping')).toHaveLength(1);
    expect(writtenPaths()).toEqual([P_COMPANY, P_TRADE].sort());
  });

  it('retries pending notes by id', async () => {
    await seeded();
    vault.open.add(P_COMPANY);
    server.put(company(180));
    await sync();
    expect(saved.pending).toEqual([PRJ]);
    vault.open.clear();
    // a fresh plugin load keeps the pending list
    newEngine(saved);
    await sync();
    expect(server.callsOf('notesByIds').at(-1)?.arg).toEqual([PRJ]);
    expect(vault.content(P_COMPANY)).toContain('基準目標價 180');
    expect(saved.pending).toEqual([]);
  });

  it('does not re-create a note the user deleted until asked to', async () => {
    await seeded();
    vault.remove(P_TRADE);
    server.put(trade(1100));
    await sync();
    expect(vault.writes).toEqual([]);
    expect(server.lastStatus().missing).toBe(1);
    expect(await engine.recreateDeleted()).toBe(1);
    await sync();
    expect(writtenPaths()).toEqual([P_TRADE]);
    expect(vault.content(P_TRADE)).toContain('數量 1100');
    expect(server.lastStatus().missing).toBe(0);
  });

  it('reports an iCloud placeholder as unavailable and does not create over it', async () => {
    vault.unindexed.add(P_TRADE.toLowerCase());
    server.put(trade());
    await sync();
    expect(vault.writes).toEqual([]);
    expect(server.lastStatus().conflicts).toEqual([{ wbId: TRD, reason: 'unavailable', paths: [P_TRADE] }]);
    expect(saved.pending).toEqual([TRD]);
  });

  it('stops between notes', async () => {
    server.put(company(), update(), trade(), index());
    vault.afterWrite = () => engine.stop();
    await sync();
    expect(vault.writes).toHaveLength(1);
    await engine.runOnce();
    expect(vault.writes).toHaveLength(1);
    expect(engine.getStatus().state).toBe('stopped');
  });

  it('never writes outside the root folder or into hidden folders', async () => {
    server.put({ ...company(), path: '../escape.md' }, { ...trade(), path: '.obsidian/x.md' });
    const s = await sync();
    expect(vault.writes).toEqual([]);
    expect(s.message).toContain('路徑無效');
  });

  it('keeps the cursor when stopped part-way through a page, so the unwritten notes come next time (regression)', async () => {
    server.put(company(), update(), trade(), index());
    vault.afterWrite = () => engine.stop();
    await sync();
    expect(vault.writes).toHaveLength(1);
    expect(saved.cursor).toBe(0);
    vault.afterWrite = null;
    newEngine(saved);
    await sync();
    expect(vault.paths()).toEqual([P_COMPANY, P_UPDATE, P_TRADE, P_INDEX].sort());
  });

  it('reports every path again, and drops old conflicts, after a new database generation (regression)', async () => {
    await seeded();
    vault.userEdit(P_COMPANY, (s) => s.replace('基準目標價 150', '基準目標價 999'));
    server.put(company(160));
    await sync();
    expect(server.lastStatus().conflicts.map((c) => c.wbId)).toEqual([PRJ]);
    await sync();
    expect(server.lastStatus().paths).toBeUndefined();
    server.generation = 'gen-2';
    server.notes.clear();
    await sync();
    const last = server.lastStatus();
    expect(last.paths?.reset).toBe(true);
    expect(Object.keys(last.paths?.set ?? {}).sort()).toEqual([PRJ, REV, TRD, 'index-trades'].sort());
    expect(last.conflicts).toEqual([]);
  });

  it('ignores malformed ids and values in a hand-edited state instead of failing every run (regression)', async () => {
    server.put(company());
    const bad = { generation: 5, publicUrl: null, cursor: 'x', pending: ['not an id', 7, PRJ], known: 'abc' } as unknown as PersistedState;
    newEngine(bad);
    const s = await sync();
    expect(s.state).toBe('synced');
    expect(server.callsOf('notesByIds').every((c) => !(c.arg as unknown[]).includes('not an id'))).toBe(true);
    expect(vault.paths()).toEqual([P_COMPANY]);
  });
});
