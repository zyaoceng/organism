import { describe, expect, it } from 'vitest';
import { isComposing, isModK } from './hotkeys';

const key = (k: string, o: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({ key: k, ctrlKey: false, metaKey: false, ...o });

describe('Ctrl/⌘+K', () => {
  it('opens on Ctrl+K and ⌘K, with or without Shift', () => {
    expect(isModK(key('k', { ctrlKey: true }))).toBe(true);
    expect(isModK(key('k', { metaKey: true }))).toBe(true);
    expect(isModK(key('K', { ctrlKey: true }))).toBe(true);
  });

  it('ignores K alone and other shortcuts', () => {
    expect(isModK(key('k'))).toBe(false);
    expect(isModK(key('j', { ctrlKey: true }))).toBe(false);
    expect(isModK(key('z', { metaKey: true }))).toBe(false);
  });
});

describe('IME composition', () => {
  it('treats Enter/Esc while composing Chinese as part of the input method, not the list', () => {
    expect(isComposing({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
    // Safari: the composition-ending Enter arrives as keyCode 229 with isComposing false
    expect(isComposing({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
    expect(isComposing({ isComposing: true })).toBe(true);
  });

  it('lets a plain Enter through', () => {
    expect(isComposing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    expect(isComposing({})).toBe(false);
  });
});
