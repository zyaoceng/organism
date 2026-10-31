import { create } from 'zustand';
import type { ModelState, ScenarioId } from '../../domain/model/types';
import { diffStates } from '../../domain/revision/diff';
import { rebaseChanges, sameValue } from '../../domain/revision/rebase';
import { actorLabel } from '../../shared/actors';
import type {
  CatalystDTO,
  DraftMetaDTO,
  EvidenceDTO,
  NoteDTO,
  ProjectDTO,
  QuoteResponse,
  ReflectionDTO,
  ReviewDTO,
  RevisionFull,
  RevisionMeta,
  SecurityDTO,
  TradeDTO,
} from '../../shared/api';
import { api, ApiError, type CommitRequest } from './api';
import { getLang, t, tm, tn } from './i18n';
import { download } from './util';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  /** Optional button inside the toast (e.g. undo an AI edit). */
  action?: { label: string; run: () => void };
}

/**
 * Record lists reloaded when the server reports a change (another window, an AI or the Obsidian
 * plugin wrote them; a reflection from Obsidian writes an audit row, which raises auditSeq).
 */
export const RECORD_PARTS = ['evidence', 'trades', 'catalysts', 'notes', 'reviews', 'revisions', 'reflections'] as const;
export type RecordPart = (typeof RECORD_PARTS)[number];
export type RefreshPart = RecordPart | 'project' | 'quote';

/** The server's draft moved on while this tab had unsaved edits, and not all of them could be re-applied. */
export interface DraftConflict {
  /** This tab's draft when the conflict was found ("my version"). */
  mine: ModelState;
  theirs: ModelState;
  theirsVersion: number;
  head: RevisionFull | null;
  /** The server's version with every edit of mine that could be re-applied. */
  rebased: ModelState;
  applied: number;
  /** Descriptions of the edits that could not be re-applied. */
  failed: string[];
}

/** "My version" kept in this browser after a conflict, until it is downloaded or discarded. */
export interface SavedMine {
  savedAt: string;
  state: ModelState;
}

interface WorkspaceStore {
  projectId: string | null;
  loading: boolean;
  loadError: string | null;
  project: ProjectDTO | null;
  securities: SecurityDTO[];
  head: RevisionFull | null;
  draft: ModelState | null;
  draftVersion: number;
  saveStatus: SaveStatus;
  saveError: string | null;
  undoStack: ModelState[];
  redoStack: ModelState[];
  evidence: EvidenceDTO[];
  catalysts: CatalystDTO[];
  trades: TradeDTO[];
  revisions: RevisionMeta[];
  notes: NoteDTO[];
  reviews: ReviewDTO[];
  /** `## 反思` sections read back from Obsidian (company, Research Updates, trades). */
  reflections: ReflectionDTO[];
  quote: QuoteResponse | null;
  /** The last draft known to equal the server's at `draftVersion` (the base for re-applying edits). */
  syncedState: ModelState | null;
  /** Changes when the whole database is replaced (data import); the page then reloads. */
  dbGeneration: string | null;
  /** Latest record change the server reported for this project (see DraftMetaDTO.auditSeq). */
  auditSeq: number;
  /** Latest draft write the server reported (draft history button). */
  lastOp: DraftMetaDTO['lastOp'];
  rebasing: boolean;
  conflict: DraftConflict | null;
  /** Last draft change made elsewhere and applied here. */
  lastRemote: { actor: string | null; changes: number; at: number } | null;
  /** A "my version" from an earlier conflict, still in this browser. */
  mine: SavedMine | null;

  scenario: ScenarioId;
  selectedNodeId: string | null;
  selectedCell: { nodeId: string; periodKey: string } | null;
  collapsed: Set<string>;
  /** Read-only time travel to an older snapshot. */
  viewing: RevisionFull | null;
  draftPanelOpen: boolean;
  /** Revision whose state was restored into the draft (commit then records kind 'restore'). */
  restoredFrom: string | null;
  /** True while a commit request is in flight; edits are refused so none can be lost. */
  committing: boolean;
  toasts: Toast[];

