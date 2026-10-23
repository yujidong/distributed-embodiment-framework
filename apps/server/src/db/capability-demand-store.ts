/**
 * R80-FW3 — Capability-demand telemetry (the L4 observability consumer).
 *
 * The R78-D/R79 rounds exposed a framework gap: a user wanting a capability
 * the platform cannot supply (crowd-monitoring before R78-D, camera
 * monitoring today) leaves NO server-side trace — the wizard's ⚠ chips and
 * rejected free-text declarations evaporate in the client, so catalog
 * evolution is driven by whichever gap a persona probe happens to hit,
 * not by demand. This module gives that demand a durable, aggregated face:
 *
 *   client (wizard ⚠ / rejected declaration / zero-hit catalog search)
 *     → POST /api/me/capability-demand  (auth, per-user+capability dedup)
 *     → admin observability top-N (deployers see what to add to the catalog)
 *
 * Architecture fit (plan §0.5): a pure L4 consumer — reads nothing from the
 * decision path, writes nothing back into L1-L3. Aggregation is a plain
 * GROUP BY over one table.
 */

import type { EafDatabase } from './database.js';

export type DemandSource =
  | 'wizard-unbacked-chip' // user SAW the ⚠ (capability offered but unbackable)
  | 'wizard-rejected-declaration' // step gate blocked an unbacked declaration
  | 'catalog-zero-hit'; // catalog search returned nothing for the term

export interface CapabilityDemandRow {
  id: string;
  user_id: string;
  env_id: string | null;
  capability: string;
  source: DemandSource;
  first_seen_at: string;
  last_seen_at: string;
  count: number;
}

const SOURCES: readonly DemandSource[] = [
  'wizard-unbacked-chip',
  'wizard-rejected-declaration',
  'catalog-zero-hit',
];

/** Assert the closed enum at the boundary (typos become loud 400s). */
export function parseDemandSource(value: unknown): DemandSource | undefined {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
    ? (value as DemandSource)
    : undefined;
}

export class CapabilityDemandStore {
  constructor(private readonly db: EafDatabase) {}

  /**
   * Record one demand signal. Dedup key = (user, env, capability, source):
   * repeats bump `count` + `last_seen_at` instead of stacking rows (the
   * notification ×N lesson applied at write time).
   */
  record(input: {
    userId: string;
    envId: string | null;
    capability: string;
    source: DemandSource;
  }): CapabilityDemandRow {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM capability_demand
          WHERE user_id = ? AND IFNULL(env_id, '') = IFNULL(?, '')
            AND capability = ? AND source = ?`,
      )
      .get(input.userId, input.envId, input.capability, input.source) as
      | CapabilityDemandRow
      | undefined;
    if (existing !== undefined) {
      this.db
        .prepare(
          `UPDATE capability_demand
             SET count = count + 1, last_seen_at = ?
             WHERE id = ?`,
        )
        .run(now, existing.id);
      return { ...existing, count: existing.count + 1, last_seen_at: now };
    }
    const id = `cd-${now.replace(/[^0-9]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
    const row: CapabilityDemandRow = {
      id,
      user_id: input.userId,
      env_id: input.envId,
      capability: input.capability,
      source: input.source,
      first_seen_at: now,
      last_seen_at: now,
      count: 1,
    };
    this.db
      .prepare(
        `INSERT INTO capability_demand (id, user_id, env_id, capability, source, first_seen_at, last_seen_at, count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, row.user_id, row.env_id, row.capability, row.source, now, now, 1);
    return row;
  }

  /** Top-N demanded capabilities across the deployment (the admin view). */
  topDemand(limit = 20): Array<{
    capability: string;
    users: number;
    signals: number;
    sources: string;
    last_seen_at: string;
    /** True when NO active catalog model provides it — the actionable gap. */
    catalogGap: boolean;
  }> {
    const rows = this.db
      .prepare(
        `SELECT capability,
                COUNT(DISTINCT user_id) AS users,
                SUM(count) AS signals,
                GROUP_CONCAT(DISTINCT source) AS sources,
                MAX(last_seen_at) AS last_seen_at
           FROM capability_demand
          GROUP BY capability
          ORDER BY signals DESC, users DESC
          LIMIT ?`,
      )
      .all(limit) as Array<{
      capability: string;
      users: number;
      signals: number;
      sources: string;
      last_seen_at: string;
    }>;
    if (rows.length === 0) return [];
    const provided = new Set(
      (this.db
        .prepare(`SELECT capabilities_json FROM device_models WHERE status = 'active'`)
        .all() as Array<{ capabilities_json: string }>)
        .flatMap(row => {
          try {
            return JSON.parse(row.capabilities_json) as string[];
          } catch {
            return [];
          }
        })
        .map(c => c.toLowerCase()),
    );
    return rows.map(row => ({
      ...row,
      catalogGap: !provided.has(row.capability.toLowerCase()),
    }));
  }
}
