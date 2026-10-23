/**
 * R38-P2 — agent world-model zone source: pure shaping (L2), see
 * docs/architecture-runtime.md. Deterministic, no engine state, no I/O.
 * Types come from cognition (L0-domain) and ../contract.js conventions.
 */

import type { WorldModelZoneSource } from '../../cognition/context-projection.js';
import { SNAPSHOT_PARAMETERS } from './world.js';

export interface ZoneSourceInput {
  /** Scenario zone definitions (id/name/adjacency — the loaded topology). */
  zoneDefs: ReadonlyArray<{ id: string; name?: string; adjacentZoneIds: string[] }>;
  /** The agent's managed zones; adjacency of these is added (visible face). */
  managedZoneIds: readonly string[];
  /** Live per-zone parameter reader (physicalEnv.getParameterValue). */
  getParameterValue: (parameter: string, zoneId: string) => number | boolean | undefined;
  /** Parameters to sample per zone (the snapshot's standard set). */
  parameters: readonly string[];
  simTimeSec: number;
  simStartEpochMs: number;
}

/**
 * Build the live zone face for one agent's world model: managed zones plus
 * their adjacency (T-708 propagation face), each with current values of the
 * standard snapshot parameters. Missing/failed reads are omitted, never
 * faked (honesty over completeness).
 */
export function buildAgentZoneSource(input: ZoneSourceInput): WorldModelZoneSource {
  const visible = new Set<string>(input.managedZoneIds);
  for (const zoneId of input.managedZoneIds) {
    for (const adjId of input.zoneDefs.find(z => z.id === zoneId)?.adjacentZoneIds ?? []) {
      visible.add(adjId);
    }
  }

  const zones = input.zoneDefs
    .filter(zone => visible.has(zone.id))
    .map(zone => {
      const parameters: Record<string, number | boolean> = {};
      for (const parameter of input.parameters) {
        const value = input.getParameterValue(parameter, zone.id);
        if (value !== undefined) parameters[parameter] = value;
      }
      return {
        zoneId: zone.id,
        ...(zone.name !== undefined ? { name: zone.name } : {}),
        parameters,
        adjacentZoneIds: zone.adjacentZoneIds,
      };
    });

  return {
    simTimeSec: input.simTimeSec,
    simStartEpochMs: input.simStartEpochMs,
    zones,
  };
}

/** The EngineRuntime reads the world-model provider closure needs (live, per call). */
export interface WorldModelProviderSeam {
  /** The agent's managed zones (undefined = no zone source this round). */
  managedZoneIds(agentId: string): readonly string[] | undefined;
  zoneDefs: ZoneSourceInput['zoneDefs'];
  getParameterValue: ZoneSourceInput['getParameterValue'];
  simTimeSec(): number;
  simStartEpochMs(): number;
}

/**
 * The R38-P2 world-model provider closure (verbatim extraction from
 * EngineRuntime's agent wiring — file-size budget): a LIVE zone-source
 * reader (managed + adjacent, snapshot parameters) re-evaluated per call.
 */
export function buildWorldModelProvider(
  seam: WorldModelProviderSeam,
  agentId: string,
): () => WorldModelZoneSource | undefined {
  return () => {
    const managed = seam.managedZoneIds(agentId);
    if (managed === undefined) return undefined;
    return buildAgentZoneSource({
      zoneDefs: seam.zoneDefs,
      managedZoneIds: managed,
      getParameterValue: seam.getParameterValue,
      parameters: SNAPSHOT_PARAMETERS,
      simTimeSec: seam.simTimeSec(),
      simStartEpochMs: seam.simStartEpochMs(),
    });
  };
}
