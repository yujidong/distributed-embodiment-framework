/**
 * Fulfillment gate — the provider-side履约评估决策点 (R6-B-F02 多跳断链根因).
 *
 * Pre-gate the provider's decision loop ended at accept: the initiator's
 * ACExecutor then drove the provider's devices directly, so a provider that
 * had promised a capability its own devices cannot actually deliver had no
 * chance to say "to fulfill this I need C" — the hop-2 collaboration never
 * happened and the chain broke silently at execution time.
 *
 * This module inserts ONE deterministic decision point into
 * CollaborationProposalHandler between the accept evaluation and the
 * join-response: "I promised X; can my own capability surface deliver it?
 * If not — who can?" The provider then has exactly three exits:
 *
 *   1. FULFILL DIRECTLY (mode 'direct') — the gap is empty; the legacy
 *      accept path runs unchanged.
 *   2. HONEST REJECT (mode 'reject') — a gap remains and either the hop
 *      budget is exhausted (depth limit) or no downstream service covers it
 *      (or the downstream handshake declined/timed out). The rejection names
 *      the missing capabilities; the initiator's existing cancel/fallback
 *      semantics take over. NEVER a hang: every delegation wait is bounded.
 *   3. DELEGATE DOWNSTREAM (mode 'delegated') — the provider initiates a
 *      hop-(n+1) collaboration LOCKED onto a discovered covering service
 *      (the consume_service semantics: a 'service-invocation'-typed
 *      ac-proposal naming the exact service), awaits that handshake, and
 *      only then accepts hop-n. The hop-2 ac-proposal/join-response pair
 *      rides the same bus lane as any AC handshake, so the server's
 *      ac-agreement-bridge lands an INDEPENDENT ephemeral agreement for
 *      hop-2 (its own collaborationId, consumer = this provider's owner,
 *      provider = the downstream agent); the bridge cascades termination
 *      from the parent completion (parent outcome inherited; a cancelled
 *      parent terminates the child WITHOUT a usage row — a never-executed
 *      chain is never metered, the Fix-21 rule applied recursively).
 *
 * Hop metadata rides proposal.metadata (hop, parentCollaborationId,
 * rootCollaborationId; hop-1 proposals carry none, defaulting to hop=1) and
 * is echoed on the join-response `fulfillment` record, so the trajectory can
 * distinguish hop-1 from hop-2 and reconstruct the parent chain.
 *
 * Depth limit: DEFAULT_MAX_HOP_DEPTH = 2 — a hop-2 provider whose surface
 * still misses the promise may NOT delegate further; it rejects honestly.
 * This bounds chain explosion (each hop is a full LLM-evaluated handshake).
 *
 * Execution boundary (honest scope): the gate secures the downstream
 * COMMITMENT before the provider signs hop-1; the hop-1 executor still
 * actuates through the environment-wide service matching, which can route
 * through the downstream provider's registered services. A hard relay of
 * device commands through the delegating provider is future work.
 */

import { v4 as uuidv4 } from 'uuid';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { CollaborationProposal } from '../types/proposal-handler.js';
import { capabilityMatches } from '../utils/capabilityMatching.js';
import { EventType, EventPriority, type SystemEvent } from '@active-collaboration/shared';

/** Deepest collaboration chain: hop-1 (root) may delegate to hop-2; hop-2 may not. */
export const DEFAULT_MAX_HOP_DEPTH = 2;

/** Default wall-clock bound for ONE downstream handshake wait. */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 30_000;

/** Configuration of the provider fulfillment gate (opt-in, default off). */
export interface FulfillmentGateConfig {
  /** Master switch. Default false — legacy accept-without-gate behavior. */
  enabled?: boolean;
  /** Maximum hop depth a proposal may carry and still delegate. Default 2. */
  maxHopDepth?: number;
  /** Wall-clock bound (ms) for the downstream handshake wait. Default 30s. */
  delegationTimeoutMs?: number;
}

/** Multi-hop chain coordinates of a proposal (hop-1 = root, no metadata). */
export interface HopContext {
  /** 1-based depth; proposals without metadata are hop-1. */
  hop: number;
  /** The collaboration this one was delegated FROM (undefined at hop-1). */
  parentCollaborationId?: string;
  /** The chain's root collaboration id (undefined at hop-1). */
  rootCollaborationId?: string;
}

/** The gate's verdict record — rides the accept/reject payload + trajectory. */
export interface FulfillmentRecord {
  mode: 'direct' | 'delegated' | 'reject';
  hop: number;
  /** Capabilities the provider's own surface could not cover ([] for direct). */
  missingCapabilities: string[];
  reason: string;
  /** Delegated mode: the hop-(n+1) handshake this accept is backed by. */
  downstream?: {
    collaborationId: string;
    providerAgentId: string;
    serviceId: string;
    serviceName: string;
  };
}

