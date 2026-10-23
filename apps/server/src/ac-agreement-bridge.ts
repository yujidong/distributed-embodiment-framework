/**
 * AC ephemeral agreement bridge (Fix-11 Phase 2,
 * service-consumption-design.md §3.1 implicit path)
 *
 * The AC handshake happens inside the core runtime (EngineRuntime /
 * CollaborationCoordinator); the agreement store lives in the server. The
 * minimal-intrusion wiring mirrors the reputation persistence (P4-1): the
 * server subscribes to the runtime's event bus — no core → server import,
 * no core change at all.
 *
 * - `ac-proposal` messages are remembered (initiator + requested
 *   capabilities + the AC's triggering event type when known) so an accept
 *   can be attributed to a consumer and a service.
 * - Every `join-response` accept lands an EPHEMERAL agreement
 *   (`source='ac'`, born `active`): consumer = the initiator agent's owner,
 *   provider = the accepting agent's BEST-MATCHING offer (P5): candidates
 *   are the responder's whole service face (derived + published + aggregate
 *   rows), scored by |requiredCapabilities ∩ the offer's executable
 *   surface| (semantic type + interface action names — an aggregate row's
 *   interface already encodes its rule's actuates); ties break by
 *   semanticType lexicographic order (deterministic). No intersection (or a
 *   proposal that named no capabilities) → the ephemeral agreement is
 *   SKIPPED with a log line naming the collaboration — pre-P5 the fallback
 *   ("first offer") metered consumptions against services the collaboration
 *   never asked for. Wave-4a: the agreement's terms carry a structured
 *   `trigger` backfilled from the collaboration (eventType + requested
 *   capabilities; BUG-02: + the event's zoneId, which the ac-proposal
 *   payload carried all along) — contract data only, nothing executes on it
 *   automatically. BUG-02: with the event zone known, a capability-tied
 *   offer BACKED in that zone wins the metering pick; when only cross-zone
 *   candidates exist the agreement still lands (no hard gate on the
 *   ephemeral path) but the mismatch is annotated in terms.notes + a warn.
 * - `COLLABORATION_COMPLETED` terminates every active ephemeral agreement of
 *   the collaboration and appends ONE UsageRecord each (`kind='ac'`,
 *   quantity=1, unit='collaboration', outcome from the same
 *   `classifyCollaborationOutcome` the reputation tracker uses).
 * - `ac-cancelled` (all-rejected or handshake timeout) terminates the
 *   ephemeral agreements WITHOUT a usage row (Fix-21): a cancelled
 *   collaboration never executed — the coordinator only runs the executor
 *   after a completed handshake — so there is no consumption to meter.
 *   Previously this metered `outcome='failure'`, which mis-recorded a
 *   non-execution as a failed consumption; in the partial-accept-timeout
 *   case it marked a provider who accepted in good faith (and may have
 *   auto-executed its part) as failed.
 *
 * R6-B-F02 multi-hop nesting/cascade: a provider's fulfillment gate
 * (core proposal/fulfillment-gate.ts) may secure a hop-2 commitment BEFORE
 * signing hop-1 — the hop-2 ac-proposal carries `parentCollaborationId`.
 * Hop-2 accounts INDEPENDENTLY: its own ac-proposal/join-response pair lands
 * its own ephemeral agreement (consumer = the delegating provider's owner),
 * metering the downstream consumption apart from hop-1's. Termination
 * CASCADES from the parent, because hop-2 never runs its own executor (it is
 * a commitment the parent's fulfillment rides on): the parent's
 * COLLABORATION_COMPLETED terminates the child's agreements WITH one usage
 * row each (the parent outcome inherited — the child's commitment WAS
 * consumed by the parent's fulfillment); the parent's ac-cancelled
 * terminates the child WITHOUT a usage row (the Fix-21 rule applied
 * recursively — a chain that never executed meters nothing).
 *
 * Reputation is deliberately NOT scored here: the runtime's own tracker
 * already scores the same COLLABORATION_COMPLETED event (Fix-12) and the
 * registry persists it — recording again from the usage row would be double
 * accounting.
 *
 * Assembly: server.ts constructs one bridge when `AC_EPHEMERAL_AGREEMENTS`
 * is on (default true) and hands it to the SimulationRegistry, which calls
 * `attach` for every environment-backed simulation. Legacy scenario sims
 * (no environmentId) have no world-layer services to meter against, so the
 * bridge never attaches to them.
 */

