/**
 * Collaboration Coordinator
 *
 * Extracted from CognitiveAgent lines 551-786, 3915-4115, 5765-5979
 *
 * Responsibilities:
 * - Autonomous AC initiation
 * - AC proposal handling
 * - AC session execution
 * - AC withdrawal
 * - AC dissolution
 */

import type { CollaborationManager } from '../../management/CollaborationManager.js';
import type { DialogueManager } from '../../management/DialogueManager.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import { EventType } from '../../events/index.js';
import { CollaborationPriority, CollaborationStatus } from '../../management/CollaborationManager.js';
import type { DualTriggerResult } from '../../decision/DualTriggerACManager.js';
import { extractSharedEventId } from '../../decision/event-cluster-summary.js';
import { matchStrength } from '../../decision/partner-summaries.js';
import { ACExecutor } from '../../execution/ACExecutor.js';
import type { ACCollaborationConfig as ExecutorCollaborationConfig } from '../../execution/ACExecutor.js';
import type { ACExecutionOptions } from '../../execution/ACExecutor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import { untrustedBlock } from '../../security/prompt-sanitizer.js';
import type { ProposalServiceTerm } from '../../types/proposal-handler.js';
import { AgentStatus } from '../CognitiveAgent.js';

import { createLogger, EventPriority } from '@active-collaboration/shared';
/**
 * AC Collaboration Configuration
 * Simplified interface for collaboration coordinator
 */
const logger = createLogger('CollaborationCoordinator');

export interface ACCollaborationConfig {
  id: string;
  name: string;
  description: string;
  priority: string;
  participantAgentIds: string[];
  requiredResources: any[];
  goals: any[];
  maxDuration?: number;
  timeout?: number;
  /**
   * R102 (eval-chain-caliber): the injection event this collaboration was
   * triggered by (same id the ac-proposal payload carries, R81-D2) —
   * threaded into the executor so every device-command receipt attributes
   * to the DECISION event instead of 'unattributed'.
   */
  triggerEventId?: string;
  /**
   * BUG-03: the triggering event's type/zone, stashed beside triggerEventId
   * when the primary proposals go out so the Phase-7 fallback batch can
   * re-emit the same trigger face (the fallback runs without the
   * DualTriggerResult in scope).
   */
  triggerEventType?: string;
  triggerZoneId?: string;
}

/**
 * Collaboration Coordinator
 *
 * Coordinates collaboration session management for CognitiveAgent
 */
export class CollaborationCoordinator {
  /**
   * Default time the initiator waits for partner accept/reject responses
   * before cancelling the AC (Fix-8 handshake timeout). Overridable via the
   * constructor options for tests.
   */
  static readonly DEFAULT_HANDSHAKE_TIMEOUT_MS = 120_000;

  /**
   * T123 (plan-e2e-hardening §5 D1, option A): real-time FLOOR for the
   * handshake window when the world runs at a high speed multiplier. The
   * window itself is a wall-clock constant (NOT sim time — see the §0 code
   * facts in the dispatch), but a ×60~×300 world multiplies per-wall-second
   * event/decision load until responder evaluation latency outgrows the
   * 120s window (R18-u3: 0/8 handshakes, all abandoned-before-response).
   * When the world's nominal sim-per-wall-second rate reaches
   * DEFAULT_FLOOR_ENGAGE_RATE the window is raised to at least this many
   * REAL milliseconds. Default 5 real minutes.
   */
  static readonly DEFAULT_RESPONSE_FLOOR_MIN_WALL_MS = 300_000;

  /**
   * T123: the rate gate for the floor — nominal sim-seconds per wall-second
   * at or above this engages the floor. Default 60 (the campaign's own
   * "×60 and up" caliber). Below the gate the window is EXACTLY today's
   * behavior — ×1/×5 worlds must stay bit-identical.
   */
  static readonly DEFAULT_FLOOR_ENGAGE_RATE = 60;

  /**
   * R44-dense-F2: how many next-ranked candidates receive a fallback
   * proposal per Phase 7 round. The legacy one-at-a-time iteration could
   * not converge at dense scale (193 agents): with a ~11-18% per-response
   * accept rate each single-candidate round is another likely miss, and
   * every 'defer' answer stalls the round for its full re-evaluation delay
   * (default 30s) — the r44city-dense run burned 114s churning 20
   * candidates one-by-one (3 defer stalls alone) and still had not
   * exhausted the ranked list when the simulation ended, leaving the
   * handshake stuck 'pending'. A batch multiplies the per-round hit
   * probability and lets any batch member's accept converge the handshake
   * while another member's defer is still pending.
   */
  static readonly DEFAULT_FALLBACK_BATCH_SIZE = 4;

  private readonly handshakeTimeoutMs: number;
  private readonly fallbackBatchSize: number;
  private readonly llmClient?: LLMClient;
  /**
   * BUG-07 (world-session AC handshake silent death): the abort handles of
   * every handshake currently parked in awaitHandshakeThenExecute, keyed by
   * collaboration id. A dying runtime (world-session rebuild / hibernate /
   * stop) calls cancelPendingHandshakes() BEFORE its event bus and
   * trajectory recorder go away, so each pending handshake is narrated as an
   * explicit ac-cancelled (outcome 'aborted') instead of orphaning the
   * waiter on the dead bus — the implicit death the T134 diagnosis line
   * could only prove by its absence.
   */
  private readonly pendingHandshakeAborts = new Map<string, (reason: string) => void>();
  /** T123: real-time floor for the window (engaged by the rate gate). */
  private readonly responseFloorMinWallMs: number;
  /** T123: engage gate — nominal sim-sec per wall-sec at/above which the floor applies. */
  private readonly floorEngageRate: number;
  /** T123: read LIVE per handshake — the rate can change online (retargetSpeed). */
  private readonly simRateProvider?: () => number;

