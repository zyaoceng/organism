import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compute, freeze } from '../domain/calc/engine';
import { sampleModel } from '../domain/testing/sample';
import type { AuditEntryDTO, EvidenceDTO, ProjectBundleDTO, TradeDTO } from '../shared/api';
import { buildApp } from './app';
import { openDatabase } from './db/connection';
import { MIGRATIONS } from './db/migrations';
import { DemoProvider } from './market/demo';
import { dbGeneration } from './repos/meta';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v2-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const T = '2026-09-01T00:00:00.000Z';

/** A database exactly as v1 shipped it (migration 1 is immutable), with one row in every table that v2 extends. */
function makeV1Database(file: string) {
  const d = new Database(file);
  d.exec(MIGRATIONS.find((m) => m.version === 1)!.sql);
  d.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  d.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(T);
  const state = sampleModel(2026);
  const stateJson = JSON.stringify(state);
  const computed = JSON.stringify(freeze(compute(state)));
  d.prepare("INSERT INTO projects (id, name, description, created_at, updated_at) VALUES ('prj_1', 'Lite-On', '', ?, ?)").run(T, T);
  d.prepare("INSERT INTO securities (id, project_id, name, ticker, exchange, api_symbol, currency, price_source) VALUES ('sec_1', 'prj_1', 'Lite-On', '2301', 'TWSE', '2301.TW', 'TWD', 'demo')").run();
  const rev = d.prepare(
    `INSERT INTO revisions (id, project_id, seq, parent_id, kind, title, reason, notes, as_of_date, committed_at, state_json, computed_json, changes_json, impact_json, market_json, engine_version)
     VALUES (?, 'prj_1', ?, ?, ?, ?, 'r', '', ?, ?, ?, ?, '[]', 'null', NULL, '1.0.0')`,
  );
  rev.run('rev_1', 1, null, 'initial', 'Created', null, T, stateJson, computed);
  rev.run('rev_2', 2, 'rev_1', 'update', 'Initiation', '2026-08-31', T, stateJson, computed);
  d.prepare("INSERT INTO drafts (project_id, state_json, base_revision_id, version, updated_at) VALUES ('prj_1', ?, 'rev_2', 7, ?)").run(stateJson, T);
  d.prepare("INSERT INTO evidence (id, project_id, title, source_type, published_at, added_at, updated_at) VALUES ('ev_1', 'prj_1', 'Q2 call', 'earnings_call', '2026-08-01', ?, ?)").run(T, T);
  d.prepare("INSERT INTO trades (id, project_id, security_id, side, entry_date, entry_price, quantity, created_at, updated_at) VALUES ('trd_1', 'prj_1', 'sec_1', 'long', '2026-09-01', 100, 1000, ?, ?)").run(T, T);
  d.prepare("INSERT INTO notes (id, project_id, body, created_at, updated_at) VALUES ('note_1', 'prj_1', 'old note', ?, ?)").run(T, T);
  d.prepare("INSERT INTO reviews (id, project_id, subject_type, title, created_at, updated_at) VALUES ('rvw_1', 'prj_1', 'project', 'Review', ?, ?)").run(T, T);
  d.prepare("INSERT INTO catalysts (id, project_id, title, type, created_at, updated_at) VALUES ('cat_1', 'prj_1', 'Earnings', 'earnings', ?, ?)").run(T, T);
  d.prepare("INSERT INTO audit_log (project_id, entity, entity_id, action, at, before_json, after_json) VALUES ('prj_1', 'trade', 'trd_1', 'update', ?, '{}', '{}')").run(T);
  d.close();
  return stateJson;
}

