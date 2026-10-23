/**
 * Shared migration types (R22 file-budget extraction from database.ts —
 * verbatim move). `EafDatabase` is re-exported from database.ts so existing
 * import sites (`from './db/database.js'`) keep working.
 */

import type Database from 'better-sqlite3';

export type EafDatabase = Database.Database;

export interface Migration {
  version: number;
  name: string;
  up: (db: EafDatabase) => void;
}
