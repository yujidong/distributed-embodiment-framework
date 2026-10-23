/**
 * Zone-claim store — zone-level stewardship grants (P-B,
 * multi-user-simulation-design.md §5.3)
 *
 * One row per (env, zone, grantee): the user an environment owner has granted
 * stewardship of a zone to via an approved `zone-claim` proposal. The
 * proposal pipeline consults these rows to let a steward's low-risk proposals
 * fully inside their own zones skip AI review; reverting the claim proposal
 * deletes the row again.
 */

import type { EafDatabase } from './database.js';

export interface ZoneClaimRow {
  env_id: string;
  zone_id: string;
  grantee_id: string;
  granted_by: string;
  granted_at: string;
}

export class ZoneClaimStore {
  constructor(private readonly db: EafDatabase) {}

  /** Grant stewardship (idempotent — a duplicate grant is a no-op). */
  grant(input: { envId: string; zoneId: string; granteeId: string; grantedBy: string }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO zone_claims (env_id, zone_id, grantee_id, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.envId, input.zoneId, input.granteeId, input.grantedBy, new Date().toISOString());
  }

  /** Revoke one grantee's stewardship of a zone (revert of the claim). */
  revoke(envId: string, zoneId: string, granteeId: string): void {
    this.db
      .prepare('DELETE FROM zone_claims WHERE env_id = ? AND zone_id = ? AND grantee_id = ?')
      .run(envId, zoneId, granteeId);
  }

  /** True when `userId` holds stewardship of `zoneId` in `envId`. */
  isClaimedBy(envId: string, zoneId: string, userId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM zone_claims WHERE env_id = ? AND zone_id = ? AND grantee_id = ?')
        .get(envId, zoneId, userId) !== undefined
    );
  }

  /** Every claim in one environment (audit/debug surface for tests). */
  listForEnv(envId: string): ZoneClaimRow[] {
    return this.db
      .prepare('SELECT * FROM zone_claims WHERE env_id = ? ORDER BY granted_at ASC, zone_id ASC')
      .all(envId) as ZoneClaimRow[];
  }
}
