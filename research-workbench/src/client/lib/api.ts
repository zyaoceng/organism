import type {
  AuditEntryDTO,
  BarsResponse,
  CatalystDTO,
  DraftDTO,
  EvidenceDTO,
  NoteDTO,
  ProjectBundleDTO,
  ProjectDTO,
  ProjectSummaryDTO,
  ProviderDTO,
  QuoteResponse,
  ReviewDTO,
  RevisionFull,
  RevisionKind,
  RevisionMeta,
  SecurityDTO,
  SeriesPoint,
  TemplateDTO,
  TradeDTO,
} from '../../shared/api';
import type { ModelState } from '../../domain/model/types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError(0, `Cannot reach the Research Workbench server (${(e as Error).message}). Is it running?`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const j = json as { error?: string; details?: unknown } | null;
    const details = Array.isArray(j?.details) ? `: ${(j!.details as string[]).slice(0, 5).join('; ')}` : '';
    throw new ApiError(res.status, (j?.error ?? `HTTP ${res.status}`) + details, j?.details);
  }
  return json as T;
}

const get = <T>(u: string) => request<T>('GET', u);
const post = <T>(u: string, b?: unknown) => request<T>('POST', u, b ?? {});
const put = <T>(u: string, b?: unknown) => request<T>('PUT', u, b);
const patch = <T>(u: string, b?: unknown) => request<T>('PATCH', u, b);
const del = <T>(u: string) => request<T>('DELETE', u);

export interface CommitRequest {
  title: string;
  reason: string;
  notes?: string;
  asOfDate: string;
  evidenceIds: string[];
  draftVersion: number;
  kind?: RevisionKind;
}

export const api = {
  projects: () => get<ProjectSummaryDTO[]>('/api/projects'),
  createProject: (b: { name: string; description?: string; templateId?: string; year?: number; security: Partial<SecurityDTO> & { ticker: string } }) => post<{ id: string }>('/api/projects', b),
  project: (id: string) => get<ProjectBundleDTO>(`/api/projects/${id}`),
  updateProject: (id: string, b: { name?: string; description?: string; archived?: boolean }) => patch<ProjectDTO>(`/api/projects/${id}`, b),
  updateSecurity: (id: string, b: Partial<SecurityDTO>) => patch<SecurityDTO>(`/api/securities/${id}`, b),
  saveDraft: (id: string, state: ModelState, version: number) => put<DraftDTO>(`/api/projects/${id}/draft`, { state, version }),
  discardDraft: (id: string, version: number) => post<DraftDTO>(`/api/projects/${id}/draft/discard`, { version }),
  restoreDraft: (id: string, revisionId: string, version: number) => post<DraftDTO>(`/api/projects/${id}/draft/restore`, { revisionId, version }),
  revisions: (id: string) => get<RevisionMeta[]>(`/api/projects/${id}/revisions`),
  revision: (id: string, rid: string) => get<RevisionFull>(`/api/projects/${id}/revisions/${rid}`),
  commit: (id: string, b: CommitRequest) => post<RevisionFull>(`/api/projects/${id}/revisions`, b),
  series: (id: string, nodeIds: string[]) => get<SeriesPoint[]>(`/api/projects/${id}/series?nodeIds=${nodeIds.map(encodeURIComponent).join(',')}`),
  audit: (id: string, entityId?: string) => get<AuditEntryDTO[]>(`/api/projects/${id}/audit${entityId ? `?entityId=${entityId}` : ''}`),

  evidence: (id: string) => get<EvidenceDTO[]>(`/api/projects/${id}/evidence`),
  createEvidence: (id: string, b: Record<string, unknown> | FormData) => post<EvidenceDTO>(`/api/projects/${id}/evidence`, b),
  updateEvidence: (eid: string, b: Record<string, unknown>) => patch<EvidenceDTO>(`/api/evidence/${eid}`, b),
  addEvidenceFiles: (eid: string, fd: FormData) => post<EvidenceDTO>(`/api/evidence/${eid}/files`, fd),
  archiveEvidence: (eid: string, archived: boolean) => post<EvidenceDTO>(`/api/evidence/${eid}/archive`, { archived }),
  deleteEvidence: (eid: string) => del<{ ok: true }>(`/api/evidence/${eid}`),

  catalysts: (id: string) => get<CatalystDTO[]>(`/api/projects/${id}/catalysts`),
  createCatalyst: (id: string, b: Partial<CatalystDTO>) => post<CatalystDTO>(`/api/projects/${id}/catalysts`, b),
  updateCatalyst: (cid: string, b: Partial<CatalystDTO>) => patch<CatalystDTO>(`/api/catalysts/${cid}`, b),
  deleteCatalyst: (cid: string) => del<{ ok: true }>(`/api/catalysts/${cid}`),

  trades: (id: string) => get<TradeDTO[]>(`/api/projects/${id}/trades`),
  createTrade: (id: string, b: Partial<TradeDTO>) => post<TradeDTO>(`/api/projects/${id}/trades`, b),
  updateTrade: (tid: string, b: Partial<TradeDTO>) => patch<TradeDTO>(`/api/trades/${tid}`, b),
  deleteTrade: (tid: string) => del<{ ok: true }>(`/api/trades/${tid}`),

  notes: (id: string) => get<NoteDTO[]>(`/api/projects/${id}/notes`),
  createNote: (id: string, body: string) => post<NoteDTO>(`/api/projects/${id}/notes`, { body }),
  updateNote: (nid: string, body: string) => patch<NoteDTO>(`/api/notes/${nid}`, { body }),
  deleteNote: (nid: string) => del<{ ok: true }>(`/api/notes/${nid}`),

  reviews: (id: string) => get<ReviewDTO[]>(`/api/projects/${id}/reviews`),
  createReview: (id: string, b: Partial<ReviewDTO>) => post<ReviewDTO>(`/api/projects/${id}/reviews`, b),
  updateReview: (rid: string, b: Partial<ReviewDTO>) => patch<ReviewDTO>(`/api/reviews/${rid}`, b),
  deleteReview: (rid: string) => del<{ ok: true }>(`/api/reviews/${rid}`),

  templates: () => get<TemplateDTO[]>('/api/templates'),
  saveTemplate: (b: { projectId: string; name: string; description?: string; includeValues?: boolean }) => post<TemplateDTO>('/api/templates', b),
  deleteTemplate: (tid: string) => del<{ ok: true }>(`/api/templates/${tid}`),

  providers: () => get<ProviderDTO[]>('/api/market/providers'),
  quote: (sid: string, provider?: string, refresh = false) => get<QuoteResponse>(`/api/securities/${sid}/quote?${new URLSearchParams({ ...(provider ? { provider } : {}), ...(refresh ? { refresh: '1' } : {}) })}`),
  bars: (sid: string, provider?: string, refresh = false) => get<BarsResponse>(`/api/securities/${sid}/bars?${new URLSearchParams({ ...(provider ? { provider } : {}), ...(refresh ? { refresh: '1' } : {}) })}`),
  importBars: (sid: string, fd: FormData) => post<{ imported: number; skipped: number; first: string; last: string }>(`/api/securities/${sid}/bars/import`, fd),
};
