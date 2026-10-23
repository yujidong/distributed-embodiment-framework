/**
 * Geo map tier helpers (§11.4) — pure functions for the Leaflet world view.
 *
 * The projection mirrors apps/server/src/geo.ts EXACTLY (keep in sync): the
 * engine works in meters, so both sides convert lat/lng ↔ local meters with
 * the equirectangular approximation around the environment center:
 *
 * ```
 * x = (lng - center.lng) * METERS_PER_DEG_LAT * cos(center.lat)   // east
 * y = (center.lat - lat) * METERS_PER_DEG_LAT                     // SOUTH
 * ```
 *
 * `y` points south so projected views keep the platform's screen convention
 * (y down = north up on screen).
 */

import type { EnvZone } from '../api/types';

/** WGS84 point (degrees). */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Meters per degree of latitude (spherical-earth approximation). */
export const METERS_PER_DEG_LAT = 111320;

/** Project a lat/lng onto local meters around `center` (see file header). */
export function projectToMeters(
  center: LatLng,
  lat: number,
  lng: number,
): { x: number; y: number } {
  const latRad = (center.lat * Math.PI) / 180;
  return {
    x: (lng - center.lng) * METERS_PER_DEG_LAT * Math.cos(latRad),
    y: (center.lat - lat) * METERS_PER_DEG_LAT,
  };
}

/** Mean of the polygon vertices (placement default; good enough for districts). */
export function polygonCentroid(polygon: readonly (readonly [number, number])[]): LatLng {
  let lat = 0;
  let lng = 0;
  for (const [la, ln] of polygon) {
    lat += la;
    lng += ln;
  }
  return { lat: lat / polygon.length, lng: lng / polygon.length };
}

/** Ray-casting point-in-polygon in degree space (affine-equivalent to meters). */
export function pointInPolygon(
  lat: number,
  lng: number,
  polygon: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    if (lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI) {
      inside = !inside;
    }
  }
  return inside;
}

/** Defensive read of a geo device position (`{lat, lng}` or null). */
export function readLatLng(raw: Record<string, unknown> | null | undefined): LatLng | null {
  if (!raw) return null;
  const { lat, lng } = raw;
  if (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  ) {
    return { lat, lng };
  }
  return null;
}

/**
 * Anchor point for an agent marker on the geo map. Priority:
 *   1. Centroid of the agent's bound-device positions (an agent's identity
 *      in the UI is "the thing that owns THESE devices", so it sits at
 *      its device cluster, not at the meaningless middle-of-city centroid
 *      of all the zones it watches).
 *   2. Centroid of managed-zone polygon centroids (fallback for
 *      sensor-only / pure-coordinator agents with no bound devices).
 *   3. Map center.
 */
export function agentLatLng(
  managedZones: EnvZone[],
  boundDevicePositions: readonly (LatLng | null)[],
  fallback: LatLng,
): LatLng {
  const devicePoints = boundDevicePositions.filter((p): p is LatLng => p !== null);
  const zonePoints = managedZones
    .filter(zone => zone.polygon && zone.polygon.length >= 3)
    .map(zone => polygonCentroid(zone.polygon!));
  const points =
    devicePoints.length > 0
      ? devicePoints
      : zonePoints.length > 0
        ? zonePoints
        : [];
  if (points.length === 0) return fallback;
  let lat = 0;
  let lng = 0;
  for (const point of points) {
    lat += point.lat;
    lng += point.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

/**
 * Point set for the geo map's one-shot auto-fit (UX-08): the union of every
 * zone polygon's vertices and every device anchor (the same anchors the
 * CircleMarkers use, so a persisted position outside every polygon still
 * lands inside the fitted view). Zones without a polygon contribute nothing
 * — nothing renders for them either. No area threshold: a small-area zone's
 * ring is part of the fit exactly like a district's (the fit's maxZoom, not
 * a filter, keeps tiny footprints from over-zooming).
 */
export function geoAutoFitPoints(
  zones: readonly { polygon?: readonly (readonly [number, number])[] | null }[],
  deviceAnchors: Iterable<LatLng>,
): [number, number][] {
  const points: [number, number][] = [];
  for (const zone of zones) {
    if (!zone.polygon) continue;
    for (const [lat, lng] of zone.polygon) {
      if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lat, lng]);
    }
  }
  for (const anchor of deviceAnchors) {
    if (Number.isFinite(anchor.lat) && Number.isFinite(anchor.lng)) {
      points.push([anchor.lat, anchor.lng]);
    }
  }
  return points;
}

/** Co-anchor fan-out unit (~220 m); sunflower spiral radius = unit·√k. */
export const AGENT_FAN_OUT_DEG = 0.002;

/**
 * De-stack agents that share an anchor point (e.g. a district's facility
 * stewards + coordinator all anchored at the same zone centroid): the first
 * sibling keeps the anchor, each subsequent one moves to a sunflower-spiral
 * position (r = fanOut·√k, θ = k·golden-angle). Agents with a unique anchor
 * keep it untouched. At city zoom a constant-radius ring reads as one dot —
 * the growing spiral keeps the cluster compact but legible. `maxRadiusDeg`
 * clamps the spiral radius (the angle keeps advancing) so a crowded anchor
 * never scatters markers kilometres away (unclamped, k=100 × 0.002° ≈ 2.2 km).
 */
export function fanOutCoAnchored<T extends { id: string; anchor: LatLng }>(
  items: readonly T[],
  fanOutDeg: number,
  maxRadiusDeg = Infinity,
): Map<string, LatLng> {
  const spiralIndexByAnchor = new Map<string, number>();
  const result = new Map<string, LatLng>();
  for (const item of items) {
    const key = `${item.anchor.lat.toFixed(5)}:${item.anchor.lng.toFixed(5)}`;
    const k = spiralIndexByAnchor.get(key) ?? 0;
    spiralIndexByAnchor.set(key, k + 1);
    if (k === 0) {
      result.set(item.id, item.anchor);
      continue;
    }
    const radius = Math.min(fanOutDeg * Math.sqrt(k), maxRadiusDeg);
    const angle = k * 2.399_963; // golden angle (radians)
    result.set(item.id, {
      lat: item.anchor.lat + Math.cos(angle) * radius,
      lng: item.anchor.lng + Math.sin(angle) * radius,
    });
  }
  return result;
}
