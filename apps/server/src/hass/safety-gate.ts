/**
 * HassSafetyGate — the real-actuation safety boundary (P3b)
 *
 * Sits between HADevice.executeCommand and the HA socket: every actuation
 * against a real Home Assistant entity passes through `actuate()`, which
 * decides whether the command executes, is blocked, or is parked for human
 * confirmation. NOTHING reaches the socket without an explicit allow.
 *
 * Evaluation order (fixed, in this exact sequence):
 *   1. EMERGENCY STOP — while engaged, EVERY actuation (including approved
 *      re-dispatch of a parked command) fails 'emergency stop active'.
 *   2. APPROVED BYPASS — a command re-dispatched after its pending entry was
 *      approved skips policy + rate-limit (the approval IS the decision) and
 *      executes; the outcome is still audited.
 *   3. POLICY — explicit deny (entity pattern match) > confirm > allow.
 *      Policies are global (env_id NULL) or scoped to the simulation's
 *      environment; a sim without an environment sees global policies only.
 *   4. DEFAULT POLICY — when no policy matches, `HASS_DEFAULT_POLICY`
 *      applies (default 'confirm' — safe out of the box: real actuation
 *      parks for approval until an operator allow-lists the entity).
 *   5. RATE LIMIT — per-entity token bucket (`HASS_RATE_LIMIT_PER_MIN`,
 *      default 6/min); only allow-decided commands consume tokens.
 *
 * Outcomes:
 * - deny      → success:false "blocked by safety policy" — never sent.
 * - confirm   → the command parks in `hass_pending` (5 min TTL, lazy expiry)
 *               and the result is a SOFT-BLOCK: success:false with
 *               `result.code === 'PENDING_CONFIRMATION'` + the pending id —
 *               distinguishable in ExecutionResults, engine events and logs.
 *               `POST /api/hass/pending/:id/approve` re-dispatches it through
 *               the normal engine path (step 2); `reject` bins it.
 * - allow     → executes; the outcome is audited.
 *
 * Audit: every attempt appends one row to `hass_audit` with the decision
 * vocabulary: estopped | blocked | pending | rate-limited | allowed |
 * approved | rejected (the last two are queue decisions written by the
 * approve/reject endpoints; an approved command's execution is audited as
 * 'allowed' with the pending id in the reason).
 *
 * Caller identity: engine-initiated actuation has no user (requested_by /
 * user_id NULL). The manual command endpoint wraps its dispatch in
 * `runWithActuationUser(userId, …)` (AsyncLocalStorage) so the gate records
 * WHO asked without changing engine call signatures; the approve endpoint
 * uses `runApprovedActuation(pendingId, …)` for the step-2 bypass.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { ApiError } from '../errors.js';
import type { EafDatabase } from '../db/database.js';

export type PolicyEffect = 'allow' | 'confirm' | 'deny';
export const POLICY_EFFECTS: readonly PolicyEffect[] = ['allow', 'confirm', 'deny'];

/** Pending-entry time to live: parked commands expire after 5 minutes. */
export const PENDING_TTL_MS = 5 * 60_000;

export interface HassPolicyRow {
  id: string;
  env_id: string | null;
  entity_pattern: string;
  effect: PolicyEffect;
  created_by: string | null;
  created_at: string;
}

