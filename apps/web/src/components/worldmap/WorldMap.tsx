/**
 * WorldMap — the shared map canvas implementing the §11.5 visualization
 * hierarchy. Used by both the world view (environment detail) and the sim
 * console so the visuals stay consistent:
 *
 * - zones as containers (live parameter overlay when a snapshot is present;
 *   click selects the zone — W4 highlight + sidebar/console linkage);
 * - devices as LOD dots (fill = role/type category, border = owner color,
 *   pulse ring on recent activity, tooltip-only identity, click → detail);
 * - agents as a distinct hexagon layer anchored at the centroid of their
 *   managed zones (or bound devices); selecting an agent draws animated
 *   binding edges to every bound device and highlights its managed zones;
 * - independent layer toggles (zones / devices / agents / binding edges);
 * - optional drag-to-reposition for builders (position PATCH on drop).
 *
 * The map is controlled: nodes/edges are derived from the `model` prop.
 * During a drag, position overrides are tracked locally and dropped whenever
 * the model changes (the server round trip then supplies the new position —
 * or snaps the dot back if the edit was rejected).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeChange,
  type NodeDragHandler,
  type ReactFlowInstance,
} from 'reactflow';
import 'reactflow/dist/style.css';

import type { EngineSnapshot } from '../../api/types';
import type { EnvFloorPlan } from '../../api/types';
import i18n from '../../i18n/config';
import { deriveAgentEdgePairs } from '../../lib/agentEdges';
import { defaultActiveFloor, floorLabeling, formatBuildingId, listBuildings, zoneIdsInBuilding } from '../../lib/buildings';
import { zoneAlertLevel } from '../../lib/campus3d';
import { isTerminal, TERMINAL_KEEP_MS, type CollabEdge, type CollabEdgeStatus } from '../../lib/collabGraph';
import { formatParameter, summarizeDeviceState } from '../../lib/format';
import { summarizeFaultProfile } from '../../lib/faults';
import { isDimmed } from '../../lib/perspective';
import type { WorldModel, WorldModelDevice } from '../../lib/worldModel';
import { collabEdgeColors, mapColors, type MapColors } from '../../lib/theme';
import {
  classifyZone,
  HEAT_TEMP_MAX,
  HEAT_TEMP_MID,
  HEAT_TEMP_MIN,
  readOccupancy,
  readZoneComfort,
  zoneHeatFill,
} from '../../lib/zoneVisual';
import { useAppStore } from '../../store/useAppStore';
import {
  AGENT_SIZE,
  agentAnchorPoint,
  computeDoorGaps,
  computeZoneFrames,
  DOT_SIZE,
  layoutDeviceDots,
  WORLD_SCALE,
  type ZoneFrame,
} from './layout';
import {
  AgentMarkerNode,
  BubbleNode,
  DeviceDotNode,
  DoorGapNode,
  PlanImageNode,
  ZoneNode,
  type DecisionBubble,
} from './nodes';

export type { DecisionBubble } from './nodes';

export interface WorldLayers {
  zones: boolean;
  devices: boolean;
  agents: boolean;
  edges: boolean;
}

export interface WorldSelection {
  objectType: 'device' | 'agent' | 'zone';
  id: string;
}

const nodeTypes = {
  zone: ZoneNode,
  deviceDot: DeviceDotNode,
  agentMarker: AgentMarkerNode,
  bubble: BubbleNode,
  planImage: PlanImageNode,
  doorGap: DoorGapNode,
};

interface BuildOptions {
  snapshot: EngineSnapshot | null;
  highlightZoneIds: ReadonlySet<string>;
  bubbles: readonly DecisionBubble[];
  layers: WorldLayers;
  selection: WorldSelection | null;
  activeDeviceIds: ReadonlySet<string>;
  memberColorById: ReadonlyMap<string, string>;
  focusedZoneIds: ReadonlySet<string>;
  /** 我的视角 (W5): objects owned by others render dimmed + non-interactive. */
  focusOwnerId: string | null;
  dragOverrides: ReadonlyMap<string, { x: number; y: number }>;
  editable: boolean;
  /**
   * UX-W2 grid bounds editing: the armed zone's rectangle is draggable
   * (move = translate bounds; resize stays on the numeric form). Optional so
   * legacy buildGraph callers (tests) stay source-compatible.
   */
  editableZoneId?: string | null;
  /** AC collaboration edges (W7 sim console): drawn between agent markers. */
  collabEdges: readonly CollabEdge[];
  /** 当前主题色板（lib/theme，覆盖层需要具体色值）。 */
  colors: MapColors;
  /** Cross-floor adjacency labels per zone id (⇅ chips on the zone node). */
  crossFloorLinks: ReadonlyMap<string, string[]>;
}

const COLLAB_EDGE_STATE_LABEL_KEYS: Record<CollabEdgeStatus, string> = {
  forming: 'collabEdgeForming',
  running: 'collabEdgeRunning',
  completed: 'collabEdgeCompleted',
  failed: 'collabEdgeFailed',
};

/** Resolves the localized collaboration-edge state label (reads i18n synchronously). */
function collabEdgeStateLabel(status: CollabEdgeStatus): string {
  return i18n.t(`worldMap:${COLLAB_EDGE_STATE_LABEL_KEYS[status]}`, {
    defaultValue: status,
  });
}

