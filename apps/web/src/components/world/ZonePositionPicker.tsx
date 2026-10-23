/**
 * ZonePositionPicker — UX-W4: the clickable zone floor plan embedded in
 * DeviceForm's position field.
 *
 * Grid worlds: clicking the plan converts the click (normalized 0–100 plan
 * space) back into zone-bounds world units and reports it via `onPick`, so
 * the X/Y inputs fill in — clicking again moves the marker. Geo worlds keep
 * the big-map pick as the only write path; the plan is a read-only preview
 * showing the outline, positioned rooms, same-zone devices (stacking
 * reference) and the current/picked point.
 *
 * All geometry is pure in lib/positionPicker; the component only translates
 * pointer coordinates through the rendered SVG rect.
 */

import { useTranslation } from 'react-i18next';

import type { EnvZone, WorldDevice } from '../../api/types';
import { readLatLng } from '../../lib/geo';
import {
  geoToPlan,
  gridToPlan,
  planOutline,
  planToGrid,
  type GridPoint,
  type PlanPoint,
} from '../../lib/positionPicker';
import { computeZoneFloorPlan } from './ZoneFloorPlan';

export interface ZonePositionPickerProps {
  zone: EnvZone;
  isGeo: boolean;
  /** grid: clicks set the position; geo: read-only preview. */
  interactive: boolean;
  /** Devices in this zone (rendered as reference dots). */
  devices: readonly WorldDevice[];
  /** The device under edit — excluded from the reference dots. */
  excludeDeviceId?: string;
  /** Current position: grid world units or geo lat/lng. */
  current: GridPoint | { lat: number; lng: number } | null;
  onPick?: (point: GridPoint) => void;
}

function readGridPoint(position: Record<string, unknown> | null): GridPoint | null {
  const x = position?.x;
  const y = position?.y;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? { x, y }
    : null;
}

function clampPlanPoint(point: PlanPoint): PlanPoint {
  return { u: Math.min(100, Math.max(0, point.u)), v: Math.min(100, Math.max(0, point.v)) };
}

export function ZonePositionPicker({
  zone,
  isGeo,
  interactive,
  devices,
  excludeDeviceId,
  current,
  onPick,
}: ZonePositionPickerProps) {
  const { t } = useTranslation('deviceForm');
  const outline = planOutline(zone);
  if (outline === null) return null;

  const toPlan = (point: GridPoint | { lat: number; lng: number }): PlanPoint | null =>
    isGeo ? geoToPlan(zone, point as { lat: number; lng: number }) : gridToPlan(zone, point as GridPoint);

  // Reference dots: same-zone devices with a position (stacking reference).
  const deviceDots = devices
    .filter(device => device.id !== excludeDeviceId)
    .map(device => {
      const point = isGeo ? readLatLng(device.position) : readGridPoint(device.position);
      const plan = point !== null ? toPlan(point) : null;
      return plan === null ? null : { id: device.id, name: device.name, ...clampPlanPoint(plan) };
    })
    .filter((dot): dot is NonNullable<typeof dot> => dot !== null);

  const currentDot = current !== null ? toPlan(current) : null;
  // Room dots (only when the zone declares positioned rooms).
  const roomDots = computeZoneFloorPlan(zone)?.dots ?? [];

  const handleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!interactive || onPick === undefined) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const point = planToGrid(zone, {
      u: ((event.clientX - rect.left) / rect.width) * 100,
      v: ((event.clientY - rect.top) / rect.height) * 100,
    });
    if (point === null) return;
    onPick({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 });
  };

  return (
    <div className="zone-position-picker-wrap">
      <svg
        className={interactive ? 'zone-position-picker zone-position-picker--interactive' : 'zone-position-picker'}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={t('positionPickerLabel')}
        onClick={handleClick}
      >
        <polygon
          className="zone-position-picker__outline"
          points={outline.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}
        />
        {roomDots.map(dot => (
          <circle key={dot.code} className="zone-position-picker__room" cx={dot.x} cy={dot.y} r={1.8}>
            <title>{dot.code === dot.name ? dot.code : `${dot.code} ${dot.name}`}</title>
          </circle>
        ))}
        {deviceDots.map(dot => (
          <circle key={dot.id} className="zone-position-picker__device" cx={dot.u} cy={dot.v} r={2.2}>
            <title>{dot.name}</title>
          </circle>
        ))}
        {currentDot !== null && (
          <circle
            className="zone-position-picker__marker"
            cx={clampPlanPoint(currentDot).u}
            cy={clampPlanPoint(currentDot).v}
            r={3}
          />
        )}
      </svg>
      <span className="page-note">{interactive ? t('positionPickHint') : t('positionPreviewHint')}</span>
    </div>
  );
}
