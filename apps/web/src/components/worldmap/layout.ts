/**
 * World-map layout — pure geometry for the shared world map (§11.5 LOD).
 *
 * - Zones WITH `bounds` (world units) map 1:1 to pixels at `WORLD_SCALE`
 *   px/unit (clamped to a minimum so labels fit), keeping real relative
 *   geometry; zones without bounds get a deterministic adjacency-aware force
 *   layout (`layoutUnboundedZonePositions`) to the right of the bounded area.
 * - Device dots with a persisted `position` (world units) are placed there
 *   (clamped inside their zone); the rest auto-arrange in a non-overlapping
 *   dot grid under the zone title bar.
 * - Agent markers anchor at the centroid of their managed zones, falling back
 *   to the centroid of their bound devices, then to the world center; ties
 *   fan out on a small ring so stacked markers stay clickable.
 */

import type { EnvZone } from '../../api/types';
import type { WorldModelAgent } from '../../lib/worldModel';

/** Pixels per world unit for zone bounds / persisted positions. */
export const WORLD_SCALE = 64;
export const ZONE_MIN_WIDTH = 260;
export const ZONE_MIN_HEIGHT = 180;
export const ZONE_TITLE_HEIGHT = 40;
export const ZONE_PADDING = 12;
export const DOT_SIZE = 18;
export const DOT_GAP = 10;
export const AGENT_SIZE = 34;
/** Fallback box size (px) for zones without bounds — shared with the 3D view (R15-E3). */
export const FALLBACK_ZONE_W = 300;
export const FALLBACK_ZONE_W_PX = FALLBACK_ZONE_W;
const FALLBACK_ZONE_H = 220;
/** Center distance the fallback force layout aims for between zone boxes. */
export const FALLBACK_GAP_PX = 60;
/** Fixed iteration budget: deterministic outcome, no random seeding. */
const FORCE_ITERATIONS = 240;
/** Radial offset between agents sharing one anchor point. */
const AGENT_FAN_OUT = 26;

export interface ZoneFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeZoneFrames(zones: readonly EnvZone[]): Map<string, ZoneFrame> {
  const frames = new Map<string, ZoneFrame>();

  // Bounded zones keep their real-world relative geometry.
  let boundedMaxX = 0;
  for (const zone of zones) {
    if (!zone.bounds) continue;
    const width = Math.max((zone.bounds.maxX - zone.bounds.minX) * WORLD_SCALE, ZONE_MIN_WIDTH);
    const height = Math.max((zone.bounds.maxY - zone.bounds.minY) * WORLD_SCALE, ZONE_MIN_HEIGHT);
    frames.set(zone.id, {
      x: zone.bounds.minX * WORLD_SCALE,
      y: zone.bounds.minY * WORLD_SCALE,
      width,
      height,
    });
    boundedMaxX = Math.max(boundedMaxX, frames.get(zone.id)!.x + width);
  }

  // Unbounded zones: deterministic adjacency-aware force layout (R14 P0-3),
  // offset past the bounded area. Adjacent zones cluster into neighbourhoods
  // instead of landing on an arbitrary grid.
  const unbounded = zones.filter(zone => !frames.has(zone.id));
  if (unbounded.length > 0) {
    const originX = boundedMaxX > 0 ? boundedMaxX + WORLD_SCALE : 0;
    const positions = layoutUnboundedZonePositions(unbounded);
    for (const zone of unbounded) {
      const position = positions.get(zone.id)!;
      frames.set(zone.id, {
        x: originX + position.x,
        y: position.y,
        width: FALLBACK_ZONE_W,
        height: FALLBACK_ZONE_H,
      });
    }
  }
  return frames;
}

/**
 * Deterministic Fruchterman–Reingold layout for zones WITHOUT bounds: every
 * pair repels, adjacent zones (`adjacentZoneIds`, either direction) attract,
 * so neighbourhoods cluster instead of landing on a rigid grid. Same input
 * always yields the same output — golden-angle spiral seeding, a fixed
 * iteration budget, no Math.random. O(n² · iterations): ~2M pair steps at
 * the 132-zone scale, which stays interactive.
 *
 * Returns top-left positions normalized so the layout starts at (0, 0).
 */