// ---------------------------------------------------------------------------
// R31 F4/F13: per-node `data` caches.
//
// reactflow v11 memo-compares each node component's props, but buildGraph
// used to hand EVERY node a fresh `data` object on every rebuild (snapshot
// tick, selection, collab-edge fade…), so all zone/device/agent components
// re-rendered each pass — 39 DeviceDots (each with useViewport subscribe +
// i18n tooltip build) plus ~12 zones plus 9 agents. An entry is reused
// verbatim while its inputs are reference/value-equal: the model object
// (zone/device/agent), the live snapshot object, the selection/overlay bits
// and the i18n language. Only genuinely changed nodes get a new `data`,
// which lets reactflow's internal memo actually skip the rest.
// ---------------------------------------------------------------------------

interface ZoneDataCacheEntry {
  zoneRef: WorldModel['zones'][number];
  liveRef: EngineSnapshot['zones'][number] | undefined;
  highlighted: boolean;
  focused: boolean;
  selected: boolean;
  /** R2-FEAT-02: critical-alert flag (live parameters over threshold). */
  alerted: boolean;
  /** UX-W2: bounds-edit affordance (dashed outline + draggable). */
  geometryEditing: boolean;
  /** join('\0') key of the cross-floor link labels (string array compare). */
  verticalLinksKey: string;
  language: string;
  data: Record<string, unknown>;
}

interface DeviceDataCacheEntry {
  deviceRef: WorldModelDevice;
  liveRef: EngineSnapshot['devices'][number] | undefined;
  ownerColor: string | null;
  active: boolean;
  selected: boolean;
  dimmed: boolean;
  language: string;
  data: Record<string, unknown>;
}

interface AgentDataCacheEntry {
  agentRef: WorldModel['agents'][number];
  ownerColor: string | null;
  selected: boolean;
  dimmed: boolean;
  data: Record<string, unknown>;
}

const zoneDataCache = new Map<string, ZoneDataCacheEntry>();
const deviceDataCache = new Map<string, DeviceDataCacheEntry>();
const agentDataCache = new Map<string, AgentDataCacheEntry>();

/** Test hook: buildGraph caches live for the module's lifetime. */
export function clearGraphNodeDataCaches(): void {
  zoneDataCache.clear();
  deviceDataCache.clear();
  agentDataCache.clear();
}

/** Drops cache entries whose ids vanished from the model (env switch). */
function pruneNodeDataCaches(model: WorldModel): void {
  if (zoneDataCache.size > 0 && zoneDataCache.size !== model.zones.length) {
    const ids = new Set(model.zones.map(zone => zone.id));
    for (const id of zoneDataCache.keys()) if (!ids.has(id)) zoneDataCache.delete(id);
  }
  if (deviceDataCache.size > 0 && deviceDataCache.size !== model.devices.length) {
    const ids = new Set(model.devices.map(device => device.id));
    for (const id of deviceDataCache.keys()) if (!ids.has(id)) deviceDataCache.delete(id);
  }
  if (agentDataCache.size > 0 && agentDataCache.size !== model.agents.length) {
    const ids = new Set(model.agents.map(agent => agent.id));
    for (const id of agentDataCache.keys()) if (!ids.has(id)) agentDataCache.delete(id);
  }
}

/** Terminal edges fade out over their keep window (~10s). */
function collabEdgeOpacity(edge: CollabEdge, now: number): number {
  if (!isTerminal(edge.status)) return 1;
  const progress = Math.min(1, Math.max(0, (now - edge.updatedAt) / TERMINAL_KEEP_MS));
  return Math.max(0.25, 1 - progress * 0.75);
}

/**
 * Pure graph assembly (exported for tests): derives the ReactFlow
 * nodes/edges from the world model + render options.
 */
