/**
 * InitiatorCoordinator — runtime-scoped primary-initiator dedup.
 *
 * Problem it solves: when N agents `managesZoneIds` the same zone, each
 * agent independently runs its own ACNecessityAssessor.preCheck and may
 * return `initiate_ac` for the same event. The result is N competing
 * CollaborationProposals for a single in-world event — most of which get
 * cancelled by the engine because the partners are shared.
 *
 * Fix: the runtime owns ONE InitiatorCoordinator. Before any agent
 * commits to `initiate_ac`, it calls `tryClaim(eventId, agentId)`. The
 * first caller wins; subsequent callers within the cooldown window get
 * `false` and must `defer`. This produces a single primary initiator per
 * event while preserving the protocol semantics (every agent still
 * receives the event and could in principle refuse to defer — the
 * coordinator is an optimization layer, not an authorization gate).
 *
 * Scope: per-EngineRuntime-instance. Not persistent. Not shared across
 * sandboxes. The cooldown is wall-clock (not sim-time) because multiple
 * agents can process the same event near-simultaneously under LLM load.
 */

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('InitiatorCoordinator');

export interface InitiatorCoordinatorConfig {
  /** How long a claim stays exclusive, in milliseconds (default 60s). */
  cooldownMs?: number;
  /** Inject now() for tests. */
  now?: () => number;
}

interface Claim {
  eventId: string;
  primaryInitiatorId: string;
  claimedAt: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;

export class InitiatorCoordinator {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly claims = new Map<string, Claim>();

  constructor(config: InitiatorCoordinatorConfig = {}) {
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Try to become the primary initiator for `eventId`.
   *
   * Returns true if the caller is now the primary initiator (either
   * first to claim, or the previous claim has expired). Returns false
   * if another agent holds a live claim.
   *
   * Idempotent: the same agent re-claiming its own eventId returns true.
   */
  tryClaim(eventId: string, agentId: string): boolean {
    if (!eventId) {
      // No event id → nothing to dedup → always allow.
      return true;
    }
    const existing = this.claims.get(eventId);
    const t = this.now();

    if (existing) {
      // Same agent re-claiming: refresh timestamp, allow.
      if (existing.primaryInitiatorId === agentId) {
        existing.claimedAt = t;
        return true;
      }
      // Different agent. Has the original claim expired?
      if (t - existing.claimedAt > this.cooldownMs) {
        logger.info(
          `Claim for ${eventId} expired (held by ${existing.primaryInitiatorId} ${t - existing.claimedAt}ms ago); transferring to ${agentId}`,
        );
        existing.primaryInitiatorId = agentId;
        existing.claimedAt = t;
        return true;
      }
      // Live claim by another agent → reject.
      logger.info(
        `Claim for ${eventId} denied for ${agentId}; primary=${existing.primaryInitiatorId}, age=${t - existing.claimedAt}ms`,
      );
      return false;
    }

    // No prior claim. Take it.
    this.claims.set(eventId, { eventId, primaryInitiatorId: agentId, claimedAt: t });
    logger.info(`Claim for ${eventId} granted to ${agentId}`);
    return true;
  }

  /**
   * Who currently holds the primary-initiator slot for `eventId`?
   * Returns undefined if no live claim.
   */
  getPrimaryInitiator(eventId: string): string | undefined {
    const existing = this.claims.get(eventId);
    if (!existing) return undefined;
    if (this.now() - existing.claimedAt > this.cooldownMs) return undefined;
    return existing.primaryInitiatorId;
  }

  /**
   * Release the claim early (e.g., if the initiator cancelled/failed and
   * we want to let another agent try). Optional — claims auto-expire.
   */
  release(eventId: string, agentId: string): void {
    const existing = this.claims.get(eventId);
    if (existing && existing.primaryInitiatorId === agentId) {
      this.claims.delete(eventId);
      logger.info(`Claim for ${eventId} released by ${agentId}`);
    }
  }

  /** Test/debug helper. */
  size(): number {
    return this.claims.size;
  }

  /** Drop expired claims. Called by the runtime periodically. */
  gc(): void {
    const t = this.now();
    for (const [id, claim] of this.claims) {
      if (t - claim.claimedAt > this.cooldownMs) {
        this.claims.delete(id);
      }
    }
  }
}
