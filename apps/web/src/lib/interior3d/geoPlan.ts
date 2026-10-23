/**
 * Geo↔plan transforms (R82 phase 2) — bridge between the plan-local meter
 * space the interior walk uses (drawing-bbox origin, z southward) and WGS84
 * coordinates stored on devices (geo tier `position {lat, lng}`).
 *
 * Chain (both directions, so placement round-trips exactly):
 *   plan meters → drawing px → full-image normalized (u, v)
 *   → footprint-bbox meters (u,v scaled to the building's spans)
 *   → lat/lng via equirectangular around the footprint centroid.
 *
 * PLAN_IMAGE_PX is the guide render size (200 dpi over the 960×540pt slide).
 */

export const PLAN_IMAGE_PX = { w: 2667, h: 1500 } as const;

const MPP_LAT = 110540;

export interface GeoFrame {
  lat0: number;
  lng0: number;
  spanLngM: number;
  spanLatM: number;
  mppLng: number;
}

export interface DrawingBbox {
  x: [number, number];
  y: [number, number];
}

/** Footprint bbox frame (meters + centroid) from the zone's geo polygon. */
export function footprintFrame(polygon: Array<[number, number]>): GeoFrame & { widthM: number; heightM: number } {
  const lat0 = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const lng0 = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const mppLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const xs = polygon.map(p => (p[1] - lng0) * mppLng);
  const ys = polygon.map(p => -(p[0] - lat0) * MPP_LAT);
  const spanLngM = Math.max(...xs) - Math.min(...xs);
  const spanLatM = Math.max(...ys) - Math.min(...ys);
  return { lat0, lng0, spanLngM, spanLatM, mppLng, widthM: spanLngM, heightM: spanLatM };
}

export interface PlanGeoMapping {
  bbox: DrawingBbox;
  mpp: number;
  frame: GeoFrame;
  /**
   * UX-W4 direct frame (runtime raster from map_data): plan meters ARE
   * footprint-frame meters re-anchored at the bbox corner — the drawing-px
   * chain is skipped entirely and the transform is exact both ways.
   * `minXm/minZm` are the projected ring's minima (centroid-relative).
   */
  direct?: { minXm: number; minZm: number };
}

/** Plan meters → WGS84. */
export function planToLatLng(map: PlanGeoMapping, x: number, z: number): { lat: number; lng: number } {
  if (map.direct) {
    return {
      lng: map.frame.lng0 + (x + map.direct.minXm) / map.frame.mppLng,
      lat: map.frame.lat0 - (z + map.direct.minZm) / MPP_LAT,
    };
  }
  const px = x / map.mpp + map.bbox.x[0];
  const py = z / map.mpp + map.bbox.y[0];
  const u = px / PLAN_IMAGE_PX.w;
  const v = py / PLAN_IMAGE_PX.h;
  const lng = map.frame.lng0 + (u - 0.5) * map.frame.spanLngM / map.frame.mppLng;
  const lat = map.frame.lat0 - (v - 0.5) * map.frame.spanLatM / MPP_LAT;
  return { lat, lng };
}

/** WGS84 → plan meters. */
export function latLngToPlanMeters(
  map: PlanGeoMapping,
  lat: number,
  lng: number,
): { x: number; z: number } {
  if (map.direct) {
    return {
      x: (lng - map.frame.lng0) * map.frame.mppLng - map.direct.minXm,
      z: -(lat - map.frame.lat0) * MPP_LAT - map.direct.minZm,
    };
  }
  const u = 0.5 + ((lng - map.frame.lng0) * map.frame.mppLng) / map.frame.spanLngM;
  const v = 0.5 - ((lat - map.frame.lat0) * MPP_LAT) / map.frame.spanLatM;
  return {
    x: (u * PLAN_IMAGE_PX.w - map.bbox.x[0]) * map.mpp,
    z: (v * PLAN_IMAGE_PX.h - map.bbox.y[0]) * map.mpp,
  };
}
