import { describe, expect, it } from 'vitest';
import { appDirName, importedArchiveName, isAppDir, layout, ONE_LINER, shouldCopy, tilde } from './layout.mjs';

describe('layout', () => {
  const L = layout({ home: '/Users/王 小明', platform: 'darwin' });

  it('puts data and logs in the macOS Library folders, keeping spaces and Chinese', () => {
    expect(L.dataDir).toBe('/Users/王 小明/Library/Application Support/ResearchWorkbench');
    expect(L.backupsDir).toBe('/Users/王 小明/Library/Application Support/ResearchWorkbench/backups');
    expect(L.logsDir).toBe('/Users/王 小明/Library/Logs/ResearchWorkbench');
    expect(L.stderrLog).toBe('/Users/王 小明/Library/Logs/ResearchWorkbench/server.err.log');
    expect(L.plist).toBe('/Users/王 小明/Library/LaunchAgents/com.researchworkbench.plist');
    expect(L.launcher).toBe('/Users/王 小明/Applications/研究工作台.app');
    expect(L.downloadsArchive).toBe('/Users/王 小明/Downloads/wb-data.tgz');
  });

  it('runs the service from the stable runtime/current and current links', () => {
    expect(L.node).toBe('/Users/王 小明/ResearchWorkbench/runtime/current/bin/node');
    expect(L.nodeBin).toBe('/Users/王 小明/ResearchWorkbench/runtime/current/bin');
    expect(L.current).toBe('/Users/王 小明/ResearchWorkbench/current');
    expect(layout({ home: '/h', platform: 'darwin', serviceNode: '/opt/node/bin/node' }).nodeBin).toBe('/opt/node/bin');
  });

  it('uses XDG folders on Linux', () => {
    const X = layout({ home: '/home/ci', platform: 'linux' });
    expect(X.mac).toBe(false);
    expect(X.dataDir).toBe('/home/ci/.local/share/research-workbench');
    expect(X.logsDir).toBe('/home/ci/.local/state/research-workbench/logs');
    expect(X.root).toBe('/home/ci/ResearchWorkbench');
  });

  it('rejects a relative home', () => {
    expect(() => layout({ home: 'Users/x', platform: 'darwin' })).toThrow(/absolute/);
  });

  it('documents the one-liner with the branch URL', () => {
    expect(ONE_LINER).toBe(
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/zyaoceng/organism/claude/vibrant-thompson-s3npyj/research-workbench/scripts/mac/install.sh)"',
    );
  });
});

describe('appDirName / isAppDir', () => {
  const sha = '8dacf8594aed836c1e3e2f662421d6037d6f845e';
  it('names release and local folders', () => {
    expect(appDirName({ commit: sha, local: false })).toBe('app-8dacf85');
    expect(appDirName({ commit: sha, local: true })).toBe('app-8dacf85-local');
    expect(appDirName({ commit: null, local: true })).toBe('app-local');
    expect(() => appDirName({ commit: 'main', local: false })).toThrow();
  });
  it('recognises version folders only', () => {
    for (const n of ['app-8dacf85', 'app-8dacf85-local', 'app-local', 'app-8dacf85.partial', 'app-8dacf85.old-1730000000000']) expect(isAppDir(n)).toBe(true);
    for (const n of ['current', 'runtime', 'settings.json', '.install.lock', 'app-', 'apps']) expect(isAppDir(n)).toBe(false);
  });
});

describe('shouldCopy', () => {
  it('skips build output, local data and caches of a checkout', () => {
    for (const p of ['node_modules', 'node_modules/x/index.js', 'dist', 'dist/client/index.html', 'data', 'data/workbench.db', 'e2e/output', 'e2e/output/01.png', '.vite', 'src/.DS_Store']) {
      expect(shouldCopy(p), p).toBe(false);
    }
    for (const p of ['', 'package.json', 'src/server/main.ts', 'e2e/acceptance.mjs', 'scripts/mac/install.mjs', 'src/server/data.ts', 'docs/dist.md']) {
      expect(shouldCopy(p), p).toBe(true);
    }
  });
});

describe('importedArchiveName', () => {
  const at = new Date(2026, 9, 30, 9, 5, 7);
  it('renames next to the original', () => {
    expect(importedArchiveName('/Users/a/Downloads/wb-data.tgz', at)).toBe('/Users/a/Downloads/wb-data.imported-2026-10-30.tgz');
    expect(importedArchiveName('/tmp/old backup.tar.gz', at)).toBe('/tmp/old backup.imported-2026-10-30.tgz');
  });
  it('adds the time when that name is taken', () => {
    expect(importedArchiveName('/d/wb-data.tgz', at, (p) => p === '/d/wb-data.imported-2026-10-30.tgz')).toBe('/d/wb-data.imported-2026-10-30-090507.tgz');
  });
});

describe('tilde', () => {
  it('shortens paths under home only', () => {
    expect(tilde('/Users/a/Library/Logs', '/Users/a')).toBe('~/Library/Logs');
    expect(tilde('/Users/a', '/Users/a')).toBe('~');
    expect(tilde('/Users/ab/x', '/Users/a')).toBe('/Users/ab/x');
  });
});
