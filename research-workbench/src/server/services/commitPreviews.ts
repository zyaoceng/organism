import type { AgentClient } from '../../shared/actors';
import { newId } from '../util';

/**
 * Commit previews an AI must take before committing (preview_commit → commit_research_update).
 * The commit replays exactly what was previewed: the same draft version, knowledge date, kind and
 * evidence. Kept in memory: a server restart drops them (PREVIEW_EXPIRED; preview again).
 */
export interface StoredPreview {
  id: string;
  projectId: string;
  client: AgentClient;
  draftVersion: number;
  baseRevisionId: string;
  dbGeneration: string;
  asOfDate: string;
  kind: 'update' | 'checkpoint';
  evidenceIds: string[];
  needsConfirmation: boolean;
  createdAt: number;
  expiresAt: number;
}

export class CommitPreviewStore {
  private readonly items = new Map<string, StoredPreview>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly max = 200,
    private readonly now: () => number = Date.now,
  ) {}

  put(p: Omit<StoredPreview, 'id' | 'createdAt' | 'expiresAt'>): StoredPreview {
    this.prune();
    const t = this.now();
    const stored: StoredPreview = { ...p, id: newId('cpv'), createdAt: t, expiresAt: t + this.ttlMs };
    this.items.set(stored.id, stored);
    // oldest first: Map keeps insertion order
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
    return stored;
  }

  /** null when unknown or expired. */
  get(id: string): StoredPreview | null {
    const p = this.items.get(id);
    if (!p) return null;
    if (p.expiresAt <= this.now()) {
      this.items.delete(id);
      return null;
    }
    return p;
  }

  delete(id: string) {
    this.items.delete(id);
  }

  private prune() {
    const t = this.now();
    for (const [id, p] of this.items) if (p.expiresAt <= t) this.items.delete(id);
  }
}
