/**
 * External event source store (R58) — persisted source definitions + the
 * seen-key dedupe ledger. Thin SQLite accessor; the poller owns semantics.
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from '../db/database.js';
import type { EventSourceMapping } from './mapping.js';

export interface EventSourceRow {
  id: string;
  env_id: string;
  name: string;
  url: string;
  poll_interval_sec: number;
  auth_headers_json: string;
  mapping_json: string;
  enabled: number;
  last_poll_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_injected: number;
  created_at: string;
}

export class ExternalEventSourceStore {
  constructor(private readonly db: EafDatabase) {}

  createSource(input: {
    envId: string;
    name: string;
    url: string;
    pollIntervalSec: number;
    authHeaders: Record<string, string>;
    mapping: EventSourceMapping;
  }): EventSourceRow {
    const row: EventSourceRow = {
      id: randomUUID(),
      env_id: input.envId,
      name: input.name,
      url: input.url,
      poll_interval_sec: input.pollIntervalSec,
      auth_headers_json: JSON.stringify(input.authHeaders),
      mapping_json: JSON.stringify(input.mapping),
      enabled: 1,
      last_poll_at: null,
      last_status: null,
      last_error: null,
      last_injected: 0,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO external_event_sources
         (id, env_id, name, url, poll_interval_sec, auth_headers_json, mapping_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(row.id, row.env_id, row.name, row.url, row.poll_interval_sec, row.auth_headers_json, row.mapping_json, row.created_at);
    return row;
  }

  getSource(id: string): EventSourceRow | undefined {
    return this.db.prepare('SELECT * FROM external_event_sources WHERE id = ?').get(id) as EventSourceRow | undefined;
  }

  sourcesOfEnv(envId: string): EventSourceRow[] {
    return this.db
      .prepare('SELECT * FROM external_event_sources WHERE env_id = ? ORDER BY created_at')
      .all(envId) as EventSourceRow[];
  }

  /** Enabled sources whose next poll is due (last_poll + interval ≤ now). */
  dueSources(now: Date): EventSourceRow[] {
    const nowIso = now.toISOString();
    return this.db
      .prepare(
        `SELECT * FROM external_event_sources
         WHERE enabled = 1
           AND (last_poll_at IS NULL OR last_poll_at <= datetime('subsec', ?, printf('-%d seconds', poll_interval_sec)))
         ORDER BY last_poll_at IS NOT NULL, last_poll_at`,
      )
      .all(nowIso) as EventSourceRow[];
  }

  updateSource(id: string, patch: Partial<Pick<EventSourceRow, 'name' | 'url' | 'poll_interval_sec' | 'mapping_json' | 'auth_headers_json' | 'enabled'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE external_event_sources SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  markPoll(id: string, status: string, injected: number, error: string | null): void {
    this.db
      .prepare(
        `UPDATE external_event_sources
         SET last_poll_at = ?, last_status = ?, last_error = ?, last_injected = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), status, error, injected, id);
  }

  deleteSource(id: string): boolean {
    return this.db.prepare('DELETE FROM external_event_sources WHERE id = ?').run(id).changes > 0;
  }

  /** True when (source, key) is NEW — and records it. The seen ledger is
   * pruned to the most recent 500 keys per source on insert. */
  claimSeen(sourceId: string, dedupeKey: string): boolean {
    const inserted = this.db
      .prepare('INSERT OR IGNORE INTO external_event_seen (source_id, dedupe_key, seen_at) VALUES (?, ?, ?)')
      .run(sourceId, dedupeKey, new Date().toISOString());
    if (inserted.changes === 0) return false;
    this.db
      .prepare(
        `DELETE FROM external_event_seen WHERE source_id = ? AND dedupe_key NOT IN (
           SELECT dedupe_key FROM external_event_seen WHERE source_id = ?
           ORDER BY seen_at DESC LIMIT 500)`,
      )
      .run(sourceId, sourceId);
    return true;
  }
}
