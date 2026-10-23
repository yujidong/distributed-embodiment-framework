/**
 * Frame evaluator — the shared "evaluate a ComputationSpec NOW against a
 * runtime and overwrite the service's frame cache" core (R14 Wave-A, §5).
 *
 * Extracted from routes/agreements.ts in living-worlds P1W: the freshness
 * deadline (§8.5) is platform-guaranteed for authoritative world sessions —
 * after every session advance the driver calls
 * `makeStaleFrameRecomputer`'s hook, which needs the SAME evaluation the
 * read route uses (the P1 note: "evaluateFrameNow is route-internal today —
 * extract it before wiring"). One implementation, two callers (manual reads
 * + the session scheduler): frames can never drift between lanes.
 */

import { parseJsonArray, type EnvironmentStore } from './db/environment-store.js';
import type { ServiceInstanceRow, ServiceStore } from './db/service-store.js';
import type { SimulationRecord } from './simulation-registry.js';
import {
  evaluateComputation,
  type ComputationInputs,
  type ComputationMetric,
  type ComputationSpec,
  type DeviceStateUnwrittenView,
  type DeviceView,
  type ZoneView,
} from './computation-evaluator.js';

/** The per-service cached frame JSON (cache is service-scoped, not agreement-scoped). */
export interface StoredDataFrame {
  kind: 'data';
  serviceId: string;
  schemaVersion: number;
  data: Record<string, number | null>;
  /**
   * T57a (R6, u4-F2): present when the spec reads the EVENT window — the
   * window length in SIMULATED seconds plus the source sim's window-rate
   * snapshot, so "no events" can be judged against the ≈real-seconds span
   * (the CLI renders the conversion).
   */
  eventWindowSec?: number;
  effectiveSpeedPerSec?: number;
  provenance: {
    computationKind: string;
    inputsSummary: {
      zones: number;
      devices: number;
      eventsWindowed: number;
      /** T54: present when the value rested entirely on never-written device state. */
      deviceStateUnwritten?: DeviceStateUnwrittenView;
    };
    providerAgentId: string;
    registeredBy: string;
    computedAtWall: string;
    simTimeSec: number;
    /** Sim that computed the frame; the §7 cache fallback keeps it (T57b). */
    simulationId: string | null;
  };
}

export interface FrameEvaluatorDeps {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  simEventTallies: { eventsOf(simId: string): Array<{ eventType: string; simTimeSec: number }> };
}

/**
 * T84 (R10, u1-F3): the shared input-gathering half of a frame evaluation —
 * zones from the snapshot, the provider agent's bound devices (∩ snapshot,
 * capability-labeled) and the T54 written-paths oracle. One gatherer, two
 * callers (the frame lane below and the signability read-source probe), so
 * the pre-signing judgment can never drift from the read-time verdict.
 */
function gatherComputationInputs(
  deps: FrameEvaluatorDeps,
  service: ServiceInstanceRow,
  record: SimulationRecord,
): { inputs: ComputationInputs; snapshot: ReturnType<SimulationRecord['runtime']['getSnapshot']> } {
  const snapshot = record.runtime.getSnapshot();
  const zones: ZoneView[] = snapshot.zones.map(zone => ({
    id: zone.id,
    parameters: zone.parameters,
    ...(zone.occupancy !== undefined ? { occupancy: zone.occupancy } : {}),
  }));
  // Privacy boundary (§2.3): device inputs are the PROVIDER agent's bound
  // devices only — the consumer never touches other tenants' device rows,
  // and the frame never carries per-device identities anyway.
  const devices: DeviceView[] = [];
  // T54 (R6 u4-F1): the placeholder oracle — per-device state paths written
  // at least once in this runtime. A value aggregated off never-written
  // scenario initialState is a placeholder, not a measurement; the evaluator
  // flags such fields and the read gate refuses them.
  const writtenDeviceStatePaths: Record<string, string[]> = {};
  let writtenPathsKnown = false;
  const agent = deps.envStore.getAgent(service.provider_agent_id);
  if (agent) {
    for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
      const deviceRow = deps.envStore.getDevice(deviceId);
      const snapshotDevice = snapshot.devices.find(device => device.id === deviceId);
      if (!deviceRow || !snapshotDevice) continue;
      devices.push({
        id: deviceId,
        capabilities: parseJsonArray<string>(deviceRow.capabilities_json),
        state: snapshotDevice.state,
      });
      const written = record.runtime.getDeviceWrittenPaths?.(deviceId);
      if (written !== undefined) {
        writtenDeviceStatePaths[deviceId] = written;
        writtenPathsKnown = true;
      }
    }
  }
  return {
    inputs: {
      zones,
      devices,
      events: deps.simEventTallies.eventsOf(record.id),
      simTimeSec: record.runtime.getSimTimeSec(),
      // Only hand the evaluator a map when the runtime could say SOMETHING —
      // an entirely-unknown runtime keeps the unwritten gate silent.
      ...(writtenPathsKnown ? { writtenDeviceStatePaths } : {}),
    },
    snapshot,
  };
}