export function layoutUnboundedZonePositions(
  zones: ReadonlyArray<{ id: string; adjacentZoneIds?: string[] }>,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const n = zones.length;
  if (n === 0) return result;
  if (n === 1) {
    result.set(zones[0].id, { x: 0, y: 0 });
    return result;
  }

  const indexById = new Map(zones.map((zone, index) => [zone.id, index]));
  // Unique adjacency pairs (either declaration direction counts).
  const pairs: Array<readonly [number, number]> = [];
  const seenPairs = new Set<string>();
  for (const zone of zones) {
    for (const adjacentId of zone.adjacentZoneIds ?? []) {
      const other = indexById.get(adjacentId);
      if (other === undefined) continue;
      const key = [zone.id, adjacentId].sort().join('::');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      pairs.push([indexById.get(zone.id)!, other]);
    }
  }

  const k = FALLBACK_ZONE_W + FALLBACK_GAP_PX;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  // Golden-angle spiral seeding: deterministic, already spread out start.
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const radius = k * 0.6 * Math.sqrt(i + 0.5);
    const theta = i * GOLDEN_ANGLE;
    px[i] = radius * Math.cos(theta);
    py[i] = radius * Math.sin(theta);
  }

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let iteration = 0; iteration < FORCE_ITERATIONS; iteration++) {
    dx.fill(0);
    dy.fill(0);
    // Repulsion between every pair (f = k²/d along the unit vector).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let deltaX = px[i] - px[j];
        let deltaY = py[i] - py[j];
        let distance = Math.hypot(deltaX, deltaY);
        if (distance < 0.01) {
          // Exact overlap: nudge apart deterministically along golden angles.
          deltaX = Math.cos(i * GOLDEN_ANGLE) * 0.01;
          deltaY = Math.sin(i * GOLDEN_ANGLE) * 0.01;
          distance = 0.01;
        }
        const factor = (k * k) / (distance * distance);
        dx[i] += deltaX * factor;
        dy[i] += deltaY * factor;
        dx[j] -= deltaX * factor;
        dy[j] -= deltaY * factor;
      }
    }
    // Attraction along adjacency edges (f = d²/k along the unit vector).
    for (const [i, j] of pairs) {
      const deltaX = px[i] - px[j];
      const deltaY = py[i] - py[j];
      const distance = Math.max(Math.hypot(deltaX, deltaY), 0.01);
      const factor = distance / k;
      dx[i] -= deltaX * factor;
      dy[i] -= deltaY * factor;
      dx[j] += deltaX * factor;
      dy[j] += deltaY * factor;
    }
    // Weak gravity keeps disconnected satellites near the cluster.
    for (let i = 0; i < n; i++) {
      dx[i] -= px[i] * 0.02;
      dy[i] -= py[i] * 0.02;
    }
    // Linearly cooling temperature caps each step.
    const temperature = k * (1 - iteration / FORCE_ITERATIONS);
    for (let i = 0; i < n; i++) {
      const length = Math.hypot(dx[i], dy[i]);
      if (length < 1e-6) continue;
      const step = Math.min(length, temperature) / length;
      px[i] += dx[i] * step;
      py[i] += dy[i] * step;
    }
  }

  // Normalize: the topmost-leftmost zone starts at the origin.
  let minX = Infinity;
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, px[i]);
    minY = Math.min(minY, py[i]);
  }
  zones.forEach((zone, i) => {
    result.set(zone.id, {
      x: Math.round(px[i] - minX),
      y: Math.round(py[i] - minY),
    });
  });
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export interface DotPosition {
  x: number;
  y: number;
  /** True when the dot comes from a persisted position (not auto-arranged). */
  pinned: boolean;
}

/**
 * Parent-relative dot positions for the devices of one zone. Persisted
 * positions (world units) are converted to parent-relative pixels and clamped
 * inside the zone; unpinned devices fill grid slots in list order.
 */
export function layoutDeviceDots(
  devices: ReadonlyArray<{ id: string; position: { x: number; y: number } | null }>,
  frame: ZoneFrame,
): Map<string, DotPosition> {
  const positions = new Map<string, DotPosition>();
  const cols = Math.max(
    1,
    Math.floor((frame.width - 2 * ZONE_PADDING + DOT_GAP) / (DOT_SIZE + DOT_GAP)),
  );
  let slot = 0;
  for (const device of devices) {
    if (device.position) {
      positions.set(device.id, {
        x: clamp(
          device.position.x * WORLD_SCALE - frame.x,
          ZONE_PADDING,
          frame.width - ZONE_PADDING - DOT_SIZE,
        ),
        y: clamp(
          device.position.y * WORLD_SCALE - frame.y,
          ZONE_TITLE_HEIGHT + 4,
          frame.height - ZONE_PADDING - DOT_SIZE,
        ),
        pinned: true,
      });
    } else {
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      slot += 1;
      positions.set(device.id, {
        x: ZONE_PADDING + col * (DOT_SIZE + DOT_GAP),
        y: ZONE_TITLE_HEIGHT + ZONE_PADDING + row * (DOT_SIZE + DOT_GAP),
        pinned: false,
      });
    }
  }
  return positions;
}

