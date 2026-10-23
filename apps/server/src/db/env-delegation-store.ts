/**
 * Env decision-delegation store — T-072 (DevLoop R23,
 * design-consent-semantics.md §3 / D-1 decide half)
 *
 * One row per (env, scope): the member the environment owner has delegated a
 * class of GOVERNANCE DECISIONS to. v1 ships exactly one scope —
 * 'zone-claims' (deciding escalated `zone-claim` proposals, optionally
 * narrowed to specific zone ids; NULL zones = every zone). Supervised-zone
 * CONSENT delegation stays owner-only by design (design-consent-semantics
 * §3: the env owner is the consent subject; delegation EXTENDS who may
 * decide claims, per-env, not who may consent to world structure).
 *
 * Model, deliberately simple and documented:
 * - ONE delegate per scope at a time (PK (env_id, scope)); switching
 *   delegates requires revoking first (the route enforces with a teaching
 *   409 so the outgoing delegate always gets a revocation notice).
 * - Re-granting to the SAME delegate refreshes the zone scope.
 * - Revoke deletes the row — the audit trail is command_log
 *   (`delegation-change`), not history columns.
 * - A delegate's membership is a grant precondition, and member
 *   removal/leave revokes their delegation (route layer) — an active row
 *   therefore always names a current member.
 */

import type { EafDatabase } from './database.js';

/** The closed scope vocabulary (v1: decisions on zone-claim proposals). */
export const DELEGATION_SCOPES = ['zone-claims'] as const;
export type DelegationScope = (typeof DELEGATION_SCOPES)[number];

export interface EnvDelegationRow {
  env_id: string;
  scope: DelegationScope;
  delegate_id: string;
  /** JSON array of zone ids; NULL = delegated for ALL zones. */
  zones_json: string | null;
  granted_by: string;
  granted_at: string;
}

/** Parse a delegation row's zone scope into its wire shape. */
export function delegationZonesOf(row: Pick<EnvDelegationRow, 'zones_json'>): string[] | 'all' {
  if (row.zones_json === null) return 'all';
  try {
    const parsed = JSON.parse(row.zones_json) as unknown;
    if (Array.isArray(parsed) && parsed.every(zone => typeof zone === 'string')) {
      return parsed as string[];
    }
  } catch {
    // Corrupt row — fall through to the conservative reading below.
  }
  return 'all';
}

/** True when `zoneId` is inside the row's delegated zone scope. */
export function delegationCoversZone(
  row: Pick<EnvDelegationRow, 'zones_json'>,
  zoneId: string,
): boolean {
  const zones = delegationZonesOf(row);
  return zones === 'all' || zones.includes(zoneId);
}

export class EnvDelegationStore {
  constructor(private readonly db: EafDatabase) {}

  /** The active delegation for one scope in one env (v1: at most one row). */
  getActive(envId: string, scope: DelegationScope): EnvDelegationRow | undefined {
    return this.db
      .prepare('SELECT * FROM env_claim_delegations WHERE env_id = ? AND scope = ?')
      .get(envId, scope) as EnvDelegationRow | undefined;
  }

  /** Every active delegation in one environment (audit/debug surface). */
  listForEnv(envId: string): EnvDelegationRow[] {
    return this.db
      .prepare('SELECT * FROM env_claim_delegations WHERE env_id = ? ORDER BY granted_at ASC')
      .all(envId) as EnvDelegationRow[];
  }

  /**
   * Upsert the delegation for (env, scope). The route layer owns the
   * semantics (member check, one-delegate-per-scope 409, zone validation);
   * INSERT OR REPLACE only ever fires for a same-delegate zone refresh
   * because a different-delegate grant was refused above.
   */
  grant(input: {
    envId: string;
    scope: DelegationScope;
    delegateId: string;
    /** null = all zones. */
    zones: string[] | null;
    grantedBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO env_claim_delegations (env_id, scope, delegate_id, zones_json, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (env_id, scope) DO UPDATE SET
           delegate_id = excluded.delegate_id,
           zones_json  = excluded.zones_json,
           granted_by  = excluded.granted_by,
           granted_at  = excluded.granted_at`,
      )
      .run(
        input.envId,
        input.scope,
        input.delegateId,
        input.zones === null ? null : JSON.stringify(input.zones),
        input.grantedBy,
        new Date().toISOString(),
      );
  }

  /**
   * Revoke the active delegation for a scope. `expectedDelegateId` (when
   * given) must match the row — the route addresses revocations by delegate.
   * Returns whether a row was actually removed.
   */
  revoke(envId: string, scope: DelegationScope, expectedDelegateId?: string): boolean {
    const result =
      expectedDelegateId === undefined
        ? this.db
            .prepare('DELETE FROM env_claim_delegations WHERE env_id = ? AND scope = ?')
            .run(envId, scope)
        : this.db
            .prepare(
              'DELETE FROM env_claim_delegations WHERE env_id = ? AND scope = ? AND delegate_id = ?',
            )
            .run(envId, scope, expectedDelegateId);
    return result.changes > 0;
  }

  /**
   * Lifecycle honesty (D-1 v2 trade-off): revoke whatever delegation names
   * this user — membership removal/leave must not leave a stale decide right
   * pointing at a non-member. Returns the scopes revoked (audit payload).
   */
  revokeForDelegate(envId: string, delegateId: string): DelegationScope[] {
    const rows = this.db
      .prepare(
        'SELECT scope FROM env_claim_delegations WHERE env_id = ? AND delegate_id = ?',
      )
      .all(envId, delegateId) as Array<{ scope: DelegationScope }>;
    if (rows.length === 0) return [];
    this.db
      .prepare('DELETE FROM env_claim_delegations WHERE env_id = ? AND delegate_id = ?')
      .run(envId, delegateId);
    return rows.map(row => row.scope);
  }

  /**
   * The decide-gate question: may `delegateId` decide a zone-claim for
   * `zoneId` here? An absent delegation, a different delegate, or an
   * out-of-scope zone all answer false (fail closed).
   */
  mayDecideZoneClaim(envId: string, delegateId: string, zoneId: string): boolean {
    const row = this.getActive(envId, 'zone-claims');
    if (row === undefined || row.delegate_id !== delegateId) return false;
    return delegationCoversZone(row, zoneId);
  }
}