import {
  capabilityMatches,
  classifyCollaborationOutcome,
  EventType,
  type EngineRuntime,
  type SystemEvent,
} from '@active-collaboration/core';
import { createLogger } from '@active-collaboration/shared';

import type { AgreementStore, AgreementTrigger, UsageOutcome } from './db/agreement-store.js';
import type { EnvironmentStore } from './db/environment-store.js';
import type { NotificationStore } from './db/notification-store.js';
import { NOTIFICATION_KINDS, notify } from './notifications.js';
import type { ServiceInstanceRow, ServiceStore } from './db/service-store.js';

const logger = createLogger('AcAgreementBridge');

export interface AcAgreementBridgeDeps {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  agreementStore: AgreementStore;
  /**
   * Fix-16: the initiator's owner learns the handshake answer
   * (accepted/rejected) without watching the sim. Optional so the bridge
   * stays usable without the inbox (tests, embedded runs).
   */
  notificationStore?: NotificationStore;
}

interface RememberedProposal {
  initiatorAgentId: string | null;
  requiredCapabilities: string[];
  /**
   * Wave-4a: the environment event type that triggered the AC, when the
   * initiator knew it — backfilled into the ephemeral agreement's
   * terms.trigger so ac-sourced contracts carry a structured trigger.
   */
  triggerEventType: string | null;
  /**
   * BUG-02: the triggering event's ZONE (the ac-proposal payload carried it
   * since R6-C-F03, the server had no reader) — backfilled into
   * terms.trigger.zoneId and used as the same-zone preference when the
   * responder's face holds offers backed in several zones.
   */
  triggerZoneId: string | null;
  /**
   * R6-B-F02: the parent collaboration id when this proposal is a hop-2
   * fulfillment delegation (core fulfillment gate). Drives the cascade
   * termination on the parent's completion/cancel.
   */
  parentCollaborationId: string | null;
}

/** R6-B-F02: the hop-2 collaboration ids a parent proposal has spawned. */
function childrenOf(
  proposals: Map<string, RememberedProposal>,
  parentCollaborationId: string,
): string[] {
  const children: string[] = [];
  for (const [collaborationId, proposal] of proposals) {
    if (proposal.parentCollaborationId === parentCollaborationId) {
      children.push(collaborationId);
    }
  }
  return children;
}

export class AcAgreementBridge {
  constructor(private readonly deps: AcAgreementBridgeDeps) {}

  /** Subscribe an environment-backed runtime; subscriptions die with stop(). */
  attach(envId: string, runtime: EngineRuntime): void {
    const proposals = new Map<string, RememberedProposal>();

    runtime.subscribe(event => this.onCollaborationMessage(envId, proposals, event), EventType.COLLABORATION_MESSAGE);
    runtime.subscribe(event => this.onCollaborationCompleted(proposals, event), EventType.COLLABORATION_COMPLETED);
  }

