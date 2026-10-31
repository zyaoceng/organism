import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReleaseError, isCommit, parseRelease, rawUrl, releaseUrl, tarExtractArgs, tarballUrl } from './release.mjs';

const sha = '8dacf8594aed836c1e3e2f662421d6037d6f845e';

describe('parseRelease', () => {
  it('reads the tested commit', () => {
    expect(parseRelease(JSON.stringify({ commit: sha, date: '2026-10-30' }))).toEqual({ commit: sha, short: '8dacf85', date: '2026-10-30' });
    expect(parseRelease(`{"commit":"${sha}"}`).date).toBeNull();
  });

  it('refuses "pending" with its own code', () => {
    try {
      parseRelease('{"commit": "pending", "note": "updated after tests pass"}');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReleaseError);
      expect(e.code).toBe('PENDING');
    }
  });

  it('refuses anything that is not a full sha', () => {
    for (const text of ['not json', '[]', '{}', '{"commit": "8dacf85"}', `{"commit": "${sha.toUpperCase()}"}`, `{"commit": "${sha}-x"}`, '{"commit": 1}']) {
      expect(() => parseRelease(text), text).toThrow(ReleaseError);
    }
  });

  it('the release.json in this checkout is either pending or a valid commit', () => {
    const text = fs.readFileSync(new URL('../../../release.json', import.meta.url), 'utf8');
    try {
      expect(isCommit(parseRelease(text).commit)).toBe(true);
    } catch (e) {
      expect(e.code).toBe('PENDING');
    }
  });
});

describe('URLs', () => {
  it('points at the branch for release.json and at the exact commit for code', () => {
    expect(releaseUrl()).toBe('https://raw.githubusercontent.com/zyaoceng/organism/claude/vibrant-thompson-s3npyj/research-workbench/release.json');
    expect(rawUrl(sha, 'scripts/mac/install.mjs')).toBe(`https://raw.githubusercontent.com/zyaoceng/organism/${sha}/research-workbench/scripts/mac/install.mjs`);
    expect(tarballUrl(sha)).toBe(`https://codeload.github.com/zyaoceng/organism/tar.gz/${sha}`);
  });
});

describe('tarExtractArgs', () => {
  it('extracts only research-workbench/ of a codeload-style tarball', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tar-'));
    try {
      const top = path.join(dir, 'src', `organism-${sha}`);
      fs.mkdirSync(path.join(top, 'research-workbench', 'src', 'server'), { recursive: true });
      fs.mkdirSync(path.join(top, '01_功率半導體'), { recursive: true });
      fs.writeFileSync(path.join(top, 'research-workbench', 'package.json'), '{}');
      fs.writeFileSync(path.join(top, 'research-workbench', 'src', 'server', 'main.ts'), '');
      fs.writeFileSync(path.join(top, '01_功率半導體', 'deck.html'), '');
      fs.writeFileSync(path.join(top, 'README.md'), '');
      const archive = path.join(dir, 'a.tar.gz');
      expect(spawnSync('tar', ['-czf', archive, '-C', path.join(dir, 'src'), `organism-${sha}`]).status).toBe(0);
      const dest = path.join(dir, 'app with space');
      fs.mkdirSync(dest);
      const r = spawnSync('tar', tarExtractArgs(archive, dest, sha), { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(fs.readdirSync(dest).sort()).toEqual(['package.json', 'src']);
      expect(fs.existsSync(path.join(dest, 'src', 'server', 'main.ts'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the commit folder is not in the archive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tar-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'organism-other', 'research-workbench'), { recursive: true });
      const archive = path.join(dir, 'a.tar.gz');
      spawnSync('tar', ['-czf', archive, '-C', path.join(dir, 'src'), 'organism-other']);
      fs.mkdirSync(path.join(dir, 'dest'));
      expect(spawnSync('tar', tarExtractArgs(archive, path.join(dir, 'dest'), sha)).status).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
