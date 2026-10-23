/**
 * Ground Truth Calculator for PAPER_DESIGN_V5
 *
 * Auto-computes per-agent per-event ground truth using the formal model
 * definitions (Coverage, Gap, NeedCollab, Decision). This replaces manual
 * per-event correctDecision annotations with systematic computation.
 *
 * Definitions follow PAPER_DESIGN_V5.md Section 3:
 *   Definition 3: Coverage(A, e)
 *   Definition 4: Gap(A, e) via semMatch
 *   Definition 6: Decision(A, e)
 *   Definition 7: Interaction Type
 */

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
import { computeCapabilityGap } from '../../../src/utils/capabilityMatching.js';

// ---------------------------------------------------------------------------
// Ground Truth Calculator
// ---------------------------------------------------------------------------

export class GroundTruthCalculator {
  private readonly scenario: ScenarioDefinition;
  private readonly zoneMap: Map<string, ZoneDef>;
  private readonly agentMap: Map<string, AgentDef>;
  private readonly deviceMap: Map<string, DeviceDef>;
  private readonly eventMap: Map<string, TestEventDef>;
  private cachedGroundTruths: AgentEventGroundTruth[] | null = null;

  constructor(scenario: ScenarioDefinition) {
    this.scenario = scenario;
    this.zoneMap = new Map(scenario.zones.map(z => [z.id, z]));
    this.agentMap = new Map(scenario.agents.map(a => [a.id, a]));
    this.deviceMap = new Map(scenario.devices.map(d => [d.id, d]));
    this.eventMap = new Map(scenario.events.map(e => [e.id, e]));
  }

  // -------------------------------------------------------------------------
  // Core computation
  // -------------------------------------------------------------------------

  /**
   * Compute ground truth for ALL (Agent, Event) pairs in the scenario.
   * Results are cached after first computation.
   */
  computeGroundTruth(): AgentEventGroundTruth[] {
    if (this.cachedGroundTruths) {
      return this.cachedGroundTruths;
    }

    const results: AgentEventGroundTruth[] = [];

    for (const agent of this.scenario.agents) {
      for (const event of this.scenario.events) {
        results.push(this.computeForAgentEvent(agent.id, event.id));
      }
    }

    this.cachedGroundTruths = results;
    return results;
  }

  /**
   * Compute ground truth for a single (Agent, Event) pair.
   */
  computeForAgentEvent(agentId: string, eventId: string): AgentEventGroundTruth {
    const agent = this.agentMap.get(agentId);
    const event = this.eventMap.get(eventId);

    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (!event) throw new Error(`Event not found: ${eventId}`);

    const actuatorZones = this.computeActuatorZones(agentId);
    const coverage = this.computeCoverage(agentId, eventId);
    const { gap, matched } = this.computeGapForAgentEvent(agentId, eventId);
    const type = this.classifyType(coverage, gap);
    const isSensorOnly = actuatorZones.length === 0;
    const correctDecision = this.deriveDecision(type, event, isSensorOnly);
    const hasDirectCoverage = coverage === 1;
    const hasPropagationCoverage = coverage === 0.5;

    return {
      agentId,
      eventId,
      actuatorZones,
      coverage,
      gap,
      type,
      correctDecision,
      matchedCapabilities: matched,
      hasDirectCoverage,
      hasPropagationCoverage,
    };
  }

  // -------------------------------------------------------------------------
  // Individual components
  // -------------------------------------------------------------------------

  /**
   * Compute actuatorZones(A): zones where the agent has actuator devices.
   *
   * actuatorZones(A) = {zone(d) | d ∈ devices(R_A), isActuator(d)}
   */
  computeActuatorZones(agentId: string): string[] {
    const agent = this.agentMap.get(agentId);
    if (!agent) return [];

    const deviceIds = agent.managesDeviceIds ?? [];
    const zones = new Set<string>();

    for (const deviceId of deviceIds) {
      const device = this.deviceMap.get(deviceId);
      if (device && (device.type === 'actuator' || device.type === 'hybrid')) {
        zones.add(device.zoneId);
      }
    }

    return Array.from(zones);
  }

