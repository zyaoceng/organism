import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setValue } from '../../domain/model/ops';
import { SCALAR_KEY, type ModelState } from '../../domain/model/types';
import { standardTemplate } from '../../domain/templates/standard';

// A fake server: optimistic locking like the real one, with configurable latencies. `remoteEdit`
// plays an AI client writing the draft through its own route (the version moves on).
const server = {
  version: 1,
  state: null as ModelState | null,
  saves: 0,
  conflicts: 0,
  latency: 40,
  projectLatency: 5,
  projectCalls: 0,
  committed: [] as ModelState[],
  gen: 'g1',
  headId: 'r1',
  lastActor: 'agent:claude-desktop',
};
vi.mock('./api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public details?: unknown,
      public code: string | null = null,
    ) {
      super(message);
    }
  }
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    ApiError,
    api: {
      saveDraft: async (_pid: string, state: ModelState, version: number, gen?: string) => {
        await delay(server.latency);
        server.saves++;
        if (gen && gen !== server.gen) throw new ApiError(409, 'replaced', { code: 'DB_GENERATION' }, 'DB_GENERATION');
        if (version !== server.version) {
          server.conflicts++;
          throw new ApiError(409, 'conflict', { code: 'VERSION', currentVersion: server.version }, 'VERSION');
        }
        server.version++;
        server.state = state;
        server.lastActor = 'user';
        return { state, version: server.version, baseRevisionId: 'r1', updatedAt: '' };
      },
      commit: async () => {
        await delay(20);
        server.committed.push(server.state!);
        server.version++;
        return { seq: 2 };
      },
      project: async () => {
        server.projectCalls++;
        await delay(server.projectLatency);
        return { project: { id: 'p', name: 'P' }, securities: [], head: { id: server.headId, seq: 1, state: server.state }, draft: { state: server.state, version: server.version } };
      },
      draftMeta: async () => {
        await delay(5);
        return {
          version: server.version,
          baseRevisionId: server.headId,
          updatedAt: '',
          dbGeneration: server.gen,
          headSeq: 1,
          auditSeq: 0,
          lastOp: { id: 1, actor: server.lastActor, kind: 'ops', at: '', summary: '', changeCount: 1 },
        };
      },
      revisions: async () => [],
      evidence: async () => [],
      trades: async () => [],
      catalysts: async () => [],
      notes: async () => [],
      reviews: async () => [],
    },
  };
});

// localStorage, as in a browser ("my version" is kept there after a conflict)
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

const { setPageReloader, unsavedWork, useWorkspace } = await import('./store');
const reloader = vi.fn();
setPageReloader(reloader);