  private onCollaborationMessage(
    envId: string,
    proposals: Map<string, RememberedProposal>,
    event: SystemEvent,
  ): void {
    const payload = event.payload as {
      type?: unknown;
      acDecision?: unknown;
      agentId?: unknown;
      collaborationId?: unknown;
      initiatorId?: unknown;
      requiredCapabilities?: unknown;
      triggerEventType?: unknown;
      triggerZoneId?: unknown;
      parentCollaborationId?: unknown;
    } | undefined;
    if (!payload || typeof payload.collaborationId !== 'string') return;
    const collaborationId = payload.collaborationId;

    if (payload.type === 'ac-proposal') {
      proposals.set(collaborationId, {
        initiatorAgentId: typeof payload.initiatorId === 'string' ? payload.initiatorId : null,
        requiredCapabilities: Array.isArray(payload.requiredCapabilities)
          ? payload.requiredCapabilities.filter((c): c is string => typeof c === 'string' && c.length > 0)
          : [],
        triggerEventType: typeof payload.triggerEventType === 'string' ? payload.triggerEventType : null,
        triggerZoneId: typeof payload.triggerZoneId === 'string' ? payload.triggerZoneId : null,
        parentCollaborationId: typeof payload.parentCollaborationId === 'string' ? payload.parentCollaborationId : null,
      });
      return;
    }

    if (payload.type === 'join-response' && payload.acDecision === 'accept') {
      const responderId = typeof payload.agentId === 'string' ? payload.agentId
        : typeof event.source === 'string' ? event.source
          : null;
      if (responderId !== null) {
        // FEAT-04 (pm-dev-backlog): the accept notification tells the truth
        // about the metering outcome — an accept whose responder has NO
        // offer matching the requested capabilities lands no agreement
        // (the P5 honest skip), and the initiator's owner hears
        // 'accepted-unmetered' instead of a bare "accepted" that the empty
        // ledger would contradict.
        const landOutcome = this.landEphemeralAgreement(envId, collaborationId, proposals.get(collaborationId), responderId);
        this.notifyHandshakeAnswer(
          envId, collaborationId, proposals.get(collaborationId), responderId,
          landOutcome === 'unmetered' ? 'accepted-unmetered' : 'accept',
        );
      }
      return;
    }

    if (payload.type === 'join-response' && payload.acDecision === 'reject') {
      const responderId = typeof payload.agentId === 'string' ? payload.agentId
        : typeof event.source === 'string' ? event.source
          : null;
      if (responderId !== null) {
        this.notifyHandshakeAnswer(envId, collaborationId, proposals.get(collaborationId), responderId, 'reject');
      }
      return;
    }

    if (payload.type === 'ac-cancelled') {
      // All-rejected or handshake timeout: the collaboration never executed
      // (the coordinator executes only after a completed handshake), so
      // there is no consumption to meter — terminate without a usage row.
      this.terminateWithoutUsage(collaborationId);
      // R6-B-F02 cascade: a cancelled parent never consumed its hop-2
      // commitments either — terminate child agreements without usage rows.
      for (const childId of childrenOf(proposals, collaborationId)) {
        this.terminateWithoutUsage(childId);
        proposals.delete(childId);
      }
      proposals.delete(collaborationId);
    }
  }

  private onCollaborationCompleted(
    proposals: Map<string, RememberedProposal>,
    event: SystemEvent,
  ): void {
    const payload = event.payload as {
      collaborationId?: unknown;
      success?: boolean;
      results?: { goals?: Array<{ achieved?: boolean }> };
      goals?: Array<{ achieved?: boolean }> | number;
    } | undefined;
    if (!payload || typeof payload.collaborationId !== 'string') return;
    const outcome = classifyCollaborationOutcome(payload);
    this.closeCollaboration(payload.collaborationId, outcome);
    // R6-B-F02 cascade: hop-2 agreements (fulfillment delegations of THIS
    // collaboration) are terminated with one usage row each, inheriting the
    // parent's outcome — hop-2 has no executor run of its own; its
    // commitment was consumed by the parent's fulfillment.
    for (const childId of childrenOf(proposals, payload.collaborationId)) {
      this.closeCollaboration(childId, outcome);
      proposals.delete(childId);
    }
    proposals.delete(payload.collaborationId);
  }

