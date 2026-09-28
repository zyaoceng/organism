import { create } from 'zustand';
import type { ModelState, ScenarioId } from '../../domain/model/types';
import type {
  CatalystDTO,
  EvidenceDTO,
  NoteDTO,
  ProjectDTO,
  QuoteResponse,
  ReviewDTO,
  RevisionFull,
  RevisionMeta,
  SecurityDTO,
  TradeDTO,
} from '../../shared/api';
import { api, ApiError, type CommitRequest } from './api';
import { t, tm } from './i18n';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
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
  quote: QuoteResponse | null;

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
  refresh(part: 'evidence' | 'catalysts' | 'trades' | 'revisions' | 'notes' | 'reviews' | 'project' | 'quote'): Promise<void>;
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
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  upsertEvidence(e: EvidenceDTO): void;
}

const SAVE_DELAY = 500;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;
let lastCoalesce: { key: string; at: number } | null = null;
let toastSeq = 1;

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
    const { projectId, draft, draftVersion } = get();
    if (!projectId || !draft) return;
    set({ saveStatus: 'saving' });
    try {
      const d = await api.saveDraft(projectId, draft, draftVersion);
      // Only mark saved if nothing changed while the request was in flight.
      if (get().draft === draft) set({ draftVersion: d.version, saveStatus: 'saved', saveError: null });
      else {
        set({ draftVersion: d.version, saveStatus: 'pending' });
        schedule();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) set({ saveStatus: 'conflict', saveError: e.message });
      else set({ saveStatus: 'error', saveError: (e as Error).message });
    }
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
    quote: null,
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
        set({ projectId, loading: true, loadError: null, project: null, draft: null, head: null, viewing: null, selectedNodeId: null, selectedCell: null, collapsed: loadCollapsed(projectId), quote: null });
      }
      // Undo history refers to the state before this load (e.g. before a conflict reload): drop it.
      set({ undoStack: [], redoStack: [] });
      try {
        const [b, evidence, catalysts, trades, revisions, notes, reviews] = await Promise.all([
          api.project(projectId),
          api.evidence(projectId),
          api.catalysts(projectId),
          api.trades(projectId),
          api.revisions(projectId),
          api.notes(projectId),
          api.reviews(projectId),
        ]);
        set({
          loading: false,
          project: b.project,
          securities: b.securities,
          head: b.head,
          draft: b.draft.state,
          draftVersion: b.draft.version,
          saveStatus: 'saved',
          saveError: null,
          evidence,
          catalysts,
          trades,
          revisions,
          notes,
          reviews,
        });
        void get().refresh('quote');
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
        saveStatus: s.saveStatus === 'conflict' ? 'conflict' : 'pending',
      }));
      if (get().saveStatus !== 'conflict') schedule();
      return true;
    },

    undo() {
      const { undoStack, draft, viewing, committing } = get();
      if (!undoStack.length || !draft || viewing || committing) return;
      set((s) => ({ draft: undoStack[undoStack.length - 1], undoStack: undoStack.slice(0, -1), redoStack: [...s.redoStack, draft], saveStatus: 'pending' }));
      lastCoalesce = null;
      schedule();
    },

    redo() {
      const { redoStack, draft, viewing, committing } = get();
      if (!redoStack.length || !draft || viewing || committing) return;
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
        set({ head: b.head, draft: b.draft.state, draftVersion: b.draft.version, saveStatus: 'saved', undoStack: [], redoStack: [], restoredFrom: null });
        await Promise.all([get().refresh('revisions'), get().refresh('evidence')]);
        return rev;
      } finally {
        set({ committing: false });
      }
    },

    async discard() {
      await get().flush().catch(() => undefined);
      const { projectId, draftVersion } = get();
      if (!projectId) return;
      try {
        const d = await api.discardDraft(projectId, draftVersion);
        set({ draft: d.state, draftVersion: d.version, saveStatus: 'saved', saveError: null, undoStack: [], redoStack: [], restoredFrom: null });
      } catch (e) {
        get().toast(tm((e as Error).message), 'error');
      }
    },

    async restore(revisionId) {
      await get().flush().catch(() => undefined);
      const { projectId, draftVersion, draft } = get();
      if (!projectId) return;
      const d = await api.restoreDraft(projectId, revisionId, draftVersion);
      set((s) => ({ draft: d.state, draftVersion: d.version, saveStatus: 'saved', viewing: null, restoredFrom: revisionId, undoStack: draft ? [...s.undoStack, draft] : s.undoStack, redoStack: [] }));
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

    toast(text, kind = 'info') {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
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
