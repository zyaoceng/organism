import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setValue } from '../../domain/model/ops';
import { SCALAR_KEY, type ModelState } from '../../domain/model/types';
import { standardTemplate } from '../../domain/templates/standard';

// A fake server: optimistic locking like the real one, with a configurable save latency.
const server = { version: 1, state: null as ModelState | null, saves: 0, conflicts: 0, latency: 40, committed: [] as ModelState[] };
vi.mock('./api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    ApiError,
    api: {
      saveDraft: async (_pid: string, state: ModelState, version: number) => {
        await delay(server.latency);
        server.saves++;
        if (version !== server.version) {
          server.conflicts++;
          throw new ApiError(409, 'conflict');
        }
        server.version++;
        server.state = state;
        return { state, version: server.version, baseRevisionId: 'r1', updatedAt: '' };
      },
      commit: async () => {
        await delay(20);
        server.committed.push(server.state!);
        server.version++;
        return { seq: 2 };
      },
      project: async () => ({ project: { id: 'p' }, securities: [], head: { state: server.state }, draft: { state: server.state, version: server.version } }),
      revisions: async () => [],
      evidence: async () => [],
    },
  };
});

const { useWorkspace } = await import('./store');
const pe = (s: ModelState) => s.nodes.find((n) => n.role === 'target_multiple')!.id;
const typed = (v: number) => (s: ModelState) => setValue(s, pe(s), SCALAR_KEY, 'base', v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  const state = standardTemplate({ year: 2026 });
  Object.assign(server, { version: 1, state, saves: 0, conflicts: 0, latency: 40, committed: [] });
  useWorkspace.setState({ projectId: 'p', draft: state, draftVersion: 1, saveStatus: 'saved', saveError: null, viewing: null, committing: false, undoStack: [], redoStack: [] });
});

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
