/**
 * Central Planner Baseline -- Sprint P13 Paper Experiments
 *
 * Deterministic, greedy-optimal baseline planner with full global knowledge
 * of all devices, agents, and zones. This is NOT an LLM-based planner -- it
 * uses pure algorithmic assignment to compute the best possible task
 * allocation for each event.
 *
 * Purpose:
 *   Establishes an upper-bound performance baseline against which the
 *   autonomous Active Collaboration (AC) approach is compared. Because the
 *   central planner has perfect information and deterministic selection, its
 *   results represent the theoretical optimum achievable under the same
 *   device/agent topology.
 *
 * Research questions addressed:
 *   - RQ1 (world model effectiveness): provides ground-truth zone targeting
 *   - RQ2 (autonomous collaboration): provides optimal partner selection
 *   - RQ3 (efficiency): provides zero-LLM-call reference point
 *   - RQ4 (robustness): provides non-degraded performance reference
 *
 * Algorithm (per event, per required capability):
 *   1. Fuzzy-match all devices whose capabilities satisfy the requirement
 *      (case-insensitive substring matching).
 *   2. Rank candidates: same zone first, then adjacent zones, then all
 *      others.
 *   3. Among same-tier candidates, pick the one closest to the event
 *      location (Euclidean distance on the x,y plane).
 *   4. Resolve the managing agent for the selected device.
 *   5. Produce an AgentTaskAssignment.
 *
 * The planner always reports isOptimal = true because its global view
 * guarantees the greedy selection is the best achievable assignment.
 */

import type {
  ScenarioDefinition,
  TestEventDef,
  DeviceDef,
  AgentDef,
  PlannedAssignment,
  AgentTaskAssignment,
} from '../infrastructure/types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Tier used to rank device candidates by proximity to the event zone.
 *
 *   0 = same zone (best)
 *   1 = adjacent zone
 *   2 = everything else
 */
type ZoneTier = 0 | 1 | 2;

/**
 * Compute the Euclidean distance between a device (3D location) and an
 * event (2D location) using only the x and y coordinates.
 *
 * @param deviceLocation - The 3D position of the device.
 * @param eventLocation  - The 2D position of the event.
 * @returns Euclidean distance on the x,y plane.
 */
