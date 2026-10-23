/**
 * GeoWorldMap — the geo map tier (§11.4): the shared world view / sim
 * console canvas for `mapType: 'geo'` environments, rendered with Leaflet
 * over a pluggable basemap (src/lib/mapProviders.ts — OSM/CARTO/Esri tiles,
 * switchable via the bottom-right style chips; the choice persists in
 * localStorage). It mirrors the grid WorldMap's prop surface and LOD
 * semantics so every surrounding component (sidebar, layer toggles, world
 * stream, sim console overlays) works unchanged:
 *
 * - zones as Leaflet polygons (subtle fill; hover tooltip with the name and,
 *   in sim mode, the live parameter overlay; pulse on recent decisions;
 *   focus highlight for the selected agent's managed zones);
 * - devices as CircleMarkers (fill = role/type category color, ring = owner
 *   color, click → sidebar detail, hover tooltip, pulse ring on activity);
 * - agents as DivIcon hexagons with the agent's initial; selecting an agent
 *   draws dashed binding polylines to every bound device (协作边 layer);
 * - AC collaboration edges (W7 sim console): polylines between agent markers,
 *   forming = dashed / running = solid / terminal = fading green|red, with a
 *   hover tooltip (participants + AC state + proposal description);
 * - transient decision bubbles (sim console) float near the zone centroid;
 * - layer toggles (zones / devices / agents / edges) identical to the grid;
 * - catalog click-to-place: while `placementActive`, the next map click is
 *   reported via `onMapClick` (crosshair cursor);
 * - zone polygon drawing (W6-2): while `drawActive`, dblclick is reported
 *   via `onMapDblClick`, doubleClickZoom is suspended, and `drawVertices`
 *   render as a dashed live-preview polyline (faint fill once a ring).
 *
 * The wrapper is hand-rolled (react-leaflet v5 requires React 19; this repo
 * pins React 18): the Leaflet map instance is created once on mount and the
 * vector overlays PERSIST in a keyed layer registry (R31 F1) — prop changes
 * are diffed and applied in place (setStyle/setLatLng/setTooltipContent);
 * layers are created/removed only when their id appears/disappears. The
 * world stream's incremental updates flow in through the same props, so a
 * created dot appears live exactly like on the grid map.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { EngineSnapshot } from '../../api/types';
import { deriveAgentEdgePairs } from '../../lib/agentEdges';
import { isTerminal, TERMINAL_KEEP_MS, type CollabEdge, type CollabEdgeStatus } from '../../lib/collabGraph';
import { formatParameter, summarizeDeviceState } from '../../lib/format';
import { summarizeFaultProfile } from '../../lib/faults';
import {
  AGENT_FAN_OUT_DEG,
  agentLatLng,
  fanOutCoAnchored,
  geoAutoFitPoints,
  polygonCentroid,
  type LatLng,
} from '../../lib/geo';
import { isDimmed } from '../../lib/perspective';
import {
  MAP_PROVIDERS,
  getMapProvider,
  loadMapProviderId,
  providerName,
  saveMapProviderId,
} from '../../lib/mapProviders';
import type { WorldModel, WorldModelAgent } from '../../lib/worldModel';
import { collabEdgeColors, mapColors, roleColor } from '../../lib/theme';
import i18n from '../../i18n/config';
import { useAppStore } from '../../store/useAppStore';
import type { DecisionBubble, WorldLayers, WorldSelection } from './WorldMap';

const COLLAB_EDGE_STATE_KEY: Record<CollabEdgeStatus, string> = {
  forming: 'worldMap:collabEdgeForming',
  running: 'worldMap:collabEdgeRunning',
  completed: 'worldMap:collabEdgeCompleted',
  failed: 'worldMap:collabEdgeFailed',
};

/** Terminal edges fade out over their keep window (~10s). */
function collabEdgeOpacity(edge: CollabEdge, now: number): number {
  if (!isTerminal(edge.status)) return 1;
  const progress = Math.min(1, Math.max(0, (now - edge.updatedAt) / TERMINAL_KEEP_MS));
  return Math.max(0.25, 1 - progress * 0.75);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// R31 F1: keyed layer registry + per-layer update descriptors.
//
// The overlay sync computes a desired descriptor per layer (style values,
// tooltip HTML, position, flags) and diffs it against what the persistent
// layer was last given — Leaflet in-place APIs (setStyle / setLatLng /
// setTooltipContent / setIcon / DOM class toggles) apply only the changed
// parts; layers are created/removed only when their id appears/disappears.
// Everything below is pure data (unit-testable) — the Leaflet calls live in
// the component's sync effect.
// ---------------------------------------------------------------------------

/** Zone polygon descriptor (style values that actually change at runtime). */
export interface ZoneLayerState {
  color: string;
  weight: number;
  fillColor: string;
  fillOpacity: number;
  highlighted: boolean;
}

export function zoneLayerState(input: {
  selected: boolean;
  focused: boolean;
  highlighted: boolean;
  colors: ReturnType<typeof mapColors>;
}): ZoneLayerState {
  return {
    color: input.selected ? input.colors.dangerStrong : input.focused ? input.colors.hybrid : input.colors.accent,
    weight: input.selected ? 3.5 : input.focused ? 2.5 : 1.5,
    fillColor: input.focused ? input.colors.hybrid : input.colors.accent,
    fillOpacity: input.selected ? 0.3 : input.highlighted ? 0.35 : input.focused ? 0.22 : 0.08,
    highlighted: input.highlighted,
  };
}

export function zoneTooltipHtml(
  zone: { id: string; name?: string; type?: string; polygon?: [number, number][] },
  liveParameters: Record<string, unknown> | undefined,
): string {
  const parameterLines = liveParameters
    ? Object.entries(liveParameters).map(([key, value]) => formatParameter(key, value as number | boolean))
    : [];
  return (
    `<strong>${escapeHtml(zone.name ?? zone.id)}</strong>` +
    (zone.type ? `<br/><span class="geo-tooltip__dim">${escapeHtml(zone.type)}</span>` : '') +
    parameterLines.map(line => `<br/>${escapeHtml(line)}`).join('')
  );
}

/** Device circle-marker descriptor. */
export interface DeviceLayerState {
  radius: number;
  color: string;
  weight: number;
  fillColor: string;
  opacity: number;
  fillOpacity: number;
  active: boolean;
}

export function deviceLayerState(input: {
  selected: boolean;
  faulted: boolean;
  dimmed: boolean;
  active: boolean;
  role: string;
  ownerColor: string | null;
  colors: ReturnType<typeof mapColors>;
}): DeviceLayerState {
  return {
    radius: input.selected ? 9 : 7,
    color: input.faulted ? input.colors.dangerStrong : (input.ownerColor ?? input.colors.border),
    weight: input.faulted || input.selected ? 3.5 : 2.5,
    fillColor: roleColor(input.colors, input.role),
    opacity: input.dimmed ? 0.25 : 1,
    fillOpacity: input.dimmed ? 0.25 : 0.95,
    active: input.active,
  };
}

export function deviceTooltipHtml(
  device: { name: string; type: string },
  live: {
    state?: Record<string, unknown>;
    stateRedacted?: boolean;
    status?: string;
    fault?: unknown;
  } | undefined,
): string {
  const tooltipLines = [
    ...(live
      ? live.stateRedacted === true
        ? [i18n.t('world:device.stateCoarse', {
            status: i18n.t(
              live.status === 'on' ? 'world:device.statusOn'
                : live.status === 'off' ? 'world:device.statusOff'
                  : 'world:device.statusPresent',
            ),
          })]
        : summarizeDeviceState(live.state)
      : []),
    ...(live?.fault != null
      ? [`${i18n.t('worldMap:deviceFaultPrefix')}${summarizeFaultProfile(live.fault)}`]
      : []),
  ];
  return (
    `<strong>${escapeHtml(device.name)}</strong><br/><span class="geo-tooltip__dim">${escapeHtml(device.type)}</span>` +
    tooltipLines.map(line => `<br/>${escapeHtml(line)}`).join('')
  );
}

/** Agent divIcon HTML (selected/dimmed/owner tinting). */
export function agentIconHtml(input: {
  name: string;
  selected: boolean;
  dimmed: boolean;
  ownerColor: string | null;
}): string {
  return (
    `<div class="geo-agent-marker${input.selected ? ' geo-agent-marker--selected' : ''}` +
    `${input.dimmed ? ' geo-agent-marker--dimmed' : ''}"` +
    ` style="${input.ownerColor ? `background:${escapeHtml(input.ownerColor)};` : ''}"` +
    ` title="Agent ${escapeHtml(input.name)}">` +
    `<span>${escapeHtml((input.name.trim()[0] ?? 'A').toUpperCase())}</span></div>`
  );
}

function stateKey(values: Array<string | number | boolean>): string {
  return values.join('\u0000');
}

function geoAgentIcon(html: string): L.DivIcon {
  return L.divIcon({
    className: 'geo-agent-icon',
    html,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function decisionBubbleIcon(bubble: DecisionBubble, index: number): L.DivIcon {
  return L.divIcon({
    className: 'geo-bubble-icon',
    html:
      `<div class="decision-bubble">` +
      `<div class="decision-bubble__text">${escapeHtml(bubble.text)}</div>` +
      `<div class="decision-bubble__source">${escapeHtml(bubble.source)}</div></div>`,
    iconSize: [182, 56],
    iconAnchor: [91, 28 + index * 60],
  });
}

interface ZoneLayerEntry {
  layer: L.Polygon;
  latLngKey: string;
  styleKey: string;
  tooltipKey: string;
  /** Selected right now — read by the persistent click-toggle handler. */
  selected: boolean;
}

interface DeviceLayerEntry {
  layer: L.CircleMarker;
  latLngKey: string;
  styleKey: string;
  tooltipKey: string;
  /** Interactivity is fixed at creation — a dimming change recreates. */
  dimmed: boolean;
}

interface AgentLayerEntry {
  layer: L.Marker;
  latLngKey: string;
  iconKey: string;
  dimmed: boolean;
}

interface BindingEdgeEntry {
  layer: L.Polyline;
  latLngKey: string;
}

interface CollabEdgeLayerEntry {
  layer: L.Polyline;
  latLngKey: string;
  styleKey: string;
  tooltipKey: string;
  status: CollabEdgeStatus;
}

interface BubbleLayerEntry {
  layer: L.Marker;
  anchorKey: string;
}

interface GeoOverlayRegistry {
  /** Ordered paint groups: zones below devices below agents below edges. */
  zones: L.LayerGroup;
  devices: L.LayerGroup;
  agents: L.LayerGroup;
  edges: L.LayerGroup;
  fx: L.LayerGroup;
  zoneLayers: Map<string, ZoneLayerEntry>;
  deviceLayers: Map<string, DeviceLayerEntry>;
  agentLayers: Map<string, AgentLayerEntry>;
  bindingEdgeLayers: Map<string, BindingEdgeEntry>;
  collabEdgeLayers: Map<string, CollabEdgeLayerEntry>;
  bubbleLayers: Map<string, BubbleLayerEntry>;
  /** Draw-preview layers (transient — recreated when vertices change). */
  previewLayers: L.Layer[];
  /** UX-W2 vertex-edit handle layers (transient — recreated on change). */
  vertexEditLayers: L.Layer[];
}

export interface GeoWorldMapProps {
  model: WorldModel;
  /** Map view center = the environment's projection origin (map data). */
  center: LatLng;
  /** Default Leaflet zoom (map data; falls back to a city-wide default). */
  zoom?: number;
  snapshot?: EngineSnapshot | null;
  highlightZoneIds?: ReadonlySet<string>;
  /** Transient decision bubbles keyed by zone (live sim mode only). */
  bubbles?: readonly DecisionBubble[];
  layers?: WorldLayers;
  selection?: WorldSelection | null;
  onSelect?: (selection: WorldSelection | null) => void;
  /** Devices with recent activity (live sim overlays) — pulse ring. */
  activeDeviceIds?: ReadonlySet<string>;
  /** ownerId → color (ownership visual). */
  memberColorById?: ReadonlyMap<string, string>;
  /** Managed zones of the selected agent (focus highlight). */
  focusedZoneIds?: ReadonlySet<string>;
  /** 我的视角 (W5): keep this owner's objects lit, dim + freeze the rest. */
  focusOwnerId?: string | null;
  /** Catalog click-to-place: the next map click is reported, not a deselect. */
  placementActive?: boolean;
  onMapClick?: (latLng: LatLng) => void;
  /** Zone polygon drawing (W6-2): preview vertices + dblclick-to-finish. */
  drawActive?: boolean;
  drawVertices?: readonly [number, number][];
  onMapDblClick?: () => void;
  /**
   * UX-W2 vertex editing: drawVertices render as DRAGGABLE handles (edge
   * midpoints insert, right-click removes) instead of inert preview dots.
   */
  vertexEditActive?: boolean;
  onVertexMove?: (index: number, latLng: LatLng) => void;
  onVertexInsert?: (edgeIndex: number) => void;
  onVertexRemove?: (index: number) => void;
  /** AC collaboration edges overlay (W7 sim console), 协作边 toggle applies. */
  collabEdges?: readonly CollabEdge[];
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map<string, string>();
const DEFAULT_LAYERS: WorldLayers = { zones: true, devices: true, agents: true, edges: true };
const DEFAULT_ZOOM = 11;
/**
 * Auto-fit zoom ceiling (UX-08): street scale. The previous 13 was city
 * scale — a single-building world shrank to a handful of pixels, which read
 * as "small zone polygons not rendered". 17 keeps a building footprint
 * filling the view without zooming into a single room.
 */
const AUTO_FIT_MAX_ZOOM = 17;

export function GeoWorldMap({
  model,
  center,
  zoom = DEFAULT_ZOOM,
  snapshot = null,
  highlightZoneIds = EMPTY_SET,
  bubbles = [],
  layers = DEFAULT_LAYERS,
  selection = null,
  onSelect,
  activeDeviceIds = EMPTY_SET,
  memberColorById = EMPTY_MAP,
  focusedZoneIds = EMPTY_SET,
  focusOwnerId = null,
  placementActive = false,
  onMapClick,
  drawActive = false,
  drawVertices = [],
  onMapDblClick,
  vertexEditActive = false,
  onVertexMove,
  onVertexInsert,
  onVertexRemove,
  collabEdges = [],
}: GeoWorldMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  /**
   * R31 F1: keyed layer registry — vector layers PERSIST across prop
   * changes and are updated in place (setStyle/setLatLng/setTooltipContent),
   * replacing the pre-R31 clearLayers()+rebuild that tore down and
   * recreated ~60-80 Leaflet layers (39 circle markers with HTML tooltips,
   * zone polygons, agent divIcons, collab polylines) on EVERY snapshot
   * (≤1.5s) and every collab tick — marker flicker, GC churn, lost hover.
   * One ordered LayerGroup per kind keeps the paint order stable while
   * individual layers come and go.
   */
  const registryRef = useRef<GeoOverlayRegistry | null>(null);
  /** The active basemap layer, swapped when the user switches providers. */
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  /** Selected basemap provider (persisted per user in localStorage). */
  const [providerId, setProviderId] = useState<string>(() => loadMapProviderId());
  /**
   * R2-FEAT-01: basemap health surface. 'disabled' = the tile layer was
   * never created (zero tile requests — NOT a load failure; happens when
   * every provider is keyless-disabled); 'error' = the layer exists but
   * tiles are failing (network blocked / provider watermarking). Without
   * this the map rendered as a silent grey void.
   */
  const [basemapIssue, setBasemapIssue] = useState<'disabled' | 'error' | null>(null);
  const [basemapIssueDismissed, setBasemapIssueDismissed] = useState(false);
  /** Latest callbacks, so the long-lived map handlers never go stale. */
  const onSelectRef = useRef(onSelect);
  const onMapClickRef = useRef(onMapClick);
  const onMapDblClickRef = useRef(onMapDblClick);
  const onVertexMoveRef = useRef(onVertexMove);
  const onVertexInsertRef = useRef(onVertexInsert);
  const onVertexRemoveRef = useRef(onVertexRemove);
  const placementRef = useRef(placementActive);
  const drawActiveRef = useRef(drawActive);
  /** Timestamp of the last layer click — guards the map's deselect-on-click. */
  const lastLayerClickAtRef = useRef(0);
  /**
   * UX-08 auto-fit state: 'pending' until zone/device geometry has fitted the
   * view once; 'user' when the first manual pan/zoom lands before that (the
   * auto-fit then never fires); 'done' after the one-shot fit.
   */
  const autoFitRef = useRef<'pending' | 'user' | 'done'>('pending');
  // 主题色板（lib/theme）：Leaflet 覆盖层需要具体色值，主题切换时重建。
  const theme = useAppStore(s => s.theme);
  const colors = mapColors(theme);
  onSelectRef.current = onSelect;
  onMapClickRef.current = onMapClick;
  onMapDblClickRef.current = onMapDblClick;
  onVertexMoveRef.current = onVertexMove;
  onVertexInsertRef.current = onVertexInsert;
  onVertexRemoveRef.current = onVertexRemove;
  placementRef.current = placementActive;
  drawActiveRef.current = drawActive;

  // -------------------------------------------------------------------------
  // Mount: create the map once (StrictMode-safe: full cleanup on unmount).
  // -------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, { zoomControl: true, attributionControl: true });
    // R31 F1: one ordered LayerGroup per kind — zones paint below devices
    // below agents below edges below transient fx, regardless of the order
    // in which individual layers are later added/removed.
    registryRef.current = {
      zones: L.layerGroup().addTo(map),
      devices: L.layerGroup().addTo(map),
      agents: L.layerGroup().addTo(map),
      edges: L.layerGroup().addTo(map),
      fx: L.layerGroup().addTo(map),
      zoneLayers: new Map(),
      deviceLayers: new Map(),
      agentLayers: new Map(),
      bindingEdgeLayers: new Map(),
      collabEdgeLayers: new Map(),
      bubbleLayers: new Map(),
      previewLayers: [],
      vertexEditLayers: [],
    };
    map.setView([center.lat, center.lng], zoom);
    // A new map instance re-arms the one-shot auto-fit (StrictMode remount:
    // the ref outlives the first map, and the fresh map must fit too).
    autoFitRef.current = 'pending';
    // UX-08: the auto-fit lives in a data-driven effect below (the old
    // mount-time fitBounds raced the zero-size flex container, covered only
    // zone polygons, and never re-ran). Here we only arm the cancel: the
    // first USER pan/zoom before the fit suspends it forever. dragstart only
    // fires for pointer drags; zoomstart also fires for the programmatic
    // fitBounds, but by then the state is already 'done'.
    const cancelAutoFit = () => {
      if (autoFitRef.current === 'pending') autoFitRef.current = 'user';
    };
    map.on('dragstart', cancelAutoFit);
    map.on('zoomstart', cancelAutoFit);

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (placementRef.current) {
        onMapClickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng });
        return;
      }
      // Layer clicks (device/agent) stop propagation via this guard.
      if (Date.now() - lastLayerClickAtRef.current < 50) return;
      onSelectRef.current?.(null);
    });

    // Zone drawing (W6-2): dblclick finishes the polygon. Leaflet fires two
    // clicks first; the store's vertex append dedupes consecutive repeats.
    map.on('dblclick', () => {
      if (drawActiveRef.current) onMapDblClickRef.current?.();
    });

    mapRef.current = map;
    // Flex containers have no size at mount time in some layouts.
    // Unmount guards (F3 _leaflet_pos pageerror): an unmount between
    // scheduling and firing — SPA navigation with placement/drawing armed,
    // or the StrictMode remount when entering the sim console — leaves these
    // callbacks calling into a REMOVED map, whose `_leaflet_pos` container
    // cache is already deleted.
    let removed = false;
    const sizeFrame = requestAnimationFrame(() => {
      if (!removed) map.invalidateSize();
    });
    // Present mode (and any layout change: sidebar resize, drawers) resizes
    // the container after mount. Leaflet caches its size, so without this
    // the projection goes stale and markers appear to drift off their
    // lat/lng positions ("agents not fixed on the map").
    const resizeObserver = new ResizeObserver(() => {
      if (!removed) map.invalidateSize();
    });
    resizeObserver.observe(container);
    return () => {
      removed = true;
      cancelAnimationFrame(sizeFrame);
      resizeObserver.disconnect();
      // Halt any in-flight zoom/pan animation FIRST: its CSS transitionend
      // (_onZoomTransitionEnd → _move → _getMapPanePos) fires after remove()
      // has deleted the container's `_leaflet_pos` cache — the auto-fit
      // fitBounds animation racing walk↔world navigation was the live
      // reproducer (ux-w4b probe B3, stack captured).
      map.stop();
      // Detach every Leaflet listener BEFORE teardown: an in-flight pointer
      // or dblclick (armed placement/zone drawing) landing mid-remove would
      // otherwise dereference the deleted container cache.
      map.off();
      map.remove();
      mapRef.current = null;
      registryRef.current = null;
      tileLayerRef.current = null;
    };
    // The view is initialized once from the environment's map data; later
    // prop changes (center/zoom edits) intentionally do not re-center.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basemap swap: rebuild the tile layer when the provider changes.
  useEffect(() => {
    const map = mapRef.current;
    const provider = getMapProvider(providerId);
    setBasemapIssueDismissed(false);
    if (!map) return;
    if (!provider || !provider.enabled) {
      // R2-FEAT-01: a disabled provider means NO tile layer exists — zero
      // tile requests, not a load failure. Surface it instead of a grey void.
      tileLayerRef.current?.remove();
      tileLayerRef.current = null;
      setBasemapIssue('disabled');
      return;
    }
    tileLayerRef.current?.remove();
    const layer = L.tileLayer(provider.tileUrl, {
      maxZoom: provider.maxZoom,
      attribution: provider.attribution,
      subdomains: provider.subdomains ?? 'abc',
      // Fills the `{r}` retina placeholder used by the CARTO basemaps.
      detectRetina: true,
    });
    // R2-FEAT-01: tile failures (blocked network, provider key watermarks)
    // raise the teaching banner; a full successful load clears it.
    layer.on('tileerror', () => setBasemapIssue('error'));
    layer.on('load', () => setBasemapIssue(null));
    tileLayerRef.current = layer.addTo(map);
    setBasemapIssue(null);
  }, [providerId]);

  const switchProvider = (id: string) => {
    const provider = getMapProvider(id);
    if (!provider?.enabled) return;
    setProviderId(id);
    saveMapProviderId(id);
  };

  // Crosshair cursor while click-to-place is armed.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.toggle('geo-map--placing', placementActive);
  }, [placementActive]);

  // Zone drawing: suspend doubleClickZoom so dblclick means "finish".
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (drawActive) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [drawActive]);

  // -------------------------------------------------------------------------
  // Derived overlay data (rebuilt whenever the world/sim props change; the
  // world stream flows in through `model`, so live edits appear here).
  // -------------------------------------------------------------------------
  const deviceLatLngById = useMemo(() => {
    const byId = new Map<string, LatLng>();
    const zoneById = new Map(model.zones.map(zone => [zone.id, zone]));
    for (const device of model.devices) {
      // Persisted position wins; unplaced devices sit at their zone centroid.
      const polygon = zoneById.get(device.zoneId)?.polygon;
      const latLng =
        device.latLng ?? (polygon && polygon.length >= 3 ? polygonCentroid(polygon) : null);
      if (latLng) byId.set(device.id, latLng);
    }
    return byId;
  }, [model]);

  const agentLatLngById = useMemo(() => {
    const zoneById = new Map(model.zones.map(zone => [zone.id, zone]));
    const anchored = model.agents.map((agent: WorldModelAgent) => {
      const managedZones = agent.managedZoneIds
        .map(zoneId => zoneById.get(zoneId))
        .filter((zone): zone is NonNullable<typeof zone> => zone !== undefined);
      const boundPositions = agent.boundDeviceIds.map(id => deviceLatLngById.get(id) ?? null);
      return { id: agent.id, anchor: agentLatLng(managedZones, boundPositions, center) };
    });
    // Co-anchored agents (e.g. one district's 8 stewards + coordinator on the
    // same zone centroid) fan out on a sunflower spiral instead of stacking.
    // Clamp the radius to 0.4 × the half diagonal of the largest zone
    // footprint (floored at two fan-out units): at city scale an unclamped
    // k≈100 anchor throws markers ~2 km off their district. Worlds without
    // polygons keep the legacy unclamped behavior.
    let maxHalfDiagDeg = 0;
    for (const zone of model.zones) {
      const polygon = zone.polygon;
      if (!polygon || polygon.length < 3) continue;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLng = Infinity;
      let maxLng = -Infinity;
      for (const [la, ln] of polygon) {
        if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
        minLat = Math.min(minLat, la);
        maxLat = Math.max(maxLat, la);
        minLng = Math.min(minLng, ln);
        maxLng = Math.max(maxLng, ln);
      }
      if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) continue;
      maxHalfDiagDeg = Math.max(maxHalfDiagDeg, Math.hypot(maxLat - minLat, maxLng - minLng) / 2);
    }
    const fanOutCap =
      maxHalfDiagDeg > 0 ? Math.max(maxHalfDiagDeg * 0.4, AGENT_FAN_OUT_DEG * 2) : Infinity;
    return fanOutCoAnchored(anchored, AGENT_FAN_OUT_DEG, fanOutCap);
  }, [model, deviceLatLngById, center]);

  // UX-08 auto-fit: once zone/device geometry is ready, fit the view to the
  // union of polygon vertices and device anchors. One-shot, and only while
  // the user has not panned/zoomed yet (autoFitRef). The map is created once
  // on mount while the model may arrive/replace later, so this must live in
  // a data-driven effect — the old mount-time fitBounds raced the zero-size
  // flex container (invalidateSize is deferred to a rAF) and silently
  // computed a degenerate zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || autoFitRef.current !== 'pending') return;
    const points = geoAutoFitPoints(model.zones, deviceLatLngById.values());
    if (points.length === 0) return;
    const bounds = L.latLngBounds(points);
    if (!bounds.isValid()) return;
    // Zero-size container (map mounted hidden, or a data tick landing
    // mid-unmount): fitting here throws Leaflet's `_leaflet_pos`
    // pageerror (ux-w4 probe B3). Stay 'pending' — the next model/snapshot
    // tick after the container gains size retries.
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return;
    autoFitRef.current = 'done';
    // Measure the container before deriving the zoom: at mount it may still
    // be 0×0 in flex layouts (see the rAF invalidateSize above).
    map.invalidateSize();
    // animate:false — an ANIMATED fit leaves a CSS transition running whose
    // transitionend (_onZoomTransitionEnd → _move → _getMapPanePos) fires
    // even after map.stop() + remove() when the user navigates away
    // mid-flight (ux-w4b probe B3, stack captured; the one-frame visual
    // polish is not worth a recurring pageerror).
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: AUTO_FIT_MAX_ZOOM, animate: false });
  }, [model, deviceLatLngById]);

  // -------------------------------------------------------------------------
  // Overlay sync (R31 F1): diff the desired per-layer state against the
  // persistent registry and apply ONLY the changes — setStyle for parameter
  // changes, setLatLng/setLatLngs for geometry, setTooltipContent /
  // setIcon for content, DOM class toggles for the pulse animations.
  // Layers are created/removed only when their id appears/disappears, so a
  // steady-state snapshot tick with no visual change costs a few string
  // compares instead of a full DOM teardown (no marker flicker, hover
  // state survives).
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const registry = registryRef.current;
    if (!map || !registry) return;

    const selectedDeviceId = selection?.objectType === 'device' ? selection.id : null;
    const selectedAgentId = selection?.objectType === 'agent' ? selection.id : null;
    const selectedZoneId = selection?.objectType === 'zone' ? selection.id : null;
    const snapshotZones = new Map(snapshot?.zones.map(z => [z.id, z]) ?? []);
    const snapshotDevices = new Map(snapshot?.devices.map(d => [d.id, d]) ?? []);
    const layerClick = (handler: () => void) => (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e.originalEvent);
      lastLayerClickAtRef.current = Date.now();
      handler();
    };
    const syncGroup = (group: L.LayerGroup, visible: boolean) => {
      if (visible === map.hasLayer(group)) return;
      if (visible) map.addLayer(group);
      else map.removeLayer(group);
    };

    // --- Zones (polygons + hover tooltip with live params in sim mode). ---
    syncGroup(registry.zones, layers.zones);
    if (layers.zones) {
      const desired = new Set<string>();
      for (const zone of model.zones) {
        if (!zone.polygon || zone.polygon.length < 3) continue;
        desired.add(zone.id);
        const liveZone = snapshotZones.get(zone.id);
        const zoneSelected = zone.id === selectedZoneId;
        const state = zoneLayerState({
          selected: zoneSelected,
          focused: focusedZoneIds.has(zone.id),
          highlighted: highlightZoneIds.has(zone.id),
          colors,
        });
        const latLngKey = stateKey(zone.polygon.flat());
        const styleKey = stateKey([state.color, state.weight, state.fillColor, state.fillOpacity]);
        const tooltipKey = zoneTooltipHtml(zone, liveZone?.parameters);

        const entry = registry.zoneLayers.get(zone.id);
        if (!entry) {
          const polygon = L.polygon(
            zone.polygon.map(([lat, lng]) => [lat, lng] as [number, number]),
            {
              color: state.color,
              weight: state.weight,
              fillColor: state.fillColor,
              fillOpacity: state.fillOpacity,
              className: state.highlighted ? 'geo-zone--pulse' : undefined,
            },
          );
          polygon.bindTooltip(tooltipKey, { sticky: true });
          // R15-D9: a click reports the selection (the console's curves
          // follow it). The toggle reads the CURRENT selection from the
          // registry entry — the layer outlives selection changes.
          polygon.on(
            'click',
            layerClick(() => {
              const current = registry.zoneLayers.get(zone.id);
              onSelectRef.current?.(current?.selected ? null : { objectType: 'zone', id: zone.id });
            }),
          );
          registry.zones.addLayer(polygon);
          registry.zoneLayers.set(zone.id, {
            layer: polygon,
            latLngKey,
            styleKey,
            tooltipKey,
            selected: zoneSelected,
          });
          continue;
        }
        if (entry.latLngKey !== latLngKey) {
          entry.layer.setLatLngs(zone.polygon.map(([lat, lng]) => [lat, lng] as [number, number]));
          entry.latLngKey = latLngKey;
        }
        if (entry.styleKey !== styleKey) {
          entry.layer.setStyle({
            color: state.color,
            weight: state.weight,
            fillColor: state.fillColor,
            fillOpacity: state.fillOpacity,
          });
          entry.styleKey = styleKey;
        }
        if (entry.tooltipKey !== tooltipKey) {
          entry.layer.setTooltipContent(tooltipKey);
          entry.tooltipKey = tooltipKey;
        }
        entry.selected = zoneSelected;
        // className (pulse) is baked in at creation for Leaflet — toggle
        // the DOM class directly for the animation afterwards.
        entry.layer.getElement()?.classList.toggle('geo-zone--pulse', state.highlighted);
      }
      for (const [id, entry] of registry.zoneLayers) {
        if (!desired.has(id)) {
          registry.zones.removeLayer(entry.layer);
          registry.zoneLayers.delete(id);
        }
      }
    }

    // --- Devices (LOD circle markers). ---
    syncGroup(registry.devices, layers.devices);
    if (layers.devices) {
      const desired = new Set<string>();
      for (const device of model.devices) {
        const latLng = deviceLatLngById.get(device.id);
        if (!latLng) continue;
        desired.add(device.id);
        const liveDevice = snapshotDevices.get(device.id);
        const ownerColor = device.ownerId ? (memberColorById.get(device.ownerId) ?? null) : null;
        const deviceSelected = device.id === selectedDeviceId;
        // P3d: an active fault injection shows as a red ring (snapshot-driven).
        // 我的视角: others' dots dim to ~25% opacity and stop responding.
        const dimmed = isDimmed(device.ownerId, focusOwnerId);
        const state = deviceLayerState({
          selected: deviceSelected,
          faulted: liveDevice?.fault != null,
          dimmed,
          active: activeDeviceIds.has(device.id),
          role: liveDevice?.role ?? device.role,
          ownerColor,
          colors,
        });
        const latLngKey = stateKey([latLng.lat, latLng.lng]);
        const styleKey = stateKey([
          state.radius,
          state.color,
          state.weight,
          state.fillColor,
          state.opacity,
          state.fillOpacity,
        ]);
        const tooltipKey = deviceTooltipHtml(device, liveDevice);

        let entry = registry.deviceLayers.get(device.id);
        if (entry && entry.dimmed !== dimmed) {
          // Interactivity is fixed at layer creation — a dimming change
          // must recreate (rare: perspective toggle only).
          registry.devices.removeLayer(entry.layer);
          registry.deviceLayers.delete(device.id);
          entry = undefined;
        }
        if (!entry) {
          const marker = L.circleMarker([latLng.lat, latLng.lng], {
            radius: state.radius,
            color: state.color,
            weight: state.weight,
            fillColor: state.fillColor,
            opacity: state.opacity,
            fillOpacity: state.fillOpacity,
            interactive: !dimmed,
            className: state.active ? 'geo-device--pulse' : undefined,
          });
          marker.bindTooltip(tooltipKey, { sticky: true });
          if (!dimmed) {
            marker.on(
              'click',
              layerClick(() => onSelectRef.current?.({ objectType: 'device', id: device.id })),
            );
          }
          registry.devices.addLayer(marker);
          registry.deviceLayers.set(device.id, { layer: marker, latLngKey, styleKey, tooltipKey, dimmed });
          continue;
        }
        if (entry.latLngKey !== latLngKey) {
          entry.layer.setLatLng([latLng.lat, latLng.lng]);
          entry.latLngKey = latLngKey;
        }
        if (entry.styleKey !== styleKey) {
          entry.layer.setStyle({
            color: state.color,
            weight: state.weight,
            fillColor: state.fillColor,
            opacity: state.opacity,
            fillOpacity: state.fillOpacity,
          });
          // Radius rides the style key; Leaflet needs setRadius to
          // re-project the circle (setStyle alone does not).
          entry.layer.setRadius(state.radius);
          entry.styleKey = styleKey;
        }
        if (entry.tooltipKey !== tooltipKey) {
          entry.layer.setTooltipContent(tooltipKey);
          entry.tooltipKey = tooltipKey;
        }
        entry.layer.getElement()?.classList.toggle('geo-device--pulse', state.active);
      }
      for (const [id, entry] of registry.deviceLayers) {
        if (!desired.has(id)) {
          registry.devices.removeLayer(entry.layer);
          registry.deviceLayers.delete(id);
        }
      }
    }

    // --- Agents (hexagon DivIcons). ---
    syncGroup(registry.agents, layers.agents);
    if (layers.agents) {
      const desired = new Set<string>();
      for (const agent of model.agents) {
        const anchor = agentLatLngById.get(agent.id);
        if (!anchor) continue;
        desired.add(agent.id);
        const ownerColor = agent.ownerId ? (memberColorById.get(agent.ownerId) ?? null) : null;
        const selected = agent.id === selectedAgentId;
        // 我的视角: others' markers dim to ~25% opacity and stop responding.
        const dimmed = isDimmed(agent.ownerId, focusOwnerId);
        const iconKey = agentIconHtml({ name: agent.name, selected, dimmed, ownerColor });
        const latLngKey = stateKey([anchor.lat, anchor.lng]);

        let entry = registry.agentLayers.get(agent.id);
        if (entry && entry.dimmed !== dimmed) {
          registry.agents.removeLayer(entry.layer);
          registry.agentLayers.delete(agent.id);
          entry = undefined;
        }
        if (!entry) {
          const icon = geoAgentIcon(iconKey);
          const marker = L.marker([anchor.lat, anchor.lng], { icon, interactive: !dimmed });
          if (!dimmed) {
            marker.on(
              'click',
              layerClick(() => onSelectRef.current?.({ objectType: 'agent', id: agent.id })),
            );
          }
          registry.agents.addLayer(marker);
          registry.agentLayers.set(agent.id, { layer: marker, latLngKey, iconKey, dimmed });
          continue;
        }
        if (entry.latLngKey !== latLngKey) {
          entry.layer.setLatLng([anchor.lat, anchor.lng]);
          entry.latLngKey = latLngKey;
        }
        if (entry.iconKey !== iconKey) {
          entry.layer.setIcon(geoAgentIcon(iconKey));
          entry.iconKey = iconKey;
        }
      }
      for (const [id, entry] of registry.agentLayers) {
        if (!desired.has(id)) {
          registry.agents.removeLayer(entry.layer);
          registry.agentLayers.delete(id);
        }
      }
    }

    // --- Binding edges: selected agent → every bound device (§11.5). ---
    syncGroup(registry.edges, layers.edges);
    const bindingVisible = layers.edges && layers.agents && layers.devices;
    if (bindingVisible) {
      const deviceIds = new Set(model.devices.map(d => d.id));
      const desired = new Set<string>();
      for (const pair of deriveAgentEdgePairs(model.agents, selectedAgentId, deviceIds)) {
        const from = agentLatLngById.get(pair.agentId);
        const to = deviceLatLngById.get(pair.deviceId);
        if (!from || !to) continue;
        const key = `${pair.agentId}::${pair.deviceId}`;
        desired.add(key);
        const latLngKey = stateKey([from.lat, from.lng, to.lat, to.lng]);
        const entry = registry.bindingEdgeLayers.get(key);
        if (!entry) {
          const polyline = L.polyline(
            [
              [from.lat, from.lng],
              [to.lat, to.lng],
            ],
            { color: colors.accent, weight: 2, dashArray: '6 6', className: 'geo-binding-edge' },
          );
          registry.edges.addLayer(polyline);
          registry.bindingEdgeLayers.set(key, { layer: polyline, latLngKey });
          continue;
        }
        if (entry.latLngKey !== latLngKey) {
          entry.layer.setLatLngs([
            [from.lat, from.lng],
            [to.lat, to.lng],
          ]);
          entry.latLngKey = latLngKey;
        }
      }
      for (const [key, entry] of registry.bindingEdgeLayers) {
        if (!desired.has(key)) {
          registry.edges.removeLayer(entry.layer);
          registry.bindingEdgeLayers.delete(key);
        }
      }
    } else {
      for (const [key, entry] of registry.bindingEdgeLayers) {
        registry.edges.removeLayer(entry.layer);
        registry.bindingEdgeLayers.delete(key);
      }
    }

    // --- AC collaboration edges (W7): polylines between the agent DivIcon
    // anchors. Forming = dashed (marching via CSS), running = solid accent,
    // completed/failed = green/red fading over the keep window. Opacity is
    // recomputed per sync (not a CSS animation) so a sync doesn't restart
    // the fade — with in-place setStyle it now also no longer restarts the
    // whole layer. ---
    const collabVisible = layers.edges && layers.agents;
    if (collabVisible && collabEdges.length > 0) {
      const agentNameById = new Map(model.agents.map(agent => [agent.id, agent.name]));
      const edgeColors = collabEdgeColors(colors);
      const now = Date.now();
      const desired = new Set<string>();
      for (const edge of collabEdges) {
        const from = agentLatLngById.get(edge.source);
        const to = agentLatLngById.get(edge.target);
        if (!from || !to) continue;
        desired.add(edge.key);
        const color = edgeColors[edge.status];
        const opacity = collabEdgeOpacity(edge, now);
        const weight = edge.status === 'running' ? 3 : 2.5;
        const dashArray = edge.status === 'forming' ? '6 6' : undefined;
        const latLngKey = stateKey([from.lat, from.lng, to.lat, to.lng]);
        const styleKey = stateKey([color, weight, opacity, dashArray ?? '-']);
        const names = `${escapeHtml(agentNameById.get(edge.source) ?? edge.source)} ↔ ${escapeHtml(agentNameById.get(edge.target) ?? edge.target)}`;
        const tooltipKey =
          `<strong>${names}</strong> · ${i18n.t(COLLAB_EDGE_STATE_KEY[edge.status])}` +
          (edge.description
            ? `<br/><span class="geo-tooltip__dim">${escapeHtml(edge.description)}</span>`
            : '');

        const entry = registry.collabEdgeLayers.get(edge.key);
        if (!entry) {
          const polyline = L.polyline(
            [
              [from.lat, from.lng],
              [to.lat, to.lng],
            ],
            {
              color,
              weight,
              opacity,
              dashArray,
              className: `geo-collab-edge geo-collab-edge--${edge.status}`,
            },
          );
          polyline.bindTooltip(tooltipKey, { sticky: true });
          registry.edges.addLayer(polyline);
          registry.collabEdgeLayers.set(edge.key, {
            layer: polyline,
            latLngKey,
            styleKey,
            tooltipKey,
            status: edge.status,
          });
          continue;
        }
        if (entry.latLngKey !== latLngKey) {
          entry.layer.setLatLngs([
            [from.lat, from.lng],
            [to.lat, to.lng],
          ]);
          entry.latLngKey = latLngKey;
        }
        if (entry.styleKey !== styleKey) {
          entry.layer.setStyle({ color, weight, opacity, dashArray });
          entry.styleKey = styleKey;
        }
        if (entry.tooltipKey !== tooltipKey) {
          entry.layer.setTooltipContent(tooltipKey);
          entry.tooltipKey = tooltipKey;
        }
        if (entry.status !== edge.status) {
          const element = entry.layer.getElement();
          element?.classList.remove(`geo-collab-edge--${entry.status}`);
          element?.classList.add(`geo-collab-edge--${edge.status}`);
          entry.status = edge.status;
        }
      }
      for (const [key, entry] of registry.collabEdgeLayers) {
        if (!desired.has(key)) {
          registry.edges.removeLayer(entry.layer);
          registry.collabEdgeLayers.delete(key);
        }
      }
    } else {
      for (const [key, entry] of registry.collabEdgeLayers) {
        registry.edges.removeLayer(entry.layer);
        registry.collabEdgeLayers.delete(key);
      }
    }

    // --- Zone drawing live preview (W6-2): dashed ring + vertex dots; a
    // faint fill appears once the ring can close (>= 3 vertices). Rare and
    // user-driven — recreated wholesale on change. ---
    for (const layer of registry.previewLayers) registry.fx.removeLayer(layer);
    registry.previewLayers = [];
    if (drawVertices.length > 0) {
      const points = drawVertices.map(([lat, lng]) => [lat, lng] as [number, number]);
      const preview: L.Layer[] = [];
      if (drawVertices.length >= 3) {
        preview.push(
          L.polygon(points, {
            color: colors.accent,
            weight: 1,
            fillColor: colors.accent,
            fillOpacity: 0.08,
            dashArray: '4 6',
            interactive: false,
          }),
        );
      } else {
        preview.push(
          L.polyline(points, { color: colors.accent, weight: 2, dashArray: '4 6', interactive: false }),
        );
      }
      for (const point of points) {
        preview.push(
          L.circleMarker(point, {
            radius: 4,
            color: colors.accent,
            weight: 2,
            fillColor: colors.bg,
            fillOpacity: 1,
            interactive: false,
          }),
        );
      }
      for (const layer of preview) registry.fx.addLayer(layer);
      registry.previewLayers = preview;
    }

    // --- UX-W2 vertex editing: draggable vertex handles (drag to move,
    // right-click to remove) + clickable edge midpoints (insert). The ring
    // outline itself comes from the draw-preview block above. Transient and
    // user-driven — recreated wholesale on change, like the preview. ---
    for (const layer of registry.vertexEditLayers) registry.fx.removeLayer(layer);
    registry.vertexEditLayers = [];
    if (vertexEditActive && drawVertices.length >= 3) {
      const handles: L.Layer[] = [];
      drawVertices.forEach(([lat, lng], index) => {
        const handle = L.marker([lat, lng], {
          icon: L.divIcon({
            className: 'geo-vertex-icon',
            html: '<div class="geo-vertex-handle"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7],
          }),
          draggable: true,
        });
        handle.on('dragend', () => {
          lastLayerClickAtRef.current = Date.now();
          const position = handle.getLatLng();
          onVertexMoveRef.current?.(index, { lat: position.lat, lng: position.lng });
        });
        handle.on('click', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e.originalEvent);
          lastLayerClickAtRef.current = Date.now();
        });
        handle.on('contextmenu', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e.originalEvent);
          L.DomEvent.preventDefault(e.originalEvent);
          lastLayerClickAtRef.current = Date.now();
          onVertexRemoveRef.current?.(index);
        });
        handles.push(handle);
      });
      drawVertices.forEach(([lat, lng], edgeIndex) => {
        const next = drawVertices[(edgeIndex + 1) % drawVertices.length];
        const midpoint = L.circleMarker([(lat + next[0]) / 2, (lng + next[1]) / 2], {
          radius: 4,
          color: colors.accent,
          weight: 1.5,
          fillColor: colors.bg,
          fillOpacity: 0.9,
          className: 'geo-vertex-midpoint',
        });
        midpoint.on('click', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e.originalEvent);
          lastLayerClickAtRef.current = Date.now();
          onVertexInsertRef.current?.(edgeIndex);
        });
        handles.push(midpoint);
      });
      for (const layer of handles) registry.fx.addLayer(layer);
      registry.vertexEditLayers = handles;
    }

    // --- Decision bubbles (sim console overlay) near the zone centroid. ---
    const zoneById = new Map(model.zones.map(zone => [zone.id, zone]));
    const bubbleIndexByZone = new Map<string, number>();
    const desiredBubbles = new Set<string>();
    for (const bubble of bubbles) {
      const polygon = zoneById.get(bubble.zoneId)?.polygon;
      if (!polygon || polygon.length < 3) continue;
      const index = bubbleIndexByZone.get(bubble.zoneId) ?? 0;
      bubbleIndexByZone.set(bubble.zoneId, index + 1);
      const anchor = polygonCentroid(polygon);
      // Stacking order within the zone rides the anchor key — an expired
      // sibling re-anchors the survivors.
      const anchorKey = stateKey([anchor.lat, anchor.lng, index]);
      desiredBubbles.add(bubble.id);
      const entry = registry.bubbleLayers.get(bubble.id);
      if (entry) {
        if (entry.anchorKey !== anchorKey) {
          entry.layer.setIcon(decisionBubbleIcon(bubble, index));
          entry.anchorKey = anchorKey;
        }
        continue;
      }
      const marker = L.marker([anchor.lat, anchor.lng], {
        icon: decisionBubbleIcon(bubble, index),
        interactive: false,
      });
      registry.fx.addLayer(marker);
      registry.bubbleLayers.set(bubble.id, { layer: marker, anchorKey });
    }
    for (const [id, entry] of registry.bubbleLayers) {
      if (!desiredBubbles.has(id)) {
        registry.fx.removeLayer(entry.layer);
        registry.bubbleLayers.delete(id);
      }
    }
  }, [
    model,
    layers,
    snapshot,
    selection,
    activeDeviceIds,
    memberColorById,
    highlightZoneIds,
    focusedZoneIds,
    focusOwnerId,
    bubbles,
    deviceLatLngById,
    agentLatLngById,
    drawVertices,
    vertexEditActive,
    collabEdges,
    colors,
  ]);

  return (
    <div className="environment-map">
      <div ref={containerRef} className="geo-map" />
      {/* R2-FEAT-01: basemap health teaching banner — a disabled provider
          (zero tile requests) or failing tiles used to render as a silent
          grey void; the banner names the cause and points at the switcher. */}
      {basemapIssue !== null && !basemapIssueDismissed && (
        <div className="geo-basemap-banner" role="alert">
          <span className="geo-basemap-banner__text">
            {basemapIssue === 'disabled'
              ? i18n.t('mapProvidersLib:basemapDisabled')
              : i18n.t('mapProvidersLib:basemapTileError', { provider: providerName(providerId) })}
          </span>
          <button
            type="button"
            className="geo-basemap-banner__dismiss"
            onClick={() => setBasemapIssueDismissed(true)}
          >
            {i18n.t('mapProvidersLib:basemapDismiss')}
          </button>
        </div>
      )}
      <div className="map-style-switcher" role="group" aria-label={i18n.t('worldMapLib:styleSwitcherAria')}>
        {MAP_PROVIDERS.map(provider => {
          const resolved = getMapProvider(provider.id)!;
          return (
            <button
              key={provider.id}
              type="button"
              className={
                `map-style-chip${provider.id === providerId ? ' map-style-chip--active' : ''}` +
                `${provider.enabled ? '' : ' map-style-chip--disabled'}`
              }
              disabled={!provider.enabled}
              title={provider.enabled ? providerName(provider.id) : resolved.disabledReason}
              onClick={() => switchProvider(provider.id)}
            >
              {providerName(provider.id)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
