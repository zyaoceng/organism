/**
 * One sync run: fetch the notes that changed on the server, write them into the vault, read the
 * `## 反思` sections back, and report what happened. The rule above all others: text the user
 * wrote is never destroyed. The engine can only create files and rewrite their generated parts
 * (VaultPort has no delete or rename), and whenever a file is not in a state where that is certain
 * (two files with the same id, a hand-edited block, missing markers, the file open in an editor or
 * just modified) it writes nothing, keeps the note pending and reports a conflict.
 */
import { findFrontmatter, readTopLevelScalar } from '../../src/domain/vault/frontmatter';
import { reflectionHash } from '../../src/domain/vault/hash';
import { resolveNote, type LinkLookup } from '../../src/domain/vault/links';
import { createNoteText, mergeNote, rebuildNote, type MergeConflict, type MergeResult } from '../../src/domain/vault/merge';
import { extractReflection } from '../../src/domain/vault/reflection';
import { parseDoc } from '../../src/domain/vault/text';
import { joinVault, pathKey, uniquePath } from '../../src/domain/vault/filename';
import {
  KIND_ORDER,
  MAX_REFLECTION_CHARS,
  VAULT_PROTOCOL,
  WB_ID_RE,
  isReflectionKind,
  kindOfWbId,
  shouldStoreReflection,
  type ConflictReason,
  type RenderedNote,
  type ReflectionUpload,
  type ResolvedNote,
  type ServerReflectionState,
  type VaultNotesResponse,
  type VaultStatusReport,
} from '../../src/domain/vault/types';
import type { Failure, PersistedState, ServerPort, VaultPort } from './ports';
import { WbIndex } from './wbIndex';

const PAGE_LIMIT = 200;
const MAX_PAGES = 20;
const IDS_CHUNK = 100;
const REFLECTION_CHUNK = 50;
/** A reflection is read only once the file has been left alone this long (the user may still be typing). */
export const QUIET_MS = 30_000;
/** A file modified this recently by someone else is not rewritten in this run. */
export const RECENT_MS = 5_000;

export type SyncState = 'idle' | 'waiting-index' | 'syncing' | 'synced' | 'offline' | 'auth' | 'outdated' | 'error' | 'stopped';

export interface ConflictEntry {
  wbId: string;
  reason: ConflictReason;
  paths: string[];
  title: string;
}

export interface EngineStatus {
  state: SyncState;
  /** ms since the epoch of the last complete run. */
  lastSyncAt: number | null;
  message: string | null;
  pending: number;
  skippedOpen: number;
  missing: number;
  conflicts: ConflictEntry[];
}

export interface EngineOptions {
  vault: VaultPort;
  server: ServerPort;
  /** The plugin's root folder inside the vault ('' = the vault root). Read at every run. */
  rootFolder: () => string;
  state: PersistedState;
  save: (s: PersistedState) => Promise<void>;
  pluginVersion: string;
  vaultName: string;
  now?: () => number;
  onStatus?: (s: EngineStatus) => void;
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/** wb_id written in a file's own frontmatter (not the cache's), or null. */
export function wbIdInText(text: string): string | null {
  const lines = parseDoc(text).lines;
  const f = findFrontmatter(lines);
  if (f.kind !== 'ok') return null;
  return readTopLevelScalar(lines.slice(1, f.close), 'wb_id');
}

/** A path the server sent, as a vault path under the root folder; null if it could leave it or is hidden. */
function safePath(root: string, rel: string): string | null {
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length || !/\.md$/i.test(rel) || segs.some((s) => s.startsWith('.') || s.includes('\\'))) return null;
  return joinVault(root, ...segs);
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function titleOf(n: RenderedNote): string {
  for (const key of ['wb_title', 'wb_name']) {
    const v = n.frontmatter.find(([k]) => k === key)?.[1];
    if (typeof v === 'string' && v) return v;
  }
  return baseName(n.path);
}

function localLabel(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Target = { kind: 'create' | 'update'; path: string };

export class SyncEngine {
  private readonly vault: VaultPort;
  private readonly server: ServerPort;
  private readonly now: () => number;
  private st: { generation: string | null; publicUrl: string | null; cursor: number };
  private pending: Set<string>;
  private known: Set<string>;
  private running: Promise<EngineStatus> | null = null;
  private stopped = false;
  /** Paths being written right now: one write per file at a time. */
  private locks = new Set<string>();
  /** mtime of each file right after our own write, so our write does not count as the user's. */
  private ownMtime = new Map<string, number>();
  /** path → mtime of the last reflection read. */
  private scanned = new Map<string, number>();
  private conflicts = new Map<string, ConflictEntry>();
  /** wbId → first path, as last reported to the server; null until a report got through. */
  private reported: Map<string, string> | null = null;
  private status: EngineStatus = { state: 'idle', lastSyncAt: null, message: null, pending: 0, skippedOpen: 0, missing: 0, conflicts: [] };

  constructor(private readonly opts: EngineOptions) {
    this.vault = opts.vault;
    this.server = opts.server;
    this.now = opts.now ?? Date.now;
    const s = opts.state;
    const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
    this.st = { generation: strOrNull(s.generation), publicUrl: strOrNull(s.publicUrl), cursor: Math.max(0, Math.trunc(Number(s.cursor)) || 0) };
    // data.json may be hand-edited or from another version: only workbench ids, or the ids= query is refused every run
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && WB_ID_RE.test(x)) : []);
    this.pending = new Set(ids(s.pending));
    this.known = new Set(ids(s.known));
  }

