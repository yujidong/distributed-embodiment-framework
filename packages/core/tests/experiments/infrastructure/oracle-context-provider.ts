/**
 * Oracle Context Provider for PAPER_DESIGN_V5 (Phase 5)
 *
 * Provides perfect ground-truth information to the agent for the oracle
 * baseline condition. The oracle baseline uses the same LLM and prompt
 * template as the full-AC condition, but injects perfect Coverage, Gap,
 * and partner information into the agent context.
 *
 * This establishes an upper bound on LLM decision quality given ideal
 * information, isolating the effect of the AC framework's information
 * gathering from the LLM's reasoning capability.
 */

import { GroundTruthCalculator } from './ground-truth-calculator.js';
import type {
  AgentDef,
  AgentEventGroundTruth,
  AgentEventType,
  CollaborationDecision,
  CoverageLevel,
  DeviceDef,
  ScenarioDefinition,
  TestEventDef,
  ZoneDef,
} from './types.js';

// ---------------------------------------------------------------------------
// Oracle insight (injected into AgentContext)
// ---------------------------------------------------------------------------

/**
 * Perfect ground-truth information for the current (Agent, Event) pair.
 * Added to AgentContext.oracleInsight when oracleMode is enabled.
 */
export interface OracleInsight {
  /** Ground-truth coverage level for this (Agent, Event) pair. */
  coverage: CoverageLevel;

  /** Human-readable coverage description. */
  coverageDescription: string;

  /** Ground-truth gap: capabilities the agent lacks for this event. */
  gapCapabilities: string[];

  /** Ground-truth matched capabilities. */
  matchedCapabilities: string[];

  /** Ground-truth interaction type (A-E). */
  interactionType: AgentEventType;

  /** Ground-truth correct decision. */
  correctDecision: CollaborationDecision;

  /** Agents that have the missing capabilities and can reach the event. */
  idealPartners: Array<{
    agentId: string;
    capabilities: string[];
    zoneId: string;
  }>;

  /** Event zone ID. */
  eventZoneId: string;
}

// ---------------------------------------------------------------------------
// Oracle Context Provider
// ---------------------------------------------------------------------------

export class OracleContextProvider {
  private readonly calculator: GroundTruthCalculator;
  private readonly scenario: ScenarioDefinition;

  constructor(scenario: ScenarioDefinition) {
    this.scenario = scenario;
    this.calculator = new GroundTruthCalculator(scenario);
  }

  /**
   * Get oracle insight for a specific (Agent, Event) pair.
   * Returns perfect ground-truth information about the agent's coverage,
   * capability gap, and ideal partners.
   */
  getOracleInsight(agentId: string, eventId: string): OracleInsight {
    const gt = this.calculator.computeForAgentEvent(agentId, eventId);
    const event = this.calculator.getEvent(eventId);
    const agent = this.calculator.getAgent(agentId);

    if (!event || !agent) {
      throw new Error(`OracleContextProvider: agent=${agentId} or event=${eventId} not found`);
    }

    // Find ideal partners: agents that have the gap capabilities and
    // can reach the event zone (coverage > 0)
    const idealPartners = this.findIdealPartners(gt, event);

    // Build coverage description
    let coverageDescription: string;
    if (gt.coverage === 1) {
      coverageDescription = `You have DIRECT actuator coverage in ${event.zoneId}`;
    } else if (gt.coverage === 0.5) {
      coverageDescription = `You have PROPAGATION coverage (adjacent zone) for ${event.zoneId}`;
    } else {
      coverageDescription = `You have NO coverage of ${event.zoneId}`;
    }

    return {
      coverage: gt.coverage,
      coverageDescription,
      gapCapabilities: gt.gap,
      matchedCapabilities: gt.matchedCapabilities,
      interactionType: gt.type,
      correctDecision: gt.correctDecision,
      idealPartners,
      eventZoneId: event.zoneId,
    };
  }

  /**
   * Find ideal partners: agents that (1) have the gap capabilities and
   * (2) can reach the event zone (coverage > 0).
   */
  private findIdealPartners(
    gt: AgentEventGroundTruth,
    event: TestEventDef,
  ): Array<{ agentId: string; capabilities: string[]; zoneId: string }> {
    if (gt.gap.length === 0) {
      return []; // No gap — no partners needed
    }

    const partners: Array<{ agentId: string; capabilities: string[]; zoneId: string }> = [];

    for (const otherAgent of this.scenario.agents) {
      // Skip self
      if (otherAgent.id === gt.agentId) continue;

      // Check if this agent has any of the gap capabilities
      const relevantCapabilities = otherAgent.capabilities.filter(cap =>
        gt.gap.some(gapCap => this.capabilityMatches(cap, gapCap)),
      );

      if (relevantCapabilities.length === 0) continue;

      // Check if this agent can reach the event zone
      const otherCoverage = this.calculator.computeCoverage(otherAgent.id, event.id);
      if (otherCoverage === 0) continue;

      // Find which zone this partner operates from
      const actuatorZones = this.calculator.computeActuatorZones(otherAgent.id);
      const partnerZone = actuatorZones.length > 0 ? actuatorZones[0] : 'unknown';

      partners.push({
        agentId: otherAgent.id,
        capabilities: relevantCapabilities,
        zoneId: partnerZone,
      });
    }

    return partners;
  }

  /**
   * Simple capability matching (consistent with GroundTruthCalculator).
   */
  private capabilityMatches(agentCap: string, requiredCap: string): boolean {
    const a = agentCap.toLowerCase();
    const r = requiredCap.toLowerCase();
    if (a === r) return true;
    if (a.includes(r) || r.includes(a)) return true;
    return false;
  }

  /**
   * Get the underlying GroundTruthCalculator (for direct access).
   */
  getCalculator(): GroundTruthCalculator {
    return this.calculator;
  }
}
