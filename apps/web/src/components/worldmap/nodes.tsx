/**
 * World-map node renderers (§11.5 visualization hierarchy):
 *
 * - `ZoneNode` — zone container with live parameter overlay;
 * - `DeviceDotNode` — the LOD device dot: ~18px circle, fill = role/type
 *   category color, border = owner color, pulse ring on recent activity, no
 *   text (hover tooltip only, click opens the sidebar detail);
 * - `AgentMarkerNode` — the agent layer: a distinct hexagon with the agent's
 *   initial, owner-colored rim, selected state;
 * - `BubbleNode` — transient decision bubble (sim console).
 */

import { Handle, Position, useViewport, type NodeProps } from 'reactflow';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AirVent,
  Blinds,
  Cctv,
  DoorClosed,
  Droplets,
  Fan,
  Gauge,
  Heater,
  Lightbulb,
  Thermometer,
  Wind,
  type LucideIcon,
} from 'lucide-react';

import { comfortBadgeVariant, type ZoneCategory, type ZoneComfort } from '../../lib/zoneVisual';
import { Icon } from '../ui/Icon';

// ---------------------------------------------------------------------------
// Plan-image underlay (B-D)
// ---------------------------------------------------------------------------

export interface PlanImageNodeData {
  /** URL or data URI of the floor-plan raster. */
  src: string;
  /** Image pixels per world meter — display width derives from it. */
  pixelsPerMeter: number;
  /** Flow px per world meter (WORLD_SCALE). */
  worldScale: number;
}

/**
 * Floor-plan underlay node: renders the raster scaled so image pixels land
 * on world meters (top-left = world origin). The natural size is only known
 * after load, so the element starts hidden and sizes itself onLoad; it is
 * non-interactive and sits below every other layer (negative zIndex).
 */
