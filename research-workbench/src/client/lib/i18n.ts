import { useSyncExternalStore } from 'react';
import { zhTW } from '../i18n';

/**
 * Interface language. Strings are keyed by their English text, so English needs no
 * dictionary and a missing translation falls back to English instead of a blank.
 * User data (node names, notes, evidence titles) is never translated.
 */
export type Lang = 'en' | 'zh-TW';
export const LANGS: { value: Lang; label: string }[] = [
  { value: 'zh-TW', label: '中文' },
  { value: 'en', label: 'English' },
];

const STORAGE_KEY = 'workbench.lang';
const listeners = new Set<() => void>();

function initialLang(): Lang {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-TW') return saved;
  } catch {
    // storage blocked: fall through to the browser language
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav?.toLowerCase().startsWith('zh') ? 'zh-TW' : 'en';
}

let current: Lang = initialLang();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch {
    // not persisted; the choice still applies to this tab
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-render when the language changes. Call it in any component that caches text in useMemo. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

export type Params = Record<string, string | number | null | undefined>;

function fill(tpl: string, params?: Params): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k] ?? '') : m));
}

/** Translate an English UI string. `{name}` placeholders are filled from params. */
export function t(en: string, params?: Params): string {
  return fill(current === 'zh-TW' ? zhTW[en] ?? en : en, params);
}

/** Plural helper for English; Chinese uses the same form for both. */
export function tn(n: number, one: string, many: string, params?: Params): string {
  return t(n === 1 ? one : many, { n, ...params });
}

export { translateMessage as tm } from '../i18n/messages';
