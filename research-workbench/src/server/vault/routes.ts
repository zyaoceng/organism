/**
 * Routes of the Obsidian sync. The plugin (actor `obsidian`, its own token from tokens.json) may
 * call only /api/vault/* (actor.ts refuses anything else with 403 OBSIDIAN_SCOPE); the plugin
 * routes in turn answer only to it: 401 without a known token, 403 for anyone else.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_PROTOCOL, WB_ID_RE, type ReflectionUpload } from '../../domain/vault/types';
import type { ReflectionDTO, ReflectionVersionDTO, VaultStatusDTO } from '../../shared/api';
import type { DB } from '../db/connection';
import { getProject } from '../repos/projects';
import { badRequest, forbidden, HttpError, nowIso } from '../util';
import { DEFAULT_PAGE, latestSeq, MAX_IDS, MAX_PAGE, NoteSource, noteContext, notesAfter, notesByIds } from './notes';
import { MAX_REFLECTION_ITEMS, projectReflections, reflectionStates, reflectionVersions, storeReflections, type ReflectionResult } from './reflections';
import { parseReport, saveStatus, vaultStatus } from './status';
import { zipFiles } from './zip';

export const PLUGIN_ID = 'research-workbench-sync';
export const PLUGIN_ZIP_NAME = 'research-workbench-sync.zip';
export const DEFAULT_ROOT_FOLDER = '研究工作台';

export interface VaultRouteOptions {
  db: DB;
  /** Base URL the plugin should call and notes link to, e.g. http://127.0.0.1:4310. */
  publicUrl: string;
  /** The built plugin (main.js, manifest.json). */
  pluginDir: string;
  /** The obsidian token from tokens.json, written into the zip's data.json. */
  obsidianToken: () => string;
  /** The current database generation; read on every request (it changes on data import). */
  generation: () => string;
}

const obsidianOnly = (req: FastifyRequest) => {
  if (req.actor === 'unknown') throw new HttpError(401, 'Obsidian token required', { code: 'OBSIDIAN_TOKEN' }, 'OBSIDIAN_TOKEN');
  if (req.actor !== 'obsidian') throw forbidden('Only the Obsidian plugin can call this', { code: 'OBSIDIAN_ONLY' });
};

const userOnly = (req: FastifyRequest) => {
  if (req.actor === 'unknown') throw new HttpError(401, 'Reload the page to download the Obsidian plugin', { code: 'NO_ACTOR' }, 'NO_ACTOR');
  if (req.actor !== 'user') throw forbidden('Only the browser user can download the Obsidian plugin', { code: 'USER_ONLY' });
};

/** A whole number in [min, max], or the default when absent. */
function intParam(v: string | undefined, name: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  if (!/^\d+$/.test(v)) throw badRequest(`${name} must be a whole number`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

export function registerVaultRoutes(app: FastifyInstance, o: VaultRouteOptions): void {
  const { db } = o;
  const meta = () => ({ generation: o.generation(), publicUrl: o.publicUrl });
  const source = () => new NoteSource(db, noteContext(o.publicUrl));

  app.get('/api/vault/ping', async (req) => {
    obsidianOnly(req);
    return { ok: true, protocol: VAULT_PROTOCOL, ...meta(), latestSeq: latestSeq(db), serverTime: nowIso() };
  });

  app.get<{ Querystring: { after?: string; limit?: string; ids?: string } }>('/api/vault/notes', async (req) => {
    obsidianOnly(req);
    const q = req.query;
    // a repeated parameter (?ids=a&ids=b) arrives as a list
    for (const k of ['after', 'limit', 'ids'] as const) if (q[k] !== undefined && typeof q[k] !== 'string') throw badRequest(`${k} may be given once`);
    const src = source();
    let res;
    if (q.ids !== undefined) {
      if (q.after !== undefined || q.limit !== undefined) throw badRequest('Use either ids or after/limit');
      const ids = q.ids.split(',').filter(Boolean);
      if (!ids.length || ids.length > MAX_IDS) throw badRequest(`ids must list 1 to ${MAX_IDS} notes`);
      const bad = ids.find((id) => !WB_ID_RE.test(id));
      if (bad) throw badRequest(`Not a note id: ${bad.slice(0, 80)}`);
      res = notesByIds(src, ids, meta());
    } else {
      const after = intParam(q.after, 'after', 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = intParam(q.limit, 'limit', 1, MAX_PAGE, DEFAULT_PAGE);
      res = notesAfter(src, after, limit, meta());
    }
    if (src.errors.length) req.log.error({ errors: src.errors.slice(0, 20) }, 'some Obsidian notes could not be rendered');
    return res;
  });

  app.get('/api/vault/reflections/hashes', async (req) => {
    obsidianOnly(req);
    return { notes: reflectionStates(db) };
  });

  app.post('/api/vault/reflections', async (req): Promise<{ results: ReflectionResult[] }> => {
    obsidianOnly(req);
    const items = (req.body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items) || !items.length || items.length > MAX_REFLECTION_ITEMS) throw badRequest(`items must list 1 to ${MAX_REFLECTION_ITEMS} reflections`);
    if (items.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) throw badRequest('Each item must be an object');
    return { results: storeReflections(db, items as ReflectionUpload[]) };
  });

  app.post('/api/vault/status', async (req) => {
    obsidianOnly(req);
    saveStatus(db, parseReport(req.body));
    return { ok: true as const };
  });

  // the settings page (any reader)
  app.get('/api/vault/status', async (): Promise<VaultStatusDTO | null> => vaultStatus(db));

  // The plugin with this server's address and the Obsidian token, for installing by hand. The token
  // is in the file, so only the browser user gets it (never an unknown caller or another client).
  app.get('/api/vault/plugin.zip', async (req, reply) => {
    userOnly(req);
    const main = path.join(o.pluginDir, 'main.js');
    const manifest = path.join(o.pluginDir, 'manifest.json');
    if (!fs.existsSync(main) || !fs.existsSync(manifest)) throw new HttpError(404, 'The Obsidian plugin is not built (npm run build)', { code: 'PLUGIN_NOT_BUILT' });
    const data = { serverUrl: o.publicUrl, token: o.obsidianToken(), rootFolder: DEFAULT_ROOT_FOLDER, intervalSec: 60 };
    const zip = zipFiles([
      { name: `${PLUGIN_ID}/main.js`, data: fs.readFileSync(main) },
      { name: `${PLUGIN_ID}/manifest.json`, data: fs.readFileSync(manifest) },
      { name: `${PLUGIN_ID}/data.json`, data: Buffer.from(`${JSON.stringify(data, null, 2)}\n`) },
    ]);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${PLUGIN_ZIP_NAME}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(zip);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/reflections', async (req): Promise<ReflectionDTO[]> => {
    getProject(db, req.params.id);
    return projectReflections(db, req.params.id);
  });

  app.get<{ Params: { noteId: string } }>('/api/reflections/:noteId/versions', async (req): Promise<ReflectionVersionDTO[]> => reflectionVersions(db, req.params.noteId));
}
