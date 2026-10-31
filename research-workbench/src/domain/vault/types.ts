/**
 * Shared vocabulary of the Obsidian sync: note kinds, ids, the rendered-note wire format and the
 * plugin's status report. Pure and free of Node built-ins: the plugin (Electron) imports this
 * folder too, except render.ts.
 */

/** Bumped when the plugin and the server stop understanding each other's payloads. */
export const VAULT_PROTOCOL = 1;

export type NoteKind = 'company' | 'research_update' | 'trade' | 'ai_session' | 'index';
export const KIND_ORDER: NoteKind[] = ['company', 'research_update', 'trade', 'ai_session', 'index'];

/** Note kinds whose `## 反思` section is read back into the workbench. */
export const REFLECTION_KINDS = ['company', 'research_update', 'trade'] as const;
export type ReflectionKind = (typeof REFLECTION_KINDS)[number];
export const isReflectionKind = (k: unknown): k is ReflectionKind => typeof k === 'string' && (REFLECTION_KINDS as readonly string[]).includes(k);

export const INDEX_IDS = ['index-companies', 'index-trades', 'index-ai'] as const;
export type IndexId = (typeof INDEX_IDS)[number];

/** Every wb_id the server can send: entity ids (ais_ is M3's AI-session prefix) and the three index notes. */
export const WB_ID_RE = /^(?:(?:prj|rev|trd|ais)_[0-9a-z]{4,32}|index-(?:companies|trades|ai))$/;

const PREFIX_KIND: Record<string, NoteKind> = { prj: 'company', rev: 'research_update', trd: 'trade', ais: 'ai_session' };

/** prj_→company, rev_→research_update, trd_→trade, ais_→ai_session, index-*→index; anything else → null. */
export function kindOfWbId(id: string): NoteKind | null {
  if (!WB_ID_RE.test(id)) return null;
  if (id.startsWith('index-')) return 'index';
  return PREFIX_KIND[id.slice(0, id.indexOf('_'))] ?? null;
}

/** A frontmatter value before it is written as YAML (frontmatter.ts renderValue, links.ts resolveNote). */
export type FmValue = string | number | boolean | null | { date: string } | { link: string; alias: string };

export interface RenderedNote {
  wbId: string;
  kind: NoteKind;
  /** The entity was deleted in the workbench; the note stays and says so. */
  deleted: boolean;
  /** Relative to the plugin's root folder, '/'-separated, ends with .md. Used only when the file is created. */
  path: string;
  /** Ordered; every key starts with 'wb_'. */
  frontmatter: [string, FmValue][];
  /** Generated markdown between the markers (markers not included); may contain [[wb:<id>|alias]] tokens. */
  block: string;
  /** User-owned text, written only when the file is created. */
  body: string;
}

/** A RenderedNote whose link tokens and frontmatter values have been turned into vault text. */
export interface ResolvedNote {
  wbId: string;
  /** [key, YAML value text] */
  frontmatter: [string, string][];
  block: string;
  body: string;
}

/** GET /api/vault/notes */
export interface VaultNotesResponse {
  protocol: number;
  generation: string;
  publicUrl: string;
  latestSeq: number;
  nextAfter: number;
  more: boolean;
  notes: RenderedNote[];
  /** wbId → default path of notes linked from this page but not in it. */
  names: Record<string, string>;
  /** Ids that were asked for (or changed) but no longer exist and have no tombstone. */
  missing: string[];
}

export type ConflictReason =
  | 'hand-edited'
  | 'missing-markers'
  | 'invalid-markers'
  | 'invalid-frontmatter'
  | 'id-mismatch'
  | 'duplicate-id'
  | 'write-failed'
  | 'unavailable';

/** Longest reflection the server stores (characters, as sent); the plugin checks it before sending. */
export const MAX_REFLECTION_CHARS = 100_000;

export interface ReflectionUpload {
  wbId: string;
  text: string;
  path: string;
  /** File modification time, ms since the epoch. */
  mtime: number;
  /** Other files that carry the same wb_id (iCloud conflict copies); only `path` was read. */
  duplicatePaths?: string[];
}

/** What the server already holds for one note: the latest hash and the latest hash per source path. */
export interface ServerReflectionState {
  latest: string;
  byPath: Record<string, string>;
}

/** POST /api/vault/status */
export interface VaultStatusReport {
  protocol: number;
  pluginVersion: string;
  vaultName: string;
  cursor: number;
  pending: number;
  skippedOpen: number;
  missing: number;
  /** At most 500. */
  conflicts: { wbId: string; reason: ConflictReason; paths: string[] }[];
  /** At most 10, each at most 500 characters. */
  errors: string[];
  paths?: { reset: boolean; set: Record<string, string>; removed: string[] };
}

/**
 * The same rule on both sides: the server decides whether to store, the plugin whether to send.
 * Nothing stored yet → store unless empty (an empty template is not a reflection). Otherwise store
 * when the text differs from the latest version and from the latest one read from this path, so a
 * stale copy at another path cannot flip the value back and forth, while X→Y→X still records X again.
 */
export function shouldStoreReflection(hash: string, empty: boolean, path: string, s: ServerReflectionState | undefined): boolean {
  if (!s) return !empty;
  return s.latest !== hash && s.byPath[path] !== hash;
}