/**
 * Absolute anchor point (flow coordinates) for an agent marker: centroid of
 * its managed zone frames → centroid of its bound devices → world center.
 * `index` fans multiple agents sharing an anchor out on a small ring.
 */
export function agentAnchorPoint(
  agent: WorldModelAgent,
  frames: ReadonlyMap<string, ZoneFrame>,
  deviceAbsolutePositions: ReadonlyMap<string, { x: number; y: number }>,
  index: number,
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let count = 0;

  for (const zoneId of agent.managedZoneIds) {
    const frame = frames.get(zoneId);
    if (!frame) continue;
    x += frame.x + frame.width / 2;
    y += frame.y + frame.height / 2;
    count += 1;
  }
  if (count === 0) {
    for (const deviceId of agent.boundDeviceIds) {
      const position = deviceAbsolutePositions.get(deviceId);
      if (!position) continue;
      x += position.x;
      y += position.y;
      count += 1;
    }
  }
  if (count === 0) {
    // World center fallback: centroid of all zone frames.
    for (const frame of frames.values()) {
      x += frame.x + frame.width / 2;
      y += frame.y + frame.height / 2;
      count += 1;
    }
  }
  if (count === 0) return { x: 0, y: 0 };

  const angle = index * 2.4; // golden-ish angle: successive agents don't overlap
  return {
    x: x / count + Math.cos(angle) * (index === 0 ? 0 : AGENT_FAN_OUT),
    y: y / count + Math.sin(angle) * (index === 0 ? 0 : AGENT_FAN_OUT),
  };
}

// ---------------------------------------------------------------------------
// Door gaps (V1): adjacency rendered as a short opening on the shared wall
// ---------------------------------------------------------------------------

export interface DoorGap {
  /** Stable id derived from the zone pair. */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  orientation: 'vertical' | 'horizontal';
}

/** Pixels of tolerance for "touching" walls (bounds are integer meters). */
const DOOR_TOUCH_TOLERANCE = 2;
const DOOR_MIN_LENGTH = 18;
const DOOR_MAX_LENGTH = 56;
const DOOR_THICKNESS = 10;

/**
 * Door segments for adjacent zone pairs whose frames intersect or touch:
 * one short segment centered on the shared boundary, replacing the long
 * floating adjacency edge. Contained pairs (one rect inside the other) and
 * disjoint pairs yield no door — the caller keeps the dashed edge for those.
 */
export function computeDoorGaps(
  zones: ReadonlyArray<{ id: string; adjacentZoneIds?: string[] }>,
  frames: ReadonlyMap<string, ZoneFrame>,
): DoorGap[] {
  const gaps: DoorGap[] = [];
  const seenPairs = new Set<string>();
  for (const zone of zones) {
    const a = frames.get(zone.id);
    if (!a) continue;
    for (const adjacentId of zone.adjacentZoneIds ?? []) {
      const pairKey = [zone.id, adjacentId].sort().join('::');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const b = frames.get(adjacentId);
      if (!b) continue;

      const ix = Math.max(a.x, b.x);
      const iy = Math.max(a.y, b.y);
      const overlapW = Math.min(a.x + a.width, b.x + b.width) - ix;
      const overlapH = Math.min(a.y + a.height, b.y + b.height) - iy;
      // Disjoint (beyond touch tolerance) → keep the dashed edge instead.
      if (overlapW < -DOOR_TOUCH_TOLERANCE || overlapH < -DOOR_TOUCH_TOLERANCE) continue;
      // One rect fully inside the other → not a wall opening.
      if (
        overlapW >= Math.min(a.width, b.width) &&
        overlapH >= Math.min(a.height, b.height)
      ) {
        continue;
      }

      const spanW = Math.max(overlapW, 0);
      const spanH = Math.max(overlapH, 0);
      if (spanW <= spanH) {
        // Shared vertical wall: short vertical opening centered on the y-overlap.
        const length = clamp(spanH * 0.5, DOOR_MIN_LENGTH, DOOR_MAX_LENGTH);
        gaps.push({
          id: `door-${pairKey}`,
          x: ix + spanW / 2 - DOOR_THICKNESS / 2,
          y: iy + spanH / 2 - length / 2,
          width: DOOR_THICKNESS,
          height: length,
          orientation: 'vertical',
        });
      } else {
        const length = clamp(spanW * 0.5, DOOR_MIN_LENGTH, DOOR_MAX_LENGTH);
        gaps.push({
          id: `door-${pairKey}`,
          x: ix + spanW / 2 - length / 2,
          y: iy + spanH / 2 - DOOR_THICKNESS / 2,
          width: length,
          height: DOOR_THICKNESS,
          orientation: 'horizontal',
        });
      }
    }
  }
  return gaps;
}