function euclideanDistanceXY(
  deviceLocation: { x: number; y: number; z: number },
  eventLocation: { x: number; y: number },
): number {
  const dx = deviceLocation.x - eventLocation.x;
  const dy = deviceLocation.y - eventLocation.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Determine the zone tier for a device relative to the event zone.
 *
 * @param deviceZoneId       - The zone the device is in.
 * @param eventZoneId        - The zone the event occurred in.
 * @param adjacentZoneIds    - Zones adjacent to the event zone.
 * @returns A numeric tier (0 = same zone, 1 = adjacent, 2 = distant).
 */
function getZoneTier(
  deviceZoneId: string,
  eventZoneId: string,
  adjacentZoneIds: string[],
): ZoneTier {
  if (deviceZoneId === eventZoneId) {
    return 0;
  }
  if (adjacentZoneIds.includes(deviceZoneId)) {
    return 1;
  }
  return 2;
}

/**
 * Check whether a device capability fuzzy-matches a required capability.
 *
 * Matching is case-insensitive and uses substring containment: a device
 * capability "Temperature-Reading" matches the requirement "temperature".
 *
 * @param deviceCapability  - The capability string advertised by the device.
 * @param requiredCapability - The capability string required by the event.
 * @returns True if the device capability satisfies the requirement.
 */
function capabilityMatches(
  deviceCapability: string,
  requiredCapability: string,
): boolean {
  const dc = deviceCapability.toLowerCase();
  const rc = requiredCapability.toLowerCase();
  return dc.includes(rc) || rc.includes(dc);
}

/**
 * Find the agent that manages a given device.
 *
 * Resolution strategy:
 *   1. Check each agent's managesDeviceIds for an explicit match.
 *   2. Fall back to checking whether the device's zoneId is covered by
 *      the agent's managesZoneIds.
 *
 * @param deviceId - The device to look up.
 * @param device   - The full device definition (needed for zoneId fallback).
 * @param agents   - All agents in the scenario.
 * @returns The managing AgentDef, or undefined if no agent claims the device.
 */
function findManagingAgent(
  deviceId: string,
  device: DeviceDef,
  agents: AgentDef[],
): AgentDef | undefined {
  // First pass: explicit device-level management.
  for (const agent of agents) {
    if (agent.managesDeviceIds?.includes(deviceId)) {
      return agent;
    }
  }
  // Second pass: zone-level management.
  for (const agent of agents) {
    if (agent.managesZoneIds.includes(device.zoneId)) {
      return agent;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CentralPlanner
// ---------------------------------------------------------------------------

/**
 * Greedy-optimal baseline planner with full global knowledge.
 *
 * Given the complete set of agents, devices, and zone topology, the planner
 * deterministically assigns the best device (and its managing agent) to each
 * required capability of every event. Because it has perfect information,
 * its assignments represent the theoretical optimum.
 *
 * Usage:
 * ```ts
 * const planner = new CentralPlanner(agents, devices, scenario);
 * const assignment = planner.plan(event);
 * ```
 */
export class CentralPlanner {
  /** All agents in the scenario. */
  private readonly agents: AgentDef[];

  /** All devices in the scenario. */
  private readonly devices: DeviceDef[];

  /** Full scenario definition including zone adjacency info. */
  private readonly scenario: ScenarioDefinition;

  /**
   * Construct a new CentralPlanner.
   *
   * @param agents   - All agents participating in the scenario.
   * @param devices  - All devices deployed in the scenario.
   * @param scenario - The full scenario definition (zones, adjacency, etc.).
   */
  constructor(
    agents: AgentDef[],
    devices: DeviceDef[],
    scenario: ScenarioDefinition,
  ) {
    this.agents = agents;
    this.devices = devices;
    this.scenario = scenario;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Compute the optimal assignment for a single test event.
   *
   * For each required capability the planner:
   *   1. Finds all devices whose capabilities fuzzy-match the requirement.
   *   2. Prefers devices in the event zone, then adjacent zones, then any.
   *   3. Among co-tier candidates, selects the closest by Euclidean distance.
   *   4. Resolves the managing agent and creates a task assignment.
   *
   * @param event - The test event to plan for.
   * @returns A PlannedAssignment with all agent assignments, the count of
   *          successfully assigned goals, and isOptimal always true.
   */
  plan(event: TestEventDef): PlannedAssignment {
    const assignments: AgentTaskAssignment[] = [];
    let goalsAchieved = 0;

    // Resolve adjacency for the event zone.
    const eventZone = this.scenario.zones.find((z) => z.id === event.zoneId);
    const adjacentZoneIds: string[] = eventZone?.adjacentZoneIds ?? [];

    // Track which devices have already been assigned to avoid double-booking.
    const assignedDeviceIds = new Set<string>();

    for (const requiredCapability of event.requiredCapabilities) {
      const assignment = this.assignCapability(
        requiredCapability,
        event,
        adjacentZoneIds,
        assignedDeviceIds,
      );

      if (assignment !== null) {
        assignments.push(assignment);
        assignedDeviceIds.add(assignment.deviceId);
        goalsAchieved++;
      }
    }

    return {
      agentAssignments: assignments,
      expectedGoals: goalsAchieved,
      isOptimal: true,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Find the best device and managing agent for a single required capability.
   *
   * @param requiredCapability - The capability to satisfy.
   * @param event              - The event that needs this capability.
   * @param adjacentZoneIds    - Zones adjacent to the event zone.
   * @param alreadyAssigned    - Device IDs already used for previous
   *                             capabilities in this event.
   * @returns An AgentTaskAssignment, or null if no suitable device was found.
   */
  private assignCapability(
    requiredCapability: string,
    event: TestEventDef,
    adjacentZoneIds: string[],
    alreadyAssigned: Set<string>,
  ): AgentTaskAssignment | null {
    // Step 1: Find all candidate devices whose capabilities match.
    const candidates = this.devices.filter(
      (device) =>
        !alreadyAssigned.has(device.id) &&
        device.capabilities.some((cap) => capabilityMatches(cap, requiredCapability)),
    );

    if (candidates.length === 0) {
      return null;
    }

    // Step 2: Rank by zone tier, then by Euclidean distance.
    const ranked = candidates
      .map((device) => ({
        device,
        tier: getZoneTier(device.zoneId, event.zoneId, adjacentZoneIds),
        distance: euclideanDistanceXY(device.location, event.location),
      }))
      .sort((a, b) => {
        // Lower tier is better.
        if (a.tier !== b.tier) {
          return a.tier - b.tier;
        }
        // Among same-tier candidates, closer is better.
        return a.distance - b.distance;
      });

    const best = ranked[0].device;

    // Step 3: Resolve the managing agent.
    const agent = findManagingAgent(best.id, best, this.agents);

    if (agent === undefined) {
      // No agent manages this device -- cannot create a valid assignment.
      return null;
    }

    // Step 4: Build the task assignment.
    return {
      agentId: agent.id,
      deviceId: best.id,
      capability: requiredCapability,
      task: `Handle "${requiredCapability}" for event "${event.type}" (${event.id}) using device "${best.name}" (${best.id})`,
    };
  }
}