  constructor(
    private collaborationManager: CollaborationManager,
    private dialogueManager: DialogueManager,
    private eventEmitter: EventEmitter,
    private environment: EnvironmentCenter,
    private agentId: string,
    private agentName: string,
    private agentCapabilities: string[],
    private setStatus: (status: AgentStatus) => void,
    options?: {
      handshakeTimeoutMs?: number;
      /**
       * R44-dense-F2: Phase 7 fallback batch size (see
       * DEFAULT_FALLBACK_BATCH_SIZE). Overridable for tests.
       */
      fallbackBatchSize?: number;
      /**
       * Wave-4a: used to evaluate partner counter-proposals (accept → the
       * handshake closes under the counter's conditions; reject → the AC is
       * cancelled). Without a client the counter is rejected by rule
       * (conservative, Fix-12 style) and labelled decisionSource 'rule'.
       */
      llmClient?: LLMClient;
      /**
       * T123: real-time floor override for the handshake window (see
       * DEFAULT_RESPONSE_FLOOR_MIN_WALL_MS). Precedence:
       * option > EAF_AC_RESPONSE_MIN_WALL_MS env > constant default.
       */
      responseFloorMinWallMs?: number;
      /**
       * T123: rate-gate override (see DEFAULT_FLOOR_ENGAGE_RATE).
       * Precedence: option > EAF_AC_RESPONSE_FLOOR_MIN_RATE env > constant.
       */
      responseFloorEngageRate?: number;
      /**
       * T123: the world's current nominal sim-per-wall-second rate, read
       * LIVE at every handshake (the rate can change online via
       * retargetSpeed — never baked in at construction). Absent = the rate
       * is unknown and the floor NEVER engages (today's behavior).
       */
      simRateProvider?: () => number;
    }
  ) {
    this.handshakeTimeoutMs = options?.handshakeTimeoutMs ?? CollaborationCoordinator.DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.fallbackBatchSize = options?.fallbackBatchSize ?? CollaborationCoordinator.DEFAULT_FALLBACK_BATCH_SIZE;
    this.llmClient = options?.llmClient;
    this.responseFloorMinWallMs =
      options?.responseFloorMinWallMs
      ?? CollaborationCoordinator.responseFloorMinWallMsFromEnv()
      ?? CollaborationCoordinator.DEFAULT_RESPONSE_FLOOR_MIN_WALL_MS;
    this.floorEngageRate =
      options?.responseFloorEngageRate
      ?? CollaborationCoordinator.floorEngageRateFromEnv()
      ?? CollaborationCoordinator.DEFAULT_FLOOR_ENGAGE_RATE;
    this.simRateProvider = options?.simRateProvider;
  }

  /**
   * T123: EAF_AC_RESPONSE_MIN_WALL_MS (positive number of milliseconds;
   * absent/invalid → undefined = caller falls through to the next tier).
   * Invalid values warn and are IGNORED — this is an optional behavior
   * enhancement, not a deployment contract, so it must never fail startup.
   */
  static responseFloorMinWallMsFromEnv(): number | undefined {
    return CollaborationCoordinator.parsePositiveEnv('EAF_AC_RESPONSE_MIN_WALL_MS');
  }

  /**
   * T123: EAF_AC_RESPONSE_FLOOR_MIN_RATE (positive number; the engage gate
   * in nominal sim-sec per wall-sec). Same absent/invalid semantics as the
   * floor env.
   */
  static floorEngageRateFromEnv(): number | undefined {
    return CollaborationCoordinator.parsePositiveEnv('EAF_AC_RESPONSE_FLOOR_MIN_RATE');
  }