export function PlanImageNode({ data }: NodeProps<PlanImageNodeData>) {
  const [loaded, setLoaded] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  return (
    <img
      className="plan-image-node"
      src={data.src}
      alt=""
      draggable={false}
      style={{
        visibility: loaded ? 'visible' : 'hidden',
        ...(natural
          ? {
              width: (natural.width / data.pixelsPerMeter) * data.worldScale,
              height: (natural.height / data.pixelsPerMeter) * data.worldScale,
            }
          : {}),
      }}
      onLoad={event => {
        const img = event.currentTarget;
        setNatural({ width: img.naturalWidth, height: img.naturalHeight });
        setLoaded(true);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Zone
// ---------------------------------------------------------------------------

/**
 * Zone text LOD (R14 P0-3): at/above this zoom the zone renders its full
 * detail lines (subtitle, parameters, comfort badge, ⇅ links); below it only
 * the truncated title survives so names stay readable deeper into the zoom
 * range.
 */
const ZONE_DETAIL_MIN_ZOOM = 0.35;
/** Below this zoom zone text drops entirely (perf floor; minZoom is 0.05). */
const ZONE_TITLE_MIN_ZOOM = 0.12;

export interface ZoneNodeData {
  title: string;
  subtitle: string;
  /** Pre-formatted live parameter lines (empty without a snapshot). */
  parameters: string[];
  highlighted: boolean;
  /** Managed by the selected agent (agent-selection focus). */
  focused: boolean;
  /** W4 zone selection (map click) — accent outline + glow. */
  selected: boolean;
  /** UX-W2: bounds-edit mode — dashed accent outline (the node is draggable). */
  geometryEditing: boolean;
  /** V1 semantic category → `zone-node--cat-*` tint (corridors de-emphasized). */
  category: ZoneCategory;
  /** Live heat fill (temperature scale / comfort tint); null keeps the category look. */
  heatFill: string | null;
  /**
   * R2-FEAT-02: the zone's live parameters cross a critical threshold
   * (campus3d zoneAlertLevel — covers smoke-only alerts that the temperature
   * heat scale cannot paint). Red outline + pulse, independent of heatFill.
   */
  alerted: boolean;
  /** Live comfort badge (NFR-1 PMV/PPD), null without runtime comfort data. */
  comfort: ZoneComfort | null;
  /** Live occupancy count chip, null when unavailable. */
  occupancy: number | null;
  /** Cross-floor adjacency labels (rendered as dashed ⇅ chips). */
  verticalLinks: string[];
}

export function ZoneNode({ data }: NodeProps<ZoneNodeData>) {
  const { t } = useTranslation('worldMap');
  const { t: tc } = useTranslation('comfort');
  // Zone text LOD (R14 P0-3): names stay visible much deeper into the zoom
  // range than the detail lines; below ZONE_TITLE_MIN_ZOOM all text drops so
  // a fully zoomed-out 100+ zone map (minZoom 0.05) renders no text at all.
  const { zoom } = useViewport();
  const showTitle = zoom >= ZONE_TITLE_MIN_ZOOM;
  const showDetails = zoom >= ZONE_DETAIL_MIN_ZOOM;
  const className = [
    'zone-node',
    `zone-node--cat-${data.category}`,
    showDetails ? '' : 'zone-node--compact',
    data.highlighted ? 'zone-node--pulse' : '',
    data.focused ? 'zone-node--focused' : '',
    data.selected ? 'zone-node--selected' : '',
    data.geometryEditing ? 'zone-node--editing' : '',
    data.alerted ? 'zone-node--alert' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={className}
      style={data.heatFill ? { background: data.heatFill } : undefined}
    >
      <Handle type="target" position={Position.Left} className="zone-handle" />
      {showTitle && (
        // Ellipsis (compact mode CSS) + native tooltip carry long names.
        <div className="zone-node__title" title={data.title}>
          {data.title}
        </div>
      )}
      {showDetails && <div className="zone-node__subtitle">{data.subtitle}</div>}
      {showDetails && data.comfort && (
        <div className="zone-node__comfort">
          <span className={`badge badge--${comfortBadgeVariant(data.comfort.comfortLevel)}`}>
            {tc(`sensation.${data.comfort.sensation}`, { defaultValue: data.comfort.sensation })}
            {' · PMV '}
            {data.comfort.pmv.toFixed(1)}
          </span>
        </div>
      )}
      {showDetails && data.parameters.length > 0 && (
        <div className="zone-node__params">
          {data.parameters.map(line => (
            <span key={line} className="zone-node__param">
              {line}
            </span>
          ))}
        </div>
      )}
      {showDetails && data.verticalLinks.length > 0 && (
        <div className="zone-node__vertical-links">
          {data.verticalLinks.map(link => (
            <span key={link} className="zone-node__vertical-link">
              ⇅ {link}
            </span>
          ))}
        </div>
      )}
      {showTitle && data.occupancy !== null && (
        <span className="zone-node__occupancy">
          {t('occupancyCount', { count: data.occupancy })}
        </span>
      )}
      <Handle type="source" position={Position.Right} className="zone-handle" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Device dot (LOD)
// ---------------------------------------------------------------------------

/**
 * Device-type → lucide glyph (V1 icon layer). First match wins; unmatched
 * types fall back to the plain role-colored dot.
 */
const DEVICE_TYPE_ICONS: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
  [/air[-_ ]?conditioner|\bac\b|hvac|空调/, AirVent],
  [/light|lamp|照明|灯/, Lightbulb],
  [/humidifier|加湿/, Droplets],
  [/thermostat|temperature|温度/, Thermometer],
  [/heater|暖气|加热/, Heater],
  [/fan|ventilation|风扇/, Fan],
  [/camera|cctv|摄像/, Cctv],
  [/door|门禁/, DoorClosed],
  [/curtain|blind|窗帘/, Blinds],
  [/co2|air[-_ ]?quality|空气/, Wind],
  [/sensor|传感/, Gauge],
];

/** Resolve the lucide glyph for a device type (null → keep the plain dot). */
export function deviceTypeIcon(type: string): LucideIcon | null {
  const lower = type.toLowerCase();
  for (const [pattern, glyph] of DEVICE_TYPE_ICONS) {
    if (pattern.test(lower)) return glyph;
  }
  return null;
}

/** Below this zoom the icon layer degrades back to plain LOD dots. */
const DEVICE_ICON_MIN_ZOOM = 0.6;

export interface DeviceDotNodeData {
  name: string;
  type: string;
  role: 'sensor' | 'actuator' | 'hybrid';
  ownerColor: string | null;
  /** Recent activity ring (live sim overlays). */
  active: boolean;
  /** Fault-injection indicator (P3d): red ring when the device has an active fault. */
  faulted: boolean;
  selected: boolean;
  /** 我的视角 (W5): not the caller's object → ~25% opacity, non-interactive. */
  dimmed: boolean;
  /** Extra tooltip lines (live state summary in sim mode). */
  tooltipLines: string[];
}

export function DeviceDotNode({ data }: NodeProps<DeviceDotNodeData>) {
  const className = [
    'device-dot',
    `device-dot--${data.role}`,
    data.active ? 'device-dot--active' : '',
    data.faulted ? 'device-dot--faulted' : '',
    data.selected ? 'device-dot--selected' : '',
    data.dimmed ? 'device-dot--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const tooltip = [`${data.name} · ${data.type}`, ...data.tooltipLines].join('\n');
  // LOD: small zoom → plain dot; close zoom → type glyph inside the dot.
  const { zoom } = useViewport();
  const glyph = zoom >= DEVICE_ICON_MIN_ZOOM ? deviceTypeIcon(data.type) : null;
  return (
    <>
      <Handle type="target" position={Position.Left} className="zone-handle" />
      <Handle type="source" position={Position.Right} className="zone-handle" />
      <div
        className={className}
        title={tooltip}
        style={data.ownerColor ? { borderColor: data.ownerColor } : undefined}
      >
        {glyph && <Icon icon={glyph} size={11} strokeWidth={2.2} className="device-dot__icon" />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Door gap (V1): short opening on the shared wall of adjacent zones
// ---------------------------------------------------------------------------

export interface DoorGapNodeData {
  orientation: 'vertical' | 'horizontal';
}

export function DoorGapNode({ data }: NodeProps<DoorGapNodeData>) {
  return <div className={`door-gap door-gap--${data.orientation}`} />;
}

// ---------------------------------------------------------------------------
// Agent marker (agent layer)
// ---------------------------------------------------------------------------

export interface AgentMarkerNodeData {
  name: string;
  initial: string;
  ownerColor: string | null;
  selected: boolean;
  /** 我的视角 (W5): not the caller's object → ~25% opacity, non-interactive. */
  dimmed: boolean;
}

export function AgentMarkerNode({ data }: NodeProps<AgentMarkerNodeData>) {
  const className = [
    'agent-marker',
    data.selected ? 'agent-marker--selected' : '',
    data.dimmed ? 'agent-marker--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <Handle type="target" position={Position.Left} className="zone-handle" />
      <Handle type="source" position={Position.Right} className="zone-handle" />
      <div
        className={className}
        title={`Agent ${data.name}`}
        style={data.ownerColor ? { background: data.ownerColor } : undefined}
      >
        <div className="agent-marker__inner">{data.initial}</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Decision bubble (sim console overlay)
// ---------------------------------------------------------------------------

/** A transient decision bubble overlaid near a zone (M3 decision stream). */
export interface DecisionBubble {
  id: string;
  zoneId: string;
  text: string;
  source: string;
}

export interface BubbleNodeData {
  text: string;
  source: string;
}

export function BubbleNode({ data }: NodeProps<BubbleNodeData>) {
  return (
    <div className="decision-bubble">
      <div className="decision-bubble__text">{data.text}</div>
      <div className="decision-bubble__source">{data.source}</div>
    </div>
  );
}
