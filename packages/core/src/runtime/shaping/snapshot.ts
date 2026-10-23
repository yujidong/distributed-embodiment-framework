/**
 * Snapshot assembly — EngineSnapshot / zone-env / services / llm / collaborations — pure shaping (L2), see docs/architecture-runtime.md
 *
 * Deterministic, no engine state, no I/O. Types come from ../contract.js.
 */
import type { LLMCacheStats } from '@active-collaboration/llm-integration';
import { localizedText } from '@active-collaboration/shared';
import type { ScenarioAgent, ScenarioDefinition, ScenarioDevice } from '../../scenario/index.js';
import { TrajectoryRecorder } from '../../trajectory/index.js';
import { resolveHumanNarrative, SNAPSHOT_PARAMETERS } from './world.js';
import type {
  EngineRuntimeState,
  EngineSnapshot,
  FaultProfile,
  InjectedEventRecord,
  RuntimeCollaborationRecord,
  RuntimeDecisionRecord,
  RuntimeDevice,
  ScheduledEventFireRecord,
} from '../contract.js';
import type { SystemEvent } from '../../events/index.js';

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Snapshot assembly (Fix-31 slice 2, R15-E2) — pure shaping of the engine
// snapshot from raw materials. EngineRuntime.getSnapshot() collects the
// materials (physics reads, agent introspection, service registrations,
// per-agent triage metrics) and delegates here; this module stays free of
// CognitiveAgent/EnvironmentCenter imports via structural input types.
// ---------------------------------------------------------------------------

/**
 * T-012: cap on `recentDecisions` embedded in snapshots. The runtime's ring
 * buffer holds MAX_RECENT_DECISIONS (50) and each record carries the agent's
 * full reasoning, so an untrimmed array is the main driver of snapshot-size
 * growth over a run (a subscriber at speed 30 was measured receiving
 * 1.25MB/s once the ring filled). 20 matches what consumers actually show
 * (the web LivePanels slice to 20; ControlBar reads only the newest entry).
 */
export const MAX_SNAPSHOT_RECENT_DECISIONS = 20;

/**
 * T-012: cap on `scheduledEvents` embedded in snapshots. The next upcoming
 * events are what consumers need (ControlBar's countdown, the UI's event
 * list); fired events matter only briefly as timeseries markers, so the
 * most recently fired ones are kept as filler when upcoming events do not
 * exhaust the cap.
 */
export const MAX_SNAPSHOT_SCHEDULED_EVENTS = 50;

/** R102: cap on the runtime-injected events embedded in snapshots. */
export const MAX_SNAPSHOT_INJECTED_EVENTS = 50;

