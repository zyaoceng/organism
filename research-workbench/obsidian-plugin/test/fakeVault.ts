/**
 * An in-memory vault that behaves like Obsidian on APFS/iCloud where it matters to the engine:
 * paths collide regardless of case and Unicode form, `create` throws when something is there,
 * the metadata cache can be stale or not ready, files can be open in an editor or exist only as
 * iCloud placeholders. Only the engine's own writes are logged in `writes`.
 */
import { findFrontmatter, readTopLevelScalar } from '../../src/domain/vault/frontmatter';
import { pathKey } from '../../src/domain/vault/filename';
import { parseDoc } from '../../src/domain/vault/text';
import type { VaultPort } from '../src/ports';

export interface FakeFile {
  content: string;
  mtime: number;
}

export class FakeVault implements VaultPort {
  files = new Map<string, FakeFile>();
  folders = new Set<string>();
  /** The clock: ms since the epoch. */
  t = Date.UTC(2026, 9, 1, 9, 0, 0);
  ready = true;
  open = new Set<string>();
  /** Paths whose metadata cache entry has not caught up (wbIdOf returns null). */
  staleCache = new Set<string>();
  /** pathKeys of files on disk that the vault does not list (iCloud placeholders). */
  unindexed = new Set<string>();
  writes: { op: 'create' | 'process'; path: string }[] = [];
  /** Called after every engine write (to stop the engine mid-run, for instance). */
  afterWrite: ((path: string) => void) | null = null;

  advance(ms: number) {
    this.t += ms;
  }

  // ---------------------------------------------------------------- VaultPort

  cacheReady() {
    return this.ready;
  }

  listMarkdown() {
    return [...this.files.entries()].filter(([p]) => p.endsWith('.md')).map(([path, f]) => ({ path, mtime: f.mtime }));
  }

  wbIdOf(path: string): string | null {
    const f = this.files.get(path);
    if (!f || this.staleCache.has(path)) return null;
    const lines = parseDoc(f.content).lines;
    const fm = findFrontmatter(lines);
    return fm.kind === 'ok' ? readTopLevelScalar(lines.slice(1, fm.close), 'wb_id') : null;
  }

  mtimeOf(path: string) {
    return this.files.get(path)?.mtime ?? null;
  }

  private find(path: string): string | null {
    const key = pathKey(path);
    for (const p of this.files.keys()) if (pathKey(p) === key) return p;
    return null;
  }

  async probe(path: string) {
    const hit = this.find(path);
    if (hit) return { kind: 'file' as const, path: hit };
    if (this.unindexed.has(pathKey(path))) return { kind: 'unindexed' as const };
    return { kind: 'none' as const };
  }

  async read(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return f.content;
  }

  async create(path: string, content: string) {
    if (this.find(path) || this.unindexed.has(pathKey(path))) throw new Error(`File already exists: ${path}`);
    this.files.set(path, { content, mtime: this.t });
    this.writes.push({ op: 'create', path });
    this.afterWrite?.(path);
  }

  async process(path: string, fn: (data: string) => string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    const out = fn(f.content);
    if (out === f.content) return;
    this.files.set(path, { content: out, mtime: this.t });
    this.writes.push({ op: 'process', path });
    this.afterWrite?.(path);
  }

  async ensureFolder(path: string) {
    this.folders.add(path);
  }

  isOpenInEditor(path: string) {
    return this.open.has(path);
  }

  // ---------------------------------------------------------------- what the user does

  content(path: string): string {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return f.content;
  }

  /** A file the user writes (not logged as an engine write). */
  put(path: string, content: string) {
    this.files.set(path, { content, mtime: this.t });
  }

  userEdit(path: string, fn: (s: string) => string) {
    this.put(path, fn(this.content(path)));
  }

  remove(path: string) {
    this.files.delete(path);
  }

  /** Rename or move; Obsidian keeps the mtime. */
  move(from: string, to: string) {
    const f = this.files.get(from);
    if (!f) throw new Error(`no such file: ${from}`);
    this.files.delete(from);
    this.files.set(to, f);
  }

  /** What iCloud does on a sync conflict: `X 2.md` with the same content. */
  conflictCopy(path: string): string {
    const copy = path.replace(/\.md$/, ' 2.md');
    this.files.set(copy, { ...this.files.get(path)! });
    return copy;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