  /**
   * Compute Coverage(A, e): the agent's physical action coverage of the event.
   *
   * Coverage(A, e) =
   *   1  if loc(e) ∈ actuatorZones(A)          // direct actuator coverage
   *   δ  if loc(e) ∈ EffectRange(A)             // propagation range
   *   0  otherwise
   */
  computeCoverage(agentId: string, eventId: string): CoverageLevel {
    const event = this.eventMap.get(eventId);
    if (!event) return 0;

    const actuatorZones = this.computeActuatorZones(agentId);

    // Direct coverage
    if (actuatorZones.includes(event.zoneId)) return 1;

    // Propagation coverage (single-hop via zone adjacency)
    const effectRange = this.computeEffectRange(agentId);
    if (effectRange.includes(event.zoneId)) return 0.5;

    return 0;
  }

  /**
   * Compute EffectRange(A): zones reachable via single-hop propagation
   * from the agent's actuator zones.
   */
  computeEffectRange(agentId: string): string[] {
    const actuatorZones = this.computeActuatorZones(agentId);
    const propagationZones = new Set<string>();

    for (const zoneId of actuatorZones) {
      const zone = this.zoneMap.get(zoneId);
      if (zone?.adjacentZoneIds) {
        for (const adjId of zone.adjacentZoneIds) {
          if (!actuatorZones.includes(adjId)) {
            propagationZones.add(adjId);
          }
        }
      }
    }

    return Array.from(propagationZones);
  }

  /**
   * Compute NeedCollab(A, e): whether this agent-event pair requires collaboration.
   * Per V5 Definition 5: NeedCollab(A, e) = (|Gap(A, e)| > 0) ∧ (Coverage(A, e) > 0)
   */
  computeNeedCollab(agentId: string, eventId: string): boolean {
    const { gap } = this.computeGapForAgentEvent(agentId, eventId);
    const coverage = this.computeCoverage(agentId, eventId);
    return gap.length > 0 && coverage > 0;
  }

  /**
   * Compute Gap(A, e): capabilities required by the event that the agent lacks.
   * Uses semantic matching (semMatch) to handle capability equivalence.
   */
  computeGapForAgentEvent(
    agentId: string,
    eventId: string,
  ): { gap: string[]; matched: string[] } {
    const agent = this.agentMap.get(agentId);
    const event = this.eventMap.get(eventId);

    if (!agent || !event) return { gap: [], matched: [] };

    return computeCapabilityGap(agent.capabilities, event.requiredCapabilities);
  }

  /**
   * Classify the interaction type based on Coverage and Gap.
   * Per V5 Definition 7.
   */
  classifyType(coverage: CoverageLevel, gap: string[]): AgentEventType {
    const hasGap = gap.length > 0;

    if (coverage > 0 && !hasGap) return 'A';    // Coverage>0, Gap=∅
    if (coverage === 1 && hasGap) return 'B';    // Direct coverage, Gap≠∅
    if (coverage === 0.5 && hasGap) return 'C';  // Propagation (δ), Gap≠∅
    if (coverage === 0 && hasGap) return 'D';    // No coverage, Gap≠∅
    if (coverage === 0 && !hasGap) return 'E';   // No coverage, Gap=∅

    // Exhaustive check — all CoverageLevel × Gap combinations are handled above
    throw new Error(`Unreachable: coverage=${coverage}, gap=${JSON.stringify(gap)}`);
  }