/** Structural agent-introspection surface the agents section needs. */
export interface SnapshotAgentLike {
  getDualTriggerACManager(): { getActiveACs(): unknown[] } | null | undefined;
  getDualTriggerStats(): { totalEventsProcessed: number };
  getActiveCollaborations(): Array<{ id: string; name: string; status: string }>;
}/** Structural per-agent runtime wiring info (EngineRuntime.agentRuntimeInfo). */
export interface SnapshotAgentInfo {
  managedZoneIds: string[];
  boundDeviceIds: string[];
  llmEnabled: boolean;
}/** Structural EnvironmentCenter service registration row. */
export interface SnapshotServiceRegistration {
  service: {
    id: string;
    name: string;
    providerAgentId?: string;
    capabilities?: string[];
    category?: string;
    actionType?: string;
  };
  agentId: string;
  deviceId?: string;
}/** P4-2 per-agent triage counters (DualTriggerACManager.getTriageMetrics). */
export interface SnapshotTriageMetrics {
  triageCalls: number;
  triageErrors: number;
  agreements: number;
  disagreements: number;
  bigModelCalls: number;
  bigModelCallsSaved: number;
  avgTriageLatencyMs: number | null;
  avgBigModelLatencyMs: number | null;
}/** Everything the pure snapshot builders need, collected by the runtime. */
export interface SnapshotInput {
  runtimeId: string;
  scenario: Pick<ScenarioDefinition, 'meta' | 'zones' | 'devices' | 'agents' | 'events'>;
  state: EngineRuntimeState;
  simTimeSec: number;
  simTimeIso: string;
  speed: number;
  tickCount: number;
  lastTickWallMs: number;
  autoThrottled: boolean;
  /** T3 (R2, B1-11): the CONFIGURED tick interval (ms) — the nominal rate base. */
  tickMs: number;
  /**
   * T43 (R4): trailing-window speed projection from the runtime's sampler
   * (shaping/speed-window), collected only while running. Undefined with
   * <2 tick intervals — the window fields stay honestly absent.
   */
  speedWindow?: { perSec: number; windowSec: number };
  /** Zone parameter read (physicalEnv.getParameterValue); errors = undefined. */
  getParameterValue: (parameter: string, zoneId: string) => number | boolean | undefined;
  /**
   * T-606 (R26): parameter names this runtime has actually written via event
   * injection — unioned into every zone's parameter set (see
   * zoneParameterNames) so condition flows can observe custom parameters
   * no baseline declares. Optional: core-only consumers keep the T-304 union.
   */
  injectedParameterNames?: ReadonlySet<string>;
  zoneOccupancy: ReadonlyMap<string, number>;
  devicesById: ReadonlyMap<string, RuntimeDevice>;
  getDeviceFault: (deviceId: string) => FaultProfile | null;
  agents: ReadonlyMap<string, SnapshotAgentLike>;
  agentRuntimeInfo: ReadonlyMap<string, SnapshotAgentInfo>;
  reputationSummarize: (
    agentId: string,
  ) => EngineSnapshot['agents'][number]['reputation'];
  recentDecisions: readonly RuntimeDecisionRecord[];
  firedEventIds: ReadonlySet<string>;
  /**
   * R102 event observability: per-event fire outcomes recorded by the
   * scheduler (effect on success, error on rejection). Optional — core-only
   * consumers without a scheduler leave the snapshot fields absent.
   */
  firedEventDetails?: ReadonlyMap<string, ScheduledEventFireRecord>;
  /** R102: the runtime's injected-event log (recent-first ring, capped). */
  injectedEvents?: readonly InjectedEventRecord[];
  /** envCenter.getServices() Map or any iterable of rows/tuples. */
  serviceRegistrations: Iterable<SnapshotServiceRegistration | [unknown, SnapshotServiceRegistration]>;
  /** Shared LLM response cache, when enabled. */
  llmCache: { getStats(): LLMCacheStats } | null | undefined;
  /** Failed LLM decision calls aggregated across agents (T-105). */
  llmErrors: number;
  /** Triage aggregation input, when triage is enabled. */
  triage: {
    mode: 'shadow' | 'enforce';
    model: string | undefined;
    metrics: SnapshotTriageMetrics[];
  } | null;
}/** Phase 8: shape the EnvironmentCenter service registry for snapshots. */
export function buildServicesSnapshot(
  registrations: Iterable<SnapshotServiceRegistration | [unknown, SnapshotServiceRegistration]>,
): NonNullable<EngineSnapshot['services']> {
  const services: NonNullable<EngineSnapshot['services']> = [];
  for (const entry of registrations) {
    const reg = Array.isArray(entry) ? entry[1] : entry;
    services.push({
      id: reg.service.id,
      name: reg.service.name,
      providerAgentId: reg.service.providerAgentId ?? reg.agentId,
      deviceId: reg.deviceId,
      capabilities: reg.service.capabilities ?? [],
      category: reg.service.category ?? '',
      actionType: reg.service.actionType,
    });
  }
  return services;
}/** P4-2: cache + triage aggregation; undefined when neither is active. */
export function buildLlmSnapshot(input: SnapshotInput): EngineSnapshot['llm'] {
  const llm: NonNullable<EngineSnapshot['llm']> = {};
  let hasAny = false;

  if (input.llmCache) {
    llm.cache = input.llmCache.getStats();
    hasAny = true;
  }

  // T-105: surface failed decision calls — a dead backend otherwise leaves
  // no API-visible trace (no decision record, sim keeps looking healthy).
  if (input.llmErrors > 0) {
    llm.llmErrors = input.llmErrors;
    hasAny = true;
  }

  if (input.triage !== null) {
    const totals = {
      triageCalls: 0,
      triageErrors: 0,
      agreements: 0,
      disagreements: 0,
      bigModelCalls: 0,
      bigModelCallsSaved: 0,
      triageLatencySum: 0,
      bigLatencySum: 0,
    };
    for (const m of input.triage.metrics) {
      totals.triageCalls += m.triageCalls;
      totals.triageErrors += m.triageErrors;
      totals.agreements += m.agreements;
      totals.disagreements += m.disagreements;
      totals.bigModelCalls += m.bigModelCalls;
      totals.bigModelCallsSaved += m.bigModelCallsSaved;
      if (m.avgTriageLatencyMs !== null) totals.triageLatencySum += m.avgTriageLatencyMs * m.triageCalls;
      if (m.avgBigModelLatencyMs !== null) totals.bigLatencySum += m.avgBigModelLatencyMs * m.bigModelCalls;
    }
    const comparisons = totals.agreements + totals.disagreements;
    const triaged = totals.bigModelCalls + totals.bigModelCallsSaved;
    const avgTriage = totals.triageCalls > 0 ? totals.triageLatencySum / totals.triageCalls : null;
    const avgBig = totals.bigModelCalls > 0 ? totals.bigLatencySum / totals.bigModelCalls : null;
    llm.triage = {
      mode: input.triage.mode,
      model: input.triage.model,
      triageCalls: totals.triageCalls,
      triageErrors: totals.triageErrors,
      agreements: totals.agreements,
      disagreements: totals.disagreements,
      agreementRate: comparisons > 0 ? totals.agreements / comparisons : null,
      bigModelCalls: totals.bigModelCalls,
      bigModelCallsSaved: totals.bigModelCallsSaved,
      bigModelCallSaveRate: triaged > 0 ? totals.bigModelCallsSaved / triaged : 0,
      avgTriageLatencyMs: avgTriage,
      avgBigModelLatencyMs: avgBig,
      latencyDeltaMs: avgTriage !== null && avgBig !== null ? avgBig - avgTriage : null,
    };
    hasAny = true;
  }

  return hasAny ? llm : undefined;
}/**
 * T-606 (R26, SC26-F02): the per-zone parameter-name union, extracted ONCE
 * so both snapshot builders stay on the same set:
 *   SNAPSHOT_PARAMETERS ∪ the zone's DECLARED baseline keys (T-304) ∪
 *   parameters this runtime has actually WRITTEN via event injection.
 * The injection-history growth is what lets condition flows observe custom
 * parameters (e.g. badge-anomaly-count) that no baseline declares — the
 * union grows as injections land, so a condition authored before the first
 * injection simply has not fired yet (no backdating, no synthetic runs).
 * Pure union, nothing domain-specific (the T-304 lesson).
 */
