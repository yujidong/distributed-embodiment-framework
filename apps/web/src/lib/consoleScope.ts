/**
 * Console scope helpers (T-027): the console's inject/fault forms must only
 * offer targets the RUNNING simulation can actually act on. The console
 * rebuilds its scenario from the FULL environment, but a zone-scoped sim
 * (zoneIds subset) or an imported scenario carries a smaller world — the
 * snapshot is the ground truth for "what exists in THIS run". Intersecting
 * the option lists turns a raw UNKNOWN_ZONE / DEVICE_NOT_FOUND engine error
 * on first submit into an option that was never offered.
 */

import type { EngineSnapshot, ScenarioDefinition } from '../api/types';

/**
 * Scenario zones restricted to the sim snapshot's zone set. No snapshot yet
 * (first poll in flight) → the full scenario list (scope unknown); the
 * effect-driven selection sync in the panels corrects once it arrives.
 */
export function scopedZones(
  zones: ScenarioDefinition['zones'],
  snapshot: EngineSnapshot | null,
): ScenarioDefinition['zones'] {
  if (snapshot === null) return zones;
  const ids = new Set(snapshot.zones.map(zone => zone.id));
  return zones.filter(zone => ids.has(zone.id));
}

/** Scenario devices restricted to the sim snapshot's device set. */
export function scopedDevices(
  devices: ScenarioDefinition['devices'],
  snapshot: EngineSnapshot | null,
): ScenarioDefinition['devices'] {
  if (snapshot === null) return devices;
  const ids = new Set(snapshot.devices.map(device => device.id));
  return devices.filter(device => ids.has(device.id));
}

/** True when the zone exists in the sim's world snapshot (send-side guard). */
export function zoneInSnapshot(snapshot: EngineSnapshot | null, zoneId: string): boolean {
  return snapshot !== null && snapshot.zones.some(zone => zone.id === zoneId);
}

/** True when the device exists in the sim's world snapshot (send-side guard). */
export function deviceInSnapshot(snapshot: EngineSnapshot | null, deviceId: string): boolean {
  return snapshot !== null && snapshot.devices.some(device => device.id === deviceId);
}
