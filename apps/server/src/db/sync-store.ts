/**
 * Twin-sync stores — observations time series + sync bindings (P-D,
 * multi-user-simulation-design.md §6, §9)
 *
 * `observations` is the append-only record of every observation that reached
 * the base layer — HA-pushed and manually POSTed alike. Nothing is ever
 * throttled OUT of this table (throttling only gates state application +
 * broadcast, see twin-sync.ts), so a replay (P-E) sees the full resolution.
 *
 * `sync_bindings` is the owner-declared wiring: one row per
 * (env, device instance, attribute), naming its data source ('manual' push
 * via the API, or 'hass:<entity_id>' subscription through the shared HA
 * connection). PUT semantics replace an environment's whole set at once, so
 * the store exposes `replaceForEnv` rather than per-row upserts.
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export type SyncBindingStatus = 'active' | 'unavailable';

export interface ObservationRow {
  id: number;
  env_id: string;
  entity_id: string;
  key: string;
  value_json: string;
  sim_time: number | null;
  wall_time: string;
}

export interface AppendObservationInput {
  envId: string;
  entityId: string;
  key: string;
  value: number | boolean | string;
  simTime?: number | null;
  /** Wall-clock override (tests / backfill); defaults to now. */
  wallTime?: string;
}

export interface ObservationQuery {
  entityId?: string;
  /** ISO wall-time bounds, inclusive (from) / exclusive (to). */
  from?: string;
  to?: string;
  limit?: number;
}

export interface SyncBindingRow {
  id: string;
  env_id: string;
  device_instance_id: string;
  attribute_key: string;
  source: string;
  min_interval_sec: number;
  status: SyncBindingStatus;
  created_by: string;
  created_at: string;
}

export interface SyncBindingInput {
  deviceInstanceId: string;
  attributeKey: string;
  source: string;
  minIntervalSec?: number;
}

export const DEFAULT_MIN_INTERVAL_SEC = 60;

export class ObservationStore {
  constructor(private readonly db: EafDatabase) {}

  /** Append one observation; wall_time defaults to now (ISO). */
  append(input: AppendObservationInput): ObservationRow {
    const result = this.db
      .prepare(
        `INSERT INTO observations (env_id, entity_id, key, value_json, sim_time, wall_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.envId,
        input.entityId,
        input.key,
        JSON.stringify(input.value),
        input.simTime ?? null,
        input.wallTime ?? new Date().toISOString(),
      );
    return this.db
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(result.lastInsertRowid) as ObservationRow;
  }

  /** Time-window query (P-E replay material): oldest first. */
  query(envId: string, filters: ObservationQuery = {}): ObservationRow[] {
    let sql = 'SELECT * FROM observations WHERE env_id = ?';
    const params: (string | number)[] = [envId];
    if (filters.entityId !== undefined) {
      sql += ' AND entity_id = ?';
      params.push(filters.entityId);
    }
    if (filters.from !== undefined) {
      sql += ' AND wall_time >= ?';
      params.push(filters.from);
    }
    if (filters.to !== undefined) {
      sql += ' AND wall_time < ?';
      params.push(filters.to);
    }
    sql += ' ORDER BY wall_time ASC, id ASC LIMIT ?';
    params.push(filters.limit ?? 1000);
    return this.db.prepare(sql).all(...params) as ObservationRow[];
  }

  /**
   * The LAST observation of every (entity_id, key) strictly before `before`
   * (ISO wall-time) — the initial-state material for a P-E replay window.
   * Ties on wall_time resolve to the higher row id (later append).
   */
  latestBefore(envId: string, before: string): ObservationRow[] {
    return this.db
      .prepare(
        `SELECT o.* FROM observations o
         WHERE o.env_id = ? AND o.wall_time < ?
           AND NOT EXISTS (
             SELECT 1 FROM observations n
             WHERE n.env_id = o.env_id AND n.entity_id = o.entity_id AND n.key = o.key
               AND n.wall_time < ?
               AND (n.wall_time > o.wall_time OR (n.wall_time = o.wall_time AND n.id > o.id))
           )
         ORDER BY o.entity_id ASC, o.key ASC`,
      )
      .all(envId, before, before) as ObservationRow[];
  }
}

export class SyncBindingStore {
  constructor(private readonly db: EafDatabase) {}

  /**
   * Replace an environment's whole binding set (PUT semantics) and return
   * the new rows. Runs in one transaction so a halfway set is never visible.
   */
  replaceForEnv(envId: string, createdBy: string, inputs: SyncBindingInput[]): SyncBindingRow[] {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM sync_bindings WHERE env_id = ?').run(envId);
      const rows: SyncBindingRow[] = [];
      for (const input of inputs) {
        const row: SyncBindingRow = {
          id: randomUUID(),
          env_id: envId,
          device_instance_id: input.deviceInstanceId,
          attribute_key: input.attributeKey,
          source: input.source,
          min_interval_sec: input.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC,
          status: 'active',
          created_by: createdBy,
          created_at: new Date().toISOString(),
        };
        this.db
          .prepare(
            `INSERT INTO sync_bindings
             (id, env_id, device_instance_id, attribute_key, source,
              min_interval_sec, status, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id, row.env_id, row.device_instance_id, row.attribute_key, row.source,
            row.min_interval_sec, row.status, row.created_by, row.created_at,
          );
        rows.push(row);
      }
      return rows;
    })();
  }

  get(id: string): SyncBindingRow | undefined {
    return this.db.prepare('SELECT * FROM sync_bindings WHERE id = ?').get(id) as
      | SyncBindingRow
      | undefined;
  }

  /** The binding governing (env, device, attribute), when one exists. */
  findFor(envId: string, deviceInstanceId: string, attributeKey: string): SyncBindingRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM sync_bindings
         WHERE env_id = ? AND device_instance_id = ? AND attribute_key = ?`,
      )
      .get(envId, deviceInstanceId, attributeKey) as SyncBindingRow | undefined;
  }

  listForEnv(envId: string): SyncBindingRow[] {
    return this.db
      .prepare('SELECT * FROM sync_bindings WHERE env_id = ? ORDER BY created_at ASC, id ASC')
      .all(envId) as SyncBindingRow[];
  }

  /** Every hass:-sourced binding (server-boot reactivation). */
  listHassBindings(): SyncBindingRow[] {
    return this.db
      .prepare(`SELECT * FROM sync_bindings WHERE source LIKE 'hass:%' ORDER BY created_at ASC`)
      .all() as SyncBindingRow[];
  }

  setStatus(id: string, status: SyncBindingStatus): void {
    this.db.prepare('UPDATE sync_bindings SET status = ? WHERE id = ?').run(status, id);
  }
}
