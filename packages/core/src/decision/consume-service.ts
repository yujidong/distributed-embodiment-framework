/**
 * consume_service — locked-target service consumption (R6-E-F07).
 *
 * The `consume_service` decision action (decision-v1 actionPlan.primary.action)
 * lets an agent consume ONE service it already discovered in the catalog —
 * unlike initiate_ac (open matchmaking: broadcast by capability, negotiate,
 * pick partners), consume_service locks the collaboration request to the
 * target service's provider. This module is the deterministic core of that
 * lane:
 *
 *   - `resolveLockedService` maps the model-named target (serviceId, else the
 *     exact serviceName from the SHORTLIST/CATALOG prompt lines) onto a live
 *     service registration — never inventing a provider, never matching the
 *     initiator's OWN services (self-consumption is not a collaboration).
 *   - `lockedServiceSelection` builds the single-candidate PartnerSelectionResult
 *     the AC initiation pipeline (DualTriggerACManager.initiateAC) consumes in
 *     place of the open findPartners negotiation. The request face is LOCKED:
 *     the proposal is typed 'service-invocation', its capabilities are the
 *     target service's own capability surface, and the structured service term
 *     carries the serviceId so the responder, the trajectory and the server's
 *     ac-agreement-bridge all see WHICH service is being consumed (not just a
 *     capability cloud).
 *
 * Downstream everything rides the EXISTING AC handshake lane unchanged:
 * CollaborationCoordinator emits the ac-proposal, the provider's
 * CollaborationProposalHandler evaluates it (its catalog match is exact, so
 * both the LLM lane and the capability fallback see a full-surface match),
 * the join-response accept closes the handshake, and ACExecutor fulfillment +
 * the ephemeral-agreement bridge work as for any ac-proposal pair.
 *
 * Pure/deterministic except the one registry read (no IO, no clock, no LLM).
 */

import { v4 as uuidv4 } from 'uuid';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { CognitiveServiceTarget } from './cognitive-decision.js';
import type {
  CollaborationProposal,
  PartnerSelectionResult,
} from './PartnerSelectionNegotiator.js';

/** A consume_service target resolved against the live service registry. */
export interface ResolvedServiceTarget {
  serviceId: string;
  serviceName: string;
  providerAgentId: string;
  providerAgentName: string;
  /** The service's own capability surface — the locked request face. */
  capabilities: string[];
  semanticType?: string;
  zoneId?: string;
}

/**
 * Resolve the model-named consumption target against the environment's
 * service registry. Exact serviceId match wins; otherwise an EXACT name
 * match (the prompt's SHORTLIST/CATALOG lines render service names). Own
 * services are never eligible — consuming your own service is not a
 * collaboration. Returns null when nothing matches (the caller degrades the
 * decision to a recorded defer — an un-targetable consume_service must NOT
 * silently become open matchmaking).
 */
export function resolveLockedService(
  environment: EnvironmentCenter,
  initiatorAgentId: string,
  target: CognitiveServiceTarget,
): ResolvedServiceTarget | null {
  if (typeof environment.getServices !== 'function') return null;
  const agentsById = new Map(
    environment.listAgents().map((agent: { id: string; name: string }) => [agent.id, agent.name]),
  );
  let byName: ResolvedServiceTarget | null = null;
  for (const registration of environment.getServices().values()) {
    if (registration.agentId === initiatorAgentId) continue;
    const service = registration.service;
    const resolved: ResolvedServiceTarget = {
      serviceId: service.id,
      serviceName: service.name,
      providerAgentId: registration.agentId,
      providerAgentName: agentsById.get(registration.agentId) ?? registration.agentId,
      capabilities: service.capabilities ?? [],
      ...(registration.semanticType !== undefined ? { semanticType: registration.semanticType } : {}),
      ...(typeof service.location === 'string' ? { zoneId: service.location } : {}),
    };
    if (target.serviceId !== undefined && service.id === target.serviceId) return resolved;
    if (target.serviceName !== undefined && service.name === target.serviceName && byName === null) {
      byName = resolved;
    }
  }
  return byName;
}

/**
 * Build the locked PartnerSelectionResult for a resolved consume_service
 * target: exactly one candidate (the target service's provider), a
 * 'service-invocation' proposal face carrying the service's OWN capability
 * surface plus the structured term with the serviceId. Deterministic; the
 * caller (initiateAC) skips findPartners/capability-relaxation entirely on
 * this lane — a locked target must not be widened.
 */
export function lockedServiceSelection(
  initiatorAgentId: string,
  initiatorAgentName: string,
  target: ResolvedServiceTarget,
  terms?: Record<string, unknown>,
): PartnerSelectionResult {
  const serviceTerm = {
    name: target.serviceName,
    ...(target.semanticType !== undefined ? { semanticType: target.semanticType } : {}),
    terms: { ...(terms ?? {}), serviceId: target.serviceId },
  };
  const now = new Date();
  const proposal: CollaborationProposal = {
    id: uuidv4(),
    initiatorId: initiatorAgentId,
    initiatorName: initiatorAgentName,
    collaborationGoal: `Consume service: ${target.serviceName}`,
    detailedDescription: `Locked consumption of service ${target.serviceName} (${target.serviceId}) from ${target.providerAgentName}`,
    triggerSummary: '',
    reasoning: `consume_service decision locked to service ${target.serviceName}`,
    benefits: [],
    requiredCapabilities: target.capabilities,
    targetPartnerIds: [target.providerAgentId],
    targetPartnerProfiles: [],
    proposedDuration: 0,
    proposedConstraints: {},
    priority: 'medium',
    expiresAt: new Date(now.getTime() + 120_000),
    createdAt: now,
    // Scenario A: the initiator found a published/derived service and is
    // invoking it directly — the responder-side threshold lane recognizes
    // this type (lowered bar: the service IS the pre-confirmed match).
    proposalType: 'service-invocation',
    serviceOffers: [{ partnerId: target.providerAgentId, serviceId: target.serviceId }],
    services: [serviceTerm],
    status: 'pending',
    responses: [],
  };
  return {
    selectedPartners: [{
      agentId: target.providerAgentId,
      agentName: target.providerAgentName,
      capabilities: target.capabilities,
      services: [serviceTerm],
      serviceId: target.serviceId,
      workload: 'idle',
      currentCollaborations: 0,
      reliability: 1,
      proximity: 1,
      matchScore: 1,
    }],
    proposal,
    confidence: 1,
    reasoning: `consume_service locked to ${target.serviceName} (${target.serviceId}) of ${target.providerAgentName}`,
    allRankedCandidates: [],
  };
}
