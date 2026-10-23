/**
 * physics-integration — the EngineRuntime physics-integration segment
 * (arch-guard (a) extraction: WS5 coarse-advance pushed EngineRuntime past
 * its size ceiling). Free functions over an explicit seams object; behavior
 * moved verbatim, no logic change.
 */

import { createLogger } from '@active-collaboration/shared';

import { physicsSubstepCount } from './shaping/lod.js';
import type { PhysicsLodTier } from './contract.js';
import { driveEnvironmentBaselines } from './shaping/world.js';
import { applyOutageTransitions, type OutageApplicationSeams } from './power-outage.js';

const logger = createLogger('RuntimePhysicsIntegration');

/** Everything the integration functions need from the runtime. */
export interface PhysicsIntegrationSeams {
  readonly devices: ReadonlyArray<{ id: string; onPhysicsTick?: (dt: number) => unknown }>;
  readonly physicalEnv: {
    simulate(dt: number, dtSim: number): unknown;
    setParameterBaseline(parameter: string, zoneId: string, value: number): unknown;
    getPhysicsLayer?: () => OutageApplicationSeams['physicsLayer'];
  };
  readonly lod: {
    getTier(): PhysicsLodTier;
    noteStep(): void;
    takePending(): number;
  };
  readonly scenarioZones: Parameters<typeof driveEnvironmentBaselines>[0];
  readonly powerOutages: { tick(atSimSec: number): Parameters<typeof applyOutageTransitions>[0] };
  readonly getDeviceState: (id: string) => Record<string, unknown> | undefined;
  readonly publishOutage: OutageApplicationSeams['publish'];
}

/** T-103 (F-PH21): apply the outage state machine's transitions. */
export function applyPowerOutages(
  seams: PhysicsIntegrationSeams,
  atSimSec: number,
): void {
  applyOutageTransitions(seams.powerOutages.tick(atSimSec), {
    getDeviceState: seams.getDeviceState,
    physicsLayer: seams.physicalEnv.getPhysicsLayer?.(),
    publish: seams.publishOutage,
    warn: message => logger.warn(message),
  });
}

/**
 * Integrate `totalSec` of physics (devices + environment; substep math:
 * shaping/lod). The optional coarse override (advanceTo fast-forward)
 * pins the substep explicitly and runs `beforeSubstep` (env baselines,
 * power outages) at each substep's start time — `substepStartSec` is the
 * sim time the integration window starts at.
 */
export function runPhysicsSubsteps(
  seams: PhysicsIntegrationSeams,
  totalSec: number,
  options?: {
    substepSec?: number;
    beforeSubstep?: (atSimSec: number, dt: number) => void;
    substepStartSec?: number;
  },
): void {
  const steps = options?.substepSec !== undefined
    ? Math.max(1, Math.ceil(totalSec / options.substepSec))
    : physicsSubstepCount(totalSec, seams.lod.getTier());
  const dt = totalSec / steps;
  for (let i = 0; i < steps; i++) {
    if (options?.beforeSubstep !== undefined) {
      options.beforeSubstep((options.substepStartSec ?? 0) + i * dt, dt);
    }
    for (const device of seams.devices) {
      try {
        device.onPhysicsTick?.(dt);
      } catch (error) {
        logger.warn(`Device control loop failed for ${device.id} (non-fatal): ${(error as Error).message}`);
      }
    }
    try {
      // simulate(dt, dt) executes exactly one physics step of dt seconds.
      seams.physicalEnv.simulate(dt, dt);
    } catch (error) {
      logger.warn(`Physics step failed (non-fatal): ${(error as Error).message}`);
    }
    seams.lod.noteStep();
  }
}

/** R30 (LOD): integrate idle-banked seconds (tier switch / checkpoint export / read surfaces). */
export function flushIdlePhysics(seams: PhysicsIntegrationSeams): void {
  const flush = seams.lod.takePending();
  if (flush > 0) runPhysicsSubsteps(seams, flush);
}

/**
 * Coarse fast-forward stride body (advanceTo coarse channel): integrate the
 * whole stride in ceil(stride/substepSec) substeps, driving env baselines +
 * outage transitions at each substep's start time (strideStartSec is the
 * sim time the stride window starts at).
 */
export function integrateCoarseStride(
  seams: PhysicsIntegrationSeams,
  strideSec: number,
  substepSec: number,
  strideStartSec: number,
): void {
  runPhysicsSubsteps(seams, strideSec, {
    substepSec,
    beforeSubstep: atSimSec => {
      driveEnvironmentBaselines(seams.scenarioZones, atSimSec, (parameter, zoneId, value) => {
        try { seams.physicalEnv.setParameterBaseline(parameter, zoneId, value); } catch { /* no bounds */ }
      });
      applyPowerOutages(seams, atSimSec);
    },
    substepStartSec: strideStartSec,
  });
}