/**
 * Evaluate a computation NOW against the target sim (pure aggregation over
 * the snapshot + the provider agent's bound devices + the sim's event tally)
 * and overwrite the service's frame cache. Returns the stored frame.
 */
export function evaluateDataFrameNow(
  deps: FrameEvaluatorDeps,
  args: {
    service: ServiceInstanceRow;
    computation: NonNullable<ReturnType<ServiceStore['computationOf']>>;
    record: SimulationRecord;
  },
): StoredDataFrame {
  const { service, computation, record } = args;
  const spec = JSON.parse(computation.spec_json) as ComputationSpec;
  const { inputs, snapshot } = gatherComputationInputs(deps, service, record);
  const result = evaluateComputation(spec, inputs);
  const frame: StoredDataFrame = {
    kind: 'data',
    serviceId: service.id,
    schemaVersion: computation.schema_version,
    data: result.data,
    // T57a: the event window's clock semantics ride every evaluated frame —
    // windowSec is SIMULATED seconds; the rate is the source sim's
    // schedule-worthy window average (falling back to the instant estimate,
    // then the nominal speed — each honestly derived, never fabricated).
    ...((spec.metrics ?? []).some(metric => metric.source === 'event')
      ? {
          eventWindowSec: Math.max(
            ...(spec.metrics ?? [])
              .filter((metric): metric is Extract<ComputationMetric, { source: 'event' }> => metric.source === 'event')
              .map(metric => metric.windowSec),
          ),
          effectiveSpeedPerSec:
            snapshot.effectiveSpeedWindowPerSec ?? snapshot.effectiveSpeedPerSec ?? snapshot.speed,
        }
      : {}),
    provenance: {
      computationKind: computation.kind,
      inputsSummary: result.inputsSummary,
      providerAgentId: service.provider_agent_id,
      registeredBy: computation.registered_by,
      computedAtWall: new Date().toISOString(),
      simTimeSec: record.runtime.getSimTimeSec(),
      simulationId: record.id,
    },
  };
  deps.serviceStore.saveFrame({
    serviceId: service.id,
    frameJson: JSON.stringify(frame),
    computedAtWall: frame.provenance.computedAtWall,
    simulationId: record.id,
    simTimeSec: frame.provenance.simTimeSec,
  });
  return frame;
}

/**
 * T84 (R10, u1-F3): the pre-signing READ-SOURCE writability face. A
 * computation whose value metrics read DEVICE state that the probed world
 * has never written is "signable but not readable" — reads FROM THAT WORLD
 * will honestly 409 COMPUTATION_DEVICE_STATE_UNWRITTEN (the T54 gate). T86
 * (R11, u1-F1): the probed world is the read DEFAULT lane's own choice (the
 * shared adjudication in agreements/targeting.ts), and the face names WHICH
 * lane's world was judged — `probedLane` — so the catalog copy can layer the
 * promise honestly (an own-sim verdict does NOT speak for the sim-less
 * fallback to the world session, whose values come from world
 * initialization). This probe reuses the EXACT oracle the read gate speaks
 * (gatherComputationInputs' written-paths map + evaluateComputation's
 * deviceStateUnwritten verdict) against a LIVE world record, so the catalog
 * face and the read-time refusal can never disagree.
 *
 * Returns undefined when there is nothing honest to claim: no computation,
 * no device value metric (the verdict can only fire on avg/min/max device
 * metrics), or the oracle cannot say (written sets unknown). Non-blocking
 * by construction — the caller layers it onto signability.
 */
