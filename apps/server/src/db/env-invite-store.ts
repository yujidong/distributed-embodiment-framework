/**
 * Env Invite Store (R15-D10) — pending invitations for not-yet-registered
 * emails.
 *
 * The teacher chain's old friction: a roster import could only add users
 * who had ALREADY registered. With invites, unknown emails are parked here;
 * the moment one registers (auth route), every pending invite for that
 * email is accepted — membership lands without anyone re-doing the import.
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export type InviteRole = 'builder' | 'viewer';

export interface EnvInviteRow {
  id: string;
  env_id: string;
  email: string;
  role: InviteRole;
  invited_by: string;
  created_at: string;
  accepted_at: string | null;
}

export class EnvInviteStore {
  constructor(private readonly db: EafDatabase) {}

  /**
   * Create or refresh the pending invite for (env, email). Re-inviting an
   * existing pending row updates its role and inviter; accepted rows are
   * left alone (the member relationship owns role changes from then on).
   * Returns the pending row.
   */
  upsertPending(input: {
    envId: string;
    email: string;
    role: InviteRole;
    invitedBy: string;
  }): EnvInviteRow {
    const existing = this.db
      .prepare('SELECT * FROM env_invites WHERE env_id = ? AND email = ?')
      .get(input.envId, input.email) as EnvInviteRow | undefined;
    const now = new Date().toISOString();
    if (existing !== undefined && existing.accepted_at === null) {
      const updated = { ...existing, role: input.role, invited_by: input.invitedBy, created_at: now };
      this.db
        .prepare('UPDATE env_invites SET role = ?, invited_by = ?, created_at = ? WHERE id = ?')
        .run(updated.role, updated.invited_by, updated.created_at, updated.id);
      return updated;
    }
    const row: EnvInviteRow = {
      id: randomUUID(),
      env_id: input.envId,
      email: input.email,
      role: input.role,
      invited_by: input.invitedBy,
      created_at: now,
      accepted_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO env_invites (id, env_id, email, role, invited_by, created_at, accepted_at)
         VALUES (@id, @env_id, @email, @role, @invited_by, @created_at, @accepted_at)`,
      )
      .run(row);
    return row;
  }

  /** Pending (unaccepted) invites for one email — what registration accepts. */
  pendingForEmail(email: string): EnvInviteRow[] {
    return this.db
      .prepare('SELECT * FROM env_invites WHERE email = ? AND accepted_at IS NULL ORDER BY created_at ASC')
      .all(email) as EnvInviteRow[];
  }

  /** Pending invites of one environment, oldest first (owner-facing list). */
  listPendingForEnv(envId: string): EnvInviteRow[] {
    return this.db
      .prepare('SELECT * FROM env_invites WHERE env_id = ? AND accepted_at IS NULL ORDER BY created_at ASC')
      .all(envId) as EnvInviteRow[];
  }

  /** Mark accepted (idempotent). */
  markAccepted(id: string): void {
    this.db
      .prepare('UPDATE env_invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  /** Revoke a pending invite (owner); unknown/accepted ids are a no-op. */
  delete(envId: string, id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM env_invites WHERE id = ? AND env_id = ? AND accepted_at IS NULL')
      .run(id, envId);
    return result.changes > 0;
  }
}
