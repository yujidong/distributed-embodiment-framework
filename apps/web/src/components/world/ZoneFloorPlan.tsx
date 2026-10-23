/**
 * ZoneFloorPlan — R82: the mini floor map behind the zone detail's rooms
 * block. Draws the floor footprint outline (geo polygon or grid bounds,
 * normalized to its own bbox) plus a dot per room carrying a normalized
 * `pos` [u, v] (u along lng/x, v from the north/min-y edge). Pure rendering
 * from the declarative rooms block — rooms without pos simply have no dot.
 */

import type { EnvRoom, EnvZone } from '../../api/types';
import { planOutline } from '../../lib/positionPicker';

/** A room dot in normalized 0-100 plan space. */
export interface FloorPlanDot {
  code: string;
  name: string;
  x: number;
  y: number;
}

export interface ZoneFloorPlanData {
  /** Outline polygon in normalized 0-100 space (closed implicitly). */
  outline: Array<[number, number]>;
  dots: FloorPlanDot[];
}

function isPositioned(room: EnvRoom): room is EnvRoom & { pos: [number, number] } {
  return (
    Array.isArray(room.pos) &&
    room.pos.length === 2 &&
    room.pos.every(n => typeof n === 'number' && Number.isFinite(n))
  );
}

/**
 * Normalize a zone's footprint + positioned rooms into plan space. Returns
 * null when the zone has neither polygon nor bounds, or no positioned rooms.
 */
export function computeZoneFloorPlan(zone: EnvZone): ZoneFloorPlanData | null {
  const positioned = (zone.rooms ?? []).filter(isPositioned);
  if (positioned.length === 0) return null;

  // Outline normalization lives in lib/positionPicker (shared with the
  // interactive ZonePositionPicker, UX-W4): geo polygon normalized to its
  // bbox (max-lat → y=0); grid bounds → the full viewBox rect.
  const outline = planOutline(zone);
  if (outline === null) return null;

  const dots: FloorPlanDot[] = positioned.map(room => ({
    code: room.code ?? room.name,
    name: room.name,
    x: room.pos[0] * 100,
    y: room.pos[1] * 100,
  }));
  return { outline, dots };
}

export function ZoneFloorPlan({ zone }: { zone: EnvZone }) {
  const plan = computeZoneFloorPlan(zone);
  if (!plan) return null;
  return (
    <svg
      className="zone-floor-plan"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label="floor plan"
    >
      <polygon
        className="zone-floor-plan__outline"
        points={plan.outline.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}
      />
      {plan.dots.map(dot => (
        <circle key={dot.code} className="zone-floor-plan__room" cx={dot.x} cy={dot.y} r={2.4}>
          <title>{dot.code === dot.name ? dot.code : `${dot.code} ${dot.name}`}</title>
        </circle>
      ))}
    </svg>
  );
}