export interface HassPendingRow {
  id: string;
  sim_id: string;
  device_id: string;
  entity_id: string;
  command_name: string;
  params_json: string;
  requested_by: string | null;
  requested_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

export interface HassAuditRow {
  id: number;
  sim_id: string | null;
  entity_id: string;
  command: string;
  decision: string;
  reason: string;
  user_id: string | null;
  at: string;
}

export interface HassEstopState {
  active: boolean;
  by?: string;
  at?: string;
}

/** Everything the gate needs to know about one actuation attempt. */
export interface GateContext {
  simId: string;
  /** Owning environment when the sim is environment-backed (else null). */
  envId: string | null;
  deviceId: string;
  entityId: string;
  commandName: string;
  params?: Record<string, unknown>;
}

/** The result shape the gate produces (HADevice adds timestamp/timing). */
export interface GateActuationResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

interface ActuationCaller {
  userId: string | null;
  /** Set when re-dispatching an approved pending command (step-2 bypass). */
  approvedPendingId?: string;
}

const callerContext = new AsyncLocalStorage<ActuationCaller>();

/** Wrap a manual dispatch so the gate records the calling user. */
export function runWithActuationUser<T>(userId: string | null, fn: () => T): T {
  return callerContext.run({ userId }, fn);
}

/** Wrap the re-dispatch of an approved pending command (bypass marker). */
export function runApprovedActuation<T>(pendingId: string, userId: string | null, fn: () => T): T {
  return callerContext.run({ userId, approvedPendingId: pendingId }, fn);
}

export interface HassSafetyGateOptions {
  /** Policy applied when nothing matches (default 'confirm'). */
  defaultPolicy?: PolicyEffect;
  /** Per-entity actuations per minute (default 6). */
  rateLimitPerMin?: number;
  /** Pending TTL override in ms (tests; default 5 min). */
  pendingTtlMs?: number;
}

interface RateBucket {
  tokens: number;
  windowStart: number;
}

export class HassSafetyGate {
  private readonly defaultPolicy: PolicyEffect;
  private readonly rateLimitPerMin: number;
  private readonly pendingTtlMs: number;
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    private readonly db: EafDatabase,
    options: HassSafetyGateOptions = {},
  ) {
    this.defaultPolicy = options.defaultPolicy ?? 'confirm';
    this.rateLimitPerMin = options.rateLimitPerMin ?? 6;
    this.pendingTtlMs = options.pendingTtlMs ?? PENDING_TTL_MS;
  }

