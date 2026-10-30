/**
 * Which old version folders under ~/ResearchWorkbench to delete after a successful switch: keep the
 * running version and the one before it (the rollback target), delete everything else, including
 * `.partial` folders left by an interrupted install.
 */
import { isAppDir } from './layout.mjs';

/**
 * @param {{ entries: { name: string, mtimeMs: number }[], current: string, previous?: string | null, keep?: number }} o
 *   entries: the directories in ~/ResearchWorkbench; current / previous: folder names (not paths).
 * @returns {string[]} names to delete
 */
export function appDirsToDelete({ entries, current, previous, keep = 2 }) {
  const apps = entries.filter((e) => isAppDir(e.name));
  const kept = new Set([current]);
  if (previous && previous !== current && apps.some((e) => e.name === previous)) kept.add(previous);
  // Same version re-installed (or no previous): keep the newest other finished folder as the rollback target.
  const others = apps.filter((e) => !kept.has(e.name) && !e.name.endsWith('.partial')).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const e of others) {
    if (kept.size >= keep) break;
    kept.add(e.name);
  }
  return apps.filter((e) => !kept.has(e.name)).map((e) => e.name);
}
