/**
 * World-state export/restore shaping (Living-worlds P0, design-living-worlds.md §9)
 *
 * Pure serialization of a running world at a sim-time boundary — the "format
 * in the CONTRACT sense": no engine logic, no I/O, everything testable as
 * data-in/data-out. Two directions:
 *
 * - `buildWorldStateExport` gathers the live state through READ seams;
 * - `planWorldStateRestore` turns a checkpoint back into an ordered, pure
 *   RESTORE PLAN the runtime executes against its own members (the plan —
 *   not the runtime — is what unit tests pin).
 *
 * Determinism rules encoded here (the P0 acceptance invariant):
 * - Timers are NEVER captured — their SCHEDULE is (firedEventIds /
 *   occupancyFired / pendingEffectChecks carry due moments, the resume
 *   replays due moments, not wall-clock accidents).
 * - Time-dependent default value models are restored via the clock anchor
 *   (simStartEpochMs + simTimeSec), NOT by freezing their current value —
 *   global (no-bounds) reads are restored as a DIFF against the freshly
 *   reconstructed models, so only runtime deviations (injected constants)
 *   are written back.
 * - The fault RNG is captured as (resolved seed, draws) — the restore
 *   fast-forwards the same number of draws.
 */

import { ENGINE_WORLD_STATE_VERSION } from '../contract.js';
import type {
  DevicePhysicsEffectLike,
  EngineWorldStateExport,
  FaultProfile,
  RuntimeDecisionRecord,
  WorldAgentStateExport,
  WorldDeviceStateExport,
  WorldZoneStateExport,
} from '../contract.js';
import type { ReputationTrackerJSON } from '../../reputation/index.js';
import type { FlowEngineStateExport } from '../../flows/index.js';
import { SNAPSHOT_PARAMETERS, zoneCenter } from './world.js';

// ---------------------------------------------------------------------------
// Export (live world → pure data)
// ---------------------------------------------------------------------------

/** Read seams the export builder needs (EngineRuntime supplies its own). */
/** Per-agent export input (R38-P2: + bounded cognition checkpoint state). */
export interface WorldStateAgentInput {
  id: string;
  enabled: boolean;
  cognition?: EngineWorldStateExport['agents'][string]['cognition'];
}

export interface WorldStateExportInput {
  scenario: {
    zones: ReadonlyArray<{
      id: string;
      baseline?: Record<string, number | boolean>;
      bounds?: { minX: number; maxX: number; minY: number; maxY: number };
      floor?: number;
    }>;
    events: ReadonlyArray<{ parameter?: unknown }>;
  };
  clock: {
    simTimeSec: number;
    speed: number;
    tickCount: number;
    simStartEpochMs: number;
    eventSeq: number;
  };
  rng: { seed: number; draws: number };
  /** Safe per-(parameter, zoneId) read (never throws; undefined when unreadable). */
  getParameterValue: (parameter: string, zoneId: string) => number | boolean | undefined;
  zoneOccupancy: ReadonlyMap<string, number>;
  physicsLayer?: {
    getLocalParameterValue?(parameter: string, location: string): number | undefined;
    getLocalParameterBaseline?(parameter: string, location: string): number | undefined;
    listDeviceEffects?(): DevicePhysicsEffectLike[];
  };
  devices: ReadonlyArray<{
    id: string;
    getState(): Record<string, unknown>;
    /** Full-fidelity override (rounded-observable devices); defaults to getState(). */
    getCheckpointState?(): Record<string, unknown>;
    fault: FaultProfile | null;
  }>;
  agents: ReadonlyArray<WorldStateAgentInput>;
  reputation: ReputationTrackerJSON | null;
  recentDecisions: ReadonlyArray<RuntimeDecisionRecord>;
  acCapabilities: ReadonlyMap<string, string[]>;
  scheduler: { firedEventIds: ReadonlySet<string>; occupancyFired: ReadonlySet<string> };
  /** R91/R92 感知基线（key、基线值、上次发射秒、上次值、上次采样秒）。 */
  perception: {
    baselines: ReadonlyArray<readonly [string, number, number, number, number]>;
  };
  pendingEffectChecks: EngineWorldStateExport['pendingEffectChecks'];
  /** Flow-engine trigger memories, or null when no engine runs. */
  flowEngine?: FlowEngineStateExport | null;
}

