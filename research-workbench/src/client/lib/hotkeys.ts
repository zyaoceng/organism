import { useEffect, useRef } from 'react';

/** Ctrl+K (⌘K on a Mac). */
export const isModK = (e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'key'>) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';

/**
 * True while an input method (Zhuyin, Pinyin, Japanese…) is composing: Enter picks a candidate and
 * Esc cancels the composition, so a list's Enter/Esc/arrow handling must ignore the key. Safari
 * reports the composition-ending Enter only through keyCode 229.
 */
export const isComposing = (e: { nativeEvent?: { isComposing?: boolean }; isComposing?: boolean; keyCode?: number }) => !!(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229;

/** Call open on Ctrl/⌘+K, also while typing in an input (as in the project pages). */
export function useModK(open: () => void) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!isModK(e)) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}
