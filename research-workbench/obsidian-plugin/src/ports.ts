/**
 * What the sync engine needs from Obsidian and from the workbench server. The engine and its tests
 * see only these interfaces; obsidianVault.ts and httpServer.ts are the real implementations.
 */
import type { ReflectionUpload, ServerReflectionState, VaultNotesResponse, VaultStatusReport } from '../../src/domain/vault/types';

/**
 * The vault, as far as the sync may touch it. There is no delete and no rename on purpose: the
 * plugin can create a note or rewrite the generated parts of one, nothing else.
 */
export interface VaultPort {
  /** The metadata cache has read every file, so wbIdOf can be trusted. */
  cacheReady(): boolean;
  listMarkdown(): { path: string; mtime: number }[];
  /** wb_id from the metadata cache's frontmatter, or null. */
  wbIdOf(path: string): string | null;
  /** Modification time of a file the vault knows, or null. */
  mtimeOf(path: string): number | null;
  /**
   * Case- and Unicode-insensitive: 'file' is an indexed file at that path (its real spelling);
   * 'unindexed' means something is on disk that the vault does not list (an iCloud placeholder).
   */
  probe(path: string): Promise<{ kind: 'none' } | { kind: 'file'; path: string } | { kind: 'unindexed' }>;
  /** From disk, not the cache. */
  read(path: string): Promise<string>;
  /** Throws if anything already exists at the path. */
  create(path: string, content: string): Promise<void>;
  /** Atomic read-modify-write; `fn` returning its input unchanged writes nothing new. */
  process(path: string, fn: (data: string) => string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  isOpenInEditor(path: string): boolean;
}

export type Failure = { ok: false; kind: 'offline' | 'auth' | 'http'; status?: number; message: string };
export type Result<T> = { ok: true; value: T } | Failure;

/** GET /api/vault/ping */
export interface PingResponse {
  ok: boolean;
  protocol: number;
  generation: string;
  publicUrl: string;
  latestSeq: number;
  serverTime: string;
}

/** POST /api/vault/reflections, one per uploaded item. */
export interface ReflectionResult {
  wbId: string;
  status: 'stored' | 'unchanged' | 'rejected';
  versionId?: number;
  error?: string;
}

export interface ServerPort {
  ping(): Promise<Result<PingResponse>>;
  notesAfter(after: number, limit: number): Promise<Result<VaultNotesResponse>>;
  notesByIds(ids: string[]): Promise<Result<VaultNotesResponse>>;
  reflectionStates(): Promise<Result<{ notes: Record<string, ServerReflectionState> }>>;
  postReflections(items: ReflectionUpload[]): Promise<Result<{ results: ReflectionResult[] }>>;
  postStatus(r: VaultStatusReport): Promise<Result<{ ok: true }>>;
}

/** Kept in data.json between runs. */
export interface PersistedState {
  /** The server database this cursor belongs to; a restore or import changes it. */
  generation: string | null;
  publicUrl: string | null;
  /** Last vault_changes seq applied. */
  cursor: number;
  /** Notes to fetch again by id: skipped (open, conflict, write error) or not yet written. */
  pending: string[];
  /** Ids the plugin has written a file for; a known id without a file was deleted by the user. */
  known: string[];
}

export const DEFAULT_STATE: PersistedState = { generation: null, publicUrl: null, cursor: 0, pending: [], known: [] };