/**
 * The parameter surface captured per zone: the standard seven ∪ every
 * DECLARED baseline key ∪ every scenario event's explicit `parameter`.
 * Custom (non-enum) domain quantities ride along as static values; keys
 * outside this authored surface are not part of the world's declared state
 * and are deliberately excluded (documented determinism bound).
 */
export function checkpointParameterNames(
  scenario: WorldStateExportInput['scenario'],
): string[] {
  const names = new Set<string>(SNAPSHOT_PARAMETERS);
  for (const zone of scenario.zones) {
    for (const key of Object.keys(zone.baseline ?? {})) names.add(key);
  }
  for (const event of scenario.events) {
    if (typeof event.parameter === 'string' && event.parameter.length > 0) {
      names.add(event.parameter);
    }
  }
  return [...names].sort();
}

/** Build the pure world-state export. Deterministic key order throughout. */
export function buildWorldStateExport(input: WorldStateExportInput): EngineWorldStateExport {
  const params = checkpointParameterNames(input.scenario);
  const customParams = new Set(params.filter(p => !SNAPSHOT_PARAMETERS.includes(p)));

  const zones: Record<string, WorldZoneStateExport> = {};
  for (const zone of input.scenario.zones) {
    const localized = zoneCenter(zone) !== undefined;
    const state: WorldZoneStateExport = {};
    const occupancy = input.zoneOccupancy.get(zone.id);
    if (occupancy !== undefined) state.occupancy = occupancy;

    const field: Record<string, { value: number; baseline?: number }> = {};
    const custom: Record<string, number | boolean> = {};
    const global: Record<string, number | boolean> = {};
    for (const parameter of params) {
      const fieldValue = input.physicsLayer?.getLocalParameterValue?.(parameter, zone.id);
      if (typeof fieldValue === 'number') {
        const entry: { value: number; baseline?: number } = { value: fieldValue };
        const baseline = input.physicsLayer?.getLocalParameterBaseline?.(parameter, zone.id);
        if (typeof baseline === 'number') entry.baseline = baseline;
        field[parameter] = entry;
        continue;
      }
      const value = input.getParameterValue(parameter, zone.id);
      if (value === undefined) continue;
      // No field entry: custom parameters are static store writes; enum
      // parameters ride the (possibly time-dependent) global value model.
      if (customParams.has(parameter)) {
        custom[parameter] = value;
      } else if (!localized) {
        global[parameter] = value;
      }
      // Localized enum parameters without a field entry were never written
      // (the fresh construction reproduces them from the scenario) — skip.
    }
    if (Object.keys(field).length > 0) state.field = field;
    if (Object.keys(custom).length > 0) state.custom = custom;
    if (Object.keys(global).length > 0) state.global = global;
    zones[zone.id] = state;
  }

  const devices: Record<string, WorldDeviceStateExport> = {};
  for (const device of input.devices) {
    // Prefer the full-fidelity seam (unrounded internal meters) over the
    // observable view. getState() returns the device's LIVE state object —
    // copying here (not below) would still alias nested mutables inside it.
    // The single deep-copy at the end of this function is what severs every
    // alias.
    devices[device.id] = {
      state: device.getCheckpointState?.() ?? device.getState(),
      fault: device.fault,
    };
  }

  const agents: Record<string, WorldAgentStateExport> = {};
  for (const agent of input.agents) {
    agents[agent.id] = {
      enabled: agent.enabled,
      ...(agent.cognition !== undefined
        ? { cognition: JSON.parse(JSON.stringify(agent.cognition)) as WorldAgentStateExport['cognition'] }
        : {}),
    };
  }

  const acCapabilities: Record<string, string[]> = {};
  for (const [id, caps] of input.acCapabilities) {
    acCapabilities[id] = [...caps];
  }

  const exportValue: EngineWorldStateExport = {
    formatVersion: ENGINE_WORLD_STATE_VERSION,
    simTimeSec: input.clock.simTimeSec,
    speed: input.clock.speed,
    tickCount: input.clock.tickCount,
    simStartEpochMs: input.clock.simStartEpochMs,
    eventSeq: input.clock.eventSeq,
    rng: { seed: input.rng.seed >>> 0, draws: input.rng.draws },
    zones,
    devices,
    deviceEffects: (input.physicsLayer?.listDeviceEffects?.() ?? [])
      .filter(effect => !effect.deviceId.startsWith('occupancy:')),
    agents,
    reputation: input.reputation,
    recentDecisions: input.recentDecisions.map(record => ({ ...record })),
    acCapabilities,
    perception: {
      baselines: [...input.perception.baselines].sort((a, b) => a[0].localeCompare(b[0])),
    },
    scheduler: {
      firedEventIds: [...input.scheduler.firedEventIds].sort(),
      occupancyFired: [...input.scheduler.occupancyFired].sort(),
    },
    pendingEffectChecks: input.pendingEffectChecks.map(check => ({ ...check })),
    flowEngine: input.flowEngine ?? null,
  };

  // Deep-copy the whole payload in one stroke. Every read seam hands out a
  // LIVE object (device.getState() aliases the mutable control-loop state;
  // fault profiles, reasoningParams and reputation records are mutated in
  // place at runtime) — an export that kept those references would silently
  // change under the caller between export and write ("checkpoint moved
  // while hibernating", found by the acceptance invariant: the continuous
  // run's post-export ticks leaked into its own checkpoint). The checkpoint
  // IS a JSON disk document; the round-trip both severs every alias and
  // proves serializability at construction time.
  return JSON.parse(JSON.stringify(exportValue)) as EngineWorldStateExport;
}

