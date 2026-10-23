/**
 * Interior walk live-layer mapping (UX-W4) — pure snapshot → overlay
 * transforms shared by useInteriorSimSnapshot (and unit-tested directly):
 *
 * - per-zone readings: temperature / co2 / occupancy ride the snapshot
 *   zone's free-form `parameters` map (occupancy is a first-class param —
 *   same convention as the zone-delta stream frames);
 * - alerts reuse the campus 3D judgment (lib/campus3d zoneAlertLevel:
 *   temperature ≥ 35 °C or smoke true/≥ 0.08) so both overlays agree on
 *   what "critical" means;
 * - recent events come from snapshot.recentDecisions (the only event
 *   signal the snapshot carries), deduped by eventId, newest-last order
 *   preserved — the page diffs by id to fire HUD toasts.
 */

import { zoneAlertLevel } from '../campus3d';

export interface InteriorLiveMaps {
  tempByZone: Record<string, number>;
  co2ByZone: Record<string, number>;
  occupancyByZone: Record<string, number>;
  /** zone id → 'critical' (campus zoneAlertLevel semantics). */
  alertByZone: Record<string, 'critical'>;
}

export interface SnapshotZoneLike {
  id: string;
  parameters?: Record<string, number | boolean>;
}

export function liveMapsFromZones(zones: readonly SnapshotZoneLike[]): InteriorLiveMaps {
  const maps: InteriorLiveMaps = {
    tempByZone: {},
    co2ByZone: {},
    occupancyByZone: {},
    alertByZone: {},
  };
  for (const z of zones) {
    const p = z.parameters;
    if (!p) continue;
    if (typeof p.temperature === 'number') maps.tempByZone[z.id] = p.temperature;
    if (typeof p.co2 === 'number') maps.co2ByZone[z.id] = p.co2;
    if (typeof p.occupancy === 'number') maps.occupancyByZone[z.id] = p.occupancy;
    if (zoneAlertLevel(p) === 'critical') maps.alertByZone[z.id] = 'critical';
  }
  return maps;
}

export interface InteriorRecentEvent {
  id: string;
  type: string;
  zoneId?: string;
}

export interface SnapshotDecisionLike {
  eventId: string;
  eventType: string;
  zoneId?: string;
}

/** recentDecisions → deduped event stream for HUD toasts. */
export function recentEventsFromDecisions(
  decisions: readonly SnapshotDecisionLike[],
): InteriorRecentEvent[] {
  const seen = new Set<string>();
  const out: InteriorRecentEvent[] = [];
  for (const d of decisions) {
    if (seen.has(d.eventId)) continue;
    seen.add(d.eventId);
    out.push({
      id: d.eventId,
      type: d.eventType,
      ...(d.zoneId !== undefined ? { zoneId: d.zoneId } : {}),
    });
  }
  return out;
}
