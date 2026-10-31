/**
 * Which company an AI means: an id, a ticker ("2301" also matches 2301.TW) or a name. Shared by
 * every tool that takes `company` (and by later tools: list_trades, journal import).
 */
import type { ProjectSummaryDTO } from '../shared/api';
import { ToolError, type Http, type RequestOptions } from './http';

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();
const bareTicker = (t: string) =>
  t
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/\.(TW|TWO)$/, '');

/** With several matches, an active company wins over archived ones. */
const preferActive = (xs: ProjectSummaryDTO[]) => (xs.length > 1 && xs.some((p) => !p.archivedAt) ? xs.filter((p) => !p.archivedAt) : xs);

export const companyLabel = (p: ProjectSummaryDTO) => `${p.name}（${p.security?.ticker || '無代號'}${p.archivedAt ? '，已封存' : ''}，id: ${p.id}）`;

/** Companies matching `ref`: exact id, then ticker or provider symbol, then exact name, then part of a name. */
export function matchCompanies(list: readonly ProjectSummaryDTO[], ref: string): ProjectSummaryDTO[] {
  const r = ref.trim();
  if (!r) return [];
  const byId = list.filter((p) => p.id === r);
  if (byId.length) return byId;
  const t = bareTicker(r);
  const byTicker = list.filter((p) => p.security && (bareTicker(p.security.ticker) === t || bareTicker(p.security.apiSymbol) === t));
  if (byTicker.length) return preferActive(byTicker);
  const n = norm(r);
  const names = (p: ProjectSummaryDTO) => [p.name, p.security?.name ?? ''].map(norm).filter(Boolean);
  const byName = list.filter((p) => names(p).includes(n));
  if (byName.length) return preferActive(byName);
  return preferActive(list.filter((p) => names(p).some((x) => x.includes(n))));
}

/** The one company `ref` names, or a ToolError listing the candidates. */
export function pickCompany(list: readonly ProjectSummaryDTO[], ref: string): ProjectSummaryDTO {
  const m = matchCompanies(list, ref);
  if (m.length === 1) return m[0];
  if (!m.length) {
    const known = list.slice(0, 30).map(companyLabel).join('、');
    throw new ToolError(`找不到公司「${ref}」。研究工作台裡的公司：${known || '（還沒有任何公司）'}${list.length > 30 ? '…' : ''}。可以用 list_companies 查詢。`);
  }
  throw new ToolError(`「${ref}」符合 ${m.length} 家公司：${m.map(companyLabel).join('、')}。請改用 id。`);
}

/** Resolve `ref` against GET /api/projects. */
export async function resolveCompany(http: Pick<Http, 'get'>, ref: string, opts?: RequestOptions): Promise<ProjectSummaryDTO> {
  return pickCompany(await http.get<ProjectSummaryDTO[]>('/api/projects', opts), ref);
}
