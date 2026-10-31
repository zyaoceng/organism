/**
 * The plugin's ServerPort over the real server (buildApp), through Fastify's inject with the
 * obsidian token: the round-trip test runs the engine against the actual /api/vault/* routes.
 */
import type { AppContext } from '../../src/server/app';
import type { ReflectionUpload, VaultStatusReport } from '../../src/domain/vault/types';
import type { Result, ServerPort } from '../src/ports';

export function injectServer(ctx: AppContext, token = ctx.tokens.tokens.obsidian): ServerPort {
  async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Result<T>> {
    const res = await ctx.app.inject({ method, url, payload: body as object | undefined, headers: { authorization: `Bearer ${token}` } });
    if (res.statusCode >= 400) {
      const message = (res.json() as { error?: string }).error ?? `HTTP ${res.statusCode}`;
      return { ok: false, kind: res.statusCode === 401 || res.statusCode === 403 ? 'auth' : 'http', status: res.statusCode, message };
    }
    return { ok: true, value: res.json() as T };
  }
  return {
    ping: () => call('GET', '/api/vault/ping'),
    notesAfter: (after, limit) => call('GET', `/api/vault/notes?after=${after}&limit=${limit}`),
    notesByIds: (ids) => call('GET', `/api/vault/notes?ids=${ids.map(encodeURIComponent).join(',')}`),
    reflectionStates: () => call('GET', '/api/vault/reflections/hashes'),
    postReflections: (items: ReflectionUpload[]) => call('POST', '/api/vault/reflections', { items }),
    postStatus: (r: VaultStatusReport) => call('POST', '/api/vault/status', r),
  };
}