export function buildGraph(
  model: WorldModel,
  options: BuildOptions,
): { nodes: Node[]; edges: Edge[]; frames: Map<string, ZoneFrame>; heatActive: boolean } {
  pruneNodeDataCaches(model);
  const frames = computeZoneFrames(model.zones);
  const snapshotZones = new Map(options.snapshot?.zones.map(z => [z.id, z]) ?? []);
  const snapshotDevices = new Map(options.snapshot?.devices.map(d => [d.id, d]) ?? []);
  const selectedDeviceId = options.selection?.objectType === 'device' ? options.selection.id : null;
  const selectedAgentId = options.selection?.objectType === 'agent' ? options.selection.id : null;
  const selectedZoneId = options.selection?.objectType === 'zone' ? options.selection.id : null;

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let heatActive = false;
  // Outdoor envelope zones (e.g. 校园室外 spanning the whole campus) must not
  // pull agent anchors or viewport fits off the buildings.
  const outdoorZoneIds = new Set<string>();

  // Zones (parent nodes precede their children in the array).
  if (options.layers.zones) {
    const language = i18n.language;
    for (const zone of model.zones) {
      const frame = frames.get(zone.id)!;
      const liveZone = snapshotZones.get(zone.id);
      const category = classifyZone(zone);
      if (category === 'outdoor') outdoorZoneIds.add(zone.id);
      // Outdoor envelope (校园室外, baseline 32°) must not heat-paint the whole
      // canvas red — it keeps its quiet category look instead.
      const heatFill = category === 'outdoor' ? null : zoneHeatFill(liveZone?.parameters);
      if (heatFill) heatActive = true;
      // R2-FEAT-02: critical alert (temp ≥ 35 °C or smoke) — covers smoke-only
      // alerts the temperature heat scale cannot paint.
      const alerted = category !== 'outdoor' && zoneAlertLevel(liveZone?.parameters) !== null;
      const highlighted = options.highlightZoneIds.has(zone.id);
      const focused = options.focusedZoneIds.has(zone.id);
      const zoneSelected = zone.id === selectedZoneId;
      const geometryEditing = zone.id === options.editableZoneId;
      const verticalLinks = options.crossFloorLinks.get(zone.id) ?? [];
      const verticalLinksKey = verticalLinks.join('\u0000');

      const nodeShell = {
        id: zone.id,
        type: 'zone' as const,
        position: { x: frame.x, y: frame.y },
        // See doorGap: explicit dimensions keep the node visible across
        // controlled-mode store syncs (console snapshot rebuilds).
        width: frame.width,
        height: frame.height,
        style: { width: frame.width, height: frame.height },
        // UX-W2: the bounds-edit zone drags like a device dot (move only).
        draggable: geometryEditing,
        connectable: false,
        selectable: false,
        // Outdoor envelope sits below every other zone so overlapping indoor
        // zones (and their devices) win click/hover targeting.
        zIndex: category === 'outdoor' ? -1 : 1,
      };

      // R31 F13: reuse the cached data while no input moved — a single
      // zone-parameter delta then re-renders ONLY that zone's node.
      const cached = zoneDataCache.get(zone.id);
      if (
        cached &&
        cached.zoneRef === zone &&
        cached.liveRef === liveZone &&
        cached.highlighted === highlighted &&
        cached.focused === focused &&
        cached.selected === zoneSelected &&
        cached.alerted === alerted &&
        cached.geometryEditing === geometryEditing &&
        cached.verticalLinksKey === verticalLinksKey &&
        cached.language === language
      ) {
        nodes.push({ ...nodeShell, data: cached.data });
        continue;
      }

      // Scalar parameter lines only: the comfort sub-object gets a badge and
      // occupancy a corner chip instead of a raw text line.
      const parameters = liveZone
        ? Object.entries(liveZone.parameters)
            .filter(
              ([key, value]) =>
                key !== 'occupancy' &&
                (typeof value === 'number' || typeof value === 'boolean'),
            )
            .map(([key, value]) => formatParameter(key, value as number | boolean))
        : [];
      const data = {
        title: zone.name ?? zone.id,
        subtitle: zone.type ?? 'zone',
        parameters,
        highlighted,
        focused,
        selected: zoneSelected,
        alerted,
        geometryEditing,
        category,
        heatFill,
        comfort: readZoneComfort(liveZone?.parameters),
        occupancy: readOccupancy(liveZone?.parameters),
        verticalLinks,
      };
      zoneDataCache.set(zone.id, {
        zoneRef: zone,
        liveRef: liveZone,
        highlighted,
        focused,
        selected: zoneSelected,
        alerted,
        geometryEditing,
        verticalLinksKey,
        language,
        data,
      });
      nodes.push({ ...nodeShell, data });
    }
  }

  // Device dots, parented to their zone (absolute when the zone layer is off).
  const devicesByZone = new Map<string, WorldModelDevice[]>();
  for (const device of model.devices) {
    const list = devicesByZone.get(device.zoneId) ?? [];
    list.push(device);
    devicesByZone.set(device.zoneId, list);
  }
  const deviceAbsoluteCenters = new Map<string, { x: number; y: number }>();
  for (const [zoneId, devices] of devicesByZone) {
    const frame = frames.get(zoneId);
    // Devices referencing an unknown zone are skipped (render defensively).
    if (!frame) continue;
    const layout = layoutDeviceDots(devices, frame);
    const language = i18n.language;
    for (const device of devices) {
      const relative = options.dragOverrides.get(device.id) ?? layout.get(device.id)!;
      const absolute = options.layers.zones
        ? relative
        : { x: frame.x + relative.x, y: frame.y + relative.y };
      deviceAbsoluteCenters.set(device.id, {
        x: frame.x + relative.x,
        y: frame.y + relative.y,
      });
      if (!options.layers.devices) continue;
      const liveDevice = snapshotDevices.get(device.id);
      const dimmed = isDimmed(device.ownerId, options.focusOwnerId);
      const deviceSelected = device.id === selectedDeviceId;
      const ownerColor = device.ownerId
        ? (options.memberColorById.get(device.ownerId) ?? null)
        : null;
      const active = options.activeDeviceIds.has(device.id);

      // R31 F4: reuse the cached data while the device model object, the
      // live snapshot object, the overlay bits and the language all hold —
      // the i18n tooltip strings for 39 devices were rebuilt per tick.
      const cached = deviceDataCache.get(device.id);
      if (
        cached &&
        cached.deviceRef === device &&
        cached.liveRef === liveDevice &&
        cached.ownerColor === ownerColor &&
        cached.active === active &&
        cached.selected === deviceSelected &&
        cached.dimmed === dimmed &&
        cached.language === language
      ) {
        nodes.push({
          id: device.id,
          type: 'deviceDot',
          ...(options.layers.zones
            ? { parentNode: zoneId, extent: 'parent' as const }
            : {}),
          position: absolute,
          width: DOT_SIZE,
          height: DOT_SIZE,
          data: cached.data,
          draggable: options.editable && !dimmed,
          selectable: !dimmed,
          connectable: false,
          zIndex: deviceSelected ? 7 : 3,
        });
        continue;
      }
      const faulted = liveDevice?.fault != null;
      const data = {
        name: device.name,
        type: device.type,
        role: liveDevice?.role ?? device.role,
        ownerColor,
        active,
        faulted,
        selected: deviceSelected,
        dimmed,
        tooltipLines: [
          // S2 (device privacy): foreign devices arrive coarse from the
          // server (state emptied, honest status) — show the privacy line
          // instead of fabricated emptiness.
          ...(liveDevice
            ? liveDevice.stateRedacted === true
              ? [i18n.t('world:device.stateCoarse', {
                  status: i18n.t(
                    liveDevice.status === 'on' ? 'world:device.statusOn'
                      : liveDevice.status === 'off' ? 'world:device.statusOff'
                        : 'world:device.statusPresent',
                  ),
                })]
              : summarizeDeviceState(liveDevice.state)
            : []),
          ...(faulted
            ? [`${i18n.t('worldMap:deviceFaultPrefix', { defaultValue: 'fault: ' })}${summarizeFaultProfile(liveDevice?.fault)}`]
            : []),
        ],
      };
      deviceDataCache.set(device.id, {
        deviceRef: device,
        liveRef: liveDevice,
        ownerColor,
        active,
        selected: deviceSelected,
        dimmed,
        language,
        data,
      });
      nodes.push({
        id: device.id,
        type: 'deviceDot',
        ...(options.layers.zones
          ? { parentNode: zoneId, extent: 'parent' as const }
          : {}),
        position: absolute,
        width: DOT_SIZE,
        height: DOT_SIZE,
        data,
        draggable: options.editable && !dimmed,
        selectable: !dimmed,
        connectable: false,
        // T-713 (R29, orchestrator): device dots must sit ABOVE the zone
        // layer — zones carry zIndex 1, so an overlapping zone rectangle
        // (floor metadata gaps, hand-drawn geo zones) used to swallow device
        // clicks; the sidebar-listed device was unreachable on the canvas.
        // Selected dots jump above door gaps (2) and collab-edge labels (5)
        // too; transient bubbles stay on top (10).
        zIndex: deviceSelected ? 7 : 3,
      });
    }
  }

  // Agent layer: hexagon markers anchored at the managed-zone centroid
  // (outdoor envelope zones excluded — anchoring to them lands the marker in
  // the middle of nowhere).
  if (options.layers.agents) {
    const anchorFrames =
      outdoorZoneIds.size > 0
        ? new Map([...frames].filter(([zoneId]) => !outdoorZoneIds.has(zoneId)))
        : frames;
    model.agents.forEach((agent, index) => {
      const anchor = agentAnchorPoint(agent, anchorFrames, deviceAbsoluteCenters, index);
      const dimmed = isDimmed(agent.ownerId, options.focusOwnerId);
      const agentSelected = agent.id === selectedAgentId;
      const ownerColor = agent.ownerId
        ? (options.memberColorById.get(agent.ownerId) ?? null)
        : null;
      // R31 F4: same reference-stable data contract as zones/devices.
      const cached = agentDataCache.get(agent.id);
      const data =
        cached &&
        cached.agentRef === agent &&
        cached.ownerColor === ownerColor &&
        cached.selected === agentSelected &&
        cached.dimmed === dimmed
          ? cached.data
          : {
              name: agent.name,
              initial: (agent.name.trim()[0] ?? 'A').toUpperCase(),
              ownerColor,
              selected: agentSelected,
              dimmed,
            };
      if (!cached || cached.agentRef !== agent || cached.data !== data) {
        agentDataCache.set(agent.id, { agentRef: agent, ownerColor, selected: agentSelected, dimmed, data });
      }
      nodes.push({
        id: agent.id,
        type: 'agentMarker',
        position: { x: anchor.x - AGENT_SIZE / 2, y: anchor.y - AGENT_SIZE / 2 },
        width: AGENT_SIZE,
        height: AGENT_SIZE,
        data,
        draggable: false,
        selectable: !dimmed,
        connectable: false,
        // T-713: same layering fix as device dots — markers must clear the
        // zone layer (zIndex 1) for clicks to land on them.
        zIndex: agentSelected ? 7 : 3,
      });
    });
  }

  // Zone adjacency (zones layer only): intersecting/touching same-storey
  // pairs get a short door gap on the shared wall instead of a long floating
  // edge; the rest keep the dashed edge, now labeled with the zone name.
  if (options.layers.zones) {
    const doorPairs = new Set<string>();
    for (const gap of computeDoorGaps(model.zones, frames)) {
      doorPairs.add(gap.id.slice('door-'.length));
      nodes.push({
        id: gap.id,
        type: 'doorGap',
        position: { x: gap.x, y: gap.y },
        // Explicit dimensions: RF's controlled-mode store sync drops measured
        // sizes, which keeps nodes `visibility:hidden` while a simulation
        // rebuilds nodes every snapshot — provide them up front instead.
        width: gap.width,
        height: gap.height,
        style: { width: gap.width, height: gap.height },
        data: { orientation: gap.orientation },
        draggable: false,
        connectable: false,
        selectable: false,
        zIndex: 2,
      });
    }
    const zoneNameById = new Map(model.zones.map(zone => [zone.id, zone.name ?? zone.id]));
    const seenPairs = new Set<string>();
    for (const zone of model.zones) {
      for (const adjacentId of zone.adjacentZoneIds ?? []) {
        if (!frames.has(adjacentId)) continue;
        const pairKey = [zone.id, adjacentId].sort().join('::');
        if (seenPairs.has(pairKey) || doorPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        edges.push({
          id: `adj-${pairKey}`,
          source: zone.id,
          target: adjacentId,
          label: `${zoneNameById.get(zone.id)} ↔ ${zoneNameById.get(adjacentId)}`,
          labelStyle: { fill: options.colors.textDim, fontSize: 10 },
          labelBgStyle: { fill: options.colors.bgPanel, fillOpacity: 0.8 },
          className: 'adjacency-edge',
        });
      }
    }
  }

  // Binding edges: selected agent → every bound device (§11.5 agent layer).
  if (options.layers.edges && options.layers.agents && options.layers.devices) {
    const deviceIds = new Set(model.devices.map(d => d.id));
    for (const pair of deriveAgentEdgePairs(model.agents, selectedAgentId, deviceIds)) {
      edges.push({
        id: `bind-${pair.agentId}-${pair.deviceId}`,
        source: pair.agentId,
        target: pair.deviceId,
        animated: true,
        className: 'binding-edge',
      });
    }
  }

  // AC collaboration edges (W7): between the agent MARKER nodes, controlled
  // by the same 协作边 layer toggle. Forming = animated dashed, running =
  // solid accent, completed/failed = green/red fading over the keep window.
  if (options.layers.edges && options.layers.agents && options.collabEdges.length > 0) {
    const agentNameById = new Map(model.agents.map(agent => [agent.id, agent.name]));
    const edgeColors = collabEdgeColors(options.colors);
    const now = Date.now();
    for (const edge of options.collabEdges) {
      const sourceName = agentNameById.get(edge.source);
      const targetName = agentNameById.get(edge.target);
      // Both endpoints must be visible agent markers on this map.
      if (sourceName === undefined || targetName === undefined) continue;
      const color = edgeColors[edge.status];
      const label =
        `${sourceName} ↔ ${targetName} · ${collabEdgeStateLabel(edge.status)}` +
        (edge.description ? ` — ${edge.description.slice(0, 24)}` : '');
      edges.push({
        id: `collab-${edge.key}-${edge.status}`,
        source: edge.source,
        target: edge.target,
        animated: edge.status === 'forming',
        label,
        labelStyle: { fill: options.colors.text, fontSize: 11 },
        labelBgStyle: { fill: options.colors.bgPanel, fillOpacity: 0.85 },
        className: 'collab-map-edge',
        style: {
          stroke: color,
          strokeWidth: edge.status === 'running' ? 2.5 : 2,
          opacity: collabEdgeOpacity(edge, now),
          ...(edge.status === 'forming' ? { strokeDasharray: '6 4' } : {}),
        },
        zIndex: 5,
      });
    }
  }

  // Decision bubbles: transient overlay nodes at the zone's top-right corner.
  const bubbleIndexByZone = new Map<string, number>();
  for (const bubble of options.bubbles) {
    const frame = frames.get(bubble.zoneId);
    if (!frame) continue;
    const index = bubbleIndexByZone.get(bubble.zoneId) ?? 0;
    bubbleIndexByZone.set(bubble.zoneId, index + 1);
    nodes.push({
      id: `bubble-${bubble.id}`,
      type: 'bubble',
      position: { x: frame.x + frame.width - 190, y: frame.y + 8 + index * 64 },
      style: { width: 182 },
      data: { text: bubble.text, source: bubble.source },
      draggable: false,
      connectable: false,
      selectable: false,
      zIndex: 10,
    });
  }

  return { nodes, edges, frames, heatActive };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface WorldMapProps {
  model: WorldModel;
  snapshot?: EngineSnapshot | null;
  highlightZoneIds?: ReadonlySet<string>;
  /** Transient decision bubbles keyed by zone (live mode only). */
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
  /** Builder+ drag handler: persisted position PATCH on drop (world units). */
  onDeviceDragStop?: (deviceId: string, position: { x: number; y: number }) => void;
  /**
   * UX-W2 grid bounds editing: the armed zone's rectangle is draggable;
   * the handler receives the dropped top-left corner in world units.
   */
  editableZoneId?: string | null;
  onZoneDragStop?: (zoneId: string, min: { x: number; y: number }) => void;
  /** AC collaboration edges overlay (W7 sim console), 协作边 toggle applies. */
  collabEdges?: readonly CollabEdge[];
  /** B-D: per-storey plan-image underlays (rendered for the active floor). */
  floorPlans?: readonly EnvFloorPlan[];
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map<string, string>();
const DEFAULT_LAYERS: WorldLayers = { zones: true, devices: true, agents: true, edges: true };
/**
 * R2-UX-19: how long after a selection change a container resize is assumed
 * to be its side effect (sidebar opening) and skipped — deliberate resizes
 * outside this window still refit.
 */
export const SELECTION_REFIT_GRACE_MS = 600;

export function WorldMap({
  model,
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
  onDeviceDragStop,
  editableZoneId = null,
  onZoneDragStop,
  collabEdges = [],
  floorPlans = [],
}: WorldMapProps) {
  const [dragOverrides, setDragOverrides] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    new Map(),
  );
  /**
   * UX-W2 zone drag snap-back: bumping this rebuilds the nodes from the
   * (unchanged) model right after a zone drop, so the rectangle returns to
   * its persisted position until the PATCH round trip repositions it — a
   * rejected edit snaps back instead of leaving a displaced ghost.
   */
  const [zoneDragNonce, setZoneDragNonce] = useState(0);

  // 主题色板（lib/theme）：reactflow 边/标签需要具体色值，随主题切换重算。
  const theme = useAppStore(s => s.theme);
  const colors = mapColors(theme);
  const { t } = useTranslation('worldMap');

  // Building tier (B-A): when any zone carries a `floor`, the map renders
  // ONE storey at a time with a floor switcher. Zones without a floor count
  // as ground (0). Environments with no floor metadata at all keep the
  // legacy single-plane rendering (no switcher).
  const floors = useMemo(() => {
    let hasFloorMetadata = false;
    const set = new Set<number>();
    for (const zone of model.zones) {
      if (zone.floor !== undefined) hasFloorMetadata = true;
      set.add(zone.floor ?? 0);
    }
    return hasFloorMetadata ? [...set].sort((a, b) => a - b) : null;
  }, [model.zones]);

  const [selectedFloor, setSelectedFloor] = useState<number | 'all' | null>(null);
  // A new environment (different floor set) resets the selection to the
  // default storey (most zones — see defaultActiveFloor).
  useEffect(() => {
    setSelectedFloor(null);
  }, [floors]);
  // R101: ONE grouping/labeling source for the floor chips and the zone ⇅
  // badges (0-based storeys vs 1-based indoor + outdoor ground — see
  // lib/buildings.floorLabeling).
  const labeling = useMemo(
    () => floorLabeling(model.zones, t('floorOutdoor')),
    [model.zones, t],
  );
  const activeFloor: number | 'all' = selectedFloor === 'all'
    ? 'all'
    : (selectedFloor ?? (floors ? defaultActiveFloor(model.zones, floors) : 0));

  const floorModel = useMemo<WorldModel>(() => {
    if (!floors || activeFloor === 'all') return model;
    const zones = model.zones.filter(zone => (zone.floor ?? 0) === activeFloor);
    const zoneIds = new Set(zones.map(zone => zone.id));
    const devices = model.devices.filter(device => zoneIds.has(device.zoneId));
    const deviceIds = new Set(devices.map(device => device.id));
    // An agent shows on a storey when it manages a zone there (or, lacking
    // managed zones, owns a bound device there).
    const agents = model.agents.filter(agent =>
      agent.managedZoneIds.length > 0
        ? agent.managedZoneIds.some(id => zoneIds.has(id))
        : agent.boundDeviceIds.some(id => deviceIds.has(id)),
    );
    return { zones, devices, agents };
  }, [model, floors, activeFloor]);

  // Cross-floor adjacency (V1): the map renders one storey at a time, so
  // adjacencies reaching other floors become dashed ⇅ chips on the zone.
  const crossFloorLinks = useMemo(() => {
    const links = new Map<string, string[]>();
    if (!floors || activeFloor === 'all') return links;
    const zoneById = new Map(model.zones.map(zone => [zone.id, zone]));
    for (const zone of model.zones) {
      if ((zone.floor ?? 0) !== activeFloor) continue;
      for (const adjacentId of zone.adjacentZoneIds ?? []) {
        const other = zoneById.get(adjacentId);
        if (!other || (other.floor ?? 0) === activeFloor) continue;
        const list = links.get(zone.id) ?? [];
        const label = `${labeling.label(other.floor ?? 0)} · ${other.name ?? other.id}`;
        if (!list.includes(label)) list.push(label);
        links.set(zone.id, list);
      }
    }
    return links;
  }, [model.zones, floors, activeFloor, labeling]);

  // Building chips (W4): distinct buildingIds across ALL floors (chips stay
  // stable when switching storeys). Environments without any buildingId
  // render no chip row at all.
  const buildings = useMemo(() => listBuildings(model.zones), [model.zones]);
  const [selectedBuilding, setSelectedBuilding] = useState<string | null>(null);
  // A building id that vanished with a new environment must not stick.
  useEffect(() => {
    if (selectedBuilding !== null && !buildings.includes(selectedBuilding)) {
      setSelectedBuilding(null);
    }
  }, [buildings, selectedBuilding]);
  // Fit target for the focused building: its zones on the ACTIVE floor.
  const buildingZoneIds = useMemo(() => {
    if (selectedBuilding === null) return null;
    const ids = zoneIdsInBuilding(floorModel.zones, selectedBuilding);
    return ids.size > 0 ? ids : null;
  }, [floorModel, selectedBuilding]);
  const buildingZoneIdsRef = useRef(buildingZoneIds);
  buildingZoneIdsRef.current = buildingZoneIds;

  // Controlled-map drag: overrides are dropped on every model change — the
  // server round trip supplies the persisted position (or the true position
  // when an edit was rejected).
  useEffect(() => {
    setDragOverrides(new Map());
  }, [model]);

  const { nodes, edges, frames, heatActive } = useMemo(
    () =>
      buildGraph(floorModel, {
        snapshot,
        highlightZoneIds,
        bubbles,
        layers,
        selection,
        activeDeviceIds,
        memberColorById,
        focusedZoneIds,
        focusOwnerId,
        dragOverrides,
        editable: onDeviceDragStop !== undefined,
        editableZoneId,
        collabEdges,
        colors,
        crossFloorLinks,
      }),
    [
      floorModel,
      snapshot,
      highlightZoneIds,
      bubbles,
      layers,
      selection,
      activeDeviceIds,
      memberColorById,
      focusedZoneIds,
      focusOwnerId,
      dragOverrides,
      onDeviceDragStop,
      editableZoneId,
      zoneDragNonce,
      collabEdges,
      colors,
      crossFloorLinks,
    ],
  );

  // B-D plan-image underlay: the current storey's raster sits at world
  // origin (0,0), scaled by its pixelsPerMeter so image pixels align with
  // the meter-space zone boxes on top (WORLD_SCALE px/m).
  const planNode = useMemo<Node | null>(() => {
    const plan = floorPlans.find(entry => entry.floor === activeFloor);
    if (!plan) return null;
    return {
      id: `plan-image-f${plan.floor}`,
      type: 'planImage',
      position: { x: 0, y: 0 },
      data: { src: plan.image, pixelsPerMeter: plan.pixelsPerMeter, worldScale: WORLD_SCALE },
      draggable: false,
      selectable: false,
      connectable: false,
      zIndex: -1,
    };
  }, [floorPlans, activeFloor]);

  const nodesWithPlan = useMemo(
    () => (planNode ? [planNode, ...nodes] : nodes),
    [nodes, planNode],
  );

  const onNodesChange = (changes: NodeChange[]) => {
    setDragOverrides(current => {
      let next: Map<string, { x: number; y: number }> | null = null;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          next = next ?? new Map(current);
          next.set(change.id, change.position);
        }
      }
      return next ?? current;
    });
  };

  const onNodeDragStop: NodeDragHandler = (_event, node) => {
    // UX-W2 zone bounds drag: the zone frame's top-left IS bounds.min ×
    // WORLD_SCALE (see computeZoneFrames), so the drop converts directly.
    if (node.type === 'zone') {
      if (!onZoneDragStop) return;
      setZoneDragNonce(nonce => nonce + 1);
      onZoneDragStop(node.id, {
        x: Math.round((node.position.x / WORLD_SCALE) * 100) / 100,
        y: Math.round((node.position.y / WORLD_SCALE) * 100) / 100,
      });
      return;
    }
    if (!onDeviceDragStop) return;
    // Parented dots report parent-relative positions; convert to world units.
    const frame = layers.zones && node.parentNode ? frames.get(node.parentNode) : undefined;
    const absoluteX = (frame?.x ?? 0) + node.position.x;
    const absoluteY = (frame?.y ?? 0) + node.position.y;
    onDeviceDragStop(node.id, {
      x: Math.round((absoluteX / WORLD_SCALE) * 100) / 100,
      y: Math.round((absoluteY / WORLD_SCALE) * 100) / 100,
    });
  };

  // Re-fit when the container resizes (present mode toggle, sidebar drag,
  // window resize): the `fitView` prop only applies at init, so without this
  // the viewport keeps a stale transform and markers render off-position.
  // Debounced so a continuous sidebar drag fits once at the end.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);

  // R2-UX-19: fit options — padding keeps wide single-storey buildings off
  // the canvas edge (the persona's「初始裁剪」report); maxZoom stops a tiny
  // floor from being zoomed to an unreadable scale.
  const FIT_OPTIONS = { padding: 0.12, maxZoom: 1.5 } as const;

  // Fit to the buildings, not to the outdoor envelope zone: the campus-wide
  // 室外 rectangle (and markers anchored to it) would otherwise stretch the
  // bounding box far beyond the actual floor plan. A focused building chip
  // narrows the fit to that building's zones on the active floor.
  const fitContent = () => {
    const instance = rfInstanceRef.current;
    if (!instance) return;
    const zoneIds = buildingZoneIdsRef.current;
    const targets = nodesWithPlan.filter(node => {
      if (node.type === 'zone' && (node.data as { category?: string }).category === 'outdoor') {
        return false;
      }
      if (zoneIds !== null) return node.type === 'zone' && zoneIds.has(node.id);
      return true;
    });
    instance.fitView(
      targets.length > 0 ? { ...FIT_OPTIONS, nodes: targets.map(node => ({ id: node.id })) } : FIT_OPTIONS,
    );
  };
  const fitContentRef = useRef(fitContent);
  fitContentRef.current = fitContent;

  // R2-UX-19: refits go through rAF (after React Flow's own layout pass),
  // not bare timers racing the data landing. Double-rAF for the mount-time
  // fits — one frame covers React's commit, the second RF's measure. Ref
  // pattern keeps the scheduling effects dependency-free (same discipline
  // as fitContentRef).
  const scheduleFitRef = useRef(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => fitContentRef.current()));
  });

  // Refit when the building chip changes (the chip click itself only flips
  // state; the fit must wait for buildingZoneIds to recompute).
  useEffect(() => {
    if (buildings.length === 0) return;
    scheduleFitRef.current();
  }, [selectedBuilding, buildings.length]);

  // R2-UX-19: a map click that opens the right sidebar resizes the canvas —
  // refitting then yanks the view away from the marker the user just clicked
  // (「点标记视图跳回」). A selection change arms a short grace window during
  // which container resizes do NOT refit; deliberate resizes (window, sidebar
  // drag, present-mode toggle) still do.
  const selectionChangedAtRef = useRef(0);
  useEffect(() => {
    selectionChangedAtRef.current = Date.now();
  }, [selection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false; // the fitView prop covers the initial layout
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Date.now() - selectionChangedAtRef.current < SELECTION_REFIT_GRACE_MS) return;
        scheduleFitRef.current();
      }, 150);
    });
    observer.observe(container);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  // Fit again when real content arrives or the floor changes: `fitView` only
  // applies at init, when async world data may not have landed yet (large
  // campuses otherwise render off-screen — e.g. a 239 m-wide floor clamped at
  // minZoom). Only fires on the empty→non-empty transition and floor switches,
  // so manual pan/zoom is not yanked on every node refresh.
  const nodesReady = nodesWithPlan.length > 0;
  useEffect(() => {
    if (!nodesReady) return;
    scheduleFitRef.current();
  }, [nodesReady, activeFloor]);

  return (
    <div className="environment-map" ref={containerRef}>
      {(floors || buildings.length > 0) && (
        <div className="map-switchers">
          {floors && (
            <div className="floor-switcher" role="tablist" aria-label={t('floorSwitcherAria')}>
              {/* R101: a REAL all-floors chip — and the selection is mutually
                  exclusive within the switcher (全部 vs one storey). */}
              <button
                type="button"
                role="tab"
                aria-selected={activeFloor === 'all'}
                className={
                  activeFloor === 'all' ? 'map-style-chip map-style-chip--active' : 'map-style-chip'
                }
                onClick={() => setSelectedFloor('all')}
              >
                {t('floorAll')}
              </button>
              {floors.map(floor => (
                <button
                  key={floor}
                  type="button"
                  role="tab"
                  aria-selected={floor === activeFloor}
                  className={
                    floor === activeFloor ? 'map-style-chip map-style-chip--active' : 'map-style-chip'
                  }
                  onClick={() => setSelectedFloor(floor)}
                >
                  {labeling.label(floor)}
                </button>
              ))}
            </div>
          )}
          {buildings.length > 0 && (
            <div className="building-switcher" role="group" aria-label={t('buildingSwitcherAria')}>
              <button
                type="button"
                className={
                  selectedBuilding === null
                    ? 'map-style-chip map-style-chip--active'
                    : 'map-style-chip'
                }
                onClick={() => setSelectedBuilding(null)}
              >
                {t('buildingAll')}
              </button>
              {buildings.map(building => (
                <button
                  key={building}
                  type="button"
                  className={
                    building === selectedBuilding
                      ? 'map-style-chip map-style-chip--active'
                      : 'map-style-chip'
                  }
                  onClick={() => setSelectedBuilding(building)}
                >
                  {formatBuildingId(building)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <ReactFlow
        nodes={nodesWithPlan}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={instance => {
          rfInstanceRef.current = instance;
        }}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_event, node) => {
          if (!onSelect) return;
          // 我的视角: dimmed (others') objects are non-interactive.
          if ((node.data as { dimmed?: boolean } | undefined)?.dimmed) return;
          if (node.type === 'deviceDot') onSelect({ objectType: 'device', id: node.id });
          else if (node.type === 'agentMarker') onSelect({ objectType: 'agent', id: node.id });
          // Outdoor envelope zones swallow clicks across the whole map and
          // carry no useful detail — never select them.
          else if (node.type === 'zone' && (node.data as { category?: string }).category !== 'outdoor') {
            onSelect({ objectType: 'zone', id: node.id });
          }
        }}
        onPaneClick={() => onSelect?.(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={FIT_OPTIONS}
        minZoom={0.05}
        // R31 F9: virtualize off-screen nodes — a zoomed-in 39-device campus
        // otherwise keeps ~600-900 DOM elements mounted (device dots ≈ 5
        // elements each incl. 2 RF handles, zones ≈ 10 with param lines).
        // Edge labels ride their edge, so they cull with it.
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color={colors.border} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {heatActive && layers.zones && (
        <div className="heat-legend" aria-hidden="true">
          <span className="heat-legend__label">{t('heatLegend')}</span>
          <div className="heat-legend__scale">
            <span className="heat-legend__bar" />
            <span className="heat-legend__ticks">
              <span className="heat-legend__tick">{HEAT_TEMP_MIN}°</span>
              <span className="heat-legend__tick">{HEAT_TEMP_MID}°</span>
              <span className="heat-legend__tick">{HEAT_TEMP_MAX}°</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