/** The gate's decision: how the handler should answer the proposal. */
export type FulfillmentVerdict =
  | { action: 'fulfill'; record: FulfillmentRecord }
  | { action: 'reject'; record: FulfillmentRecord }
  | {
    action: 'delegate';
    record: Omit<FulfillmentRecord, 'downstream'>;
    /** The downstream target to attempt (a discovered covering service). */
    target: DownstreamTarget;
  };

/** A discovered downstream service that covers (part of) the gap. */
export interface DownstreamTarget {
  serviceId: string;
  serviceName: string;
  providerAgentId: string;
  /** The gap capabilities this service covers (capabilityMatches semantics). */
  coversCapabilities: string[];
  semanticType?: string;
}

/** Read the hop context of an incoming proposal (metadata; hop-1 default). */
export function hopContextOf(proposal: CollaborationProposal): HopContext {
  const metadata = (proposal.metadata ?? {}) as Record<string, unknown>;
  const hop = typeof metadata.hop === 'number' && Number.isFinite(metadata.hop) && metadata.hop >= 1
    ? Math.floor(metadata.hop)
    : 1;
  return {
    hop,
    ...(typeof metadata.parentCollaborationId === 'string' && metadata.parentCollaborationId.length > 0
      ? { parentCollaborationId: metadata.parentCollaborationId }
      : {}),
    ...(typeof metadata.rootCollaborationId === 'string' && metadata.rootCollaborationId.length > 0
      ? { rootCollaborationId: metadata.rootCollaborationId }
      : {}),
  };
}

/** The provider's delivery gap for a proposal: required capabilities its own surface cannot cover. */
export function fulfillmentGap(
  requiredCapabilities: readonly string[],
  ownSurface: readonly string[],
): string[] {
  return requiredCapabilities.filter(req =>
    !ownSurface.some(own => capabilityMatches(own, req)),
  );
}

/**
 * The deterministic verdict for one accepted-pending proposal. Pure
 * (the registry read is delegated to `findDownstreamTarget`): given the gap,
 * the hop context and the budget, decide fulfill / reject / delegate. The
 * handler acts on the verdict (delegate = run the hop-(n+1) handshake via
 * DownstreamDelegator, then accept-or-reject from its outcome).
 */
export function assessFulfillment(
  proposal: CollaborationProposal,
  ownSurface: readonly string[],
  config: { maxHopDepth: number },
  findDownstreamTarget: (gap: string[]) => DownstreamTarget | null,
): FulfillmentVerdict {
  const hopCtx = hopContextOf(proposal);
  const gap = fulfillmentGap(proposal.capabilities ?? [], ownSurface);

  if (gap.length === 0) {
    return {
      action: 'fulfill',
      record: {
        mode: 'direct',
        hop: hopCtx.hop,
        missingCapabilities: [],
        reason: 'Own capability surface covers the full promise',
      },
    };
  }

  const base = {
    mode: 'reject' as const,
    hop: hopCtx.hop,
    missingCapabilities: gap,
  };

  if (hopCtx.hop >= config.maxHopDepth) {
    return {
      action: 'reject',
      record: {
        ...base,
        reason:
          `Honest exit: cannot deliver [${gap.join(', ')}] from my own surface and the hop budget ` +
          `is exhausted (hop ${hopCtx.hop} of max ${config.maxHopDepth}) — no further delegation allowed`,
      },
    };
  }

  const target = findDownstreamTarget(gap);
  if (target === null) {
    return {
      action: 'reject',
      record: {
        ...base,
        reason: `Honest exit: cannot deliver [${gap.join(', ')}] and no discovered service covers the gap`,
      },
    };
  }

  return {
    action: 'delegate',
    record: {
      ...base,
      reason:
        `Delegating [${gap.join(', ')}] downstream to ${target.serviceName} ` +
        `(${target.serviceId}) of ${target.providerAgentId} before signing hop ${hopCtx.hop}`,
    },
    target,
  };
}

/**
 * The provider's hop-(n+1) initiator: publishes ONE locked ac-proposal
 * (consume_service semantics — service-invocation typed, exact service term,
 * hop/parent/root metadata) for a downstream target and awaits the
 * handshake answer correlated by the new collaborationId. Bounded by
 * `timeoutMs`; a reject/defer/timeout all resolve to outcome 'rejected'
 * with the reason — the caller then rejects hop-n honestly (never hangs).
 */
export class DownstreamDelegator {
  constructor(
    private readonly environment: EnvironmentCenter,
    private readonly agentId: string,
  ) {}