  getStatus(): EngineStatus {
    return { ...this.status, conflicts: [...this.status.conflicts] };
  }

  persisted(): PersistedState {
    return { ...this.st, pending: [...this.pending], known: [...this.known] };
  }

  /** Ends the current run after the note being written, and every later one. */
  stop() {
    this.stopped = true;
    this.update({ state: 'stopped' });
  }

  /** Runs never overlap: a call during a run gets that run's result. */
  runOnce(): Promise<EngineStatus> {
    if (this.stopped) return Promise.resolve(this.getStatus());
    if (this.running) return this.running;
    this.running = this.run()
      .catch((e: unknown) => this.update({ state: 'error', message: errText(e) }))
      .then(() => this.getStatus())
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  // ---------------------------------------------------------------- the run

  private async run() {
    if (!this.vault.cacheReady()) return this.update({ state: 'waiting-index', message: null });
    this.update({ state: 'syncing', message: null });
    const index = this.buildIndex();
    const errors: string[] = [];
    let skippedOpen = 0;
    const counters = { skipOpen: () => void skippedOpen++ };

    const ping = await this.server.ping();
    if (!ping.ok) return this.failed(ping);
    const p = ping.value;
    if (p.protocol !== VAULT_PROTOCOL) return this.outdated();
    if (p.generation !== this.st.generation || p.publicUrl !== this.st.publicUrl) {
      // another database (restore, import) or another server: start over, but files we wrote stay known
      this.st = { generation: p.generation, publicUrl: p.publicUrl, cursor: 0 };
      this.pending.clear();
      this.scanned.clear();
      // the new database knows none of the paths, and the old conflicts would never be retried
      this.conflicts.clear();
      this.reported = null;
    }
    if (this.st.cursor > p.latestSeq) this.st.cursor = 0;

    const handled = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      if (this.stopped) return this.save();
      const r = await this.server.notesAfter(this.st.cursor, PAGE_LIMIT);
      if (!r.ok) return this.failed(r);
      if (r.value.protocol !== VAULT_PROTOCOL) return this.outdated();
      await this.applyBatch(r.value, index, handled, errors, counters);
      // stopped part-way through the page: its unwritten notes are not pending, so keep the cursor
      if (this.stopped) return this.save();
      this.st.cursor = r.value.nextAfter;
      await this.save();
      if (!r.value.more) break;
    }

    const retry = [...this.pending].filter((id) => !handled.has(id));
    for (let i = 0; i < retry.length; i += IDS_CHUNK) {
      if (this.stopped) return this.save();
      const r = await this.server.notesByIds(retry.slice(i, i + IDS_CHUNK));
      if (!r.ok) return this.failed(r);
      await this.applyBatch(r.value, index, handled, errors, counters);
    }
    await this.save();
    if (this.stopped) return;

    await this.scanReflections(index, errors);
    if (this.stopped) return;

    const missing = [...this.known].filter((id) => !index.has(id)).length;
    await this.report(index, errors, skippedOpen, missing);
    this.update({ state: 'synced', lastSyncAt: this.now(), message: errors[0] ?? null, skippedOpen, missing });
  }

  private buildIndex(): WbIndex {
    return WbIndex.build(this.vault.listMarkdown().map((f) => [f.path, this.vault.wbIdOf(f.path)] as [string, string | null]));
  }

