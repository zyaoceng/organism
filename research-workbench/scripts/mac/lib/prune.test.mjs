import { describe, expect, it } from 'vitest';
import { appDirsToDelete } from './prune.mjs';

const e = (name, mtimeMs) => ({ name, mtimeMs });

describe('appDirsToDelete', () => {
  it('keeps the running version and the rollback target', () => {
    const entries = [e('app-aaaaaaa', 1), e('app-bbbbbbb', 2), e('app-ccccccc', 3), e('app-ddddddd', 4), e('runtime', 9)];
    expect(appDirsToDelete({ entries, current: 'app-ddddddd', previous: 'app-bbbbbbb' }).sort()).toEqual(['app-aaaaaaa', 'app-ccccccc']);
  });

  it('keeps the newest other version when re-installing the same one', () => {
    const entries = [e('app-aaaaaaa', 1), e('app-bbbbbbb', 3), e('app-ccccccc', 2)];
    expect(appDirsToDelete({ entries, current: 'app-ccccccc', previous: 'app-ccccccc' })).toEqual(['app-aaaaaaa']);
  });

  it('removes leftovers of interrupted installs and set-aside copies', () => {
    const entries = [e('app-aaaaaaa', 1), e('app-bbbbbbb.partial', 5), e('app-aaaaaaa.old-17', 2), e('app-ccccccc-local', 3)];
    expect(appDirsToDelete({ entries, current: 'app-aaaaaaa', previous: 'app-aaaaaaa.old-17' }).sort()).toEqual(['app-bbbbbbb.partial', 'app-ccccccc-local']);
  });

  it('never deletes anything that is not a version folder', () => {
    const entries = [e('app-aaaaaaa', 1), e('runtime', 0), e('current', 0), e('.install.lock', 0), e('notes', 0)];
    expect(appDirsToDelete({ entries, current: 'app-aaaaaaa', previous: null })).toEqual([]);
  });

  it('ignores a previous folder that no longer exists', () => {
    const entries = [e('app-aaaaaaa', 1), e('app-bbbbbbb', 2), e('app-ccccccc', 3)];
    expect(appDirsToDelete({ entries, current: 'app-ccccccc', previous: 'app-zzzzzzz' })).toEqual(['app-aaaaaaa']);
  });
});