  /**
   * Discover a downstream service covering at least one gap capability.
   * Excludes the delegating provider itself, the hop-1 initiator (no
   * delegate-back loops) and heartbeat-stale registrations. Deterministic:
   * the covering services are sorted by service id before picking.
   */
  findDownstreamTarget(gap: readonly string[], excludedProviderIds: readonly string[]): DownstreamTarget | null {
    if (typeof this.environment.getServices !== 'function') return null;
    const excluded = new Set(excludedProviderIds);
    const matches: DownstreamTarget[] = [];
    for (const registration of this.environment.getServices().values()) {
      if (excluded.has(registration.agentId)) continue;
      if (typeof this.environment.isRegistrationStale === 'function' &&
          this.environment.isRegistrationStale(registration)) {
        continue;
      }
      const service = registration.service;
      const covers = gap.filter(req =>
        (service.capabilities ?? []).some(cap => capabilityMatches(cap, req)),
      );
      if (covers.length === 0) continue;
      matches.push({
        serviceId: service.id,
        serviceName: service.name,
        providerAgentId: registration.agentId,
        coversCapabilities: covers,
        ...(registration.semanticType !== undefined ? { semanticType: registration.semanticType } : {}),
      });
    }
    matches.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
    return matches[0] ?? null;
  }

  /**
   * Run the hop-(n+1) handshake against a chosen target. Resolves with the
   * outcome; never throws, never hangs (timeout backstop; the timer never
   * keeps the process alive).
   */
  async delegate(
    target: DownstreamTarget,
    hopCtx: HopContext,
    parentCollaborationId: string,
    goal: string,
    timeoutMs: number,
  ): Promise<{ outcome: 'accepted' | 'rejected'; collaborationId: string; reason: string }> {
    const collaborationId = uuidv4();
    const answer = this.awaitAnswer(collaborationId, target.providerAgentId, timeoutMs);

    // The hop-2 ac-proposal — SAME bus lane as any AC handshake, so the
    // responder's CollaborationProposalHandler evaluates it normally and the
    // server's ac-agreement-bridge lands an independent ephemeral agreement.
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'ac-proposal',
        collaborationId,
        collaborationName: `hop-${hopCtx.hop + 1} fulfillment support for ${parentCollaborationId}`,
        initiatorId: this.agentId,
        targetAgentId: target.providerAgentId,
        description: goal,
        requiredCapabilities: target.coversCapabilities,
        proposalType: 'service-invocation',
        services: [{
          name: target.serviceName,
          ...(target.semanticType !== undefined ? { semanticType: target.semanticType } : {}),
          terms: { serviceId: target.serviceId },
        }],
        // The chain coordinates — the responder's gate reads hop from here,
        // the trajectory distinguishes hop-1/hop-2, the bridge cascades.
        hop: hopCtx.hop + 1,
        parentCollaborationId,
        rootCollaborationId: hopCtx.rootCollaborationId ?? parentCollaborationId,
        task: { description: goal },
        metadata: { fulfillmentDelegation: true, parentCollaborationId },
      },
      metadata: {},
    });

    const decision = await answer;
    return { ...decision, collaborationId };
  }

  /**
   * Await the downstream provider's answer (correlated by collaborationId,
   * responder identity checked). 'defer' keeps waiting (the provider
   * re-evaluates and answers later — the timeout bounds the total wait);
   * 'counter' is declined (the gate does not renegotiate mid-fulfillment).
   */
  private awaitAnswer(
    collaborationId: string,
    providerId: string,
    timeoutMs: number,
  ): Promise<{ outcome: 'accepted' | 'rejected'; reason: string }> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: { outcome: 'accepted' | 'rejected'; reason: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          this.environment.eventManager.unsubscribe(subscriptionId);
        } catch {
          // Subscription may already be gone.
        }
        resolve(result);
      };
      const subscriptionId = this.environment.eventManager.subscribe({
        subscriberId: `fulfillment-gate-${collaborationId}`,
        eventType: EventType.COLLABORATION_MESSAGE,
        priority: EventPriority.NORMAL,
        handler: (event: SystemEvent) => {
          const payload = event.payload as {
            type?: unknown;
            acDecision?: unknown;
            agentId?: unknown;
            collaborationId?: unknown;
            reason?: unknown;
          } | undefined;
          if (!payload || payload.collaborationId !== collaborationId) return;
          const responder = typeof payload.agentId === 'string' ? payload.agentId : event.source;
          if (responder !== providerId) return;
          const reason = typeof payload.reason === 'string' ? payload.reason : 'no reason given';
          if (payload.type === 'join-response' && payload.acDecision === 'accept') {
            finish({ outcome: 'accepted', reason });
          } else if (payload.type === 'counter' || payload.acDecision === 'counter') {
            finish({ outcome: 'rejected', reason: `counter-proposal declined: ${reason}` });
          } else if (payload.type === 'reject' || payload.acDecision === 'reject') {
            finish({ outcome: 'rejected', reason });
          }
        },
      });
      const timer = setTimeout(() => {
        finish({
          outcome: 'rejected',
          reason: `Downstream provider ${providerId} did not answer within ${timeoutMs}ms (timeout)`,
        });
      }, timeoutMs);
      timer.unref?.();
    });
  }
}