  load(projectId: string): Promise<void>;
  refresh(part: RefreshPart): Promise<void>;
  /** Reload every record list (RECORD_PARTS). */
  refreshRecords(): Promise<void>;
  /** Poll the server: apply a newer draft written elsewhere, reload changed records, reload the page after a data import. */
  syncNow(): Promise<void>;
  resolveConflict(choice: 'rebased' | 'theirs'): void;
  /** Download "my version" (from the open conflict, or the one kept from an earlier one). */
  downloadMine(): void;
  /** Forget the kept "my version". */
  discardMine(): void;
  /** Put back the draft as it was before a draft history entry (e.g. a discard). */
  recover(opId: number): Promise<void>;
  edit(fn: (s: ModelState) => ModelState, opts?: { coalesce?: string }): boolean;
  undo(): void;
  redo(): void;
  flush(): Promise<void>;
  commit(input: Omit<CommitRequest, 'draftVersion'>): Promise<RevisionFull>;
  discard(): Promise<void>;
  restore(revisionId: string): Promise<void>;
  view(revisionId: string | null): Promise<void>;
  setScenario(s: ScenarioId): void;
  select(nodeId: string | null, periodKey?: string | null): void;
  toggleCollapsed(nodeId: string, value?: boolean): void;
  setDraftPanelOpen(open: boolean): void;
  toast(text: string, kind?: Toast['kind'], action?: Toast['action']): void;
  dismissToast(id: number): void;
  upsertEvidence(e: EvidenceDTO): void;
}

const SAVE_DELAY = 500;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;
let syncing: Promise<void> | null = null;
let lastCoalesce: { key: string; at: number } | null = null;
let toastSeq = 1;

let reloadPage: () => void = () => window.location.reload();
/** Replace the full-page reload (tests). */
export function setPageReloader(fn: () => void) {
  reloadPage = fn;
}

/** Edits that would be lost by closing the tab. */
export function unsavedWork(s: { saveStatus: SaveStatus; conflict: DraftConflict | null }): boolean {
  return ['pending', 'saving', 'error', 'conflict'].includes(s.saveStatus) || !!s.conflict;
}

/** Who to name for a change made elsewhere: the AI client, or another window of the user. */
function whoLabel(actor: string | null | undefined): string {
  return actor === 'user' ? t('another window') : actorLabel(actor, getLang());
}

const mineKey = (pid: string) => `wb.mine.${pid}`;
function persistMine(pid: string, state: ModelState): SavedMine {
  const m = { savedAt: new Date().toISOString(), state };
  try {
    localStorage.setItem(mineKey(pid), JSON.stringify(m));
  } catch {
    /* storage unavailable or full: the conflict strip still offers the download */
  }
  return m;
}
function loadMine(pid: string): SavedMine | null {
  try {
    const raw = localStorage.getItem(mineKey(pid));
    const m = raw ? (JSON.parse(raw) as SavedMine) : null;
    return m?.state && m.savedAt ? m : null;
  } catch {
    return null;
  }
}
function forgetMine(pid: string) {
  try {
    localStorage.removeItem(mineKey(pid));
  } catch {
    /* nothing kept */
  }
}

