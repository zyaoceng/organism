/**
 * The plugin's settings as kept in data.json, without anything from Obsidian (so tests can load it).
 * settings.ts re-exports these next to the settings tab.
 */
export interface SyncSettings {
  serverUrl: string;
  token: string;
  rootFolder: string;
  intervalSec: number;
}

export const DEFAULTS: SyncSettings = { serverUrl: 'http://127.0.0.1:4310', token: '', rootFolder: '研究工作台', intervalSec: 60 };
export const MIN_INTERVAL_SEC = 30;

/**
 * Settings as read from data.json, which the user (or an old installer) may have edited by hand:
 * a missing or wrongly typed value falls back to the default, and the interval is never below the
 * minimum (a NaN interval would make setInterval fire continuously). Other keys are kept.
 */
export function normalizeSettings(raw: Record<string, unknown>): SyncSettings {
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v.trim() : d);
  const n = typeof raw.intervalSec === 'number' || typeof raw.intervalSec === 'string' ? Number(raw.intervalSec) : NaN;
  return {
    ...raw,
    serverUrl: str(raw.serverUrl, DEFAULTS.serverUrl) || DEFAULTS.serverUrl,
    token: str(raw.token, ''),
    rootFolder: str(raw.rootFolder, DEFAULTS.rootFolder).replace(/^\/+|\/+$/g, ''),
    intervalSec: Number.isFinite(n) && n > 0 ? Math.max(MIN_INTERVAL_SEC, Math.round(n)) : DEFAULTS.intervalSec,
  };
}