  private async applyBatch(resp: VaultNotesResponse, index: WbIndex, handled: Set<string>, errors: string[], c: { skipOpen: () => void }) {
    for (const id of resp.missing) {
      // gone on the server without a tombstone: nothing to write, nothing to wait for
      handled.add(id);
      this.done(id);
    }
    const notes = resp.notes.filter((n) => WB_ID_RE.test(n.wbId)).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    const root = this.opts.rootFolder();
    const taken = new Set(this.vault.listMarkdown().map((f) => pathKey(f.path)));
    const planned = new Set<string>();
    const plan = new Map<string, Target>();

    // Phase A: where each note goes
    for (const n of notes) {
      if (this.stopped) return;
      handled.add(n.wbId);
      const paths = index.pathsFor(n.wbId);
      if (paths.length > 1) {
        this.conflict(n, 'duplicate-id', paths);
        continue;
      }
      if (paths.length === 1) {
        plan.set(n.wbId, { kind: 'update', path: paths[0] });
        continue;
      }
      const proposed = safePath(root, n.path);
      if (!proposed) {
        errors.push(`伺服器給的路徑無效：${n.path}`);
        this.pending.add(n.wbId);
        continue;
      }
      const probe = await this.vault.probe(proposed);
      if (probe.kind === 'file' && (await this.readId(probe.path)) === n.wbId) {
        // the metadata cache had not caught up with this file yet
        index.add(probe.path, n.wbId);
        plan.set(n.wbId, { kind: 'update', path: probe.path });
        continue;
      }
      if (probe.kind === 'unindexed') {
        this.conflict(n, 'unavailable', [proposed]);
        continue;
      }
      if (n.deleted || this.known.has(n.wbId)) {
        // deleted on the server and never written, or deleted by the user: never re-create it
        this.done(n.wbId);
        continue;
      }
      const free = await this.freePath(proposed, taken, planned);
      if (!free) {
        this.conflict(n, 'unavailable', [proposed]);
        continue;
      }
      planned.add(pathKey(free));
      plan.set(n.wbId, { kind: 'create', path: free });
    }

    // Phase B: links point at where each note actually is
    const lookup: LinkLookup = (id) => {
      const named = resp.names[id] ? safePath(root, resp.names[id]) : null;
      const p = plan.get(id)?.path ?? index.firstPath(id) ?? named;
      return p ? p.replace(/\.md$/i, '') : null;
    };

    // Phase C: write
    for (const n of notes) {
      if (this.stopped) return;
      const t = plan.get(n.wbId);
      if (!t) continue;
      const r = resolveNote(n, lookup);
      if (t.kind === 'create') await this.create(n, r, t.path, index, errors);
      else await this.write(n, r, t.path, errors, c);
    }
  }

  /** The proposed path, or `name (2).md` … when something else (in any case or Unicode form) is there. */
  private async freePath(proposed: string, taken: Set<string>, planned: Set<string>): Promise<string | null> {
    for (let tries = 0; tries < 50; tries++) {
      let candidate: string;
      try {
        candidate = uniquePath(proposed, (k) => taken.has(k) || planned.has(k));
      } catch {
        return null;
      }
      if ((await this.vault.probe(candidate)).kind === 'none') return candidate;
      taken.add(pathKey(candidate));
    }
    return null;
  }

  private async create(n: RenderedNote, r: ResolvedNote, path: string, index: WbIndex, errors: string[]) {
    try {
      const dir = dirOf(path);
      if (dir) await this.vault.ensureFolder(dir);
      await this.vault.create(path, createNoteText(r));
      this.noteOwnWrite(path);
      index.add(path, n.wbId);
      this.known.add(n.wbId);
      this.done(n.wbId);
    } catch (e) {
      errors.push(`無法建立 ${path}：${errText(e)}`);
      this.conflict(n, 'write-failed', [path]);
    }
  }

  private async write(n: RenderedNote, r: ResolvedNote, path: string, errors: string[], c: { skipOpen: () => void }) {
    if (this.busy(path)) {
      c.skipOpen();
      this.pending.add(n.wbId);
      return;
    }
    this.locks.add(path);
    try {
      const current = await this.vault.read(path);
      const m = mergeNote(current, r);
      if (!m.ok) return this.conflict(n, m.conflict, [path]);
      if (m.changed) {
        // the user may have opened it while we were reading
        if (this.vault.isOpenInEditor(path)) {
          c.skipOpen();
          this.pending.add(n.wbId);
          return;
        }
        let late: MergeConflict | null = null;
        await this.vault.process(path, (d) => {
          if (d === current) return m.text;
          // changed since we read it: merge again on what is there now, or leave it alone
          const again = mergeNote(d, r);
          if (!again.ok) late = again.conflict;
          return again.ok ? again.text : d;
        });
        const lateConflict = late as MergeConflict | null;
        if (lateConflict) return this.conflict(n, lateConflict, [path]);
        this.noteOwnWrite(path);
      }
      this.known.add(n.wbId);
      this.done(n.wbId);
    } catch (e) {
      errors.push(`無法寫入 ${path}：${errText(e)}`);
      this.conflict(n, 'write-failed', [path]);
    } finally {
      this.locks.delete(path);
    }
  }

