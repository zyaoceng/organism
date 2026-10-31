import type { DB } from '../db/connection';

/**
 * The database generation: a random id that changes when the whole database is replaced (data
 * import). Browser tabs compare it on every poll and reload when it differs. Read it on every
 * request; never cache it.
 */
export function dbGeneration(db: DB): string {
  return (db.prepare('SELECT db_generation FROM db_meta WHERE id = 1').get() as { db_generation: string }).db_generation;
}

export function rotateDbGeneration(db: DB): string {
  db.prepare('UPDATE db_meta SET db_generation = lower(hex(randomblob(16))) WHERE id = 1').run();
  return dbGeneration(db);
}
