/**
 * ServerPort over Obsidian's requestUrl (no CORS, no fetch from app://). Every call carries the
 * plugin's own token; the server attributes the writes to 'obsidian' and refuses anything outside
 * /api/vault/*.
 */
import { requestUrl } from 'obsidian';
import type { ReflectionUpload, ServerReflectionState, VaultNotesResponse, VaultStatusReport } from '../../src/domain/vault/types';
import type { PingResponse, ReflectionResult, Result, ServerPort } from './ports';

export interface Connection {
  serverUrl: string;
  token: string;
}

export class HttpServer implements ServerPort {
  /** Read on every call, so a settings change applies to the next request. */
  constructor(private readonly conn: () => Connection) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Result<T>> {
    const { serverUrl, token } = this.conn();
    if (!token.trim()) return { ok: false, kind: 'auth', message: '尚未設定權杖' };
    let res;
    try {
      res = await requestUrl({
        url: serverUrl.replace(/\/+$/, '') + path,
        method,
        headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        throw: false,
      });
    } catch (e) {
      return { ok: false, kind: 'offline', message: e instanceof Error ? e.message : String(e) };
    }
    if (res.status >= 400) {
      let message = `HTTP ${res.status}`;
      try {
        const j = res.json as { error?: unknown };
        if (typeof j?.error === 'string') message = j.error;
      } catch {
        /* not JSON */
      }
      return { ok: false, kind: res.status === 401 || res.status === 403 ? 'auth' : 'http', status: res.status, message };
    }
    try {
      return { ok: true, value: res.json as T };
    } catch {
      return { ok: false, kind: 'http', status: res.status, message: '伺服器回應不是 JSON' };
    }
  }

  ping() {
    return this.call<PingResponse>('GET', '/api/vault/ping');
  }
  notesAfter(after: number, limit: number) {
    return this.call<VaultNotesResponse>('GET', `/api/vault/notes?after=${after}&limit=${limit}`);
  }
  notesByIds(ids: string[]) {
    return this.call<VaultNotesResponse>('GET', `/api/vault/notes?ids=${ids.map(encodeURIComponent).join(',')}`);
  }
  reflectionStates() {
    return this.call<{ notes: Record<string, ServerReflectionState> }>('GET', '/api/vault/reflections/hashes');
  }
  postReflections(items: ReflectionUpload[]) {
    return this.call<{ results: ReflectionResult[] }>('POST', '/api/vault/reflections', { items });
  }
  postStatus(r: VaultStatusReport) {
    return this.call<{ ok: true }>('POST', '/api/vault/status', r);
  }
}
