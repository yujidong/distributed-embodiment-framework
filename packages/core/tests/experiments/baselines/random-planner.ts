/**
 * Random Partner Selection Baseline Planner
 *
 * Sprint P13: Provides a lower-bound baseline for paper experiments by
 * randomly selecting devices to handle each event's required capabilities.
 * This planner exercises no spatial reasoning, no world model, and no
 * intelligent partner selection -- it purely relies on chance to match
 * capabilities to devices and their managing agents.
 *
 * Purpose:
 *   Establishes the floor of expected performance. Any intelligent
 *   collaboration system should significantly outperform this baseline
 *   across all evaluation metrics (zone targeting, capability
 *   appropriateness, goal achievement rate, etc.).
 *
 * Reproducibility:
 *   An optional seed parameter enables deterministic random selection
 *   via the mulberry32 PRNG, ensuring experiment reproducibility.
 *   When no seed is provided, Math.random is used instead.
 */

import type {
  ScenarioDefinition,
  TestEventDef,
  DeviceDef,
  AgentDef,
  PlannedAssignment,
} from '../infrastructure/types.js';

/**
 * A single agent-to-device task assignment produced during planning.
 * Used internally by the planner before being bundled into a
 * {@link PlannedAssignment}.
 */
interface AgentTaskAssignment {
  /** The agent assigned to the task. */
  agentId: string;

  /** The device the agent should use. */
  deviceId: string;

  /** The capability to exercise on the device. */
  capability: string;

  /** Natural-language description of the task. */
  task: string;
}

/**
 * Random planner baseline for Sprint P13 paper experiments.
 *
 * For each required capability of an incoming event, the planner:
 *   1. Identifies all devices whose capabilities fuzzy-match the
 *      requirement (case-insensitive substring matching).
 *   2. Randomly selects one matching device.
 *   3. Finds the agent that manages the selected device.
 *   4. Records an {@link AgentTaskAssignment} linking agent, device,
 *      capability, and a descriptive task string.
 *
 * The result is a {@link PlannedAssignment} whose `expectedGoals`
 * reflects the number of successfully assigned capabilities and whose
 * `isOptimal` is always `false`.
 */
export class RandomPlanner {
  /** Agents available in the scenario. */
  private readonly agents: AgentDef[];

  /** Devices available in the scenario. */
  private readonly devices: DeviceDef[];

  /** The scenario definition providing environmental context. */
  private readonly scenario: ScenarioDefinition;

  /**
   * Constructs a new RandomPlanner.
   *
   * @param agents   - All agents participating in the scenario.
   * @param devices  - All devices deployed in the scenario.
   * @param scenario - The full scenario definition (zones, events, etc.).
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

  /**
   * Produces a random assignment plan for the given event.
   *
   * @param event - The test event to plan assignments for.
   * @param seed  - Optional PRNG seed for reproducibility. When provided,
   *                the mulberry32 algorithm is used to generate deterministic
   *                pseudo-random numbers. When omitted, Math.random is used.
   * @returns A {@link PlannedAssignment} containing the randomly selected
   *          agent-device-capability assignments.
   */
  plan(event: TestEventDef, seed?: number): PlannedAssignment {
    const random =
      seed !== undefined ? this.seededRandom(seed) : Math.random;

    const assignments: AgentTaskAssignment[] = [];
    let successfulAssignments = 0;

    for (const requiredCapability of event.requiredCapabilities) {
      const matchingDevices = this.findMatchingDevices(requiredCapability);

      if (matchingDevices.length === 0) {
        continue;
      }

      const selectedIndex = Math.floor(random() * matchingDevices.length);
      const selectedDevice = matchingDevices[selectedIndex];

      const managingAgent = this.findManagingAgent(selectedDevice);

      if (!managingAgent) {
        continue;
      }

      assignments.push({
        agentId: managingAgent.id,
        deviceId: selectedDevice.id,
        capability: requiredCapability,
        task: `Handle ${requiredCapability} for event ${event.id} (${event.type}) in zone ${event.zoneId}`,
      });

      successfulAssignments++;
    }

    return {
      agentAssignments: assignments,
      expectedGoals: successfulAssignments,
      isOptimal: false,
    };
  }

  /**
   * Finds all devices whose capabilities fuzzy-match the required
   * capability using case-insensitive substring matching.
   *
   * A device matches if any of its capabilities contains the required
   * capability string as a substring (case-insensitive), or vice versa.
   * This bidirectional substring check accommodates scenarios where
   * the required capability name may be more or less specific than
   * the device's registered capability name.
   *
   * @param requiredCapability - The capability string to match against.
   * @returns An array of devices with at least one matching capability.
   */
  private findMatchingDevices(requiredCapability: string): DeviceDef[] {
    const requiredLower = requiredCapability.toLowerCase();

    return this.devices.filter((device) =>
      device.capabilities.some((cap) => {
        const capLower = cap.toLowerCase();
        return (
          capLower.includes(requiredLower) ||
          requiredLower.includes(capLower)
        );
      }),
    );
  }

  /**
   * Finds the agent that manages a given device.
   *
   * An agent is considered the manager of a device if:
   *   - The device's ID appears in the agent's `managesDeviceIds` list, OR
   *   - The device's `zoneId` is included in the agent's `managesZoneIds`.
   *
   * When multiple agents match, the first one found is returned.
   * This is acceptable for a random baseline -- deterministic selection
   * of the managing agent does not compromise the randomness guarantee
   * since device selection itself is already random.
   *
   * @param device - The device to find the managing agent for.
   * @returns The managing agent, or `undefined` if none is found.
   */
  private findManagingAgent(device: DeviceDef): AgentDef | undefined {
    return this.agents.find((agent) => {
      if (agent.managesDeviceIds?.includes(device.id)) {
        return true;
      }
      if (agent.managesZoneIds.includes(device.zoneId)) {
        return true;
      }
      return false;
    });
  }

  /**
   * Creates a seeded pseudo-random number generator using the
   * mulberry32 algorithm.
   *
   * Mulberry32 is a fast, high-quality 32-bit PRNG suitable for
   * generating reproducible random sequences in experiments. It
   * produces output in the range [0, 1) matching the Math.random
   * interface.
   *
   * @param seed - The initial seed value.
   * @returns A function that returns a pseudo-random number in [0, 1)
   *          on each invocation.
   */
  private seededRandom(seed: number): () => number {
    let t = seed + 0x6d2b79f5;
    return () => {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}