// ---------------------------------------------------------------------------
// Restore (checkpoint → ordered pure plan)
// ---------------------------------------------------------------------------

/** One queued zone write. */
export interface ZoneWrite {
  zoneId: string;
  parameter: string;
  value: number | boolean;
}

/** The ordered restore plan — pure data; EngineRuntime executes it. */
export interface WorldStateRestorePlan {
  /** Field relaxation baselines (must land before field values). */
  fieldBaselines: Array<ZoneWrite & { value: number }>;
  /** Field values (point writes at the zone center). */
  fieldValues: Array<ZoneWrite & { value: number }>;
  /** Static custom-parameter writes. */
  customWrites: ZoneWrite[];
  /** Occupancy re-registrations (order preserved: Map insertion order). */
  occupancyWrites: Array<{ zoneId: string; count: number }>;
  /**
   * Global (no-bounds) deviations from the freshly reconstructed value
   * models — computed against `readParameter` AFTER the clock anchor was
   * restored, so clock-driven models match and only injected constants
   * (or runtime-rewritten models) are written back.
   */
  globalWrites: ZoneWrite[];
  /** Device state restores (device.restoreState seam). */
  deviceRestores: Array<{ deviceId: string; state: Record<string, unknown> }>;
  /** Fault profiles to re-apply (null entries omitted — fresh is healthy). */
  faultWrites: Array<{ deviceId: string; fault: FaultProfile }>;
  /** Physics effects to re-register (occupancy virtual sources excluded). */
  effectRegisters: DevicePhysicsEffectLike[];
  /** Agents to disable (enabled=true is the construction default). */
  agentDisables: string[];
  /** R38-P2: per-agent cognition checkpoints (event ring + last decision). */
  agentCognition: Array<{ agentId: string; cognition: NonNullable<WorldAgentStateExport['cognition']> }>;
  /** Warnings for honest degradation (unknown ids, unsupported devices). */
  warnings: string[];
}

