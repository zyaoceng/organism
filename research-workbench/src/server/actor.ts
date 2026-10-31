import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { agentClientOf, isAgentActor, type Actor } from '../shared/actors';
import type { AiActionDTO } from '../shared/api';
import type { DB } from './db/connection';
import { recordAiActions, touchAiClient } from './repos/aiSessions';
import type { TokenSet } from './tokens';
import { HttpError, nowIso } from './util';

/**
 * Who is making the current request, carried through async code with AsyncLocalStorage so that
 * repositories can record it without changing their signatures (`currentActor()`).
 *
 * Resolution: `Authorization: Bearer <token>` (AI clients, Obsidian, tests) → the token's actor; otherwise
 * the `wb_session` cookie set by GET /api/session (the browser) → user; otherwise unknown.
 * An unknown caller may read but never write: writes are refused with 401 NO_ACTOR instead of being
 * recorded as the user. Code outside a request (seeding, CLIs, background work) is `system`.
 */

export type AiAction = AiActionDTO;

export interface ActorStore {
  actor: Actor | 'unknown';
  tool: string | null;
  /** Writes made by an agent during this request; grouped into ai_sessions when the response is sent. */
  aiActions: AiAction[];
  /** A POST that changes nothing (heartbeat, preview, dry run): not AI activity. */
  quiet?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | 'unknown';
    actorStore: ActorStore | null;
  }
}

const als = new AsyncLocalStorage<ActorStore>();
const resources = new WeakMap<object, AsyncResource>();

export const SESSION_COOKIE = 'wb_session';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isMutating = (method: string) => MUTATING.has(method.toUpperCase());

export const OBSIDIAN_SCOPE_MESSAGE = 'The Obsidian plugin may only call /api/vault/*';

/** The Obsidian token may call only the vault routes (by matched route, so encoded paths cannot slip through). */
export const inObsidianScope = (routeUrl: string | undefined) => !!routeUrl && routeUrl.startsWith('/api/vault/');

export const NO_ACTOR_MESSAGE = 'Who is writing could not be identified. Reload the page; AI assistants must use the Research Workbench tools.';

/** The actor of the current request; `system` outside a request. Throws 401 for an unidentified caller. */
export function currentActor(): Actor {
  const store = als.getStore();
  if (!store) return 'system';
  if (store.actor === 'unknown') throw new HttpError(401, NO_ACTOR_MESSAGE, { code: 'NO_ACTOR' }, 'NO_ACTOR');
  return store.actor;
}

/** Run `fn` as `actor` (background work, CLIs, tests). */
export function runAs<T>(actor: Actor, fn: () => T): T {
  return als.run({ actor, tool: null, aiActions: [] }, fn);
}

/** Remember a write for the AI activity log. Ignored unless an agent is acting. */
export function noteAiAction(a: Omit<AiAction, 'at' | 'tool'>): void {
  const store = als.getStore();
  if (!store || !isAgentActor(store.actor)) return;
  store.aiActions.push({ ...a, at: nowIso(), tool: store.tool });
}

/** Mark the current request as changing nothing, so it is not listed as AI activity. */
export function quietRequest(): void {
  const store = als.getStore();
  if (store) store.quiet = true;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function resolveActor(req: FastifyRequest, tokens: TokenSet): Actor | 'unknown' {
  const auth = req.headers.authorization;
  if (auth !== undefined) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    return (m && tokens.actorFor(m[1])) || 'unknown';
  }
  const cookie = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (cookie && tokens.actorFor(cookie) === 'user') return 'user';
  return 'unknown';
}

/** Register after the Host/Origin hook (a refused host never reaches these). */
export function installActorHooks(app: FastifyInstance, tokens: TokenSet, db: DB): void {
  app.decorateRequest('actor', 'unknown');
  app.decorateRequest('actorStore', null);
  const lastTouch = new Map<string, number>();

  app.addHook('onRequest', (req, reply, done) => {
    const actor = resolveActor(req, tokens);
    req.actor = actor;
    // Decided on the method alone: a percent-encoded path (/%61pi/…) still reaches an /api route,
    // and a handler that writes before it audits would otherwise keep a write nobody is named for.
    if (actor === 'obsidian' && !inObsidianScope(req.routeOptions.url)) {
      reply.code(403).send({ error: OBSIDIAN_SCOPE_MESSAGE, code: 'OBSIDIAN_SCOPE', details: null });
      return;
    }
    if (actor === 'unknown' && isMutating(req.method)) {
      reply.code(401).send({ error: NO_ACTOR_MESSAGE, code: 'NO_ACTOR', details: null });
      return;
    }
    const client = agentClientOf(actor);
    if (client && Date.now() - (lastTouch.get(client) ?? 0) > 60_000) {
      lastTouch.set(client, Date.now());
      try {
        touchAiClient(db, client);
      } catch (err) {
        req.log.warn({ err }, 'could not record the AI client connection');
      }
    }
    const tool = req.headers['x-workbench-tool'];
    const store: ActorStore = { actor, tool: typeof tool === 'string' && tool ? tool.slice(0, 80) : null, aiActions: [] };
    req.actorStore = store;
    als.run(store, () => {
      const r = new AsyncResource('wb-actor');
      resources.set(req, r);
      r.runInAsyncScope(done, req.raw);
    });
  });

  // Body parsing finishes in the socket's async context; step back into the request's.
  app.addHook('preValidation', (req, _reply, done) => {
    const r = resources.get(req);
    if (r) r.runInAsyncScope(done, req.raw);
    else done();
  });

  // A write must never be recorded under the wrong name: losing the context is a loud error.
  app.addHook('preHandler', (req, _reply, done) => {
    if (isMutating(req.method) && req.actorStore && als.getStore() !== req.actorStore) {
      done(new HttpError(500, 'actor context lost'));
      return;
    }
    done();
  });

  app.addHook('onResponse', (req, reply, done) => {
    const store = req.actorStore;
    const client = agentClientOf(store?.actor);
    if (store && client && isMutating(req.method) && reply.statusCode < 400 && !(store.quiet && !store.aiActions.length)) {
      if (!store.aiActions.length) {
        store.aiActions.push({ at: nowIso(), tool: store.tool, kind: 'other', projectId: null, ref: null, summary: `${req.method} ${req.routeOptions.url ?? req.url}` });
      }
      try {
        recordAiActions(db, client, store.aiActions);
      } catch (err) {
        req.log.error({ err }, 'could not record AI activity');
      }
    }
    done();
  });
}
