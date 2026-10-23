/**
 * tick-loop — the EngineRuntime tick-loop segment (arch-guard (a)
 * extraction, same ceiling push as physics-integration). Free functions
 * over explicit seams; behavior moved verbatim, no logic change.
 *
 * Contents: tick body (re-entrancy guard + advance + due events + flow
 * evaluation), fireDueEvents (scheduled scenario events + occupancy
 * schedules + effect checks).
 */

import { createLogger } from '@active-collaboration/shared';

import type { ScenarioEvent } from '../scenario/scenario-types.js';
import { applyOccupantScheduleWrites } from './shaping/due-moments.js';
import { scheduledFireRecord } from './shaping/events.js';

const logger = createLogger('RuntimeTickLoop');

export interface TickLoopSeams {
  readonly speed: number;
  readonly simTimeSec: number;
  readonly scenarioEvents: readonly ScenarioEvent[];
  readonly scenarioZones: Parameters<typeof applyOccupantScheduleWrites>[0];
  readonly firedEventIds: Set<string>;
  readonly firedEventDetails: Map<string, unknown>;
  readonly occupancyScheduleFired: Set<string>;
  readonly flowEngine?: { onTick(simTimeSec: number): Promise<unknown> };
  advanceTickBy(strideSec: number): void;
  processDueEffectChecks(): void;
  fireOccupantSchedules(): void;
  injectEvent(event: ScenarioEvent): Promise<{ parameter: string; value: number | boolean } | undefined>;
  setZoneOccupancy(zoneId: string, count: number): void;
}

/** Inject scheduled scenario events whose sim-time has come due. */
export async function fireDueScenarioEvents(seams: TickLoopSeams): Promise<void> {
  seams.processDueEffectChecks();
  // Fix-52a: schedule-driven occupancy — fire setZoneOccupancy at the
  // zone's declared schedule boundaries. Tracks per-zone per-day state so
  // repeatDaily schedules re-fire every simulated day.
  seams.fireOccupantSchedules();
  for (const event of seams.scenarioEvents) {
    if (event.atSimTimeSec === undefined) continue;
    if (seams.firedEventIds.has(event.id)) continue;
    if (event.atSimTimeSec > seams.simTimeSec) continue;
    seams.firedEventIds.add(event.id);
    // T-019: observation-only events are recorded world state (replay-baked
    // zone samples, device-state snapshots, past decisions), not stimuli.
    // They carry their payload in `details` for replay consumers; injecting
    // them would fan one spurious agent decision out per recorded sample
    // (R10: 2326 decisions in one replayed window). Mark fired, never inject.
    if (event.observationOnly === true) continue;
    try {
      const result = await seams.injectEvent(event);
      seams.firedEventDetails.set(event.id, scheduledFireRecord(seams.simTimeSec, result));
    } catch (error) {
      // R98: the rejection is recorded ON the event — fired:true with zero trace is never silent.
      seams.firedEventDetails.set(event.id, scheduledFireRecord(seams.simTimeSec, undefined, error));
      logger.error(`Scheduled event "${event.id}" failed to inject:`, error);
    }
  }
}

/** Fix-52a: setZoneOccupancy at schedule boundaries — due/keys shape is the shaping truth (due-moments), writes only here. */
export function fireOccupantScheduleWrites(seams: TickLoopSeams): void {
  applyOccupantScheduleWrites(seams.scenarioZones, seams.occupancyScheduleFired, seams.simTimeSec, (zoneId, count) => {
    try { seams.setZoneOccupancy(zoneId, count); } catch { /* zone may lack bounds */ }
  });
}

/**
 * Tick-loop body with a re-entrancy guard (a slow tick never overlaps).
 * Flow evaluation stays INSIDE the tick body (advanceTickBy keeps its
 * synchronous signature); the FlowEngine's serial queue makes the awaited
 * call safe even if a slow flow outlives this tick.
 */
export async function runTickBody(
  seams: TickLoopSeams,
  isInProgress: () => boolean,
  setInProgress: (value: boolean) => void,
  noteTickBody: () => void,
): Promise<void> {
  if (isInProgress()) return;
  setInProgress(true);
  try {
    seams.advanceTickBy(seams.speed);
    await fireDueScenarioEvents(seams);
    if (seams.flowEngine) await seams.flowEngine.onTick(seams.simTimeSec);
    noteTickBody();
    // R91 感知：随 tick 体差分世界状态并投递给管理 Agent（观察侧，不改调度）
  } catch (error) {
    logger.error('Tick error:', error);
  } finally {
    setInProgress(false);
  }
}