  /**
   * Derive the correct decision based on interaction type and event properties.
   * Per V5 Definition 6:
   *
   *   handle_independently  if |Gap|=0 ∧ Coverage>0                    → Type A
   *   initiate_ac           if NeedCollab ∨ (|Gap|=0 ∧ Coverage=0)      → Types B, C, E
   *   defer                 if Coverage=0 ∧ Gap>0 ∧ sig(e) ≥ threshold  → Type D (significant)
   *   ignore                if Coverage=0 ∧ Gap>0 ∧ sig(e) < threshold  → Type D (trivial)
   *
   * Type D refinement for sensor-only agents: a pure-sensor agent that detects
   * an event but has no actuators should initiate collaboration (notify capable
   * agents) rather than silently defer/ignore. This aligns with the Distributed
   * Embodiment paradigm where sensors are the perception layer.
   *
   * Type C refinement: propagation-only agents defer for low-severity events
   * since the marginal benefit of collaboration through propagation is small.
   */
  deriveDecision(
    type: AgentEventType,
    event: TestEventDef,
    isSensorOnly: boolean = false,
  ): CollaborationDecision {
    switch (type) {
      case 'A':
        return 'handle_independently';
      case 'B':
        return 'initiate_ac';
      case 'C':
        // Propagation coverage: initiate_ac for significant events, defer for low-severity
        return event.severity === 'low' ? 'defer' : 'initiate_ac';
      case 'D':
        // Sensor-only agents should initiate collaboration (perception → action via others)
        if (isSensorOnly) return 'initiate_ac';
        // Agents with actuators but no coverage: defer significant, ignore trivial
        return event.severity === 'low' || event.requiredCapabilities.length === 0
          ? 'ignore'
          : 'defer';
      case 'E':
        // Has capabilities but can't reach the event location → collaborate
        return 'initiate_ac';
    }
  }

  // -------------------------------------------------------------------------
  // Utility: get scenario
  // -------------------------------------------------------------------------

  getScenario(): ScenarioDefinition {
    return this.scenario;
  }

  getAgent(agentId: string): AgentDef | undefined {
    return this.agentMap.get(agentId);
  }

  getEvent(eventId: string): TestEventDef | undefined {
    return this.eventMap.get(eventId);
  }

  /**
   * Get ground truths filtered by type.
   */
  getByType(type: AgentEventType): AgentEventGroundTruth[] {
    return this.computeGroundTruth().filter(gt => gt.type === type);
  }

  /**
   * Get ground truths filtered by agent.
   */
  getByAgent(agentId: string): AgentEventGroundTruth[] {
    return this.computeGroundTruth().filter(gt => gt.agentId === agentId);
  }

  /**
   * Get ground truths filtered by event.
   */
  getByEvent(eventId: string): AgentEventGroundTruth[] {
    return this.computeGroundTruth().filter(gt => gt.eventId === eventId);
  }

  /**
   * Print a summary of the ground truth distribution.
   */
  printSummary(): void {
    const groundTruths = this.computeGroundTruth();

    console.log(`\n=== Ground Truth Summary: ${this.scenario.id} ===`);
    console.log(`Total (Agent, Event) pairs: ${groundTruths.length}`);
    console.log(`Agents: ${this.scenario.agents.length}`);
    console.log(`Events: ${this.scenario.events.length}`);

    // Type distribution
    const typeCounts = new Map<AgentEventType, number>();
    for (const gt of groundTruths) {
      typeCounts.set(gt.type, (typeCounts.get(gt.type) ?? 0) + 1);
    }

    console.log('\nType distribution:');
    for (const type of ['A', 'B', 'C', 'D', 'E'] as AgentEventType[]) {
      const count = typeCounts.get(type) ?? 0;
      const pct = ((count / groundTruths.length) * 100).toFixed(1);
      console.log(`  Type ${type}: ${count} (${pct}%)`);
    }

    // Decision distribution
    const decisionCounts = new Map<CollaborationDecision, number>();
    for (const gt of groundTruths) {
      decisionCounts.set(gt.correctDecision, (decisionCounts.get(gt.correctDecision) ?? 0) + 1);
    }

    console.log('\nDecision distribution:');
    for (const [decision, count] of decisionCounts) {
      const pct = ((count / groundTruths.length) * 100).toFixed(1);
      console.log(`  ${decision}: ${count} (${pct}%)`);
    }
  }
}
