/**
 * SQLite database — connection setup + versioned migration runner
 *
 * One `better-sqlite3` database per server process (WAL mode, foreign keys
 * enforced). Migrations are ordered, in-code DDL steps recorded in the
 * `migrations` table; each runs inside a transaction so a failed migration
 * never leaves a half-applied schema.
 *
 * The path comes from config (`EAF_DB_PATH`, default `<repo>/data/eaf.db`);
 * tests use `:memory:`.
 *
 * Migration BODIES live in ./migrations/ (R22 file-budget extraction,
 * verbatim move — the file hit the 2200-line budget at v59; see
 * arch-guards.vitest.test.ts). This file keeps the ordered registry, the
 * runner, and the re-exports that make existing import sites
 * (`from './db/database.js'`) keep working. New migrations go into the
 * segment file covering their version (split further when a segment
 * approaches the budget).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import {
  backfillDerivedServiceInterfaces,
  backfillDerivedServices,
  normalizeAgentLlmNullIntent,
} from './migration-backfills.js';
import type { EafDatabase, Migration } from './migrations/types.js';
import { MIGRATIONS_V1_V20 } from './migrations/v1-v20.js';
import { MIGRATIONS_V21_V40 } from './migrations/v21-v40.js';
import { MIGRATIONS_V41_V59 } from './migrations/v41-v59.js';
import { MIGRATIONS_V60_V79 } from './migrations/v60-v79.js';

export type { EafDatabase } from './migrations/types.js';

/**
 * All schema migrations, ordered. Exported so the migration-robustness test
 * (R15-A2) can build an old-version database fixture and drive the upgrade
 * chain; runtime code only ever consumes it through openDatabase().
 */
export const MIGRATIONS: Migration[] = [
  ...MIGRATIONS_V1_V20,
  ...MIGRATIONS_V21_V40,
  ...MIGRATIONS_V41_V59,
  ...MIGRATIONS_V60_V79,
];

/**
 * Open (creating if needed) the database at `path`, apply WAL + foreign-key
 * pragmas, and run pending migrations. `:memory:` skips directory creation.
 */
export function openDatabase(path: string): EafDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Migrations run with foreign_keys OFF so a table rebuild (v13's proposals
  // CHECK expansion, the standard 12-step procedure) can DROP the original
  // table without firing referential actions (command_log's ON DELETE SET
  // NULL) or having its FK text rewritten by a rename. Enforcement is
  // enabled immediately after, before any data statement runs.
  migrate(db);
  db.pragma('foreign_keys = ON');
  return db;
}

/** Apply every migration newer than the recorded schema version. */
function migrate(db: EafDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  // better-sqlite3 enables foreign_keys by DEFAULT, and PRAGMA foreign_keys
  // is a silent no-op inside a transaction — so the long-documented
  // "migrations run with foreign_keys OFF" invariant (needed by the table
  // rebuilds: v13/v27/v33/v38) was never actually enforced. With FKs ON, a
  // rebuild's DROP TABLE runs an implicit DELETE that CASCADES child tables
  // (v38 dropped service_instances with live subscriptions — found by the
  // migration chain test). Flip the pragma OUTSIDE the per-migration
  // transactions; openDatabase re-enables enforcement right after.
  db.pragma('foreign_keys = OFF');
  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as { version: number }[])
      .map(row => row.version),
  );
  const record = db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
  db.pragma('foreign_keys = ON');
}

/**
 * Migration backfill helpers live in ./migration-backfills.ts (R21-W5
 * file-budget extraction, verbatim move — the file hit the 2200-line budget
 * at v59). Re-exported here so existing import sites
 * (`from './db/database.js'`) keep working; the migrations/ segment files
 * call them through the same names.
 */
export {
  backfillDerivedServiceInterfaces,
  backfillDerivedServices,
  normalizeAgentLlmNullIntent,
};
export type { AgentLlmNullRecoveryStats, DerivedServiceBackfillStats } from './migration-backfills.js';