  /** Being written, open in an editor, or modified by someone else in the last few seconds. */
  private busy(path: string): boolean {
    if (this.locks.has(path) || this.vault.isOpenInEditor(path)) return true;
    const mtime = this.vault.mtimeOf(path);
    return mtime !== null && this.now() - mtime < RECENT_MS && this.ownMtime.get(path) !== mtime;
  }

  private noteOwnWrite(path: string) {
    const m = this.vault.mtimeOf(path);
    if (m !== null) this.ownMtime.set(path, m);
  }

  private async readId(path: string): Promise<string | null> {
    try {
      return wbIdInText(await this.vault.read(path));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- reflections

  private async scanReflections(index: WbIndex, errors: string[]) {
    const s = await this.server.reflectionStates();
    if (!s.ok) {
      errors.push(`讀取反思狀態失敗：${s.message}`);
      return;
    }
    const states: Record<string, ServerReflectionState> = { ...s.value.notes };
    const queue: ReflectionUpload[] = [];
    for (const [id, paths] of index.entries()) {
      if (!isReflectionKind(kindOfWbId(id))) continue;
      for (const path of paths) {
        if (this.stopped) return;
        const mtime = this.vault.mtimeOf(path);
        if (mtime === null || this.scanned.get(path) === mtime) continue;
        // not marked as read: the next run looks again
        if (this.now() - mtime < QUIET_MS) continue;
        let text: string;
        try {
          text = await this.vault.read(path);
        } catch {
          continue;
        }
        this.scanned.set(path, mtime);
        // the cache may be behind the file; the file's own frontmatter decides
        if (wbIdInText(text) !== id) continue;
        const ex = extractReflection(text);
        if (!ex.found) continue;
        if (ex.text.length > MAX_REFLECTION_CHARS) {
          // the server would refuse it: say so on every run (not just once) until the text is shorter
          this.scanned.delete(path);
          errors.push(`反思太長（${ex.text.length} 字，上限 ${MAX_REFLECTION_CHARS}），沒有送出：${path}`);
          continue;
        }
        if (!shouldStoreReflection(reflectionHash(ex.text), ex.text === '', path, states[id])) continue;
        const others = paths.filter((p) => p !== path);
        queue.push({ wbId: id, text: ex.text, path, mtime, ...(others.length ? { duplicatePaths: others } : {}) });
      }
    }
    for (let i = 0; i < queue.length; i += REFLECTION_CHUNK) {
      const chunk = queue.slice(i, i + REFLECTION_CHUNK);
      const r = await this.server.postReflections(chunk);
      if (!r.ok) {
        for (const item of chunk) this.scanned.delete(item.path);
        errors.push(`送出反思失敗：${r.message}`);
        continue;
      }
      r.value.results.forEach((res, k) => {
        const item = chunk[k]?.wbId === res.wbId ? chunk[k] : chunk.find((x) => x.wbId === res.wbId);
        if (!item || res.status === 'rejected') {
          if (res.error) errors.push(`反思未被接受（${res.wbId}）：${res.error}`);
          return;
        }
        const h = reflectionHash(item.text);
        const prev = states[item.wbId];
        states[item.wbId] = { latest: h, byPath: { ...(prev?.byPath ?? {}), [item.path]: h } };
      });
    }
  }

  // ---------------------------------------------------------------- status

  private async report(index: WbIndex, errors: string[], skippedOpen: number, missing: number) {
    const current = new Map(index.entries().map(([id, ps]) => [id, ps[0]] as [string, string]));
    let paths: VaultStatusReport['paths'];
    if (!this.reported) paths = { reset: true, set: Object.fromEntries(current), removed: [] };
    else {
      const set: Record<string, string> = {};
      for (const [id, p] of current) if (this.reported.get(id) !== p) set[id] = p;
      const removed = [...this.reported.keys()].filter((id) => !current.has(id));
      if (Object.keys(set).length || removed.length) paths = { reset: false, set, removed };
    }
    const r = await this.server.postStatus({
      protocol: VAULT_PROTOCOL,
      pluginVersion: this.opts.pluginVersion,
      vaultName: this.opts.vaultName,
      cursor: this.st.cursor,
      pending: this.pending.size,
      skippedOpen,
      missing,
      conflicts: [...this.conflicts.values()].slice(0, 500).map(({ wbId, reason, paths: ps }) => ({ wbId, reason, paths: ps })),
      errors: errors.slice(0, 10).map((e) => e.slice(0, 500)),
      ...(paths ? { paths } : {}),
    });
    if (r.ok) this.reported = current;
    else errors.push(`回報狀態失敗：${r.message}`);
  }

  private conflict(n: RenderedNote, reason: ConflictReason, paths: string[]) {
    this.conflicts.set(n.wbId, { wbId: n.wbId, reason, paths, title: titleOf(n) });
    this.pending.add(n.wbId);
  }

  /** Nothing left to do for this note. */
  private done(id: string) {
    this.pending.delete(id);
    this.conflicts.delete(id);
  }

  private save() {
    return this.opts.save(this.persisted());
  }

  private failed(f: Failure) {
    this.update({ state: f.kind === 'auth' ? 'auth' : f.kind === 'offline' ? 'offline' : 'error', message: f.message });
  }

  private outdated() {
    this.update({ state: 'outdated', message: '外掛與研究工作台的版本不相容，請更新外掛' });
  }

  private update(patch: Partial<EngineStatus>) {
    this.status = { ...this.status, ...patch, pending: this.pending.size, conflicts: [...this.conflicts.values()] };
    this.opts.onStatus?.(this.getStatus());
  }

  // ---------------------------------------------------------------- commands

  /**
   * 重建目前筆記的自動產生區: the one forced write. A hand-edited block is replaced but its old
   * text is kept in a collapsed callout; missing or broken markers get a fresh block. Unclosed
   * frontmatter and another note's id are still refused.
   */
  async rebuild(path: string): Promise<ActionResult> {
    if (!this.vault.cacheReady()) return { ok: false, message: 'Obsidian 還在建立索引，請稍後再試' };
    if (this.locks.has(path)) return { ok: false, message: '這則筆記正在同步，請稍後再試' };
    let text: string;
    try {
      text = await this.vault.read(path);
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
    const id = wbIdInText(text);
    if (!id || !WB_ID_RE.test(id)) return { ok: false, message: '這則筆記不是研究工作台產生的（沒有 wb_id）' };
    const r = await this.server.notesByIds([id]);
    if (!r.ok) return { ok: false, message: r.message };
    const n = r.value.notes.find((x) => x.wbId === id);
    if (!n) return { ok: false, message: '研究工作台裡已經沒有這則筆記' };
    const index = this.buildIndex();
    const root = this.opts.rootFolder();
    const resolved = resolveNote(n, (lid) => {
      const p = lid === id ? path : (index.firstPath(lid) ?? (r.value.names[lid] ? safePath(root, r.value.names[lid]) : null));
      return p ? p.replace(/\.md$/i, '') : null;
    });
    this.locks.add(path);
    let res: MergeResult | null = null;
    try {
      const label = localLabel(this.now());
      await this.vault.process(path, (d) => {
        const m = rebuildNote(d, resolved, label);
        res = m;
        return m.ok ? m.text : d;
      });
    } catch (e) {
      return { ok: false, message: errText(e) };
    } finally {
      this.locks.delete(path);
    }
    const done = res as MergeResult | null;
    if (!done || !done.ok) return { ok: false, message: done ? conflictText(done.conflict) : '沒有寫入' };
    this.noteOwnWrite(path);
    this.known.add(id);
    // other copies with the same id are still a conflict; the next run decides
    this.done(id);
    await this.save();
    this.update({});
    return { ok: true, message: done.changed ? '已重建自動產生區' : '自動產生區已是最新' };
  }

  /** 重新建立被刪除的筆記: forget which deleted notes we wrote and fetch everything again. Returns how many. */
  async recreateDeleted(): Promise<number> {
    if (!this.vault.cacheReady()) return 0;
    const index = this.buildIndex();
    const gone = [...this.known].filter((id) => !index.has(id));
    for (const id of gone) this.known.delete(id);
    this.st.cursor = 0;
    await this.save();
    return gone.length;
  }
}

export const CONFLICT_TEXT: Record<ConflictReason, string> = {
  'hand-edited': '自動產生區被手動修改過',
  'missing-markers': '找不到自動產生區的標記',
  'invalid-markers': '自動產生區的標記不成對或重複',
  'invalid-frontmatter': '筆記開頭的屬性區（frontmatter）沒有結束',
  'id-mismatch': '檔案裡的 wb_id 是另一則筆記',
  'duplicate-id': '有多個檔案使用同一個 wb_id',
  'write-failed': '寫入失敗',
  unavailable: '檔案還沒下載到這台 Mac（iCloud）或無法存取',
};

export const conflictText = (r: ConflictReason) => CONFLICT_TEXT[r];
