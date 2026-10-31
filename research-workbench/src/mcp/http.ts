/**
 * The adapter's only way into the workbench: HTTP to the local server with this AI client's token
 * from <dataDir>/tokens.json. The server identifies the client by the token and applies every rule;
 * the adapter never touches the database (it must not import src/server or better-sqlite3).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentClient } from '../shared/actors';

export interface RequestOptions {
  /** MCP tool making the request (x-workbench-tool), recorded in the AI activity log. */
  tool?: string;
  timeoutMs?: number;
}

/** What tools and `resolveCompany` need from the client. */
export interface Http {
  get<T>(path: string, opts?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
}

/** The server is not running (connection refused) or did not answer in time. */
export class WorkbenchDownError extends Error {
  override name = 'WorkbenchDownError';
  constructor(
    readonly baseUrl: string,
    readonly reason: 'refused' | 'timeout',
    readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(reason === 'timeout' ? `${baseUrl} did not answer within ${timeoutMs} ms` : `${baseUrl} is not reachable`, { cause });
  }
}

/** tokens.json is missing or has no token for this client. */
export class TokenError extends Error {
  override name = 'TokenError';
}

/** A request the adapter refuses or cannot resolve before calling the server; the message is for the AI (zh). */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** A non-2xx answer: the server's `{ error, code, details }`. */
export class ApiErr extends Error {
  override name = 'ApiErr';
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    readonly details: unknown,
  ) {
    super(message);
  }
}

export class WorkbenchHttp implements Http {
  private token: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: { baseUrl: string; dataDir: string; client: AgentClient; fetch?: typeof fetch }) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  get<T>(p: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', p, undefined, opts);
  }

  post<T>(p: string, body: unknown = {}, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', p, body, opts);
  }

  patch<T>(p: string, body: unknown = {}, opts?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', p, body, opts);
  }

  /** This client's token, read again after a 401 (the server regenerates a deleted tokens.json). */
  readToken(): string {
    const file = path.join(this.opts.dataDir, 'tokens.json');
    let doc: { tokens?: Record<string, unknown> };
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof doc;
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      throw new TokenError(
        missing
          ? `找不到研究工作台的連線憑證 ${file}。請使用者先打開「研究工作台」App（第一次啟動會產生它），或重跑安裝指令。`
          : `研究工作台的連線憑證 ${file} 讀不出來（${(e as Error).message}）。請重跑安裝指令。`,
      );
    }
    const t = doc?.tokens?.[this.opts.client];
    if (typeof t !== 'string' || !t) throw new TokenError(`連線憑證 ${file} 裡沒有 ${this.opts.client} 的項目。請重新啟動「研究工作台」App 或重跑安裝指令。`);
    return t;
  }

  private async request<T>(method: string, p: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    for (let attempt = 0; ; attempt++) {
      this.token ??= this.readToken();
      const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
      if (opts.tool) headers['x-workbench-tool'] = opts.tool;
      if (body !== undefined) headers['content-type'] = 'application/json';
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.baseUrl + p, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const name = (e as Error).name;
        throw new WorkbenchDownError(this.opts.baseUrl, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'refused', timeoutMs, e);
      }
      if (res.status === 401 && attempt === 0) {
        // tokens.json may have been regenerated since it was read
        this.token = null;
        await res.body?.cancel();
        continue;
      }
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const b = (data ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
        const message = typeof b.error === 'string' ? b.error : text.slice(0, 500) || res.statusText;
        throw new ApiErr(res.status, message, typeof b.code === 'string' ? b.code : null, b.details ?? null);
      }
      return data as T;
    }
  }
}
