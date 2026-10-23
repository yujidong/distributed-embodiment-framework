/**
 * Deploy catalog + per-floor plan calibration (R82 phase 2).
 *
 * - DEPLOY_TYPES: the starter palette of deployable device kinds (targets
 *   POST /environments/:id/devices; capabilities align with the platform
 *   catalog). UX-W3: the interior deploy palette now pulls the full registry
 *   from GET /api/device-templates — this list survives as the OFFLINE
 *   FALLBACK (lib/deviceTemplates.ts FALLBACK_DEVICE_TEMPLATES).
 * - DRAWING_BBOX: per (building, storey) extent of the floor-plan drawing on
 *   its guide page, in full-image pixels — recorded while hand-reading the
 *   plans. Used by the plan↔geo transforms and the room-region extractor
 *   (extract-xjtlu-walls.py).
 */

import type { DeployKind } from '../../components/interior/types';

export const DEPLOY_TYPES: DeployKind[] = [
  {
    type: 'temp-humidity-sensor',
    name: '温湿度传感器',
    capabilities: ['temperature-reading', 'humidity-reading'],
  },
  { type: 'people-counter', name: '人流计数器', capabilities: ['people-counting'] },
  {
    type: 'hvac',
    name: '空调机组',
    capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
  },
  { type: 'smart-light', name: '智能照明', capabilities: ['lighting', 'turn-on', 'turn-off'] },
];

export interface DrawingBbox {
  x: [number, number];
  y: [number, number];
  mpp: number;
}

/** D 栋（读图时同步记录）；其余楼栋提取时补录。 */
export const DRAWING_BBOX: Record<string, DrawingBbox> = {
  'D:0': { x: [680, 2150], y: [25, 1430], mpp: 0.0805 },
  'D:1': { x: [640, 2400], y: [25, 1420], mpp: 0.0811 },
  'D:2': { x: [620, 2400], y: [95, 1400], mpp: 0.0867 },
  'D:3': { x: [550, 2350], y: [65, 1395], mpp: 0.085 },
  'D:4': { x: [650, 2350], y: [40, 1420], mpp: 0.082 },
};

export function drawingBboxFor(buildingId: string, floor: number): DrawingBbox | null {
  const letter = String(buildingId).replace('bldg-', '').toUpperCase();
  return DRAWING_BBOX[`${letter}:${floor}`] ?? null;
}
