/**
 * Which files carry which wb_id. Rebuilt from the metadata cache at the start of every run instead
 * of being kept up to date from vault events, so a missed rename or a sync conflict copy can never
 * leave it stale. Files are found by wb_id, never by path: the user may move and rename notes.
 */
import { WB_ID_RE } from '../../src/domain/vault/types';

export class WbIndex {
  private byId = new Map<string, string[]>();

  static build(entries: Iterable<[string, string | null]>): WbIndex {
    const ix = new WbIndex();
    for (const [path, id] of entries) if (id) ix.add(path, id);
    return ix;
  }

  /** Ids that are not workbench ids are ignored. */
  add(path: string, id: string) {
    if (!WB_ID_RE.test(id)) return;
    const paths = this.byId.get(id) ?? [];
    if (!paths.includes(path)) {
      paths.push(path);
      paths.sort();
    }
    this.byId.set(id, paths);
  }

  /** Every file with this id, sorted; more than one is a duplicate-id conflict. */
  pathsFor(id: string): string[] {
    return this.byId.get(id) ?? [];
  }

  firstPath(id: string): string | null {
    return this.byId.get(id)?.[0] ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** [wbId, paths] for every id. */
  entries(): [string, string[]][] {
    return [...this.byId.entries()];
  }
}
