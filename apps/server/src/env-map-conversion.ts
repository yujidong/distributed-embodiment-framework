/**
 * Environment map-data conversions — the single conversion module between
 * core `ScenarioDefinition`s and environment map data (Fix-2, RC-2).
 *
 * Field fidelity is guaranteed structurally, not by per-field discipline:
 *
 * - Map-level building/physics metadata (storeyHeight, slabAttenuation,
 *   envelopeU, occupancyHeatW, occupancyCo2Rate) flows through the canonical
 *   `MAP_META_FIELDS` list (environment-store.ts): add a new meta field THERE
 *   and every conversion point — import, bridge, detail view, parseMapData —
 *   picks it up automatically.
 * - Zone fidelity uses SPREAD passthrough: every zone field the core loader
 *   knows (id/name/type/buildingId/floor/bounds/occupancy/envelopeU/
 *   adjacentZoneIds/baseline — and future ones) crosses each hop with zero
 *   per-field code. Only tier-specific derivations (geo polygon ↔ bounds/
 *   adjacency projection) are handled explicitly.
 *
 * The full-chain round-trip test (environment-roundtrip.vitest.test.ts)
 * asserts the fixture's field set survives import → detail → bridge →
 * simulation snapshot, so a regression in ANY layer fails loudly.
 */

import type { ScenarioDefinition, ScenarioMeta, ScenarioZone } from '@active-collaboration/core';

import { MAP_META_FIELDS, type EnvDemoMeta, type EnvMapData, type EnvZone } from './db/environment-store.js';

/** Map-level metadata: validated scenario meta → map-data block. */
export function scenarioMetaToMapMeta(meta: ScenarioMeta): Partial<EnvMapData> {
  const out: Partial<EnvMapData> = {};
  for (const field of MAP_META_FIELDS) {
    const value = meta[field];
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  return out;
}

/** Map-level metadata: stored map data → scenario meta block (bridge). */
export function mapMetaToScenarioMeta(mapData: EnvMapData): Partial<ScenarioMeta> {
  const out: Partial<ScenarioMeta> = {};
  for (const field of MAP_META_FIELDS) {
    const value = mapData[field];
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  return out;
}

/**
 * Map-level metadata for the environment DETAIL view: every canonical field
 * exposed, `null` when the world does not carry it (same shape storeyHeight
 * always had).
 */
export function mapMetaForDetail(mapData: EnvMapData): Record<MapMetaFieldWire, number | null> {
  const out = {} as Record<MapMetaFieldWire, number | null>;
  for (const field of MAP_META_FIELDS) {
    out[field] = mapData[field] ?? null;
  }
  return out;
}

type MapMetaFieldWire = (typeof MAP_META_FIELDS)[number];

/**
 * T-032 (DevLoop R17, EC-F09): demo metadata ↔ map data. The loader keeps
 * tagline/heroEventId/recommendedPlaybackRate/vendorDisclaimer on
 * ScenarioDefinition.meta — these two functions are the only seams that move
 * them between the scenario world and the env's map data, so the template →
 * env import, the env detail view and the bridge/replay export all agree.
 */

/** Validated scenario meta → map-data `demo` block (undefined when empty). */
export function scenarioMetaToDemo(meta: ScenarioMeta): EnvDemoMeta | undefined {
  const demo: EnvDemoMeta = {
    ...(meta.tagline !== undefined ? { tagline: meta.tagline } : {}),
    ...(meta.heroEventId !== undefined ? { heroEventId: meta.heroEventId } : {}),
    ...(meta.recommendedPlaybackRate !== undefined
      ? { recommendedPlaybackRate: meta.recommendedPlaybackRate }
      : {}),
    ...(meta.vendorDisclaimer !== undefined ? { vendorDisclaimer: meta.vendorDisclaimer } : {}),
  };
  return Object.keys(demo).length > 0 ? demo : undefined;
}

/** Map-data `demo` block → scenario meta fields (bridge / replay export). */
export function demoToScenarioMeta(demo: EnvDemoMeta | undefined): Partial<ScenarioMeta> {
  if (demo === undefined) return {};
  return {
    ...(demo.tagline !== undefined ? { tagline: demo.tagline } : {}),
    ...(demo.heroEventId !== undefined ? { heroEventId: demo.heroEventId } : {}),
    ...(demo.recommendedPlaybackRate !== undefined
      ? { recommendedPlaybackRate: demo.recommendedPlaybackRate }
      : {}),
    ...(demo.vendorDisclaimer !== undefined ? { vendorDisclaimer: demo.vendorDisclaimer } : {}),
  };
}

/**
 * Scenario zone → stored map-data zone (grid tier). Spread passthrough; the
 * loader's defaults (symmetrized adjacency) ride along.
 */
export function scenarioZoneToMapZone(zone: ScenarioZone): EnvZone {
  return { ...zone };
}

/**
 * Scenario zone → stored map-data zone for the GEO tier: the projection
 * fields (bounds, adjacency) are derived from the polygon at bridge time,
 * so only the polygon is stored.
 */
export function scenarioZoneToGeoMapZone(
  zone: ScenarioZone,
  polygon: EnvZone['polygon'],
): EnvZone {
  const { bounds: _bounds, ...rest } = scenarioZoneToMapZone(zone);
  // R64: DECLARED adjacency survives storage — real administrative borders
  // (or any authored topology) are semantic truth the polygon-proximity
   // derivation cannot recover (district boxes sit far apart). The bridge
  // prefers a declared list and derives only for zones without one.
  return {
    ...rest,
    polygon,
    ...(zone.adjacentZoneIds !== undefined && zone.adjacentZoneIds.length > 0
      ? { adjacentZoneIds: zone.adjacentZoneIds }
      : {}),
  };
}

/**
 * Stored map-data zone → scenario zone (grid tier bridge). The geo-only
 * `polygon` is stripped (the scenario schema's zone shape carries bounds);
 * adjacency defaults to [].
 */
export function mapZoneToScenarioZone(zone: EnvZone): ScenarioZone {
  const { polygon: _polygon, ...rest } = zone;
  return { ...rest, adjacentZoneIds: zone.adjacentZoneIds ?? [] };
}

/**
 * Stored map-data zone → scenario zone for the GEO tier bridge: bounds are
 * the polygon's bbox in local meters and adjacency is derived from polygon
 * proximity — everything else passes through.
 */
export function mapZoneToGeoScenarioZone(
  zone: EnvZone,
  bounds: ScenarioZone['bounds'],
  adjacentZoneIds: string[],
): ScenarioZone {
  const { polygon: _polygon, bounds: _bounds, adjacentZoneIds: _adj, ...rest } = zone;
  return { ...rest, ...(bounds !== undefined ? { bounds } : {}), adjacentZoneIds };
}

/** Scheduled events: validated scenario events → map-data events. */
export function scenarioEventsToMapEvents(
  events: ScenarioDefinition['events'],
): NonNullable<EnvMapData['events']> {
  return events.map(event => ({ ...event }));
}
