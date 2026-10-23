/**
 * Sandbox store — P-C sandbox fork persistence
 * (multi-user-simulation-design.md §3 Layer 0, §9; living-worlds §10)
 *
 * One row per forked sandbox: who forked which environment with which fork
 * parameters (`fork_base_json` — P2F extends it to `{overlays, policy,
 * checkpointId?, scenarioFingerprint?}`, the §10.4 lineage material), and
 * which simulation-registry instance (`simulation_id`) holds its isolated
 * in-memory world. Rows cascade with their environment — the runtime must
 * be stopped BEFORE the environment row is deleted (see the
 * onEnvironmentDeleted wiring in server.ts).
 *
 * P2F (§10.2): `sandbox_members` — the fork's join roster. The fork OWNER
 * (sandboxes.owner_id) is implicit; this table carries the invited
 * builders/viewers (same role vocabulary as env_members). Quota semantics
 * stay holder-based: joining someone else's fork consumes none of the
 * joiner's sandboxes_per_user_per_env slots (design §10.2 缺省建议).
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export type SandboxStatus = 'active' | 'stopped';
export const SANDBOX_STATUSES: readonly SandboxStatus[] = ['active', 'stopped'];

export type SandboxMemberRole = 'builder' | 'viewer';
export const SANDBOX_MEMBER_ROLES: readonly SandboxMemberRole[] = ['builder', 'viewer'];

export interface SandboxRow {
  id: string;
  env_id: string;
  owner_id: string;
  fork_base_json: string;
  status: SandboxStatus;
  simulation_id: string | null;
  created_at: string;
  /** P2F §10.3: explicit per-row retention stamp (NULL = the global age knob governs). */
  expires_at: string | null;
}

export interface SandboxMemberRow {
  sandbox_id: string;
  user_id: string;
  role: SandboxMemberRole;
  invited_by: string;
  created_at: string;
}

export interface CreateSandboxInput {
  envId: string;
  ownerId: string;
  /**
   * Fork parameters recorded for audit + lineage, e.g. `{overlays, policy,
   * checkpointId?, scenarioFingerprint?}` (§10.1/§10.4).
   */
  forkBase: Record<string, unknown>;
  simulationId?: string | null;
  /**
   * P2F: caller-supplied row id — the fork id must exist BEFORE the
   * registry sim is created (the sim's timeline records stamp it as
   * `forkId`), so sandbox-service pre-generates it. Absent = fresh UUID
   * (legacy callers).
   */
  id?: string;
  /** P2F §10.3: explicit retention ceiling (ISO); NULL = global age knob. */
  expiresAt?: string | null;
}

export interface CreateSandboxMemberInput {
  sandboxId: string;
  userId: string;
  role: SandboxMemberRole;
  invitedBy: string;
}

export class SandboxStore {
  constructor(private readonly db: EafDatabase) {}

