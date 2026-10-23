/**
 * zone-state — the EngineRuntime zone-state segment (arch-guard (a)
 * extraction, same ceiling push as physics-integration/tick-loop). Free
 * functions over explicit seams; behavior moved verbatim, no logic change.
 *
 * Contents: setZoneOccupancy (B-B occupancy model — virtual effect sources
 * at the zone center), getZoneOccupancy, updateZoneBaseline (B-B externally
 * driven baseline updates).
 */

import {
  DEFAULT_OCCUPANCY_CO2_RATE_PPM_S,
  DEFAULT_OCCUPANCY_HEAT_W,
  DEFAULT_STOREY_HEIGHT_M,
  zoneCenter,
  zoneWriteRadius,
} from './world.js';

export interface ZoneStateSeams {
  readonly zones: ReadonlyArray<{ id: string } & Record<string, unknown>>;
  readonly meta: { storeyHeight?: number; occupancyHeatW?: number; occupancyCo2Rate?: number };
  readonly zoneOccupancy: Map<string, number>;
  readonly physicalEnv: {
    setParameterBaseline(parameter: string, zoneId: string, value: number | boolean): unknown;
    setParameterValue(parameter: string, zoneId: string, value: number | boolean): unknown;
    getPhysicsLayer?: () => {
      registerDeviceEffect?: (effect: Record<string, unknown>) => unknown;
      unregisterDeviceEffect?: (sourceId: string) => unknown;
    } | undefined;
  };
  assertNotStopped(operation: string): void;
}

/**
 * Set the current headcount of a zone (B-B occupancy model). Registers
 * (or replaces) the zone's occupancy effect sources with the physics
 * layer — a virtual EffectSource at the zone center contributing
 * `occupancy × occupancyHeatW` sensible heat and
 * `occupancy × occupancyCo2Rate` CO2 emission — following the same
 * mount path as device effects. Zero headcount removes the sources.
 */
export function setZoneOccupancy(seams: ZoneStateSeams, zoneId: string, occupancy: number): void {
  seams.assertNotStopped('setZoneOccupancy');
  const zone = seams.zones.find(z => z.id === zoneId);
  if (!zone) {
    throw new Error(`EngineRuntime.setZoneOccupancy: unknown zone "${zoneId}"`);
  }
  if (!Number.isFinite(occupancy) || occupancy < 0) {
    throw new Error(`EngineRuntime.setZoneOccupancy: occupancy for "${zoneId}" must be a number >= 0`);
  }
  seams.zoneOccupancy.set(zoneId, occupancy);

  const physicsLayer = seams.physicalEnv.getPhysicsLayer?.();
  const sourceId = `occupancy:${zoneId}`;
  if (occupancy <= 0) {
    physicsLayer?.unregisterDeviceEffect?.(sourceId);
    return;
  }

  // Zones without bounds keep legacy global behavior — no spatial center
  // to mount an effect source at, so occupancy has no physical effect.
  const center = zoneCenter(zone as never, seams.meta.storeyHeight ?? DEFAULT_STOREY_HEIGHT_M);
  if (!center || !physicsLayer?.registerDeviceEffect) return;

  const heatW = seams.meta.occupancyHeatW ?? DEFAULT_OCCUPANCY_HEAT_W;
  const co2Rate = seams.meta.occupancyCo2Rate ?? DEFAULT_OCCUPANCY_CO2_RATE_PPM_S;
  const affectedArea = { location: zoneId, radius: zoneWriteRadius(zone as never), position: center };

  // Same (deviceId, parameter) pair is REPLACED by the physics layer, so
  // repeated occupancy updates never stack duplicate sources.
  physicsLayer.registerDeviceEffect({
    deviceId: sourceId,
    parameter: 'temperature',
    effect: 'heating',
    magnitude: occupancy * heatW,
    affectedArea,
  });
  physicsLayer.registerDeviceEffect({
    deviceId: sourceId,
    parameter: 'co2',
    effect: 'pollutant',
    magnitude: occupancy * co2Rate,
    affectedArea,
  });
}

/** B-B: externally driven baseline update (weather feeds, twin-sync pushes). */
export function updateZoneBaseline(
  seams: ZoneStateSeams,
  zoneId: string,
  parameter: string,
  value: number | boolean,
): void {
  seams.assertNotStopped('updateZoneBaseline');
  const zone = seams.zones.find(z => z.id === zoneId);
  if (!zone) {
    throw new Error(`EngineRuntime.updateZoneBaseline: unknown zone "${zoneId}"`);
  }
  if (zoneCenter(zone as never) !== undefined) {
    seams.physicalEnv.setParameterBaseline(parameter, zoneId, value);
  } else {
    seams.physicalEnv.setParameterValue(parameter, zoneId, value);
  }
}