  /**
   * Land one ephemeral agreement for an accepting responder. Idempotent per
   * (collaboration, responder) — a duplicate accept never double-meters.
   *
   * FEAT-04: the outcome is reported so the caller's handshake notification
   * can tell "accepted + metered" apart from "accepted but unmetered" — and
   * the previously SILENT aborts (provider/consumer agent gone) leave a
   * warn, so a handshake that lands nothing is never log-free.
   */
  private landEphemeralAgreement(
    envId: string,
    collaborationId: string,
    proposal: RememberedProposal | undefined,
    responderId: string,
  ): 'landed' | 'unmetered' | 'duplicate' | 'aborted' {
    const { envStore, serviceStore, agreementStore } = this.deps;
    const existing = agreementStore.activeAgreementsOfCollaboration(collaborationId);
    if (existing.some(row => row.provider_agent_id === responderId)) return 'duplicate';

    const providerAgent = envStore.getAgent(responderId);
    if (!providerAgent || providerAgent.env_id !== envId) {
      logger.warn(
        `Skipping ephemeral agreement for collaboration ${collaborationId}: ` +
        `responder agent ${responderId} not found in env ${envId} (removed mid-handshake?)`,
      );
      return 'aborted';
    }
    const consumerAgent = proposal?.initiatorAgentId != null
      ? envStore.getAgent(proposal.initiatorAgentId)
      : undefined;
    if (!consumerAgent || consumerAgent.env_id !== envId) {
      logger.warn(
        `Skipping ephemeral agreement for collaboration ${collaborationId}: ` +
        `initiator agent ${proposal?.initiatorAgentId ?? '(unknown — no remembered ac-proposal)'} ` +
        `not found in env ${envId} (removed mid-handshake?)`,
      );
      return 'aborted';
    }

    // P5: the metered offer is the responder's best-matching service (see
    // selectMeteredService). No match → skip: nothing honest to meter
    // against (pre-P5 fell back to the agent's first offer).
    const services = serviceStore.servicesOfAgent(responderId);
    const requested = proposal?.requiredCapabilities ?? [];
    // BUG-02: when the event's zone is known, prefer an offer BACKED in that
    // zone (a cross-zone fan cannot ventilate the event's dorm). Zones come
    // from the backing devices: the derived row's pinned source device, else
    // the provider agent's bound devices. Zone-less backing is unjudgeable
    // and stays neutral — signing-gates' ungated zone-less discipline.
    const preferredZoneId = proposal?.triggerZoneId ?? undefined;
    const zonesCache = new Map<string, Set<string>>();
    const zonesOf = (row: ServiceInstanceRow): Set<string> => {
      const cached = zonesCache.get(row.id);
      if (cached !== undefined) return cached;
      const zones = new Set<string>();
      const push = (deviceId: string): void => {
        const zoneId = envStore.getDevice(deviceId)?.zone_id;
        if (typeof zoneId === 'string' && zoneId.length > 0) zones.add(zoneId);
      };
      if (row.source_device_id !== null && row.source_device_id !== undefined) {
        push(row.source_device_id);
      } else {
        for (const deviceId of parseBoundDeviceIds(providerAgent)) push(deviceId);
      }
      zonesCache.set(row.id, zones);
      return zones;
    };
    const service = selectMeteredService(
      services,
      requested,
      preferredZoneId !== undefined
        ? { zoneId: preferredZoneId, inZone: row => zonesOf(row).has(preferredZoneId) }
        : undefined,
    );
    if (!service) {
      logger.warn(
        `Skipping ephemeral agreement for collaboration ${collaborationId}: ` +
        `responder ${responderId} has no offer matching required capabilities ` +
        `[${requested.join(', ')}] (${services.length} offers on the face)`,
      );
      return 'unmetered';
    }

    // Wave-4a (小林 R8 F-14): backfill the structured trigger from the
    // collaboration that spawned this contract — the AC's triggering event
    // type plus the capabilities it requested. Contract data only: nothing
    // executes on the trigger automatically (post-Wave-4 work).
    // BUG-02: the event's zone rides too (the payload carried it all along).
    const trigger: AgreementTrigger = {};
    if (proposal?.triggerEventType != null) trigger.eventType = proposal.triggerEventType;
    if (requested.length > 0) trigger.parameter = requested.join(',');
    if (proposal?.triggerZoneId != null) trigger.zoneId = proposal.triggerZoneId;

    // BUG-02: a cross-zone pick is not refused (no hard gate on the
    // ephemeral path) but it is VISIBLE — a terms.notes annotation plus a
    // warn, so the contract admits its backing sits outside the event zone.
    let notes: string | undefined;
    if (preferredZoneId !== undefined) {
      const backingZones = zonesOf(service);
      if (backingZones.size > 0 && !backingZones.has(preferredZoneId)) {
        const backing = [...backingZones].join(', ');
        notes =
          `cross-zone backing: the event zone is "${preferredZoneId}" but the metered offer ` +
          `"${service.name}" is backed by zone(s) ${backing} — no in-zone candidate on the responder's face`;
        logger.warn(
          `Collaboration ${collaborationId}: metering cross-zone — event zone "${preferredZoneId}", ` +
          `offer "${service.name}" backed by zone(s) ${backing} (no in-zone candidate)`,
        );
      }
    }

    agreementStore.createAgreement({
      envId,
      serviceId: service.id,
      consumerAgentId: consumerAgent.id,
      consumerOwnerId: consumerAgent.owner_id,
      providerAgentId: providerAgent.id,
      providerOwnerId: providerAgent.owner_id,
      terms: {
        ...(Object.keys(trigger).length > 0 ? { trigger } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
      source: 'ac',
      status: 'active',
      collaborationId,
    });
    return 'landed';
  }

  /**
   * Fix-16 doorbell: the initiator's owner learns the responder's answer.
   * Noise control: self-collaboration (both agents owned by the same user)
   * is dropped by notify(); without a remembered ac-proposal the initiator
   * is unknown, so nothing can be sent.
   *
   * FEAT-04: 'accepted-unmetered' is the honest accept form — the responder
   * accepted but had NO offer matching the requested capabilities, so the
   * bridge landed no ephemeral agreement (the P5 skip). The notification
   * says so instead of letting the empty ledger contradict a "accepted"
   * doorbell.
   */
  private notifyHandshakeAnswer(
    envId: string,
    collaborationId: string,
    proposal: RememberedProposal | undefined,
    responderId: string,
    decision: 'accept' | 'reject' | 'accepted-unmetered',
  ): void {
    const { envStore, notificationStore } = this.deps;
    if (!notificationStore) return;
    if (proposal?.initiatorAgentId == null) {
      // FEAT-04: was a silent return — a handshake answer we cannot
      // attribute (bridge attached after the proposal, or the runtime
      // never emitted one) now leaves a clue.
      logger.warn(
        `Collaboration ${collaborationId}: cannot notify the handshake answer ` +
        `(${decision}) — no remembered ac-proposal names the initiator`,
      );
      return;
    }
    const initiator = envStore.getAgent(proposal.initiatorAgentId);
    const responder = envStore.getAgent(responderId);
    if (!initiator || !responder) {
      logger.warn(
        `Collaboration ${collaborationId}: cannot notify the handshake answer ` +
        `(${decision}) — initiator ${proposal.initiatorAgentId} or responder ${responderId} ` +
        'is gone from the env (removed mid-handshake?)',
      );
      return;
    }
    notify(notificationStore, {
      recipientId: initiator.owner_id,
      actorId: responder.owner_id,
      envId,
      kind: decision === 'reject'
        ? NOTIFICATION_KINDS.collaborationRejected
        : NOTIFICATION_KINDS.collaborationAccepted,
      title: decision === 'reject'
        ? '你的协作请求被拒绝'
        : decision === 'accepted-unmetered'
          ? '你的协作请求被接受（未落合约：应答方无匹配服务报价）'
          : '你的协作请求被接受',
      body: {
        collaborationId,
        initiatorAgentId: initiator.id,
        responderAgentId: responder.id,
        decision,
        ...(decision === 'accepted-unmetered'
          ? { note: '未落合约：应答方无匹配服务报价（握手被接受，但无服务可计量，台账为空属预期）' }
          : {}),
      },
      refId: collaborationId,
    });
  }

  /**
   * R78 病灶 C — termination notification funnel: EVERY path that terminates
   * an agreement tells BOTH parties (a collaboration completing silently
   * killed 17 agreements in the R77 world and the consumers only found out
   * on their next invoke). Manual terminate already notifies the other
   * party (Fix-16); these collaboration-driven paths notify both.
   *
   * T85 (R8, u4-P2-6): the title branches on the collaboration OUTCOME, not
   * just the cause — a partial collaboration is not "已完成" (the outcome
   * wording follows the one `terminatedAgreementOutcome` 口径: success /
   * partial / failure), and the body carries the outcome field.
   */
  private notifyAgreementTerminated(
    agreement: { id: string; env_id: string; service_id: string | null; consumer_owner_id: string; provider_owner_id: string },
    cause: 'ac-completed' | 'ac-cancelled',
    outcome?: UsageOutcome,
  ): void {
    const { notificationStore } = this.deps;
    if (!notificationStore) return;
    const title =
      cause === 'ac-cancelled'
        ? '协作未成立，其临时合约已终止'
        : outcome === 'partial'
          ? '协作部分达成，其临时合约已终止'
          : outcome === 'failure'
            ? '协作未达成，其临时合约已终止'
            : '协作已完成，其临时合约已终止';
    for (const recipientId of [agreement.consumer_owner_id, agreement.provider_owner_id]) {
      notify(notificationStore, {
        recipientId,
        actorId: recipientId, // system-driven transition (no human actor)
        allowSelf: true, // notify() drops self-rows without this — the whole point is the party learns
        envId: agreement.env_id,
        kind: NOTIFICATION_KINDS.agreementTerminated,
        title,
        body: {
          agreementId: agreement.id,
          serviceId: agreement.service_id,
          status: 'terminated',
          cause,
          ...(outcome !== undefined ? { outcome } : {}),
        },
        refId: agreement.id,
      });
    }
  }

  /** Terminate the collaboration's ephemeral agreements + meter one usage row each. */
  private closeCollaboration(collaborationId: string, outcome: UsageOutcome): void {
    const { agreementStore } = this.deps;
    for (const agreement of agreementStore.activeAgreementsOfCollaboration(collaborationId)) {
      agreementStore.appendUsage({
        agreementId: agreement.id,
        envId: agreement.env_id,
        consumerAgentId: agreement.consumer_agent_id,
        providerAgentId: agreement.provider_agent_id,
        kind: 'ac',
        quantity: 1,
        unit: 'collaboration',
        outcome,
        // v58: the origin dimension rides the metering (snapshot of the
        // hit offer's service_instances.origin; null when already gone).
        origin: (agreement.service_id !== null ? this.deps.serviceStore.getService(agreement.service_id) : undefined)?.origin ?? null,
        startedAt: agreement.created_at,
        endedAt: new Date().toISOString(),
      });
      // R102: the auto-termination writes its reason into statusReason —
      // the party reads WHY the platform ended the agreement in agreement
      // get (auto decisions need explainability most).
      agreementStore.setStatus(agreement.id, 'terminated', 'ac-completed');
      // T85: the metered outcome rides the notification — partial/failure
      // must not announce "已完成" (same 口径 the usage row records).
      this.notifyAgreementTerminated(agreement, 'ac-completed', outcome);
    }
  }

  /**
   * Fix-21: terminate the collaboration's ephemeral agreements WITHOUT
   * metering — used for ac-cancelled, where the collaboration never executed
   * and therefore nothing was consumed.
   */
  private terminateWithoutUsage(collaborationId: string): void {
    const { agreementStore } = this.deps;
    for (const agreement of agreementStore.activeAgreementsOfCollaboration(collaborationId)) {
      // R102: same reason channel for the cancelled collaboration.
      agreementStore.setStatus(agreement.id, 'terminated', 'ac-cancelled');
      this.notifyAgreementTerminated(agreement, 'ac-cancelled');
    }
  }
}

/**
 * P5: an offer's executable surface for capability matching — its semantic
 * is generated from the rule's requires ∪ actuates command surface
 * (service-store aggregateInterface), so the actuation backing is matched
 * without re-deriving the rule table here. Malformed/missing interface_json
 * degrades to the semantic type alone.
 */
function serviceExecutableSurface(row: ServiceInstanceRow): string[] {
  const tokens = [row.semantic_type];
  try {
    const iface = JSON.parse(row.interface_json ?? '{}') as { actions?: Array<{ name?: unknown }> };
    if (Array.isArray(iface.actions)) {
      for (const action of iface.actions) {
        if (typeof action?.name === 'string' && action.name.length > 0) tokens.push(action.name);
      }
    }
  } catch {
    // malformed interface_json → semantic type only
  }
  return tokens;
}

/**
 * P5: pick the offer a collaboration's accept should be metered against.
 * Two-tier scoring against the offer's executable surface (semantic type +
 * interface action names): first the number of required capabilities with an
 * EXACT surface token, then the number matched fuzzily under the shared
 * matcher (bidirectional substring + synonym groups) — a row whose surface
 * literally names both requested capabilities outranks one that only reaches
 * the second via synonym fuzz. Remaining ties prefer an offer whose
 * semantic_type IS a requested capability (T-043 collapsed switching rows
 * share the turn-on/turn-off command surface — the row named by the request
 * is the honest meter target). BUG-02: with a zonePreference, a still-tied
 * offer BACKED in the event's zone wins over a cross-zone twin (the dorm-3
 * incident: building-6's fan metered a building-3 event) — inserted after
 * the capability/named criteria so relevance still outranks locality. Final
 * ties break by semanticType lexicographic (then id) so the choice is
 * deterministic. Returns undefined when nothing intersects — the caller
 * skips the agreement and logs the clue.
 */
export function selectMeteredService(
  services: ServiceInstanceRow[],
  requiredCapabilities: readonly string[],
  zonePreference?: { zoneId: string; inZone: (row: ServiceInstanceRow) => boolean },
): ServiceInstanceRow | undefined {
  let best:
    | { row: ServiceInstanceRow; exact: number; fuzzy: number; named: boolean; inZone: boolean }
    | undefined;
  for (const row of services) {
    const surface = serviceExecutableSurface(row);
    const exact = requiredCapabilities.filter(required =>
      surface.some(token => token === required),
    ).length;
    const fuzzy = requiredCapabilities.filter(required =>
      surface.some(token => capabilityMatches(token, required)),
    ).length;
    if (fuzzy === 0) continue;
    const named = requiredCapabilities.some(required => required === row.semantic_type);
    const inZone = zonePreference?.inZone(row) ?? false;
    const better =
      best === undefined ||
      exact > best.exact ||
      (exact === best.exact &&
        (fuzzy > best.fuzzy ||
          (fuzzy === best.fuzzy &&
            ((named && !best.named) ||
              (named === best.named &&
                ((inZone && !best.inZone) ||
                  (inZone === best.inZone &&
                    (row.semantic_type < best.row.semantic_type ||
                      (row.semantic_type === best.row.semantic_type && row.id < best.row.id)))))))));
    if (better) best = { row, exact, fuzzy, named, inZone };
  }
  return best?.row;
}

/** Defensive parse of an agent row's bound_device_ids_json (malformed → none). */
function parseBoundDeviceIds(agent: { bound_device_ids_json?: unknown }): string[] {
  try {
    const raw = typeof agent.bound_device_ids_json === 'string' ? agent.bound_device_ids_json : '[]';
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
  } catch {
    return [];
  }
}