/**
 * Turn a world-state export into an ordered restore plan. `readParameter`
 * must read from the FRESH runtime after its clock anchor was restored —
 * the global diff depends on it. Zones/devices/agents missing from the
 * checkpoint (or from the fresh scenario) produce warnings, never throws:
 * a checkpoint of a slightly drifted world restores everything it still
 * can, and the caller decides whether the warnings matter.
 */
export function planWorldStateRestore(
  world: EngineWorldStateExport,
  context: {
    scenario: { zones: ReadonlyArray<{ id: string }> };
    deviceIds: ReadonlySet<string>;
    agentIds: ReadonlySet<string>;
    readParameter: (parameter: string, zoneId: string) => number | boolean | undefined;
  },
): WorldStateRestorePlan {
  const plan: WorldStateRestorePlan = {
    fieldBaselines: [],
    fieldValues: [],
    customWrites: [],
    occupancyWrites: [],
    globalWrites: [],
    deviceRestores: [],
    faultWrites: [],
    effectRegisters: [],
    agentDisables: [],
    agentCognition: [],
    warnings: [],
  };
  const zoneIds = new Set(context.scenario.zones.map(zone => zone.id));

  for (const zone of context.scenario.zones) {
    const state = world.zones[zone.id];
    if (state === undefined) {
      plan.warnings.push(`zone "${zone.id}" has no checkpoint state (fresh initial conditions kept)`);
      continue;
    }
    for (const [parameter, entry] of Object.entries(state.field ?? {})) {
      if (typeof entry.baseline === 'number') {
        plan.fieldBaselines.push({ zoneId: zone.id, parameter, value: entry.baseline });
      }
      plan.fieldValues.push({ zoneId: zone.id, parameter, value: entry.value });
    }
    for (const [parameter, value] of Object.entries(state.custom ?? {})) {
      plan.customWrites.push({ zoneId: zone.id, parameter, value });
    }
    if (state.occupancy !== undefined && state.occupancy > 0) {
      plan.occupancyWrites.push({ zoneId: zone.id, count: state.occupancy });
    }
    for (const [parameter, value] of Object.entries(state.global ?? {})) {
      const fresh = context.readParameter(parameter, zone.id);
      if (fresh !== value) {
        plan.globalWrites.push({ zoneId: zone.id, parameter, value });
      }
    }
  }
  for (const zoneId of Object.keys(world.zones)) {
    if (!zoneIds.has(zoneId)) {
      plan.warnings.push(`checkpoint zone "${zoneId}" no longer exists in the scenario (state dropped)`);
    }
  }

  for (const [deviceId, device] of Object.entries(world.devices)) {
    if (!context.deviceIds.has(deviceId)) {
      plan.warnings.push(`checkpoint device "${deviceId}" no longer exists in the scenario (state dropped)`);
      continue;
    }
    plan.deviceRestores.push({ deviceId, state: device.state });
    if (device.fault !== null) plan.faultWrites.push({ deviceId, fault: device.fault });
  }

  for (const effect of world.deviceEffects) {
    if (!context.deviceIds.has(effect.deviceId) && !effect.deviceId.startsWith('occupancy:')) {
      plan.warnings.push(`physics effect of unknown device "${effect.deviceId}" dropped`);
      continue;
    }
    plan.effectRegisters.push(effect);
  }

  for (const [agentId, agent] of Object.entries(world.agents)) {
    if (!context.agentIds.has(agentId)) {
      plan.warnings.push(`checkpoint agent "${agentId}" no longer exists in the scenario (toggle dropped)`);
      continue;
    }
    if (agent.enabled === false) plan.agentDisables.push(agentId);
    if (agent.cognition !== undefined) {
      plan.agentCognition.push({ agentId, cognition: agent.cognition });
    }
  }

  return plan;
}