const collapsedKey = (pid: string) => `wb.collapsed.${pid}`;
function loadCollapsed(pid: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(collapsedKey(pid)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function saveCollapsed(pid: string, s: Set<string>) {
  try {
    localStorage.setItem(collapsedKey(pid), JSON.stringify([...s]));
  } catch {
    /* storage unavailable: collapse state is a convenience only */
  }
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  async function doSave(): Promise<void> {
    const { projectId, draft, draftVersion, conflict, dbGeneration } = get();
    if (!projectId || !draft || conflict) return;
    set({ saveStatus: 'saving' });
    try {
      const d = await api.saveDraft(projectId, draft, draftVersion, dbGeneration ?? undefined);
      if (get().projectId !== projectId) return;
      // Only mark saved if nothing changed while the request was in flight.
      if (get().draft === draft) set({ draftVersion: d.version, syncedState: draft, saveStatus: 'saved', saveError: null });
      else {
        set({ draftVersion: d.version, syncedState: draft, saveStatus: 'pending' });
        schedule();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'DB_GENERATION') {
        set({ saveStatus: 'error', saveError: e.message });
        reloadForReplacedData();
      } else if (e instanceof ApiError && e.status === 409) {
        // Someone else wrote the draft: re-apply this tab's edits onto theirs, inside the save chain.
        await rebaseOntoServer(projectId);
      } else set({ saveStatus: 'error', saveError: (e as Error).message });
    }
  }

  /**
   * The server has a newer draft and this tab has edits it never saw. Replay the edits (the diff
   * from the last shared state) onto the server's draft; keep "my version" when some cannot be.
   */
  async function rebaseOntoServer(pid: string): Promise<void> {
    set({ rebasing: true, saveStatus: 'saving' });
    try {
      const [b, meta] = await Promise.all([api.project(pid), api.draftMeta(pid).catch(() => null)]);
      if (get().projectId !== pid) return;
      const { draft: mine, syncedState, head } = get();
      if (!mine) return;
      const theirs = b.draft.state;
      const r = rebaseChanges(syncedState ?? b.head.state, mine, theirs, { lang: getLang() });
      const who = whoLabel(meta?.lastOp?.actor);
      if (head && b.head.id !== head.id) void get().refresh('revisions');
      if (!r.conflicts.length) {
        const same = sameValue(r.state, theirs);
        set({ draft: r.state, syncedState: theirs, draftVersion: b.draft.version, head: b.head, undoStack: [theirs], redoStack: [], saveStatus: same ? 'saved' : 'pending', saveError: null });
        // the next keystroke starts its own undo step (else one Undo would also drop the re-applied edits)
        lastCoalesce = null;
        if (!same) schedule();
        if (r.applied.length) get().toast(tn(r.applied.length, 'The draft was also changed by {who}; your {n} edit was re-applied', 'The draft was also changed by {who}; your {n} edits were re-applied', { who }));
        return;
      }
      set({
        saveStatus: 'conflict',
        saveError: t('The draft was also changed by {who}; {n} of your edits could not be re-applied', { who, n: r.conflicts.length }),
        conflict: { mine, theirs, theirsVersion: b.draft.version, head: b.head, rebased: r.state, applied: r.applied.length, failed: r.conflicts.map((c) => c.text) },
        mine: persistMine(pid, mine),
      });
    } catch (e) {
      set({ saveStatus: 'error', saveError: (e as Error).message });
    } finally {
      set({ rebasing: false });
    }
  }

  /**
   * The whole database was replaced (data import): reload the page. Edits not yet saved can never
   * be saved now (they belong to the old data), so keep them as "my version" in this browser first.
   */
  function reloadForReplacedData() {
    const s = get();
    if (s.projectId && s.draft && unsavedWork(s)) set({ mine: persistMine(s.projectId, s.draft) });
    reloadPage();
  }

  /** Refuse an edit while the draft is being merged with a version written elsewhere. */
  function blockedByConflict(): boolean {
    const { conflict, rebasing } = get();
    if (!conflict && !rebasing) return false;
    get().toast(
      rebasing ? t('The draft is being merged with a version saved elsewhere. Edit again in a moment.') : t('The draft was changed elsewhere. Choose a version in the draft bar first.'),
      'error',
    );
    return true;
  }

  /** Start a save chained after any in-flight one, so saves never overlap. */
  function startSave() {
    const p: Promise<void> = (saving ?? Promise.resolve()).then(doSave).finally(() => {
      if (saving === p) saving = null;
    });
    saving = p;
  }

  function schedule() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      startSave();
    }, SAVE_DELAY);
  }

  return {
    projectId: null,
    loading: false,
    loadError: null,
    project: null,
    securities: [],
    head: null,
    draft: null,
    draftVersion: 0,
    saveStatus: 'saved',
    saveError: null,
    undoStack: [],
    redoStack: [],
    evidence: [],
    catalysts: [],
    trades: [],
    revisions: [],
    notes: [],
    reviews: [],
    reflections: [],
    quote: null,
    syncedState: null,
    dbGeneration: null,
    auditSeq: 0,
    lastOp: null,
    rebasing: false,
    conflict: null,
    lastRemote: null,
    mine: null,
    scenario: 'base',
    selectedNodeId: null,
    selectedCell: null,
    collapsed: new Set(),
    viewing: null,
    draftPanelOpen: false,
    restoredFrom: null,
    committing: false,
    toasts: [],

    async load(projectId) {
      if (get().projectId !== projectId) {
        // Save any pending edit of the previously open project before switching.
        await get().flush().catch(() => undefined);
        set({ projectId, loading: true, loadError: null, project: null, draft: null, head: null, viewing: null, selectedNodeId: null, selectedCell: null, collapsed: loadCollapsed(projectId), quote: null, reflections: [] });
      }
      // Undo history refers to the state before this load (e.g. before a conflict reload): drop it.
      set({ undoStack: [], redoStack: [], conflict: null, lastRemote: null, mine: loadMine(projectId) });
      try {
        const [b, evidence, catalysts, trades, revisions, notes, reviews, meta] = await Promise.all([
          api.project(projectId),
          api.evidence(projectId),
          api.catalysts(projectId),
          api.trades(projectId),
          api.revisions(projectId),
          api.notes(projectId),
          api.reviews(projectId),
          api.draftMeta(projectId).catch(() => null),
        ]);
        if (get().projectId !== projectId) return;
        set({
          loading: false,
          project: b.project,
          securities: b.securities,
          head: b.head,
          draft: b.draft.state,
          syncedState: b.draft.state,
          draftVersion: b.draft.version,
          saveStatus: 'saved',
          saveError: null,
          evidence,
          catalysts,
          trades,
          revisions,
          notes,
          reviews,
          ...(meta ? { auditSeq: meta.auditSeq, lastOp: meta.lastOp, dbGeneration: get().dbGeneration ?? meta.dbGeneration } : { auditSeq: 0 }),
        });
        void get().refresh('quote');
        // after the rest: a vault problem never keeps the project from opening
        void get().refresh('reflections');
      } catch (e) {
        set({ loading: false, loadError: (e as Error).message });
      }
    },

    async refresh(part) {
      const pid = get().projectId;
      if (!pid) return;
      try {
        switch (part) {
          case 'evidence':
            set({ evidence: await api.evidence(pid) });
            break;
          case 'catalysts':
            set({ catalysts: await api.catalysts(pid) });
            break;
          case 'trades':
            set({ trades: await api.trades(pid) });
            break;
          case 'revisions':
            set({ revisions: await api.revisions(pid) });
            break;
          case 'notes':
            set({ notes: await api.notes(pid) });
            break;
          case 'reviews':
            set({ reviews: await api.reviews(pid) });
            break;
          case 'reflections':
            set({ reflections: await api.reflections(pid) });
            break;
          case 'project': {
            const b = await api.project(pid);
            set({ project: b.project, securities: b.securities });
            break;
          }
          case 'quote': {
            const sec = get().securities[0];
            if (sec) set({ quote: await api.quote(sec.id) });
            break;
          }
        }
      } catch (e) {
        get().toast(tm((e as Error).message), 'error');
      }
    },

    async refreshRecords() {
      await Promise.all(RECORD_PARTS.map((p) => get().refresh(p)));
    },

    syncNow() {
      if (syncing) return syncing;
      const run = async () => {
        const s0 = get();
        const pid = s0.projectId;
        if (!pid || !s0.draft || s0.loading || s0.committing || s0.rebasing || s0.conflict) return;
        const meta = await api.draftMeta(pid);
        const s = get();
        if (s.projectId !== pid || s.loading) return;
        // the whole database was replaced (data import): nothing on this page is valid any more
        if (s.dbGeneration && meta.dbGeneration !== s.dbGeneration) {
          reloadForReplacedData();
          return;
        }
        set({ lastOp: meta.lastOp, ...(s.dbGeneration ? {} : { dbGeneration: meta.dbGeneration }) });
        if (meta.auditSeq > s.auditSeq) {
          set({ auditSeq: meta.auditSeq });
          void get().refreshRecords();
        }
        if (meta.version <= s.draftVersion) return;
        // An edit of this tab is waiting or being saved: its save gets a 409 and re-applies it instead.
        if (s.saveStatus !== 'saved' || saveTimer || saving || s.committing || s.rebasing || s.conflict) return;
        const draftAtStart = s.draft;
        const versionAtStart = s.draftVersion;
        const headAtStart = s.head;
        const b = await api.project(pid);
        const now = get();
        // edited (or switched project) while fetching: keep the edit; its save will merge
        if (now.projectId !== pid || now.draft !== draftAtStart || now.draftVersion !== versionAtStart || now.saveStatus !== 'saved' || saveTimer || saving || now.committing || now.rebasing || now.conflict) return;
        if (b.draft.version <= versionAtStart || !draftAtStart) return;
        const changes = diffStates(draftAtStart, b.draft.state);
        const who = whoLabel(meta.lastOp?.actor);
        const applied = b.draft.state;
        set({ draft: applied, syncedState: applied, draftVersion: b.draft.version, head: b.head });
        if (changes.length) {
          set((x) => ({ undoStack: [...x.undoStack.slice(-99), draftAtStart], redoStack: [], lastRemote: { actor: meta.lastOp?.actor ?? null, changes: changes.length, at: Date.now() } }));
          lastCoalesce = null;
          // The toast's Undo takes back this change only: after a later edit it would undo that edit instead.
          const undoRemote = () => {
            if (get().draft === applied) get().undo();
            else get().toast(t('The draft has changed since; use ↶ Undo in the draft bar instead.'), 'error');
          };
          get().toast(tn(changes.length, '{who} changed {n} item in the draft', '{who} changed {n} items in the draft', { who }), 'info', { label: t('Undo'), run: undoRemote });
        }
        if (headAtStart && b.head.id !== headAtStart.id) {
          void get().refresh('revisions');
          get().toast(t('{who} committed Research Update #{seq}', { who, seq: b.head.seq }), 'info');
        }
      };
      const p: Promise<void> = run()
        .catch(() => undefined) // offline or restarting: the next poll tries again
        .finally(() => {
          if (syncing === p) syncing = null;
        });
      syncing = p;
      return p;
    },

    resolveConflict(choice) {
      const { conflict, projectId } = get();
      if (!conflict || !projectId) return;
      forgetMine(projectId);
      const head = conflict.head ?? get().head;
      if (choice === 'theirs') {
        set({ draft: conflict.theirs, syncedState: conflict.theirs, draftVersion: conflict.theirsVersion, head, conflict: null, mine: null, saveStatus: 'saved', saveError: null, undoStack: [], redoStack: [] });
        return;
      }
      const same = sameValue(conflict.rebased, conflict.theirs);
      lastCoalesce = null;
      set({ draft: conflict.rebased, syncedState: conflict.theirs, draftVersion: conflict.theirsVersion, head, conflict: null, mine: null, saveStatus: same ? 'saved' : 'pending', saveError: null, undoStack: [conflict.theirs], redoStack: [] });
      if (!same) schedule();
    },

    downloadMine() {
      const { conflict, mine, projectId, project } = get();
      const state = conflict?.mine ?? mine?.state;
      if (!state || !projectId) return;
      const savedAt = mine?.savedAt ?? new Date().toISOString();
      const stamp = savedAt.slice(0, 16).replace(/[-:T]/g, '');
      download(`${(project?.name ?? projectId).replace(/\s+/g, '_')}-我的版本-${stamp}.json`, JSON.stringify({ format: 'research-workbench/draft-state', projectId, savedAt, state }, null, 2));
    },

    discardMine() {
      const { projectId } = get();
      if (projectId) forgetMine(projectId);
      set({ mine: null });
    },

    async recover(opId) {
      if (blockedByConflict()) return;
      await get().flush().catch(() => undefined);
      const { projectId, draftVersion, draft } = get();
      if (!projectId) return;
      try {
        const d = await api.recoverDraft(projectId, opId, draftVersion);
        set((s) => ({ draft: d.state, syncedState: d.state, draftVersion: d.version, saveStatus: 'saved', saveError: null, viewing: null, undoStack: draft ? [...s.undoStack.slice(-99), draft] : s.undoStack, redoStack: [] }));
        if (get().head?.id !== d.baseRevisionId) {
          const b = await api.project(projectId);
          set({ head: b.head });
        }
      } catch (e) {
        get().toast(tm((e as Error).message), 'error');
      }
    },

    edit(fn, opts) {
      const { draft, viewing } = get();
      if (!draft) return false;
      if (viewing) {
        get().toast(t('You are viewing an older snapshot (read-only). Return to the draft to edit.'), 'error');
        return false;
      }
      if (get().committing) {
        get().toast(t('A Research Update is being committed. Edit again in a moment.'), 'error');
        return false;
      }
      if (blockedByConflict()) return false;
      let next: ModelState;
      try {
        next = fn(draft);
      } catch (e) {
        get().toast(tm((e as Error).message), 'error');
        return false;
      }
      if (next === draft) return true;
      const now = Date.now();
      const coalesce = opts?.coalesce && lastCoalesce && lastCoalesce.key === opts.coalesce && now - lastCoalesce.at < 1500;
      lastCoalesce = opts?.coalesce ? { key: opts.coalesce, at: now } : null;
      set((s) => ({
        draft: next,
        undoStack: coalesce ? s.undoStack : [...s.undoStack.slice(-99), draft],
        redoStack: [],
        saveStatus: 'pending',
      }));
      schedule();
      return true;
    },

    undo() {
      const { undoStack, draft, viewing, committing } = get();
      if (!undoStack.length || !draft || viewing || committing || blockedByConflict()) return;
      set((s) => ({ draft: undoStack[undoStack.length - 1], undoStack: undoStack.slice(0, -1), redoStack: [...s.redoStack, draft], saveStatus: 'pending' }));
      lastCoalesce = null;
      schedule();
    },

    redo() {
      const { redoStack, draft, viewing, committing } = get();
      if (!redoStack.length || !draft || viewing || committing || blockedByConflict()) return;
      set((s) => ({ draft: redoStack[redoStack.length - 1], redoStack: redoStack.slice(0, -1), undoStack: [...s.undoStack, draft], saveStatus: 'pending' }));
      lastCoalesce = null;
      schedule();
    },

    async flush() {
      // Drain until nothing is scheduled, nothing is in flight and the latest draft is saved.
      for (let guard = 0; guard < 50; guard++) {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          startSave();
        }
        if (saving) {
          await saving;
          continue;
        }
        if (get().saveStatus === 'pending') {
          startSave();
          continue;
        }
        break;
      }
      const st = get().saveStatus;
      if (st === 'error' || st === 'conflict') throw new Error(get().saveError ?? t('The draft could not be saved'));
      if (st !== 'saved') throw new Error(t('The draft is still being saved; try again'));
    },

    async commit(input) {
      const { projectId } = get();
      if (!projectId) throw new Error(t('No project'));
      // Block edits first, so nothing can change between the final save and the commit.
      set({ committing: true });
      try {
        await get().flush();
        const rev = await api.commit(projectId, { ...input, draftVersion: get().draftVersion });
        const b = await api.project(projectId);
        set({ head: b.head, draft: b.draft.state, syncedState: b.draft.state, draftVersion: b.draft.version, saveStatus: 'saved', undoStack: [], redoStack: [], restoredFrom: null });
        await Promise.all([get().refresh('revisions'), get().refresh('evidence')]);
        return rev;
      } finally {
        set({ committing: false });
      }
    },

    async discard() {
      if (blockedByConflict()) return;
      await get().flush().catch(() => undefined);
      const { projectId, draftVersion } = get();
      if (!projectId) return;
      try {
        const d = await api.discardDraft(projectId, draftVersion);
        set({ draft: d.state, syncedState: d.state, draftVersion: d.version, saveStatus: 'saved', saveError: null, undoStack: [], redoStack: [], restoredFrom: null });
      } catch (e) {
        get().toast(tm((e as Error).message), 'error');
      }
    },

    async restore(revisionId) {
      if (blockedByConflict()) throw new Error(t('The draft was changed elsewhere. Choose a version in the draft bar first.'));
      await get().flush().catch(() => undefined);
      const { projectId, draftVersion, draft } = get();
      if (!projectId) return;
      const d = await api.restoreDraft(projectId, revisionId, draftVersion);
      set((s) => ({ draft: d.state, syncedState: d.state, draftVersion: d.version, saveStatus: 'saved', viewing: null, restoredFrom: revisionId, undoStack: draft ? [...s.undoStack, draft] : s.undoStack, redoStack: [] }));
    },

    async view(revisionId) {
      const { projectId } = get();
      if (!projectId) return;
      if (!revisionId) {
        set({ viewing: null });
        return;
      }
      try {
        set({ viewing: await api.revision(projectId, revisionId) });
      } catch (e) {
        get().toast(tm((e as Error).message), 'error');
      }
    },

    setScenario(s) {
      set({ scenario: s });
    },

    select(nodeId, periodKey) {
      set({ selectedNodeId: nodeId, selectedCell: nodeId && periodKey ? { nodeId, periodKey } : null });
    },

    toggleCollapsed(nodeId, value) {
      const next = new Set(get().collapsed);
      const collapse = value ?? !next.has(nodeId);
      if (collapse) next.add(nodeId);
      else next.delete(nodeId);
      set({ collapsed: next });
      const pid = get().projectId;
      if (pid) saveCollapsed(pid, next);
    },

    setDraftPanelOpen(open) {
      set({ draftPanelOpen: open });
    },

    toast(text, kind = 'info', action) {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text, ...(action ? { action } : {}) }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' || action ? 8000 : 4000);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    upsertEvidence(e) {
      set((s) => ({ evidence: s.evidence.some((x) => x.id === e.id) ? s.evidence.map((x) => (x.id === e.id ? e : x)) : [e, ...s.evidence] }));
    },
  };
});

/** The state shown in the workspace: an older snapshot when time-travelling, else the draft. */
export function useActiveState(): { state: ModelState | null; readOnly: boolean } {
  const draft = useWorkspace((s) => s.draft);
  const viewing = useWorkspace((s) => s.viewing);
  return viewing ? { state: viewing.state, readOnly: true } : { state: draft, readOnly: false };
}
