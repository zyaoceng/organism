import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The research-workbench directory this server runs from. */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface AppVersion {
  /** Git commit the installer downloaded, or 'dev' for a checkout. */
  commit: string;
  installedAt?: string;
}

/** Read <appRoot>/version.json, written by the Mac installer. A development checkout has none. */
export function readVersion(appRoot = APP_ROOT): AppVersion {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(appRoot, 'version.json'), 'utf8')) as Partial<AppVersion>;
    if (typeof v.commit === 'string' && v.commit.trim()) {
      return { commit: v.commit.trim(), ...(typeof v.installedAt === 'string' ? { installedAt: v.installedAt } : {}) };
    }
  } catch {
    // missing or unreadable: a development checkout
  }
  return { commit: 'dev' };
}