describe('upgrading a v1 database to v2', () => {
  it('adds the AI connection schema without touching old rows', async () => {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir);
    const file = path.join(dataDir, 'workbench.db');
    const stateJson = makeV1Database(file);
    const backupDir = path.join(dataDir, 'backups');

    const db = openDatabase(file, { backupDir });
    try {
      const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version);
      expect(versions).toEqual(expect.arrayContaining([1, 2]));
      expect(fs.readdirSync(backupDir).filter((f) => /^pre-v\d+-.+\.db$/.test(f))).toHaveLength(1);

      // rows from before v2 carry no actor ("before v2"); nothing was backfilled
      for (const t of ['revisions', 'evidence', 'trades', 'notes', 'reviews', 'catalysts']) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE created_by IS NOT NULL`).get(), t).toEqual({ n: 0 });
      }
      expect(db.prepare('SELECT actor FROM audit_log').all()).toEqual([{ actor: null }]);
      expect(db.prepare('SELECT source, external_ref, source_text FROM trades').get()).toEqual({ source: null, external_ref: null, source_text: null });
      expect(db.prepare("SELECT published_at_source FROM evidence WHERE id = 'ev_1'").get()).toEqual({ published_at_source: null });
      const states = db.prepare('SELECT state_json, contributors_json FROM revisions ORDER BY seq').all() as { state_json: string; contributors_json: string | null }[];
      expect(states.map((r) => r.state_json)).toEqual([stateJson, stateJson]);
      expect(states.map((r) => r.contributors_json)).toEqual([null, null]);

      const meta = db.prepare('SELECT * FROM db_meta').all() as { db_generation: string }[];
      expect(meta).toHaveLength(1);
      expect(meta[0].db_generation).toMatch(/^[0-9a-f]{32}$/);

      // the guarantees still hold
      expect(() => db.prepare("UPDATE revisions SET title = 'x' WHERE id = 'rev_2'").run()).toThrow(/immutable/);
      const insertTrade = db.prepare(
        "INSERT INTO trades (id, project_id, security_id, side, entry_date, entry_price, quantity, created_at, updated_at, external_ref) VALUES (?, 'prj_1', 'sec_1', 'long', '2026-09-02', 100, 1, ?, ?, ?)",
      );
      insertTrade.run('t_a', T, T, 'jrnl:abc');
      expect(() => insertTrade.run('t_b', T, T, 'jrnl:abc')).toThrow(/UNIQUE/);
      insertTrade.run('t_c', T, T, null);
      insertTrade.run('t_d', T, T, null);
      expect(() =>
        db.prepare("INSERT INTO evidence (id, project_id, title, source_type, added_at, updated_at, published_at_source) VALUES ('ev_x', 'prj_1', 'x', 'other', ?, ?, 'x')").run(T, T),
      ).toThrow(/CHECK/);
      expect(() => db.prepare("INSERT INTO trades (id, project_id, security_id, side, entry_date, entry_price, quantity, created_at, updated_at, source) VALUES ('t_e', 'prj_1', 'sec_1', 'long', '2026-09-02', 1, 1, ?, ?, 'x')").run(T, T)).toThrow(/CHECK/);
      db.prepare("DELETE FROM trades WHERE id IN ('t_a', 't_c', 't_d')").run();
    } finally {
      db.close();
    }

    // the server reads the old rows: no actor, no contributors
    const ctx = await buildApp({ dataDir, providers: [new DemoProvider(() => '2026-09-25')] });
    let generation: string;
    try {
      const get = async <T>(url: string) => (await ctx.app.inject({ method: 'GET', url })).json() as T;
      const b = await get<ProjectBundleDTO>('/api/projects/prj_1');
      expect(b.head).toMatchObject({ seq: 2, createdBy: null, contributors: null, excludedFromCalibration: false });
      expect(b.draft.version).toBe(7);
      expect((await get<TradeDTO[]>('/api/projects/prj_1/trades'))[0]).toMatchObject({ createdBy: null, source: null, externalRef: null, sourceText: null });
      expect((await get<EvidenceDTO[]>('/api/projects/prj_1/evidence'))[0]).toMatchObject({ createdBy: null, publishedAtSource: null });
      expect((await get<AuditEntryDTO[]>('/api/projects/prj_1/audit'))[0].actor).toBeNull();
      // pending changes of a pre-v2 draft count as the user's (none here: the draft equals its base)
      expect(await get('/api/projects/prj_1/draft/pending')).toEqual({ version: 7, changes: [], counts: {} });
      generation = dbGeneration(ctx.db);
    } finally {
      await ctx.app.close();
    }

    // opening again changes nothing
    const again = openDatabase(file, { backupDir });
    try {
      expect(dbGeneration(again)).toBe(generation);
      expect(fs.readdirSync(backupDir).filter((f) => f.startsWith('pre-v'))).toHaveLength(1);
    } finally {
      again.close();
    }
  });
});