const pe = (s: ModelState) => s.nodes.find((n) => n.role === 'target_multiple')!.id;
const gm = (s: ModelState) => s.nodes.find((n) => n.role === 'gross_margin')!.id;
const typed = (v: number) => (s: ModelState) => setValue(s, pe(s), SCALAR_KEY, 'base', v);
const margin = (v: number) => (s: ModelState) => setValue(s, gm(s), s.periods.at(-1)!.id, 'base', v);
const peOf = (s: ModelState | null) => s!.nodes.find((n) => n.role === 'target_multiple')!.values[SCALAR_KEY];
const gmOf = (s: ModelState | null) => s!.nodes.find((n) => n.role === 'gross_margin')!.values[s!.periods.at(-1)!.id];
/** Another writer (an AI client) changes the server's draft. */
const remoteEdit = (fn: (s: ModelState) => ModelState) => {
  server.state = fn(server.state!);
  server.version++;
  server.lastActor = 'agent:claude-desktop';
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => useWorkspace.getState().flush().catch(() => undefined);

beforeEach(() => {
  const state = standardTemplate({ year: 2026 });
  Object.assign(server, { version: 1, state, saves: 0, conflicts: 0, latency: 40, projectLatency: 5, projectCalls: 0, committed: [], gen: 'g1', headId: 'r1', lastActor: 'user' });
  storage.clear();
  reloader.mockClear();
  useWorkspace.setState({
    projectId: 'p',
    project: { id: 'p', name: 'P' } as never,
    draft: state,
    syncedState: state,
    head: { id: 'r1', seq: 1, state } as never,
    draftVersion: 1,
    saveStatus: 'saved',
    saveError: null,
    viewing: null,
    committing: false,
    loading: false,
    rebasing: false,
    conflict: null,
    mine: null,
    lastRemote: null,
    dbGeneration: 'g1',
    auditSeq: 0,
    undoStack: [],
    redoStack: [],
    toasts: [],
  });
});

// a save still scheduled by a test must not land in the next one
afterEach(settle);

describe('workspace store autosave', () => {
  it('overlapping saves never send a stale version (no false conflict)', async () => {
    server.latency = 800;
    const { edit } = useWorkspace.getState();
    edit(typed(20));
    await sleep(600); // first save starts at 500ms and is still in flight
    edit(typed(21));
    await sleep(2600);
    expect(server.conflicts).toBe(0);
    expect(useWorkspace.getState().saveStatus).toBe('saved');
    expect(server.state!.nodes.find((n) => n.role === 'target_multiple')!.values[SCALAR_KEY]).toBe(21);
  }, 10_000);

  it('flush waits for the latest draft to be saved', async () => {
    const { edit, flush } = useWorkspace.getState();
    edit(typed(30));
    await flush();
    expect(useWorkspace.getState().saveStatus).toBe('saved');
    expect(server.state!.nodes.find((n) => n.role === 'target_multiple')!.values[SCALAR_KEY]).toBe(30);
  });

  it('an edit attempted during a commit is refused instead of silently lost', async () => {
    const { edit, commit } = useWorkspace.getState();
    edit(typed(40));
    const p = commit({ title: 't', reason: 'r', asOfDate: '2026-09-26', evidenceIds: [] });
    await sleep(10);
    expect(edit(typed(41))).toBe(false);
    useWorkspace.getState().undo();
    await p;
    const committed = server.committed[0].nodes.find((n) => n.role === 'target_multiple')!.values[SCALAR_KEY];
    expect(committed).toBe(40);
    expect(useWorkspace.getState().draft!.nodes.find((n) => n.role === 'target_multiple')!.values[SCALAR_KEY]).toBe(40);
    expect(useWorkspace.getState().committing).toBe(false);
    expect(edit(typed(42))).toBe(true);
  });
});

describe('workspace store sync with edits made elsewhere', () => {
  it('applies a newer server draft while everything here is saved, and can undo it', async () => {
    const before = useWorkspace.getState().draft;
    remoteEdit(margin(0.31));
    await useWorkspace.getState().syncNow();
    const s = useWorkspace.getState();
    expect(gmOf(s.draft)).toBe(0.31);
    expect(s.draftVersion).toBe(server.version);
    expect(s.syncedState).toBe(s.draft);
    expect(s.undoStack.at(-1)).toBe(before);
    expect(s.lastRemote).toMatchObject({ actor: 'agent:claude-desktop', changes: 1 });
    const toast = s.toasts.at(-1)!;
    expect(toast.text).toMatch(/Claude/);
    // the toast's Undo puts the old state back and saves it
    toast.action!.run();
    await settle();
    expect(gmOf(server.state)).toBe(gmOf(before));
  });

  it('does not fetch the draft after its own save', async () => {
    useWorkspace.getState().edit(typed(20));
    await settle();
    await useWorkspace.getState().syncNow();
    expect(server.projectCalls).toBe(0);
    expect(useWorkspace.getState().undoStack).toHaveLength(1);
  });

  it('leaves a pending edit alone (its save merges instead)', async () => {
    useWorkspace.getState().edit(typed(20));
    remoteEdit(margin(0.31));
    await useWorkspace.getState().syncNow();
    expect(server.projectCalls).toBe(0);
    expect(peOf(useWorkspace.getState().draft)).toBe(20);
    await settle();
  });

  it('throws away a fetched draft when the user edited during the fetch', async () => {
    server.projectLatency = 200;
    remoteEdit(margin(0.31));
    const p = useWorkspace.getState().syncNow();
    await sleep(40); // the draft is being fetched
    useWorkspace.getState().edit(typed(25));
    await p;
    const s = useWorkspace.getState();
    expect(peOf(s.draft)).toBe(25);
    expect(gmOf(s.draft)).not.toBe(0.31);
    expect(s.draftVersion).toBe(1);
    await settle();
  });

  it('re-applies edits of a different cell onto the newer server draft after a 409', async () => {
    useWorkspace.getState().edit(typed(20)); // saved after 500 ms
    remoteEdit(margin(0.31)); // meanwhile the AI edits another cell
    await sleep(700);
    await settle();
    const s = useWorkspace.getState();
    expect(server.conflicts).toBe(1);
    expect(s.saveStatus).toBe('saved');
    expect(s.conflict).toBeNull();
    expect(peOf(server.state)).toBe(20);
    expect(gmOf(server.state)).toBe(0.31);
    expect(s.draftVersion).toBe(server.version);
    expect(s.toasts.some((t) => /Claude/.test(t.text))).toBe(true);
  });

  it('after re-applying edits, the next keystroke is its own undo step', async () => {
    const { edit } = useWorkspace.getState();
    edit(typed(20), { coalesce: 'pe' });
    remoteEdit(margin(0.31));
    await sleep(700); // the save got a 409 and the edit was re-applied onto the AI's draft
    await settle();
    // still typing in the same field, within the coalescing window
    edit(typed(21), { coalesce: 'pe' });
    useWorkspace.getState().undo();
    const s = useWorkspace.getState();
    expect(peOf(s.draft)).toBe(20);
    expect(gmOf(s.draft)).toBe(0.31);
  });

  it('stops on the same cell edited differently: conflict, editing paused, my version kept', async () => {
    useWorkspace.getState().edit(typed(20));
    remoteEdit(typed(30));
    await sleep(700);
    await settle();
    const s = useWorkspace.getState();
    expect(s.saveStatus).toBe('conflict');
    expect(s.conflict!.failed).toHaveLength(1);
    expect(peOf(s.conflict!.mine)).toBe(20);
    expect(useWorkspace.getState().edit(typed(21))).toBe(false);
    expect(JSON.parse(storage.get('wb.mine.p')!).state).toBeTruthy();
    expect(unsavedWork(s)).toBe(true);
    // nothing of mine reached the server
    expect(peOf(server.state)).toBe(30);
  });

  it('resolves a conflict with the merged version (edits that fit) or theirs', async () => {
    const { edit } = useWorkspace.getState();
    edit(typed(20));
    edit(margin(0.4));
    remoteEdit(typed(30));
    await sleep(700);
    await settle();
    expect(useWorkspace.getState().conflict!.applied).toBe(1);
    useWorkspace.getState().resolveConflict('rebased');
    await settle();
    let s = useWorkspace.getState();
    expect(s.conflict).toBeNull();
    expect(s.saveStatus).toBe('saved');
    expect(storage.has('wb.mine.p')).toBe(false);
    expect(peOf(server.state)).toBe(30);
    expect(gmOf(server.state)).toBe(0.4);

    edit(typed(22));
    remoteEdit(typed(33));
    await sleep(700);
    await settle();
    expect(useWorkspace.getState().saveStatus).toBe('conflict');
    useWorkspace.getState().resolveConflict('theirs');
    s = useWorkspace.getState();
    expect(s.conflict).toBeNull();
    expect(s.saveStatus).toBe('saved');
    expect(s.draft).toBe(server.state);
    expect(s.draftVersion).toBe(server.version);
    expect(edit(typed(23))).toBe(true);
    await settle();
  });

  it('reloads the page when the database was replaced', async () => {
    server.gen = 'g2';
    await useWorkspace.getState().syncNow();
    expect(reloader).toHaveBeenCalledTimes(1);
    expect(server.projectCalls).toBe(0);
    // everything was saved: nothing to keep
    expect(storage.has('wb.mine.p')).toBe(false);
  });

  it('keeps edits that can no longer be saved as "my version" before reloading for replaced data', async () => {
    // an edit still waiting for its save when the poll sees the new generation
    useWorkspace.getState().edit(typed(20));
    server.gen = 'g2';
    await useWorkspace.getState().syncNow();
    expect(reloader).toHaveBeenCalledTimes(1);
    expect(peOf(JSON.parse(storage.get('wb.mine.p')!).state)).toBe(20);
    expect(useWorkspace.getState().mine).not.toBeNull();
    storage.clear();
    // the save itself is refused with DB_GENERATION: same
    await settle();
    expect(reloader).toHaveBeenCalledTimes(2);
    expect(peOf(JSON.parse(storage.get('wb.mine.p')!).state)).toBe(20);
    expect(peOf(server.state)).not.toBe(20);
  });

  it("the toast's Undo takes back only the change it announced", async () => {
    remoteEdit(margin(0.31));
    await useWorkspace.getState().syncNow();
    const toast = useWorkspace.getState().toasts.at(-1)!;
    // the user edits before pressing the toast's Undo: that must not undo the user's edit
    useWorkspace.getState().edit(typed(55));
    toast.action!.run();
    const s = useWorkspace.getState();
    expect(peOf(s.draft)).toBe(55);
    expect(gmOf(s.draft)).toBe(0.31);
    expect(s.toasts.at(-1)!.kind).toBe('error');
    await settle();
  });

  it('counts an open conflict as unsaved work', () => {
    expect(unsavedWork({ saveStatus: 'saved', conflict: null })).toBe(false);
    expect(unsavedWork({ saveStatus: 'conflict', conflict: null })).toBe(true);
    expect(unsavedWork({ saveStatus: 'saved', conflict: {} as never })).toBe(true);
    expect(unsavedWork({ saveStatus: 'pending', conflict: null })).toBe(true);
  });
});
