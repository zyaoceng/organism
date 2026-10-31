import type { DashboardRowDTO, ProjectSummaryDTO } from '../../shared/api';
import { api } from './api';

/** A company as the Ctrl+K switcher, the search palette and the dashboard filter see it. */
export interface CompanyEntry {
  id: string;
  name: string;
  ticker: string;
  apiSymbol: string;
  exchange: string;
  archived: boolean;
  updatedAt: string;
}

/** Full-width digits and letters become ASCII (２３０１ → 2301), case is ignored. */
export const norm = (s: string) => s.normalize('NFKC').toLowerCase().trim();

export function companyEntry(p: Pick<ProjectSummaryDTO, 'id' | 'name' | 'archivedAt' | 'updatedAt'> & { security: { ticker: string; apiSymbol: string; exchange: string } | null }): CompanyEntry {
  return {
    id: p.id,
    name: p.name,
    ticker: p.security?.ticker ?? '',
    apiSymbol: p.security?.apiSymbol ?? '',
    exchange: p.security?.exchange ?? '',
    archived: !!p.archivedAt,
    updatedAt: p.updatedAt,
  };
}

export const dashboardCompany = (r: DashboardRowDTO): CompanyEntry => companyEntry({ id: r.projectId, name: r.name, archivedAt: r.archivedAt, updatedAt: r.updatedAt, security: r.security });

/** Lower is better; null = no match. */
function rank(c: CompanyEntry, q: string): number | null {
  const ticker = norm(c.ticker);
  const symbol = norm(c.apiSymbol);
  const name = norm(c.name);
  if (ticker === q || symbol === q) return 0;
  if (ticker.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (name.includes(q)) return 3;
  if (ticker.includes(q) || symbol.includes(q)) return 4;
  return null;
}

const byRecent = (a: CompanyEntry, b: CompanyEntry) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Companies matching a name or code, best first: exact code < code prefix < name prefix < name
 * contains < code contains; archived ones after active ones. An empty query lists the active
 * companies edited most recently.
 */
export function matchCompanies(list: CompanyEntry[], query: string, o: { excludeId?: string; limit?: number } = {}): CompanyEntry[] {
  const limit = o.limit ?? 8;
  const q = norm(query);
  const pool = list.filter((c) => c.id !== o.excludeId);
  if (!q)
    return pool
      .filter((c) => !c.archived)
      .sort(byRecent)
      .slice(0, limit);
  const hits: { c: CompanyEntry; r: number }[] = [];
  for (const c of pool) {
    const r = rank(c, q);
    if (r !== null) hits.push({ c, r });
  }
  hits.sort((a, b) => Number(a.c.archived) - Number(b.c.archived) || a.r - b.r || byRecent(a.c, b.c));
  return hits.slice(0, limit).map((h) => h.c);
}

let cache: CompanyEntry[] = [];

/** The last loaded list (empty before the first load), so a switcher opens instantly. */
export function peekCompanies(): CompanyEntry[] {
  return cache;
}

/** Seed the list from data a page already has (the dashboard rows). */
export function rememberCompanies(list: CompanyEntry[]) {
  cache = list;
}

export async function loadCompanies(): Promise<CompanyEntry[]> {
  cache = (await api.projects()).map(companyEntry);
  return cache;
}
