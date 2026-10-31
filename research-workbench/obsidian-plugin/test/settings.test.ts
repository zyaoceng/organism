import { describe, expect, it } from 'vitest';
import { DEFAULTS, MIN_INTERVAL_SEC, normalizeSettings } from '../src/config';

describe('normalizeSettings (hand-edited data.json, regression)', () => {
  it('falls back to the defaults for missing or wrongly typed values', () => {
    expect(normalizeSettings({})).toEqual(DEFAULTS);
    expect(normalizeSettings({ serverUrl: null, token: null, rootFolder: 5, intervalSec: 'abc' })).toEqual(DEFAULTS);
  });

  it('never yields an interval that would make setInterval fire continuously', () => {
    for (const v of ['abc', NaN, 0, -5, null, {}, Infinity]) expect(normalizeSettings({ intervalSec: v }).intervalSec).toBe(DEFAULTS.intervalSec);
    expect(normalizeSettings({ intervalSec: 1 }).intervalSec).toBe(MIN_INTERVAL_SEC);
    expect(normalizeSettings({ intervalSec: '120' }).intervalSec).toBe(120);
  });

  it('trims, strips slashes from the root folder and keeps unknown keys', () => {
    const s = normalizeSettings({ serverUrl: ' http://127.0.0.1:4999 ', token: ' abc ', rootFolder: '/我的研究/', extra: 1 });
    expect(s).toMatchObject({ serverUrl: 'http://127.0.0.1:4999', token: 'abc', rootFolder: '我的研究', extra: 1 });
  });
});
