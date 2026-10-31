/**
 * VaultPort over Obsidian's App. Deliberately no delete or rename. `create` refuses when anything
 * exists at the path in any case or Unicode form, because macOS and iCloud treat those as the same
 * file and Obsidian's own check is case-sensitive.
 */
import { TFile, type App, type MarkdownView } from 'obsidian';
import { pathKey } from '../../src/domain/vault/filename';
import type { VaultPort } from './ports';

export class ObsidianVault implements VaultPort {
  private resolved = false;

  constructor(private readonly app: App) {}

  /** Called on the metadata cache's 'resolved' event. */
  markResolved() {
    this.resolved = true;
  }

  cacheReady(): boolean {
    if (this.resolved) return true;
    const mc = this.app.metadataCache;
    return this.app.vault.getMarkdownFiles().every((f) => mc.getFileCache(f) !== null);
  }

  listMarkdown() {
    return this.app.vault.getMarkdownFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime }));
  }

  wbIdOf(path: string): string | null {
    const id: unknown = this.app.metadataCache.getCache(path)?.frontmatter?.wb_id;
    return typeof id === 'string' ? id : null;
  }

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new Error(`找不到檔案：${path}`);
    return f;
  }

  mtimeOf(path: string): number | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f.stat.mtime : null;
  }

  async probe(path: string) {
    const key = pathKey(path);
    const hit = this.app.vault.getAllLoadedFiles().find((f) => pathKey(f.path) === key);
    if (hit instanceof TFile) return { kind: 'file' as const, path: hit.path };
    // a folder of that name, a file Obsidian does not list, or an iCloud placeholder (.name.icloud)
    if (hit) return { kind: 'unindexed' as const };
    const adapter = this.app.vault.adapter;
    const slash = path.lastIndexOf('/');
    const placeholder = `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.icloud`;
    if ((await adapter.exists(path)) || (await adapter.exists(placeholder))) return { kind: 'unindexed' as const };
    return { kind: 'none' as const };
  }

  read(path: string) {
    return this.app.vault.read(this.file(path));
  }

  async create(path: string, content: string) {
    if ((await this.probe(path)).kind !== 'none') throw new Error(`已經有同名的檔案：${path}`);
    await this.app.vault.create(path, content);
  }

  async process(path: string, fn: (data: string) => string) {
    await this.app.vault.process(this.file(path), fn);
  }

  async ensureFolder(path: string) {
    const segs = path.split('/').filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      if (this.app.vault.getAbstractFileByPath(p)) continue;
      try {
        await this.app.vault.createFolder(p);
      } catch (e) {
        // created meanwhile (or on disk already but not yet listed): fine
        if (!/already exists/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
  }

  /** Also true for background tabs Obsidian has not loaded yet (their view has no file). */
  isOpenInEditor(path: string): boolean {
    return this.app.workspace.getLeavesOfType('markdown').some((l) => {
      const viewFile = (l.view as MarkdownView | undefined)?.file?.path;
      const stateFile = (l.getViewState()?.state as { file?: unknown } | undefined)?.file;
      return viewFile === path || stateFile === path;
    });
  }
}