  private static parsePositiveEnv(name: string): number | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logger.warn(`[CollaborationCoordinator] Ignoring invalid ${name}=${raw} (expected a positive number) — using the default`);
      return undefined;
    }
    return parsed;
  }

  /**
   * T123: the CURRENT nominal sim-per-wall-second rate, defensively read
   * through the provider (provider faults degrade to "rate unknown" — the
   * floor simply does not engage, never throws into the handshake).
   */
  private currentSimRate(): number | undefined {
    if (this.simRateProvider === undefined) return undefined;
    try {
      const rate = this.simRateProvider();
      return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * T123: the effective handshake window for THIS handshake — the base wall
   * clock timeout, raised to the real-time floor only when the world's
   * nominal sim-per-wall-second rate reaches the engage gate. Recomputed
   * per handshake (Phase 7 fallback rounds each re-enter here, so an online
   * rate change takes effect from the next round/handshake on).
   */
  private effectiveHandshakeWindowMs(acConfigId: string): number {
    const rate = this.currentSimRate();
    if (rate === undefined || rate < this.floorEngageRate) return this.handshakeTimeoutMs;
    const effMs = Math.max(this.handshakeTimeoutMs, this.responseFloorMinWallMs);
    if (effMs > this.handshakeTimeoutMs) {
      logger.info(
        `[CollaborationCoordinator:${this.agentId}] AC ${acConfigId} handshake window floor engaged: ` +
        `rate=${rate} sim-s/wall-s >= ${this.floorEngageRate}, base=${this.handshakeTimeoutMs}ms → eff=${effMs}ms`,
      );
    }
    return effMs;
  }

  /**
   * Handle autonomous AC initiation
   * Extracted from CognitiveAgent.handleAutonomousACInitiation() (lines 551-786)
   *
   * Handshake semantics (Fix-8): when partners were proposed to AND a shared
   * event bus is available, goal execution is GATED on the partners'
   * responses — at least one partner must accept before anything is
   * actuated, and only accepting partners participate in execution. When all
   * partners reject or the handshake timeout elapses, the session is
   * CANCELLED and an 'ac-cancelled' message is emitted. Without a bus (or
   * without partners) the legacy fire-and-forget path runs immediately.
   */
  async handleAutonomousACInitiation(
    acConfig: ACCollaborationConfig,
    result: DualTriggerResult,
    execOptions?: ACExecutionOptions
  ): Promise<void> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Autonomously initiating AC: ${acConfig.name}`);
    logger.info(`[CollaborationCoordinator:${this.agentId}] AC Reason: ${acConfig.description}`);
    logger.info(`[CollaborationCoordinator:${this.agentId}] Partners: ${acConfig.participantAgentIds.join(', ')}`);

    // Update agent status
    this.setStatus(AgentStatus.BUSY);

    // Create the collaboration session FIRST so we have a session ID.
    // The session is created WITH the AC config id (Fix-8): accepting
    // partners join under the same collaborationId, so both sides track one
    // shared, queryable id instead of two unrelated ones.
    const session = this.collaborationManager.createSessionWithId(
      acConfig.id,
      'service-composition',
      [this.agentId, ...acConfig.participantAgentIds],
      this.agentId,
      this.mapPriority(acConfig.priority),
      acConfig.description,
      this.extractResourceIds(acConfig.requiredResources)
    );

    // T-036-depth (DevLoop R17): capability-matching candidates that the
    // scope-of-practice filter excluded from THIS selection ride the session
    // (bounded — the first 10 exclusions), so the collaborations view and
    // the event stream show the honest "who was blocked and why" beside the
    // collaboration that DID form. Exclusions only exist when some
    // capability-matching candidate had a cannotDeliverClasses intersection.
    const scopeExclusions = result.layer2Result?.partnerSelection?.scopeExclusions;
    if (scopeExclusions !== undefined && scopeExclusions.length > 0) {
      session.scopeExclusions = scopeExclusions.slice(0, 10)
        .map(exclusion => ({
          agentId: exclusion.agentId,
          blockedBy: [...exclusion.blockedBy],
        }));
    }

    logger.info(`[CollaborationCoordinator:${this.agentId}] AC ${acConfig.id} autonomously initiated - Session: ${session.id}`);

    // Emit AC initiation event with BOTH acConfig.id and session.id
    // Listeners can use sessionId to look up the session in CollaborationManager
    this.eventEmitter.emit(EventType.COLLABORATION_STARTED, {
      acId: acConfig.id,
      sessionId: session.id,
      acName: acConfig.name,
      initiatorId: this.agentId,
      participantIds: acConfig.participantAgentIds,
      priority: acConfig.priority,
      goals: acConfig.goals.map(g => g.name),
      triggerReason: acConfig.description,
      autonomous: true,
      ...(session.scopeExclusions !== undefined ? { scopeExclusions: session.scopeExclusions } : {}),
    });

    // Send collaboration proposals to selected partners (skip self)
    const partnerIds: string[] = [];
    for (const partnerId of acConfig.participantAgentIds) {
      if (partnerId === this.agentId) {
        logger.info(`[CollaborationCoordinator:${this.agentId}] Skipping self-proposal`);
        continue;
      }
      partnerIds.push(partnerId);
      logger.info(`[CollaborationCoordinator:${this.agentId}] Sending proposal to agent ${partnerId}`);

      // Extract resource IDs from AC config
      const resourceIds: string[] = [];
      for (const r of acConfig.requiredResources) {
        if (typeof r === 'string') {
          resourceIds.push(r);
        } else if (r && typeof r === 'object' && 'id' in r) {
          resourceIds.push((r as { id: string }).id);
        }
      }

      // requiredCapabilities arrives in both shapes — string[] (assessor
      // inference) and [{ capability }] (GoalFormulationEngine); normalize
      // so the partner sees what is actually requested of it.
      // BUG-03: the primary goal AND every subgoal each carry the full
      // requiredCapabilities — dedupe after the flatMap or the request face
      // repeats every capability once per goal (the server's terms.trigger
      // ended up with "ventilation,ventilation").
      const requiredCapabilities = [...new Set(acConfig.goals.flatMap((g: any) =>
        (g.requiredCapabilities ?? []).map((rc: any) =>
          typeof rc === 'string' ? rc : String(rc?.capability ?? ''),
        )
      ).filter((cap: string) => cap.length > 0))];

      const proposal = this.dialogueManager.proposeCollaboration(
        this.agentId,
        partnerId,
        acConfig.name,
        acConfig.description,
        resourceIds,
        {
          priority: acConfig.priority,
          urgency: acConfig.priority,
          acConfig: acConfig, // Include full AC config
        }
      );

      logger.info(`[CollaborationCoordinator:${this.agentId}] Proposal created: ${proposal.id}`);

      // R42-A/F3 §7.2: the services THIS partner exposes (from partner
      // selection's service face) ride the proposal as structured terms —
      // the responder matches them against its own catalog by semanticType.
      // R100 (chen-11): SUBSET the partner's face to the services this
      // request can mean — the full unfiltered face read as "I request
      // every service you offer" (a smoke AC's proposals named the
      // partner's lighting service → justified mass rejection). No request
      // face → no service terms at all (a pure coverage broadcast does not
      // name services).
      const partnerServiceFace = result?.layer2Result?.partnerSelection?.selectedPartners
        ?.find(p => p.agentId === partnerId)?.services;
      const proposalFormation = result?.layer2Result?.partnerSelection?.proposal?.proposalType;
      const partnerServices = proposalFormation === 'service-invocation'
        // Exempt service-invocation proposals: the locked service IS the
        // request — narrowing the face by capability words could drop it.
        ? partnerServiceFace ?? []
        : requiredCapabilities.length > 0 && partnerServiceFace !== undefined
          ? partnerServiceFace.filter(s =>
              requiredCapabilities.some(rc => matchStrength(s.semanticType ?? s.name, rc) > 0),
            )
          : [];

      // Also publish proposal via EventManager so partner agents'
      // CollaborationProposalHandler can receive and process it.
      // triggerEventType (Wave-4a): the environment event type that brought
      // this AC into being, when known — the server's agreement bridge
      // backfills it into the ephemeral agreement's structured terms.trigger.
      const triggerEventType = result?.layer1Result?.cluster?.events?.[0]?.type;
      // R81-D2 (R44-F4): the SOURCE event id rides the proposal too — the
      // async handshake answers arrive after the runtime's inflight-event
      // window closed, so the trajectory's collaboration-response records
      // would otherwise attribute to the synthetic collaboration UUID
      // (extreme tier: 57% of responses missed per-event attribution).
      const triggerEvent = result?.layer1Result?.cluster?.events?.[0];
      const triggerEventId = triggerEvent !== undefined
        ? extractSharedEventId(triggerEvent)
        : undefined;
      // R102: the SAME id rides the config into the executor — every device
      // command this collaboration runs attributes to the decision event.
      if (triggerEventId !== undefined && triggerEventId.length > 0) {
        acConfig.triggerEventId = triggerEventId;
      }
      // R6-C-F03: the trigger event's ZONE rides too (cluster region id —
      // factual L1 metadata, not the model's narrative). The responder's
      // ground-truth check locates the claimed situation by zone and
      // verifies it against its own observations; 'unknown' (aggregate
      // fallback) carries no locatable claim, so it is not backfilled.
      const clusterZoneId = result?.layer1Result?.cluster?.region?.id;
      const triggerZoneId = typeof clusterZoneId === 'string' &&
        clusterZoneId.length > 0 && clusterZoneId !== 'unknown'
        ? clusterZoneId
        : undefined;
      // BUG-03: stash the trigger face beside triggerEventId so the Phase-7
      // fallback batch (no DualTriggerResult in scope there) re-emits the
      // same triggerEventType/triggerZoneId on its fresh proposals.
      if (typeof triggerEventType === 'string') acConfig.triggerEventType = triggerEventType;
      if (triggerZoneId !== undefined) acConfig.triggerZoneId = triggerZoneId;
      // R6-E-F07: the proposal formation type rides the ac-proposal so the
      // responder's evaluation threshold lane recognizes a locked
      // service-invocation (consume_service) the same as a broker-initiated one.
      const proposalType = result?.layer2Result?.partnerSelection?.proposal?.proposalType;
      this.eventEmitter.emit(EventType.COLLABORATION_MESSAGE, {
        type: 'ac-proposal',
        collaborationId: acConfig.id,
        collaborationName: acConfig.name,
        initiatorId: this.agentId,
        targetAgentId: partnerId,
        description: acConfig.description,
        requiredCapabilities,
        ...(partnerServices !== undefined && partnerServices.length > 0
          ? { services: partnerServices.map(s => ({ ...s })) }
          : {}),
        priority: acConfig.priority,
        ...(proposalType !== undefined ? { proposalType } : {}),
        ...(typeof triggerEventType === 'string' ? { triggerEventType } : {}),
        ...(triggerEventId !== undefined && triggerEventId.length > 0
          ? { triggerEventId }
          : {}),
        ...(triggerZoneId !== undefined ? { triggerZoneId } : {}),
        task: {
          description: acConfig.description,
        },
        metadata: {
          proposalId: proposal.id,
          acConfigId: acConfig.id,
        },
      });
    }

    // Handshake gating (Fix-8): with partners + a shared bus, wait for
    // accept/reject before executing. The wait is ASYNCHRONOUS — this method
    // returns once proposals are out; the agent stays BUSY until the
    // handshake resolves. Without partners or a bus, execute immediately
    // (legacy behavior).
    const eventManager = this.environment?.eventManager;
    if (partnerIds.length > 0 && eventManager) {
      // Phase 6+7: extract ranked candidates for Contract Net selection
      // and fallback iteration.
      const rankedCandidates = result?.layer2Result?.partnerSelection?.allRankedCandidates ?? [];
      void this.awaitHandshakeThenExecute(acConfig, partnerIds, execOptions, rankedCandidates).catch(error => {
        logger.error(`[CollaborationCoordinator:${this.agentId}] Handshake wait failed:`, error);
        this.setStatus(AgentStatus.ERROR);
      });
      return;
    }

    // Legacy path: no partners to consult — execute right away.
    try {
      await this.executeAC(acConfig, acConfig.participantAgentIds, execOptions);
      logger.info(`[CollaborationCoordinator:${this.agentId}] AC execution completed successfully`);

      // Update agent status back to IDLE
      this.setStatus(AgentStatus.IDLE);
    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] AC execution failed:`, error);

      // Update agent status to ERROR
      this.setStatus(AgentStatus.ERROR);

      throw error;
    }
  }

  /**
   * Wait for partner responses to the AC proposals, then either execute the
   * collaboration with the ACCEPTING partners or cancel it (Fix-8).
   *
   * Resolution:
   * - every partner responded → 'accepted' when ≥1 accepted, else 'rejected'
   * - handshake timeout first → 'timeout' (non-responders count as no consent)
   *
   * Wave-4a: 'counter' and 'defer' answers now CONVERGE into the handshake
   * instead of falling through to the timeout:
   * - counter → the initiator re-evaluates (LLM when configured, else a
   *   conservative rule rejection) and answers with a 'counter-response'.
   *   Accept → the responder joins and its regular join-response accept
   *   closes its slot under the counter's conditions; reject → the partner
   *   counts as declined. ONE round only: a second counter from the same
   *   partner is treated as a rejection (no infinite negotiation).
   * - defer → the partner stays pending; it re-evaluates after its own
   *   suggested delay (≤60s) and then answers accept/reject. The handshake
   *   window (120s, with the T123 real-time floor at high world rates)
   *   remains the final backstop either way.
   */
  private async awaitHandshakeThenExecute(
    acConfig: ACCollaborationConfig,
    partnerIds: string[],
    execOptions?: ACExecutionOptions,
    rankedCandidates: Array<{ agentId: string; agentName: string; matchScore: number; services?: ProposalServiceTerm[] }> = [],
  ): Promise<void> {
    const eventManager = this.environment.eventManager;
    const accepted = new Map<string, string | undefined>(); // agentId → reasoning
    const declined = new Map<string, string | undefined>();
    const countered = new Set<string>(); // partners whose counter we already answered (Wave-4a)

    // T123: per-handshake window — base wall-clock timeout, raised to the
    // real-time floor when the world rate reaches the engage gate. Read
    // LIVE here so an online retargetSpeed is honored by the next
    // handshake (Phase 7 fallback rounds naturally recompute via recursion).
    const effMs = this.effectiveHandshakeWindowMs(acConfig.id);
    // T134 (R20-F, u1-F1) bounded diagnosis: when this handshake ends WITHOUT
    // acceptance, the cancel narration below reports HOW LONG it actually
    // waited — the eval funnel only sees the trajectory record (timeout
    // counted solely on an explicit decisionSource marker), so without this
    // line an in-window cancel vs an implicit death are indistinguishable.
    const handshakeStartedAtMs = Date.now();

    const outcome: 'accepted' | 'rejected' | 'timeout' | 'aborted' = await new Promise(resolve => {
      let subscriptionId: string | undefined;
      let settled = false;
      const finish = (value: 'accepted' | 'rejected' | 'timeout' | 'aborted'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingHandshakeAborts.delete(acConfig.id);
        if (subscriptionId !== undefined) {
          try {
            eventManager.unsubscribe(subscriptionId);
          } catch {
            // Subscription may already be gone
          }
        }
        resolve(value);
      };
      // BUG-07: register the abort handle so a runtime teardown (world-session
      // rebuild / hibernate / stop) can end this handshake EXPLICITLY. The
      // cancel is narrated synchronously — the bus subscribers (trajectory
      // recorder, agreement bridge, session finalizer) must see it before the
      // runtime's stop() unsubscribes them.
      this.pendingHandshakeAborts.set(acConfig.id, (reason: string) => {
        if (settled) return;
        logger.info(
          `[CollaborationCoordinator:${this.agentId}] [T134 diagnosis] AC ${acConfig.id} handshake aborted ` +
          `windowMs=${effMs} waitedMs=${Date.now() - handshakeStartedAtMs} reason=${reason} ` +
          `accepted=${accepted.size} declined=${declined.size} ` +
          `pending=${partnerIds.length - accepted.size - declined.size}`,
        );
        this.collaborationManager.updateSessionStatus(acConfig.id, CollaborationStatus.CANCELLED);
        this.eventEmitter.emit(EventType.COLLABORATION_MESSAGE, {
          type: 'ac-cancelled',
          collaborationId: acConfig.id,
          agentId: this.agentId,
          outcome: 'aborted',
          reason,
          acceptedBy: [...accepted.keys()],
          declinedBy: [...declined.keys()],
        });
        finish('aborted');
      });
      const maybeFinish = (): void => {
        if (accepted.size + declined.size >= partnerIds.length) {
          finish(accepted.size > 0 ? 'accepted' : 'rejected');
        }
      };

      // R44-dense-F2: the timeout backstop only cancels a handshake that
      // has ZERO accepts. With a widened (batched) candidate set some
      // members may stay silent past the window while another already
      // accepted — Fix-8's contract is "at least one accept → execute with
      // the consenting partners", so the consent already in hand wins and
      // the silent remainder counts as declined.
      const timer = setTimeout(
        () => finish(accepted.size > 0 ? 'accepted' : 'timeout'),
        effMs,
      );
      // Do not keep the process alive solely for an unanswered handshake.
      timer.unref?.();

      subscriptionId = eventManager.subscribe({
        subscriberId: `${this.agentId}-ac-handshake-${acConfig.id}`,
        eventType: EventType.COLLABORATION_MESSAGE,
        handler: (event) => {
          const payload = event.payload as {
            type?: string;
            acDecision?: string;
            agentId?: string;
            collaborationId?: string;
            reason?: string;
            counterProposal?: { modifications?: string[]; reasoning?: string };
            originalProposal?: unknown;
            deferMs?: number;
          } | undefined;
          if (!payload || payload.collaborationId !== acConfig.id) return;

          const responder = payload.agentId ?? event.source;
          if (!partnerIds.includes(responder)) return;
          if (accepted.has(responder) || declined.has(responder)) return;

          if (payload.type === 'join-response' && payload.acDecision === 'accept') {
            accepted.set(responder, payload.reason);
            logger.info(`[CollaborationCoordinator:${this.agentId}] Partner ${responder} ACCEPTED AC ${acConfig.id}`);
            maybeFinish();
          } else if (payload.type === 'reject' || payload.acDecision === 'reject') {
            declined.set(responder, payload.reason);
            logger.info(`[CollaborationCoordinator:${this.agentId}] Partner ${responder} REJECTED AC ${acConfig.id}: ${payload.reason ?? 'no reason'}`);
            maybeFinish();
          } else if (payload.type === 'defer' || payload.acDecision === 'defer') {
            // Wave-4a: the partner will re-evaluate after its suggested
            // delay — its slot stays pending; the handshake timer bounds
            // the total wait.
            logger.info(
              `[CollaborationCoordinator:${this.agentId}] Partner ${responder} DEFERRED AC ${acConfig.id} ` +
              `(re-evaluation in ~${payload.deferMs ?? '?'}ms): ${payload.reason ?? 'no reason'}`,
            );
          } else if (payload.type === 'counter' || payload.acDecision === 'counter') {
            if (countered.has(responder)) {
              // One negotiation round only: a second counter is a rejection.
              declined.set(responder, payload.reason ?? 'second counter-proposal treated as rejection');
              logger.info(`[CollaborationCoordinator:${this.agentId}] Partner ${responder} sent a SECOND counter for AC ${acConfig.id} — treated as rejection`);
              maybeFinish();
              return;
            }
            countered.add(responder);
            logger.info(`[CollaborationCoordinator:${this.agentId}] Partner ${responder} COUNTERED AC ${acConfig.id}: ${payload.reason ?? 'no reason'}`);
            void this.evaluateCounterProposal(acConfig, responder, payload.counterProposal, payload.reason)
              .then(answer => {
                if (settled) return;
                this.publishCounterResponse(acConfig, responder, payload, answer);
                if (!answer.accept) {
                  declined.set(responder, answer.reason);
                  maybeFinish();
                }
                // accept: the responder's slot stays open until its
                // join-response accept closes it (or the timer fires).
              })
              .catch(error => {
                logger.error(`[CollaborationCoordinator:${this.agentId}] Counter evaluation failed:`, error);
                if (settled) return;
                declined.set(responder, 'counter evaluation failed');
                maybeFinish();
              });
          }
          // anything else: unrelated — handshake stays open
        },
        priority: EventPriority.NORMAL,
      });
    });

    if (outcome === 'aborted') {
      // BUG-07: the abort path already cancelled the session and narrated
      // ac-cancelled synchronously (it had to land before the runtime's
      // teardown unsubscribed the bus) — nothing left to settle here.
      this.setStatus(AgentStatus.IDLE);
      return;
    }

    if (outcome === 'accepted') {
      logger.info(
        `[CollaborationCoordinator:${this.agentId}] Handshake complete for AC ${acConfig.id}: ` +
        `accepted by [${[...accepted.keys()].join(', ')}]` +
        (declined.size > 0 ? `, declined by [${[...declined.keys()].join(', ')}]` : ''),
      );
      this.collaborationManager.updateSessionStatus(acConfig.id, CollaborationStatus.IN_PROGRESS);

      // ============================================================
      // Phase 6: Contract Net selection. When multiple partners accept
      // and we have ranked candidates (matchScore), pick the best-scoring
      // partner and execute with only the winner. This is the runtime
      // implementation of FIPA Contract Net's accept-proposal/reject-
      // proposal phase — no new event subtypes needed because partners
      // already responded with accept; we simply select the best.
      // ============================================================
      let executionPartners = [this.agentId, ...accepted.keys()];
      if (accepted.size > 1 && rankedCandidates.length > 0) {
        const acceptedIds = [...accepted.keys()];
        const scored = acceptedIds
          .map(id => {
            const candidate = rankedCandidates.find(c => c.agentId === id);
            return { id, score: candidate?.matchScore ?? 0.5 };
          })
          .sort((a, b) => b.score - a.score);
        const winnerId = scored[0]?.id;
        const loserIds = scored.slice(1).map(s => s.id);

        if (winnerId && loserIds.length > 0) {
          logger.info(
            `[CollaborationCoordinator:${this.agentId}] Contract Net: selected ${winnerId} ` +
            `(score ${scored[0].score.toFixed(3)}) over ${loserIds.join(', ')} ` +
            `from ${accepted.size} accepting partners`,
          );
          executionPartners = [this.agentId, winnerId];
          // Notify non-winners that they were not selected.
          for (const loserId of loserIds) {
            this.eventEmitter.emit(EventType.COLLABORATION_MESSAGE, {
              type: 'reject-proposal',
              collaborationId: acConfig.id,
              agentId: this.agentId,
              targetAgentId: loserId,
              reason: `Contract Net: another partner scored higher`,
            });
          }
        }
      }

      try {
        await this.executeAC(acConfig, executionPartners, execOptions);
        logger.info(`[CollaborationCoordinator:${this.agentId}] AC execution completed successfully`);
        this.setStatus(AgentStatus.IDLE);
      } catch (error) {
        logger.error(`[CollaborationCoordinator:${this.agentId}] AC execution failed:`, error);
        this.collaborationManager.updateSessionStatus(acConfig.id, CollaborationStatus.FAILED);
        this.setStatus(AgentStatus.ERROR);
      }
      return;
    }

    // ============================================================
    // Phase 7: Fallback iteration. When all primary partners reject or
    // the handshake times out, try the next-ranked candidates from the
    // full partner selection list. This implements graceful degradation
    // without re-running the entire AC initiation pipeline.
    //
    // R44-dense-F2: the fallback proposes to a BATCH of next-ranked
    // candidates per round (fallbackBatchSize, default 4) instead of one —
    // at dense scale the serial iteration could not converge inside the
    // run (see DEFAULT_FALLBACK_BATCH_SIZE).
    // ============================================================
    if ((outcome === 'rejected' || outcome === 'timeout') && rankedCandidates.length > 0) {
      const triedIds = new Set([...partnerIds, this.agentId]);
      const batch: Array<{ agentId: string; agentName: string; matchScore: number; services?: ProposalServiceTerm[] }> = [];
      for (const candidate of rankedCandidates) {
        if (triedIds.has(candidate.agentId)) continue;
        batch.push(candidate);
        if (batch.length >= this.fallbackBatchSize) break;
      }
      if (batch.length > 0) {
        logger.info(
          `[CollaborationCoordinator:${this.agentId}] Phase 7 fallback: ` +
          `all primary partners ${outcome}, proposing to next-ranked batch ` +
          `[${batch.map(c => `${c.agentId} (${c.matchScore.toFixed(3)})`).join(', ')}]`,
        );
        // Send a fresh proposal to every batch member.
        for (const nextCandidate of batch) {
          this.eventEmitter.emit(EventType.COLLABORATION_MESSAGE, {
            type: 'ac-proposal',
            collaborationId: acConfig.id,
            collaborationName: acConfig.name,
            initiatorId: this.agentId,
            targetAgentId: nextCandidate.agentId,
            description: acConfig.description,
            // BUG-03: same dedupe as the primary proposals (primary + sub
            // goals each carry the full capability list).
            requiredCapabilities: [...new Set((acConfig.goals ?? []).flatMap((g: any) =>
              (g.requiredCapabilities ?? []).map((rc: any) =>
                typeof rc === 'string' ? rc : String(rc?.capability ?? ''),
              ),
            ).filter((cap: string) => cap.length > 0))],
            // R42-A/F3 §7.2: each fallback candidate's own service face
            // rides its fresh proposal too.
            ...(nextCandidate.services !== undefined && nextCandidate.services.length > 0
              ? { services: nextCandidate.services.map(s => ({ ...s })) }
              : {}),
            priority: acConfig.priority,
            // BUG-03: the fallback batch re-emits the SAME trigger face the
            // primary proposals carried (stashed on the config there) — the
            // server's agreement bridge backfills terms.trigger from it.
            ...(acConfig.triggerEventType !== undefined
              ? { triggerEventType: acConfig.triggerEventType }
              : {}),
            ...(acConfig.triggerEventId !== undefined
              ? { triggerEventId: acConfig.triggerEventId }
              : {}),
            ...(acConfig.triggerZoneId !== undefined
              ? { triggerZoneId: acConfig.triggerZoneId }
              : {}),
            task: { description: acConfig.description },
            metadata: { fallbackAttempt: true },
          });
        }
        // Re-enter handshake for this batch (recursive, with the remaining
        // ranked candidates for further fallback rounds).
        const batchIds = new Set(batch.map(c => c.agentId));
        const remainingRanked = rankedCandidates.filter(c => !triedIds.has(c.agentId) && !batchIds.has(c.agentId));
        await this.awaitHandshakeThenExecute(
          acConfig,
          batch.map(c => c.agentId),
          execOptions,
          remainingRanked,
        );
        return;
      }
    }

    // Rejected by everyone, or the timeout elapsed: cancel the session and
    // narrate the cancel on the bus so runtime/trajectory listeners see the
    // handshake outcome (Fix-8).
    const reason = outcome === 'timeout'
      ? `Handshake timeout: no response within ${effMs}ms ` +
        `(accepted: ${accepted.size}, declined: ${declined.size}, pending: ${partnerIds.length - accepted.size - declined.size})`
      : `All partners rejected the collaboration`;
    logger.info(`[CollaborationCoordinator:${this.agentId}] AC ${acConfig.id} cancelled: ${reason}`);
    // T134 (R20-F, u1-F1) diagnosis: the cancel's real source + wait, on one
    // line. u1's ×300 runs showed timeout=0 with abandoned-before-response
    // dominating — this line is the evidence surface that separates (a) the
    // coordinator's own window elapsing from (b) an implicit death (run end /
    // teardown, which never reaches this line at all: its absence beside an
    // abandoned-byCause bucket IS the signal that the handshake never
    // concluded before the world went away).
    logger.info(
      `[CollaborationCoordinator:${this.agentId}] [T134 diagnosis] AC ${acConfig.id} handshake ended ` +
      `outcome=${outcome} windowMs=${effMs} waitedMs=${Date.now() - handshakeStartedAtMs} ` +
      `accepted=${accepted.size} declined=${declined.size} ` +
      `pending=${partnerIds.length - accepted.size - declined.size}`,
    );
    this.collaborationManager.updateSessionStatus(acConfig.id, CollaborationStatus.CANCELLED);
    this.eventEmitter.emit(EventType.COLLABORATION_MESSAGE, {
      type: 'ac-cancelled',
      collaborationId: acConfig.id,
      agentId: this.agentId,
      outcome,
      reason,
      acceptedBy: [...accepted.keys()],
      declinedBy: [...declined.keys()],
    });
    this.setStatus(AgentStatus.IDLE);
  }

  /**
   * BUG-07: cancel every handshake currently parked in
   * awaitHandshakeThenExecute with an explicit reason. Called by the runtime
   * BEFORE its event bus / trajectory recorder go away (EngineRuntime.stop,
   * world-session rebuildLiveSession) so each pending handshake lands on the
   * trajectory as ac-cancelled with outcome 'aborted' — the handshake's
   * death is never implicit anymore. Idempotent (a concluded handshake
   * deregisters its abort handle); returns the number cancelled.
   */
  cancelPendingHandshakes(reason: string): number {
    const aborts = [...this.pendingHandshakeAborts.values()];
    for (const abort of aborts) {
      try {
        abort(reason);
      } catch (error) {
        logger.error(`[CollaborationCoordinator:${this.agentId}] Pending-handshake abort failed:`, error);
      }
    }
    return aborts.length;
  }

  /**
   * Evaluate a partner's counter-proposal (Wave-4a): LLM-first when a client
   * is configured; otherwise a conservative rule rejection (Fix-12 style —
   * no rubber-stamping without semantic judgment). Any LLM failure also
   * degrades to the rule rejection. The source label lands on the
   * counter-response and the trajectory.
   */
  private async evaluateCounterProposal(
    acConfig: ACCollaborationConfig,
    responder: string,
    counterProposal: { modifications?: string[]; reasoning?: string } | undefined,
    reason?: string,
  ): Promise<{ accept: boolean; reason: string; source: 'llm' | 'rule' }> {
    const ruleRejection = (why: string): { accept: boolean; reason: string; source: 'llm' | 'rule' } => ({
      accept: false,
      reason: `Counter-proposal from ${responder} rejected by rule: ${why}`,
      source: 'rule',
    });

    if (!this.llmClient) {
      return ruleRejection('no LLM configured to evaluate the modified conditions');
    }

    const modifications = counterProposal?.modifications ?? [];
    // S1: counter-proposal text (and the goal description it may echo) is
    // partner/event-derived world data — ride the canonical sanitizer.
    const prompt = `COUNTER-PROPOSAL EVALUATION

You initiated the collaboration "${acConfig.name}" (${untrustedBlock('collaboration-description', acConfig.description)}).
Partner ${responder} did not accept as-is but proposes modified conditions:
${untrustedBlock('counter-modifications', modifications.length > 0 ? modifications.map(m => `- ${m}`).join('\n') : '- (no explicit modifications listed)', { collapseNewlines: false })}
Partner reasoning: ${untrustedBlock('counter-reasoning', counterProposal?.reasoning ?? reason ?? 'none')}

Decide whether the collaboration is still worth executing UNDER THE COUNTER'S
conditions. Respond in JSON:
{ "accept": true|false, "reason": "short explanation" }`;

    try {
      const response = await this.llmClient.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
      });
      const content = response.content ?? '';
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      const parsed = firstBrace !== -1 && lastBrace > firstBrace
        ? JSON.parse(content.substring(firstBrace, lastBrace + 1)) as { accept?: unknown; reason?: unknown }
        : {};
      return {
        accept: parsed.accept === true,
        reason: typeof parsed.reason === 'string' && parsed.reason.length > 0
          ? parsed.reason
          : (parsed.accept === true ? 'counter conditions accepted' : 'counter conditions rejected'),
        source: 'llm',
      };
    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] Counter-proposal LLM evaluation failed:`, error);
      return ruleRejection(`LLM evaluation unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /**
   * Answer a partner's counter-proposal on the bus (Wave-4a). The responder's
   * CollaborationProposalHandler listens for 'counter-response' addressed to
   * it: on accept it joins the collaboration and publishes the regular
   * join-response accept (closing its handshake slot under the counter's
   * conditions); on reject it stands down — we already count it declined.
   * The original proposal is echoed back so the responder can join without
   * having kept state.
   */
  private publishCounterResponse(
    acConfig: ACCollaborationConfig,
    responder: string,
    counterPayload: { originalProposal?: unknown; counterProposal?: unknown },
    answer: { accept: boolean; reason: string; source: 'llm' | 'rule' },
  ): void {
    logger.info(
      `[CollaborationCoordinator:${this.agentId}] ${answer.accept ? 'ACCEPTING' : 'REJECTING'} counter from ${responder} ` +
      `for AC ${acConfig.id} (${answer.source}): ${answer.reason}`,
    );
    this.eventEmitter.emit(EventType.COLLABORATION_MESSAGE, {
      type: 'counter-response',
      acDecision: answer.accept ? 'accept' : 'reject',
      agentId: this.agentId,
      targetAgentId: responder,
      collaborationId: acConfig.id,
      reason: answer.reason,
      evaluationSource: answer.source,
      proposal: counterPayload.originalProposal,
      counterProposal: counterPayload.counterProposal,
    });
  }

  /**
   * Execute collaboration goals using ACExecutor.
   * Extracted from handleAutonomousACInitiation (Fix-8) so both the legacy
   * immediate path and the post-handshake path share it.
   */
  private async executeAC(
    acConfig: ACCollaborationConfig,
    participantAgentIds: string[],
    execOptions?: ACExecutionOptions
  ): Promise<void> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Now executing AC goals using ACExecutor...`);
    const executor = new ACExecutor();

    // Convert GoalFormulationEngine.ACCollaborationConfig to ACExecutor.ACCollaborationConfig
    // Note: Using type assertion due to minor interface differences (underscore vs hyphen naming)
    const executorConfig = {
      id: acConfig.id,
      name: acConfig.name,
      description: acConfig.description,
      environment: this.environment,
      initiatorId: this.agentId,
      participantAgentIds,
      collaborationManager: this.collaborationManager,
      goals: acConfig.goals,
      maxDuration: acConfig.maxDuration,
      timeout: acConfig.timeout,
      // R102: the trigger event id threads into every executed device
      // command (decision attribution for the trajectory receipts).
      ...(acConfig.triggerEventId !== undefined ? { triggerEventId: acConfig.triggerEventId } : {}),
    } as unknown as ExecutorCollaborationConfig;

    await executor.executeCollaboration(executorConfig, execOptions);
  }

  /**
   * Withdraw from an active collaboration
   * Agent autonomously decides to leave an AC
   * Extracted from CognitiveAgent.withdrawFromCollaboration() (lines 5778-5839)
   */
  async withdrawFromCollaboration(
    collaborationId: string,
    reason: string,
    gracefulPeriod?: number
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Requesting withdrawal from AC ${collaborationId}`);
    logger.info(`  Reason: ${reason}`);

    try {
      // Create withdrawal request
      const request = this.collaborationManager.requestWithdrawal({
        collaborationId,
        agentId: this.agentId,
        agentName: this.agentName,
        reason,
        gracefulPeriod,
      });

      logger.info(`[CollaborationCoordinator:${this.agentId}] Withdrawal request created: ${request.id}`);
      logger.info(`  Graceful period: ${request.gracefulPeriod}ms`);

      // If graceful period is set, schedule the actual withdrawal
      if (request.gracefulPeriod > 0) {
        setTimeout(async () => {
          logger.info(`[CollaborationCoordinator:${this.agentId}] Graceful period ended, processing withdrawal...`);
          await this.collaborationManager.processWithdrawal(request.id);
        }, request.gracefulPeriod);
      } else {
        // Immediate withdrawal
        await this.collaborationManager.processWithdrawal(request.id);
      }

      return {
        success: true,
      };
    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] Withdrawal failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Propose dissolution of a collaboration
   * Extracted from CognitiveAgent.proposeDissolution() (lines 5847-5917)
   */
  async proposeDissolution(
    collaborationId: string,
    reason: string,
    voteThreshold?: number
  ): Promise<{
    success: boolean;
    proposalId?: string;
    error?: string;
  }> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Proposing dissolution of ${collaborationId}`);
    logger.info(`  Reason: ${reason}`);

    // Check if agent is in this collaboration
    const sessions = this.collaborationManager.getActiveSessions(this.agentId);
    const session = sessions.find(s => s.id === collaborationId);

    if (!session) {
      return {
        success: false,
        error: `Agent ${this.agentId} is not in collaboration ${collaborationId}`,
      };
    }

    try {
      const proposal = this.collaborationManager.proposeDissolution({
        collaborationId,
        proposerId: this.agentId,
        proposerName: this.agentName,
        reason,
        voteThreshold,
      });

      if (!proposal) {
        return {
          success: false,
          error: 'Failed to create dissolution proposal',
        };
      }

      logger.info(`[CollaborationCoordinator:${this.agentId}] Dissolution proposal created: ${proposal.id}`);

      return {
        success: true,
        proposalId: proposal.id,
      };
    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] Dissolution proposal failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Vote on dissolution proposal
   * Extracted from CognitiveAgent.voteOnDissolution() (lines 5921-5978)
   */
  async voteOnDissolution(
    proposalId: string,
    vote: boolean
  ): Promise<{
    success: boolean;
    result?: 'approved' | 'rejected' | 'pending';
    error?: string;
  }> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Voting on dissolution ${proposalId}: ${vote ? 'YES' : 'NO'}`);

    try {
      const result = this.collaborationManager.voteOnDissolution({
        proposalId,
        agentId: this.agentId,
        vote,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }

      logger.info(`[CollaborationCoordinator:${this.agentId}] Vote recorded. Current result: ${result.result}`);

      return {
        success: true,
        result: result.result,
      };
    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] Vote failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get active collaborations
   * Extracted from CognitiveAgent.getActiveCollaborations() (lines 5963-5978)
   */
  getActiveCollaborations(): any[] {
    const sessions = this.collaborationManager.getActiveSessions(this.agentId);
    logger.info(`[CollaborationCoordinator:${this.agentId}] Active collaborations: ${sessions.length}`);
    return sessions;
  }

  /**
   * Extract resource IDs from AC config
   */
  private extractResourceIds(resources: any[]): string[] {
    const resourceIds: string[] = [];

    for (const r of resources) {
      if (typeof r === 'string') {
        resourceIds.push(r);
      } else if (r && typeof r === 'object' && 'id' in r) {
        resourceIds.push((r as { id: string }).id);
      }
    }

    return resourceIds;
  }

  /**
   * Map AC priority to CollaborationManager priority
   */
  private mapPriority(priority: string): CollaborationPriority {
    if (priority === 'urgent') return CollaborationPriority.CRITICAL;
    if (priority === 'high') return CollaborationPriority.HIGH;
    return CollaborationPriority.NORMAL;
  }
}