  /**
   * The single actuation entry point. `execute` performs the real HA service
   * call and is only invoked when the decision allows it.
   */
  async actuate(
    ctx: GateContext,
    execute: () => Promise<GateActuationResult>,
  ): Promise<GateActuationResult> {
    const caller = callerContext.getStore();
    const userId = caller?.userId ?? null;

    // 1. Emergency stop: blocks EVERYTHING, approved bypass included.
    if (this.estopState().active) {
      this.audit(ctx, userId, 'estopped', 'emergency stop active');
      return {
        success: false,
        error: 'Actuation blocked: emergency stop active',
        result: { code: 'ESTOP_ACTIVE' },
      };
    }

    // 2. Approved bypass: the human decision was made; execute + audit.
    if (caller?.approvedPendingId !== undefined) {
      const pendingId = caller.approvedPendingId;
      const outcome = await execute();
      this.audit(
        ctx,
        userId,
        'allowed',
        `approved pending ${pendingId}; executed: ${outcomeSuffix(outcome)}`,
      );
      return outcome;
    }

    // 3. Policy evaluation: explicit deny > confirm > allow > default.
    const policies = this.matchingPolicies(ctx.envId, ctx.entityId);
    const deny = policies.find(p => p.effect === 'deny');
    if (deny) {
      this.audit(ctx, userId, 'blocked', `denied by policy ${deny.id} ("${deny.entity_pattern}")`);
      return {
        success: false,
        error: `Actuation blocked by safety policy ("${deny.entity_pattern}" → deny)`,
        result: { code: 'POLICY_DENIED' },
      };
    }
    const confirm = policies.find(p => p.effect === 'confirm');
    const allow = policies.find(p => p.effect === 'allow');
    const effect: PolicyEffect = confirm ? 'confirm' : allow ? 'allow' : this.defaultPolicy;
    const basis = confirm
      ? `policy ${confirm.id} ("${confirm.entity_pattern}")`
      : allow
        ? `policy ${allow.id} ("${allow.entity_pattern}")`
        : `default policy (${this.defaultPolicy})`;

    // 4. Default policy may itself be deny/confirm.
    if (effect === 'deny') {
      this.audit(ctx, userId, 'blocked', `denied by ${basis}`);
      return {
        success: false,
        error: 'Actuation blocked by safety policy (default policy → deny)',
        result: { code: 'POLICY_DENIED' },
      };
    }
    if (effect === 'confirm') {
      const pendingId = this.park(ctx, userId);
      this.audit(ctx, userId, 'pending', `confirmation required by ${basis}; pending ${pendingId}`);
      return {
        success: false,
        error: 'Command parked pending confirmation',
        result: { code: 'PENDING_CONFIRMATION', pendingId },
      };
    }

    // 5. Rate limit (allow path only): fixed-window per-entity bucket.
    if (!this.consumeRateToken(ctx.entityId)) {
      this.audit(
        ctx,
        userId,
        'rate-limited',
        `rate limit ${this.rateLimitPerMin}/min exceeded for ${ctx.entityId}`,
      );
      return {
        success: false,
        error: `Actuation rate limited (${this.rateLimitPerMin}/min per entity)`,
        result: { code: 'RATE_LIMITED' },
      };
    }

    const outcome = await execute();
    this.audit(ctx, userId, 'allowed', `allowed by ${basis}; executed: ${outcomeSuffix(outcome)}`);
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Policies
  // -------------------------------------------------------------------------

  listPolicies(): HassPolicyRow[] {
    return this.db
      .prepare('SELECT * FROM hass_policies ORDER BY created_at ASC, id ASC')
      .all() as HassPolicyRow[];
  }

  getPolicy(id: string): HassPolicyRow | undefined {
    return this.db.prepare('SELECT * FROM hass_policies WHERE id = ?').get(id) as
      | HassPolicyRow
      | undefined;
  }

  createPolicy(input: {
    envId: string | null;
    entityPattern: string;
    effect: PolicyEffect;
    createdBy: string | null;
  }): HassPolicyRow {
    const row: HassPolicyRow = {
      id: randomUUID(),
      env_id: input.envId,
      entity_pattern: input.entityPattern,
      effect: input.effect,
      created_by: input.createdBy,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hass_policies (id, env_id, entity_pattern, effect, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.env_id, row.entity_pattern, row.effect, row.created_by, row.created_at);
    return row;
  }

  /** @returns false when the policy does not exist. */
  deletePolicy(id: string): boolean {
    return this.db.prepare('DELETE FROM hass_policies WHERE id = ?').run(id).changes > 0;
  }

  // -------------------------------------------------------------------------
  // Pending queue
  // -------------------------------------------------------------------------

  /** Live pending entries (stale ones are lazily marked 'expired' first). */
  listPending(): HassPendingRow[] {
    this.expireStale();
    return this.db
      .prepare(`SELECT * FROM hass_pending WHERE status = 'pending' ORDER BY requested_at ASC`)
      .all() as HassPendingRow[];
  }

  getPending(id: string): HassPendingRow | undefined {
    this.expireStale();
    return this.db.prepare('SELECT * FROM hass_pending WHERE id = ?').get(id) as
      | HassPendingRow
      | undefined;
  }

  /**
   * Mark a pending entry approved + audit the decision. The CALLER then
   * re-dispatches the command inside `runApprovedActuation`.
   * @throws ApiError 404 PENDING_NOT_FOUND / 409 PENDING_NOT_ACTIONABLE
   */
  approve(id: string, approverId: string): HassPendingRow {
    const row = this.requireActionable(id);
    this.db
      .prepare(`UPDATE hass_pending SET status = 'approved' WHERE id = ?`)
      .run(id);
    this.insertAudit({
      simId: row.sim_id,
      entityId: row.entity_id,
      command: row.command_name,
      decision: 'approved',
      reason: `pending ${id} approved by ${approverId}`,
      userId: approverId,
    });
    return { ...row, status: 'approved' };
  }

  /**
   * Mark a pending entry rejected + audit the decision.
   * @throws ApiError 404 PENDING_NOT_FOUND / 409 PENDING_NOT_ACTIONABLE
   */
  reject(id: string, rejecterId: string): HassPendingRow {
    const row = this.requireActionable(id);
    this.db
      .prepare(`UPDATE hass_pending SET status = 'rejected' WHERE id = ?`)
      .run(id);
    this.insertAudit({
      simId: row.sim_id,
      entityId: row.entity_id,
      command: row.command_name,
      decision: 'rejected',
      reason: `pending ${id} rejected by ${rejecterId} — never executed`,
      userId: rejecterId,
    });
    return { ...row, status: 'rejected' };
  }

  // -------------------------------------------------------------------------
  // Emergency stop
  // -------------------------------------------------------------------------

  estopState(): HassEstopState {
    const row = this.db
      .prepare('SELECT active, by_user, at FROM hass_estop WHERE id = 1')
      .get() as { active: number; by_user: string | null; at: string | null } | undefined;
    if (!row || row.active !== 1) return { active: false };
    return {
      active: true,
      ...(row.by_user !== null ? { by: row.by_user } : {}),
      ...(row.at !== null ? { at: row.at } : {}),
    };
  }

  engageEstop(userId: string): HassEstopState {
    const at = new Date().toISOString();
    this.db
      .prepare('UPDATE hass_estop SET active = 1, by_user = ?, at = ? WHERE id = 1')
      .run(userId, at);
    return { active: true, by: userId, at };
  }

  clearEstop(userId: string): HassEstopState {
    this.db
      .prepare('UPDATE hass_estop SET active = 0, by_user = ?, at = ? WHERE id = 1')
      .run(userId, new Date().toISOString());
    return { active: false };
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  listAudit(filters: { entity?: string; sim?: string; limit?: number } = {}): HassAuditRow[] {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filters.entity !== undefined) {
      clauses.push('entity_id = ?');
      args.push(filters.entity);
    }
    if (filters.sim !== undefined) {
      clauses.push('sim_id = ?');
      args.push(filters.sim);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM hass_audit ${where} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as HassAuditRow[];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Entity-pattern match: '*' matches everything, a trailing '*' is a prefix
   * wildcard ('light.*' → every light), anything else is an exact match.
   */
  private patternMatches(pattern: string, entityId: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return entityId.startsWith(pattern.slice(0, -1));
    return pattern === entityId;
  }

  private matchingPolicies(envId: string | null, entityId: string): HassPolicyRow[] {
    const rows = envId !== null
      ? (this.db
          .prepare('SELECT * FROM hass_policies WHERE env_id IS NULL OR env_id = ?')
          .all(envId) as HassPolicyRow[])
      : (this.db.prepare('SELECT * FROM hass_policies WHERE env_id IS NULL').all() as HassPolicyRow[]);
    return rows.filter(row => this.patternMatches(row.entity_pattern, entityId));
  }

  private park(ctx: GateContext, userId: string | null): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO hass_pending
         (id, sim_id, device_id, entity_id, command_name, params_json, requested_by, requested_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        ctx.simId,
        ctx.deviceId,
        ctx.entityId,
        ctx.commandName,
        JSON.stringify(ctx.params ?? {}),
        userId,
        new Date().toISOString(),
      );
    return id;
  }

  private requireActionable(id: string): HassPendingRow {
    const row = this.getPending(id);
    if (!row) {
      throw new ApiError(404, 'PENDING_NOT_FOUND', `Pending command "${id}" not found`);
    }
    if (row.status === 'expired') {
      throw new ApiError(409, 'PENDING_EXPIRED', `Pending command "${id}" has expired`);
    }
    if (row.status !== 'pending') {
      throw new ApiError(
        409,
        'PENDING_NOT_ACTIONABLE',
        `Pending command "${id}" is already ${row.status}`,
      );
    }
    return row;
  }

  private expireStale(): void {
    const cutoff = new Date(Date.now() - this.pendingTtlMs).toISOString();
    this.db
      .prepare(`UPDATE hass_pending SET status = 'expired' WHERE status = 'pending' AND requested_at < ?`)
      .run(cutoff);
  }

  private consumeRateToken(entityId: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(entityId);
    if (!bucket || now - bucket.windowStart >= 60_000) {
      bucket = { tokens: this.rateLimitPerMin, windowStart: now };
      this.buckets.set(entityId, bucket);
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }

  private audit(ctx: GateContext, userId: string | null, decision: string, reason: string): void {
    this.insertAudit({
      simId: ctx.simId,
      entityId: ctx.entityId,
      command: ctx.commandName,
      decision,
      reason,
      userId,
    });
  }

  private insertAudit(entry: {
    simId: string | null;
    entityId: string;
    command: string;
    decision: string;
    reason: string;
    userId: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO hass_audit (sim_id, entity_id, command, decision, reason, user_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.simId,
        entry.entityId,
        entry.command,
        entry.decision,
        entry.reason,
        entry.userId,
        new Date().toISOString(),
      );
  }
}

function outcomeSuffix(outcome: GateActuationResult): string {
  return outcome.success ? 'success' : `failed (${outcome.error ?? 'unknown error'})`;
}