export interface ReadSourceWritabilityFace {
  status: 'never-written';
  /** Output fields whose reads will honestly refuse until something writes. */
  fields: string[];
  /** The world the judgment was probed against (named for honesty). */
  simulationId: string;
  /**
   * T86: which read lane's default world was judged — 'own-sim' (the
   * viewer's own running sim, the default read target when she has one) or
   * 'world-session' (the authoritative session, the target when she does
   * not). The layered promise hangs off this: an own-sim verdict must not
   * claim the sim-less fallback refuses too.
   */
  probedLane: 'own-sim' | 'world-session';
}

export function readSourceWritabilityOf(
  deps: FrameEvaluatorDeps,
  service: ServiceInstanceRow,
  record: SimulationRecord,
  probedLane: ReadSourceWritabilityFace['probedLane'],
): ReadSourceWritabilityFace | undefined {
  let spec: ComputationSpec;
  try {
    const computation = deps.serviceStore.computationOf(service.id);
    if (computation === undefined) return undefined;
    spec = JSON.parse(computation.spec_json) as ComputationSpec;
  } catch {
    return undefined; // unreadable stored spec — the read lane owns that refusal
  }
  const hasDeviceValueMetric = (spec.metrics ?? []).some(
    metric =>
      metric !== null && typeof metric === 'object' && metric.source === 'device' &&
      (metric.fn === 'avg' || metric.fn === 'min' || metric.fn === 'max'),
  );
  if (!hasDeviceValueMetric) return undefined;
  try {
    const { inputs } = gatherComputationInputs(deps, service, record);
    const unwritten = evaluateComputation(spec, inputs).inputsSummary.deviceStateUnwritten;
    if (unwritten === undefined || unwritten.fields.length === 0) return undefined;
    return { status: 'never-written', fields: unwritten.fields, simulationId: record.id, probedLane };
  } catch {
    return undefined; // a probe must never take a catalog face down
  }
}

/**
 * Living-worlds P1W (§8.5, the deadline's platform half): after a session
 * advance, overwrite the cached frame of every computation-backed service
 * whose active data-read agreement carries a minFreshnessSec floor the cache
 * is about to violate. Column-authoritative staleness check (the R14
 * lesson): computed_at_wall is read from the ROW, not the cached JSON.
 * Never throws — the scheduler hook must not take the world down.
 */
export function makeStaleFrameRecomputer(
  deps: FrameEvaluatorDeps & {
    // v60: service_id is nullable (retired rows) — they are never active,
    // so the loop below simply skips them.
    agreementStore: { agreementsOfEnv(envId: string): Array<{ status: string; terms_json: string; service_id: string | null }> };
  },
  options: { nowMs?: () => number } = {},
): (envId: string, record: SimulationRecord) => void {
  const now = options.nowMs ?? Date.now;
  return (envId: string, record: SimulationRecord): void => {
    let agreements: Array<{ status: string; terms_json: string; service_id: string | null }>;
    try {
      agreements = deps.agreementStore.agreementsOfEnv(envId);
    } catch {
      return; // store faults never take the scheduler down
    }
    for (const agreement of agreements) {
      if (agreement.status !== 'active' || agreement.service_id === null) continue;
      try {
        const terms = JSON.parse(agreement.terms_json) as { read?: { minFreshnessSec?: unknown } };
        const floor = terms.read?.minFreshnessSec;
        if (typeof floor !== 'number' || !Number.isFinite(floor) || floor <= 0) continue;
        const service = deps.serviceStore.getService(agreement.service_id);
        if (service === undefined) continue;
        const computation = deps.serviceStore.computationOf(service.id);
        if (computation === undefined) continue;
        const cached = deps.serviceStore.latestFrameOf(service.id);
        if (cached !== undefined) {
          const computedAt = Date.parse(cached.computed_at_wall);
          if (Number.isFinite(computedAt) && computedAt + floor * 1000 > now()) {
            continue; // still inside the contract — no recompute
          }
        }
        evaluateDataFrameNow(deps, { service, computation, record });
      } catch {
        // One bad agreement/service must not block the rest — skip it.
      }
    }
  };
}
