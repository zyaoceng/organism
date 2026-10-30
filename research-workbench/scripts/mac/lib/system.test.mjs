import { describe, expect, it } from 'vitest';
import { NODE_RELEASES, nodeForMacos, versionAtLeast } from './system.mjs';

describe('versionAtLeast', () => {
  it('compares dotted versions numerically', () => {
    expect(versionAtLeast('13.5', '13.5')).toBe(true);
    expect(versionAtLeast('13.5.1', '13.5')).toBe(true);
    expect(versionAtLeast('13.4.1', '13.5')).toBe(false);
    expect(versionAtLeast('13.10', '13.5')).toBe(true);
    expect(versionAtLeast('26.0', '13.5')).toBe(true);
    expect(versionAtLeast('11', '11.0')).toBe(true);
    expect(versionAtLeast('10.15.7', '11')).toBe(false);
  });
});

describe('nodeForMacos', () => {
  it('uses Node 24 from macOS 13.5, Node 22 from 11, nothing older', () => {
    expect(nodeForMacos('15.1')).toBe('24.22.2');
    expect(nodeForMacos('13.5')).toBe('24.22.2');
    expect(nodeForMacos('13.4.1')).toBe('22.23.4');
    expect(nodeForMacos('11.7.10')).toBe('22.23.4');
    expect(nodeForMacos('10.15.7')).toBeNull();
  });
  it('has a checksum for every platform of both versions', () => {
    for (const v of ['24.22.2', '22.23.4']) {
      expect(Object.keys(NODE_RELEASES[v]).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64']);
      for (const sha of Object.values(NODE_RELEASES[v])) expect(sha).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