  create(input: CreateSandboxInput): SandboxRow {
    const row: SandboxRow = {
      id: input.id ?? randomUUID(),
      env_id: input.envId,
      owner_id: input.ownerId,
      fork_base_json: JSON.stringify(input.forkBase),
      status: 'active',
      simulation_id: input.simulationId ?? null,
      created_at: new Date().toISOString(),
      expires_at: input.expiresAt ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO sandboxes
         (id, env_id, owner_id, fork_base_json, status, simulation_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.owner_id, row.fork_base_json,
        row.status, row.simulation_id, row.created_at, row.expires_at,
      );
    return row;
  }

  get(id: string): SandboxRow | undefined {
    return this.db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(id) as
      | SandboxRow
      | undefined;
  }

  /** The sandbox owning one registry simulation (lineage lookup by sim id). */
  findBySimulationId(simulationId: string): SandboxRow | undefined {
    return this.db
      .prepare('SELECT * FROM sandboxes WHERE simulation_id = ?')
      .get(simulationId) as SandboxRow | undefined;
  }

  /** Sandboxes of one environment, newest first; `ownerId` scopes to one user. */
  listForEnv(envId: string, filters: { ownerId?: string } = {}): SandboxRow[] {
    let sql = 'SELECT * FROM sandboxes WHERE env_id = ?';
    const params: string[] = [envId];
    if (filters.ownerId !== undefined) {
      sql += ' AND owner_id = ?';
      params.push(filters.ownerId);
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    return this.db.prepare(sql).all(...params) as SandboxRow[];
  }

  /** Active (not yet stopped) sandboxes of one environment. */
  activeForEnv(envId: string): SandboxRow[] {
    return this.db
      .prepare("SELECT * FROM sandboxes WHERE env_id = ? AND status = 'active'")
      .all(envId) as SandboxRow[];
  }

  /**
   * S3 (Task 2): every ACTIVE sandbox row across all environments — the
   * retention sweep's candidate set (boot + hourly).
   */
  listActive(): SandboxRow[] {
    return this.db
      .prepare("SELECT * FROM sandboxes WHERE status = 'active'")
      .all() as SandboxRow[];
  }

  /** One user's active sandboxes in one environment — the quota usage. */
  countActiveForUser(envId: string, ownerId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sandboxes WHERE env_id = ? AND owner_id = ? AND status = 'active'",
      )
      .get(envId, ownerId) as { n: number };
    return row.n;
  }

  /**
   * Largest active-sandbox count the user holds in any single environment —
   * the binding number for /api/me/quotas (mirrors maxDevicesInOwnedEnvs).
   */
  maxActiveForUser(ownerId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(n), 0) AS m FROM (
           SELECT COUNT(*) AS n FROM sandboxes
           WHERE owner_id = ? AND status = 'active'
           GROUP BY env_id
         )`,
      )
      .get(ownerId) as { m: number };
    return row.m;
  }

  /** Mark a sandbox stopped; returns the updated row. */
  markStopped(id: string): SandboxRow {
    this.db
      .prepare("UPDATE sandboxes SET status = 'stopped' WHERE id = ?")
      .run(id);
    return this.get(id)!;
  }

  // ---------------------------------------------------------------------------
  // P2F §10.2: membership join
  // ---------------------------------------------------------------------------

  /** Invite (or re-role) one member; repeat invites UPDATE the role. */
  addMember(input: CreateSandboxMemberInput): SandboxMemberRow {
    this.db
      .prepare(
        `INSERT INTO sandbox_members (sandbox_id, user_id, role, invited_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sandbox_id, user_id) DO UPDATE SET
           role = excluded.role,
           invited_by = excluded.invited_by`,
      )
      .run(
        input.sandboxId, input.userId, input.role, input.invitedBy,
        new Date().toISOString(),
      );
    return this.memberOf(input.sandboxId, input.userId)!;
  }

  memberOf(sandboxId: string, userId: string): SandboxMemberRow | undefined {
    return this.db
      .prepare('SELECT * FROM sandbox_members WHERE sandbox_id = ? AND user_id = ?')
      .get(sandboxId, userId) as SandboxMemberRow | undefined;
  }

  membersOf(sandboxId: string): SandboxMemberRow[] {
    return this.db
      .prepare('SELECT * FROM sandbox_members WHERE sandbox_id = ? ORDER BY created_at ASC')
      .all(sandboxId) as SandboxMemberRow[];
  }

  removeMember(sandboxId: string, userId: string): boolean {
    return this.db
      .prepare('DELETE FROM sandbox_members WHERE sandbox_id = ? AND user_id = ?')
      .run(sandboxId, userId).changes > 0;
  }

  /**
   * Forks of one environment the user JOINED (member rows only — ownership
   * is sandboxes.owner_id, not a member row). The list route unions this
   * with the user's own forks (§10.2 visibility).
   */
  joinedByUserInEnv(envId: string, userId: string): SandboxRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sandboxes s
         JOIN sandbox_members m ON m.sandbox_id = s.id
         WHERE s.env_id = ? AND m.user_id = ?
         ORDER BY s.created_at DESC`,
      )
      .all(envId, userId) as SandboxRow[];
  }
}
