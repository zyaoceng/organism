import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDTO } from '../../shared/api';

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

// The mode is read once when the module loads, so each test imports a fresh copy.
async function load(initial?: Record<string, string>) {
  const storage = fakeStorage(initial);
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
  return { prefs: await import('./prefs'), storage };
}

const provider = (id: string, over: Partial<ProviderDTO> = {}): ProviderDTO => ({ id, label: id, description: '', synthetic: false, fetches: true, ...over });
const PROVIDERS = [provider('yahoo'), provider('finmind'), provider('fugle'), provider('demo', { synthetic: true }), provider('csv', { fetches: false })];

describe('basic / advanced mode', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('starts in basic mode when nothing is saved', async () => {
    const { prefs } = await load();
    expect(prefs.getAdvanced()).toBe(false);
  });

  it('reads a saved choice', async () => {
    expect((await load({ 'workbench.advanced': '1' })).prefs.getAdvanced()).toBe(true);
    expect((await load({ 'workbench.advanced': '0' })).prefs.getAdvanced()).toBe(false);
  });

  it('stores 1 / 0 (never removes the key) and notifies listeners', async () => {
    const { prefs, storage } = await load();
    const seen: boolean[] = [];
    const unsub = prefs.subscribeAdvanced(() => seen.push(prefs.getAdvanced()));
    prefs.setAdvanced(true);
    expect(storage.getItem('workbench.advanced')).toBe('1');
    expect(prefs.getAdvanced()).toBe(true);
    prefs.setAdvanced(false);
    expect(storage.getItem('workbench.advanced')).toBe('0');
    prefs.setAdvanced(false); // no change, no notification
    unsub();
    expect(seen).toEqual([true, false]);
  });

  it('still switches when storage is blocked', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    vi.resetModules();
    const prefs = await import('./prefs');
    expect(prefs.getAdvanced()).toBe(false);
    prefs.setAdvanced(true);
    expect(prefs.getAdvanced()).toBe(true);
  });

  it('hides info notes and the two structural warnings only in basic mode', async () => {
    const { prefs } = await load();
    const cases = [
      { severity: 'info', code: 'HARDCODED' },
      { severity: 'warning', code: 'ROLE_DUPLICATE' },
      { severity: 'warning', code: 'OVERRIDE_ON_ACTUAL' },
    ] as const;
    for (const c of cases) {
      expect(prefs.issueVisible(c, false)).toBe(false);
      expect(prefs.issueVisible(c, true)).toBe(true);
    }
    expect(prefs.issueVisible({ severity: 'error', code: 'CYCLE' }, false)).toBe(true);
    expect(prefs.issueVisible({ severity: 'warning', code: 'UNIT_MISMATCH' }, false)).toBe(true);
  });

  it('lists only real price sources in basic mode, plus the one in use', async () => {
    const { prefs } = await load();
    const ids = (adv: boolean, current?: string) => PROVIDERS.filter((p) => prefs.providerVisible(p, adv, current)).map((p) => p.id);
    expect(ids(false)).toEqual(['yahoo', 'finmind', 'fugle']);
    expect(ids(false, 'demo')).toEqual(['yahoo', 'finmind', 'fugle', 'demo']);
    expect(ids(false, 'csv')).toEqual(['yahoo', 'finmind', 'fugle', 'csv']);
    expect(ids(true, 'yahoo')).toEqual(['yahoo', 'finmind', 'fugle', 'demo', 'csv']);
  });
});