function zoneParameterNames(
  baseline: Record<string, number | boolean> | undefined,
  injectedNames?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>(SNAPSHOT_PARAMETERS);
  const names = [...SNAPSHOT_PARAMETERS];
  for (const name of Object.keys(baseline ?? {})) {
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  for (const name of injectedNames ?? []) {
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  return names;
}

/**
 * Constructor step 4 (R26 extraction from EngineRuntime — pure assembly):
 * build the optional TrajectoryRecorder. T-014: attribute the trajectory
 * file to the model the injected client will actually call (the same model
 * the server reports), not the scenario-declared llm.model — the two drift
 * when the client is configured from an env knob or override. T-601: null
 * llmPerAgent entries are explicit opt-outs, not clients. P0 resume
 * appends; P2 threads the per-segment cap (core default otherwise).
 */
export function createTrajectoryRecorder(
  scenario: Pick<ScenarioDefinition, 'meta' | 'agents'>,
  options: {
    trajectoryDir?: string;
    trajectoryAppend?: boolean;
    trajectorySegmentBytes?: number;
    llmClient?: { getModel?(): string };
    llmPerAgent?: Record<string, { getModel?(): string } | null>;
  },
): TrajectoryRecorder | null {
  if (options.trajectoryDir === undefined) return null;
  const hasLLM = options.llmClient !== undefined ||
    Object.values(options.llmPerAgent ?? {}).some(c => c != null);
  const clientModel = options.llmClient?.getModel?.() ??
    Object.values(options.llmPerAgent ?? {})[0]?.getModel?.();
  return new TrajectoryRecorder({
    outputDir: options.trajectoryDir,
    condition: 'engine-runtime',
    scenario: scenario.meta.id,
    iteration: 0,
    model: clientModel ??
      scenario.agents.find(a => a.llm != null)?.llm?.model ??
      (hasLLM ? 'provided-client' : 'rule-only'),
    ...(options.trajectoryAppend === true ? { append: true } : {}),
    ...(options.trajectorySegmentBytes !== undefined
      ? { segmentMaxBytes: options.trajectorySegmentBytes }
      : {}),
  });
}

/** The full EngineSnapshot — pure shaping over SnapshotInput. */
export function buildEngineSnapshot(input: SnapshotInput): EngineSnapshot {
  const zones = input.scenario.zones.map(zone => {
    const parameters: Record<string, number | boolean> = {};
    // T-061: same generic union as buildZoneEnvSnapshot (T-304) — the
    // user-facing snapshot exposes the standard seven ∪ the zone's DECLARED
    // baseline keys, so custom domain quantities are VISIBLE (timeline
    // zone-samples read this shape too), not just condition-evaluable.
    // T-606: ∪ runtime-injected names (see zoneParameterNames).
    const paramNames = zoneParameterNames(zone.baseline, input.injectedParameterNames);
    for (const param of paramNames) {
      const value = input.getParameterValue(param, zone.id);
      if (typeof value === 'number' || typeof value === 'boolean') {
        parameters[param] = value;
      }
    }
    return {
      id: zone.id,
      name: zone.name,
      type: zone.type,
      parameters,
      ...(zone.baseline !== undefined ? { baseline: { ...zone.baseline } } : {}),
      // R98: occupancy is ALWAYS exposed (0 when the zone never declared or
      // received a headcount) — a missing field made "event fired but the
      // world didn't change" indistinguishable from "field not exposed".
      occupancy: input.zoneOccupancy.get(zone.id) ?? 0,
    };
  });

  const devices = input.scenario.devices.map(deviceDef => {
    const device = input.devicesById.get(deviceDef.id);
    let state: Record<string, unknown> = {};
    try {
      state = { ...(device?.getState() ?? {}) };
    } catch {
      // Device state unavailable — keep empty
    }
    // Executable commands: ask the device itself (SimulatedDevice derives
    // the list from its capabilities and registered command handlers — the
    // "declared = executable" contract). Devices that cannot introspect
    // fall back to their declared capability names.
    let commands: string[] = [...deviceDef.capabilities];
    const introspectable = device as (RuntimeDevice & { getExecutableCommands?: () => string[] }) | undefined;
    if (typeof introspectable?.getExecutableCommands === 'function') {
      try {
        commands = introspectable.getExecutableCommands();
      } catch {
        // Keep the declared-capability fallback
      }
    }
    return {
      id: deviceDef.id,
      name: deviceDef.name,
      type: deviceDef.type,
      role: deviceDef.role,
      zoneId: deviceDef.zoneId,
      state,
      commands,
      fault: input.getDeviceFault(deviceDef.id),
    };
  });

  const agents = input.scenario.agents.map((agentDef: ScenarioAgent) => {
    const agent = input.agents.get(agentDef.id);
    const info = input.agentRuntimeInfo.get(agentDef.id);
    let activeACCount = 0;
    let eventsProcessed = 0;
    let activeCollaborations: Array<{ id: string; name: string; status: string }> = [];
    if (agent) {
      try {
        activeACCount = agent.getDualTriggerACManager()?.getActiveACs().length ?? 0;
        eventsProcessed = agent.getDualTriggerStats().totalEventsProcessed;
        activeCollaborations = agent.getActiveCollaborations();
      } catch {
        // Agent introspection unavailable — keep zeros
      }
    }
    return {
      id: agentDef.id,
      name: agentDef.name,
      capabilities: [...agentDef.capabilities],
      managedZoneIds: info?.managedZoneIds ?? [],
      boundDeviceIds: info?.boundDeviceIds ?? [],
      llmEnabled: info?.llmEnabled ?? false,
      activeACCount,
      eventsProcessed,
      activeCollaborations,
      reputation: input.reputationSummarize(agentDef.id),
    };
  });

  const scheduledEvents = input.scenario.events.map(event => {
    // R98 event observability: a fired event carries WHAT it did (resolved
    // effect) or WHY it did nothing (rejection error) — "fired:true with no
    // trace" is no longer a possible state.
    const fire = input.firedEventDetails?.get(event.id);
    return {
      id: event.id,
      type: event.type,
      zoneId: event.zoneId,
      atSimTimeSec: event.atSimTimeSec,
      fired: input.firedEventIds.has(event.id),
      ...(fire !== undefined ? { firedAtSimTimeSec: fire.firedAtSimTimeSec } : {}),
      ...(fire?.effect !== undefined ? { effect: fire.effect } : {}),
      ...(fire?.error !== undefined ? { error: fire.error } : {}),
      // Wave A3: surface acRationale for UI badges
      ...(event.acRationale ? { acRationale: { verdict: event.acRationale.verdict, score: event.acRationale.score } } : {}),
      ...resolveHumanNarrative(event.humanNarrative),
    };
  });

  return {
    runtimeId: input.runtimeId,
    scenarioId: input.scenario.meta.id,
    scenarioName: localizedText(input.scenario.meta.name, 'zh-CN'),
    state: input.state,
    simTimeSec: input.simTimeSec,
    simTime: input.simTimeIso,
    speed: input.speed,
    tickCount: input.tickCount,
    ...(input.lastTickWallMs > 0 ? { tickWallMs: input.lastTickWallMs } : {}),
    autoThrottled: input.autoThrottled,
    // T3 (R2, B1-11): the real-advancement face. `speed` is NOMINAL (sim-s
    // per tick); the self-scheduling loop stretches the interval to
    // max(tickMs, ceil(lastTickWallMs × 1.2) + 1) when ticks cost more than
    // the budget (LLM decisions, event-loop lag — EngineRuntime.nextTickDelay).
    // effectiveSpeedPerSec divides the nominal speed by that EFFECTIVE
    // interval: an instantaneous estimate around the last tick; it fluctuates with LLM
    // load — a planning aid, never a promise. Absent unless running and the
    // loop has ticked at least once (honest "—" over a fake number).
    tickMs: input.tickMs,
    ...(input.state === 'running' && input.lastTickWallMs > 0
      ? {
          effectiveSpeedPerSec:
            input.speed / (Math.max(input.tickMs, Math.ceil(input.lastTickWallMs * 1.2) + 1) / 1000),
        }
      : {}),
    // T43: the schedule-worthy window average beside the instantaneous
    // estimate above — present only while running AND once the sampler has
    // two completed tick intervals (the CLI renders "instant / window avg").
    ...(input.state === 'running' && input.speedWindow !== undefined
      ? {
          effectiveSpeedWindowPerSec: input.speedWindow.perSec,
          effectiveSpeedWindowSec: input.speedWindow.windowSec,
        }
      : {}),
    zones,
    devices,
    agents,
    // T-012: keep only the newest entries — the ring holds up to
    // MAX_RECENT_DECISIONS (50) but the snapshot is re-serialized onto
    // every WebSocket subscriber every snapshot cadence, and decision
    // records carry full reasoning text (the snapshot-growth driver).
    recentDecisions: input.recentDecisions.slice(-MAX_SNAPSHOT_RECENT_DECISIONS),
    scheduledEvents: capScheduledEvents(scheduledEvents),
    // R102: runtime injections ride the same snapshot face (one query
    // surface for "what has this world been through") — scenario-scheduled
    // firings stay in scheduledEvents, not duplicated here.
    injectedEvents: (input.injectedEvents ?? [])
      .filter(record => !input.scenario.events.some(event => event.id === record.eventId))
      .slice(-MAX_SNAPSHOT_INJECTED_EVENTS)
      .map(record => ({ ...record, targetAgentIds: [...record.targetAgentIds] })),
    // Phase 8: surface published services for UI observability.
    services: buildServicesSnapshot(input.serviceRegistrations),
    llm: buildLlmSnapshot(input),
  };
}

/**
 * T-012: bound the scheduledEvents section to MAX_SNAPSHOT_SCHEDULED_EVENTS
 * entries — large scenarios (env-bridged worlds with many scheduled events)
 * otherwise embed the full list in every snapshot. Upcoming (unfired) events
 * win, soonest first; leftover slots keep the most recently fired events so
 * marker consumers (web timeseries markLines) still observe fresh fires.
 * Lists at or below the cap pass through untouched (declaration order).
 */
function capScheduledEvents(
  events: EngineSnapshot['scheduledEvents'],
): EngineSnapshot['scheduledEvents'] {
  if (events.length <= MAX_SNAPSHOT_SCHEDULED_EVENTS) return events;

  const upcoming = events
    .filter(event => !event.fired)
    .sort((a, b) => (a.atSimTimeSec ?? Number.POSITIVE_INFINITY) - (b.atSimTimeSec ?? Number.POSITIVE_INFINITY));
  const firedDesc = events
    .filter(event => event.fired)
    .sort((a, b) => (b.atSimTimeSec ?? Number.NEGATIVE_INFINITY) - (a.atSimTimeSec ?? Number.NEGATIVE_INFINITY));

  if (upcoming.length >= MAX_SNAPSHOT_SCHEDULED_EVENTS) {
    return upcoming.slice(0, MAX_SNAPSHOT_SCHEDULED_EVENTS);
  }
  return [
    ...upcoming,
    ...firedDesc.slice(0, MAX_SNAPSHOT_SCHEDULED_EVENTS - upcoming.length),
  ];
}// ---------------------------------------------------------------------------
// Zone-env snapshot + reputation subscription parsing (Fix-31 slice 6)
// ---------------------------------------------------------------------------

/** NFR-1 thermal comfort per zone (ASHRAE 55 PMV/PPD). */
export interface ZoneComfortSource {
  getZoneComfort?: (loc: string) => { pmv: number; ppd: number; sensation: string; comfortLevel: string } | undefined;
}/**
 * Environment snapshot for flow condition evaluation: per-zone parameters
 * shaped as `{ zoneId: { param: value } }` with occupancy and NFR-1 comfort
 * merged in. Never throws — unreadable parameters are omitted per zone.
 *
 * T-304: the per-zone parameter set is SNAPSHOT_PARAMETERS ∪ the zone's
 * DECLARED baseline keys — custom domain quantities (any key outside the
 * standard seven) ride along so condition triggers can evaluate them
 * (EN-F05: `roof.pvOutputW > 12000` could never fire when the snapshot
 * only ever exposed the standard fields). Generic union, nothing
 * domain-specific.
 */
export function buildZoneEnvSnapshot(
  zones: ReadonlyArray<{ id: string; baseline?: Record<string, number | boolean> }>,
  input: {
    getParameterValue: (parameter: string, zoneId: string) => number | boolean | undefined;
    /** T-606 (R26): injection-written names join the union (see zoneParameterNames). */
    injectedParameterNames?: ReadonlySet<string>;
    zoneOccupancy: ReadonlyMap<string, number>;
    comfort?: ZoneComfortSource;
  },
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const zone of zones) {
    const parameters: Record<string, number | boolean> = {};
    const paramNames = zoneParameterNames(zone.baseline, input.injectedParameterNames);
    for (const param of paramNames) {
      const value = input.getParameterValue(param, zone.id);
      if (typeof value === 'number' || typeof value === 'boolean') {
        parameters[param] = value;
      }
    }
    const occupancy = input.zoneOccupancy.get(zone.id);
    if (occupancy !== undefined) parameters.occupancy = occupancy;
    if (input.comfort?.getZoneComfort) {
      try {
        const comfort = input.comfort.getZoneComfort(zone.id);
        if (comfort) {
          (parameters as Record<string, unknown>).comfort = comfort;
        }
      } catch { /* comfort unavailable for this zone */ }
    }
    snapshot[zone.id] = parameters;
  }
  return snapshot;
}