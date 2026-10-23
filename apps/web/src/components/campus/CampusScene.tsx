/**
 * CampusScene — Babylon.js campus-scale 3D renderer for the world view's 3D
 * slot (the sole 3D engine at campus scale; the legacy three.js
 * Building3DView was removed in the campus-3d cleanup).
 *
 * - view model comes from `lib/campus3d.ts` (unit-tested): zones grouped per
 *   building, footprint outlines deduped per (building, floor), deterministic
 *   ground/greenery plan;
 * - scene mood mirrors the interior baseScene palette (light clearColor,
 *   linear fog, hemispheric + directional light) scaled to campus radius;
 * - buildings: one ExtrudePolygon slab per floor + brighter roof cap + white
 *   edge overlay; bbox/fallback zones as boxes (campus/buildings.ts);
 * - IoT devices: one low-poly glyph per device, thin-instanced per role
 *   shape (campus/devices.ts) — per-instance color buffer carries the role
 *   tint AND the live fault/off status (buffer write-back, never a rebuild);
 * - agents: capsule+diamond avatars with nameplates (campus/agents.ts);
 *   collaboration edges derived from the snapshot's advisory AC list
 *   (running solid / forming dashed) sync in place through a keyed registry;
 * - live channel: the world-session snapshot is POLLED every 4 s
 *   (hooks/useCampusSimSnapshot — same source as the interior walk, works
 *   without an open sim console); zone heat re-tints slab materials in
 *   place, device states rewrite the instance color buffer, edges re-sync.
 *   An explicit `snapshot` prop (e.g. a stream-driven parent) wins over the
 *   poll; zone-delta/device-delta frames take the same applyZoneHeat /
 *   applyStates path (both accept partial maps);
 * - ArcRotateCamera with inertia, radius limits and pan clamping; opening
 *   pose converted from the shared initialCameraPose (lib/campus3d);
 * - picking via scene.onPointerObservable: hover tooltip + cursor, click
 *   (< 5 px travel, Building3DView semantics) — zone slabs pin the local
 *   selection chip, device/agent picks call `onSelect` (2D map semantics:
 *   the right sidebar shows the detail);
 * - in-scene deployment (Phase 4, geo worlds, builders only): while
 *   `placementActive` a translucent ghost disc follows the raycast point
 *   (rooftop-aware; UX-W4 floor-aware while a building is focused — floor
 *   chips / +/- keys pick the storey, the ghost raycasts that floor's slab
 *   top plane, and the click context carries the storey's zoneId) and
 *   clicks route to the page's geo state machine via `onPlacePick` (zone
 *   drawing > device pick > catalog placement — identical to the geo map);
 *   dblclick finishes a zone polygon, Esc cancels via `onCancelPlacement`;
 *   devices drag-reposition with the camera input detached for the gesture,
 *   a dashed line to the origin, and the drop reported through `onDeviceMove`
 *   as lat/lng (unprojectGeoPoint);
 * - UX-W4 campus↔walk traversal: the selection chip's「进入室内」enters the
 *   building at its 1F zone (lib/campus3d `buildingEntryZoneId`), and the
 *   `focusZoneId` prop (world page's ?zone= deep link) restores chip + focus
 *   flight — the walk page's「返回校园」round-trips the exact focus;
 * - UX-W4 agent 活化: the snapshot's recentDecisions ring drives avatar
 *   migration (lib/agentActivity maps the latest fresh decision per agent
 *   to a zone anchor; the family lerps ~1 s in place and drifts home when
 *   the signal goes stale) and new collaboration edges pulse once — all
 *   in-place writes on the render loop's tick, never a family rebuild;
 * - labels: building cards always (within range), floor tags when zoomed in,
 *   refreshed throttled ~150 ms (campus/labels.ts);
 * - on-demand rendering: the render loop only calls scene.render() when the
 *   camera moved or something marked the scene dirty (picking, resize,
 *   live-data application) — the campus is static between interactions.
 *
 * Covered by tsc only (no WebGL in jsdom); the mapping logic it consumes is
 * unit-tested in `src/test/campus3d.vitest.test.ts`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ArcRotateCamera,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  Engine,
  HemisphericLight,
  LinesMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

import type { EngineSnapshot, EnvZone } from '../../api/types';
import { useCampusSimSnapshot } from '../../hooks/useCampusSimSnapshot';
import { agentActivityTargets, activityAnchorForZone } from '../../lib/agentActivity';
import {
  LABEL_ALL_THRESHOLD,
  agentPlacements,
  alertingZoneIds,
  arcPoseFromPose,
  buildingEntryZoneId,
  campusGroundPlan,
  collabEdgesFromSnapshot,
  computePolygonAnchor,
  computeSceneBoundsWithExtrusions,
  computeZoneBoxes,
  computeZoneExtrusions,
  devicePlacements,
  groupZonesByBuilding,
  initialCameraPose,
  placementFloorY,
  resolveStoreyHeight,
  unprojectGeoPoint,
  type GeoAnchor,
  type SceneBounds,
  type Vec3,
} from '../../lib/campus3d';
import type { WorldModelAgent, WorldModelDevice } from '../../lib/worldModel';
import { floorLabeling } from '../../lib/buildings';
import { isDimmed } from '../../lib/perspective';
import type { WorldLayers, WorldSelection } from '../../store/useAppStore';
import { useAppStore } from '../../store/useAppStore';
import {
  buildCampusAgents,
  createCollabEdgeLayer,
  type CampusAgentMeshes,
  type CampusCollabEdgeLayer,
} from './agents';
import { buildCampusMeshes, type BuiltCampusMeshes, type CampusPickInfo } from './buildings';
import { buildCampusDevices, type CampusDeviceMeshes } from './devices';
import { buildCampusGround, buildCampusTrees } from './ground';
import {
  createCampusLabels,
  type CampusLabelSpec,
  type CampusLabelThresholds,
  type CampusLabels,
} from './labels';

export interface CampusSceneProps {
  zones: readonly EnvZone[];
  /** World storey height (B-A); null/undefined falls back to 3.5 m. */
  storeyHeight?: number | null;
  /**
   * Optional live snapshot (explicit prop wins). When absent, the component
   * polls the world-session snapshot itself (envId required).
   */
  snapshot?: EngineSnapshot | null;
  /** Environment id for the built-in snapshot poll (no sim console needed). */
  envId?: string;
  devices?: readonly WorldModelDevice[];
  agents?: readonly WorldModelAgent[];
  /** Layer toggles shared with the 2D maps (devices / agents / edges). */
  layers?: WorldLayers;
  /** 2D selection semantics: device/agent clicks bubble to the sidebar. */
  onSelect?: (selection: WorldSelection | null) => void;
  /** Builder gate (world.myRole owner/builder) — deployment UI stays off otherwise. */
  canBuild?: boolean;
  /**
   * Placement mode (geo worlds): ghost follows the raycast point, clicks
   * route to the page's geo state machine via `onPlacePick`. UX-W4 楼层感知:
   * while a building is focused the ghost raycasts the SELECTED floor's slab
   * top plane (floor chips / +/- keys) instead of the ground, and the click
   * context carries that floor's zoneId so the placed device lands in the
   * right storey (devices carry no floor field — zone attribution is the
   * persisted floor signal).
   */
  placementActive?: boolean;
  onPlacePick?: (latLng: { lat: number; lng: number }, context?: { zoneId?: string }) => void;
  /** dblclick while zone drawing finishes the polygon (geo semantics). */
  onPlaceDblClick?: () => void;
  /** Esc while placing. */
  onCancelPlacement?: () => void;
  /** Device drag-reposition drop (geo position as lat/lng). */
  onDeviceMove?: (deviceId: string, latLng: { lat: number; lng: number }) => void;
  /**
   * UX-W4 返回校园: deep-link zone focus (world page's ?zone= param) — the
   * scene flies to the zone's building and opens its selection chip, so the
   * walk page's「返回校园」restores the exact focus the user left from.
   */
  focusZoneId?: string | null;
  /**
   * 我的视角 (W5): owner whose objects stay lit; null = global. Non-owned
   * devices/agents and non-focused slabs dim (lib/perspective isDimmed).
   */
  focusOwnerId?: string | null;
  /** Zones managed by the focus owner's agents (slab dim complement). */
  focusedZoneIds?: ReadonlySet<string>;
}

/** Max pointer travel (px) between down/up that still counts as a click. */
const CLICK_TOLERANCE_PX = 5;
/** Wall-time an alerting zone keeps pulsing after the last threshold read. */
const ALERT_LATCH_MS = 10_000;
/** Demo hero alert window (wall ms) — mirrors the banner's hero-rate window. */
const HERO_ALERT_WINDOW_MS = 90_000;
/** Label refresh throttle (ms) — mirrors the interior distance-culling cadence. */
const LABEL_THROTTLE_MS = 150;
/** Hover / selection emissive lift as a fraction of the slab's base color. */
const HOVER_EMISSIVE = 0.35;
const SELECTED_EMISSIVE = 0.6;
const DEFAULT_LAYERS: WorldLayers = { zones: true, devices: true, agents: true, edges: true };
const EMPTY_DEVICES: readonly WorldModelDevice[] = [];
const EMPTY_AGENTS: readonly WorldModelAgent[] = [];

/**
 * Post pipeline (Phase 5): FXAA + gentle bloom (only emissive markers cross
 * the 0.9 threshold) + sharpen. Costs ~1–2 ms/frame at 1080p on modest GPUs
 * and only runs when the dirty-flag loop actually renders; flip to false if
 * a low-end client drops frames — the scene is identical without it.
 */
const ENABLE_POST_PIPELINE = true;
/** Focus flight duration (ms), ease-out cubic. */
const FOCUS_FLIGHT_MS = 600;
/** Other buildings dim to this alpha while one is focused. */
const FOCUS_DIM_ALPHA = 0.35;
/** 我的视角 (W5): non-focused slabs dim to this alpha (2D: ~25% opacity). */
const PERSPECTIVE_DIM_ALPHA = 0.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Device glyph distance tiers (camera radius → uniform scale): keeps ~2.2 m
 * glyphs readable at mid/far zoom without per-frame math — the buffer is
 * rewritten only when the tier flips.
 */
function deviceScaleTier(radius: number): number {
  if (radius < 60) return 1;
  if (radius < 200) return 2;
  return 3.5;
}

/** Scene + family handles shared across the component's effects. */
interface CampusRuntime {
  scene: Scene;
  bounds: SceneBounds | null;
  sceneRadius: number;
  markDirty: () => void;
  built: BuiltCampusMeshes;
  /** Mutable pick registry — families add/remove their meshes on rebuild. */
  pickables: Set<Mesh>;
  labelThresholds: CampusLabelThresholds;
  labels: CampusLabels;
  devicesFamily: CampusDeviceMeshes | null;
  agentsFamily: CampusAgentMeshes | null;
  edgeLayer: CampusCollabEdgeLayer;
  /** Zones currently in a critical state (live channel → emissive pulse). */
  alertZoneIds: Set<string>;
  /** zoneId → wall-ms latch expiry (smoke spikes decay faster than the poll cadence). */
  alertLatchUntil: Map<string, number>;
  /**
   * Demo hero alert (demo-on-world-page): the hero event's zone pulses for the
   * hero window regardless of parameter readouts — at demo tick rates the
   * smoke spike decays in sim-time far faster than any poll can catch.
   */
  heroAlert: { zoneId: string; untilMs: number } | null;
  /** Last applied device-glyph distance tier (replay after family rebuilds). */
  deviceTier: number;
  /**
   * Pan-clamp box (C5): starts at the zone bounds, then the marker effect
   * widens it to cover device placements so dragged-out devices stay
   * reachable. Read by the camera input closure.
   */
  panClamp: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  /**
   * Single alpha resolver (C3/C4 discipline for opacity): combines building
   * focus dimming (focusBuildingId) with 我的视角 perspective dimming
   * (perspectiveRef). Called by the focus, perspective and marker effects.
   */
  applyAlpha: () => void;
  /** Currently focused building (focus flight), null = overview. */
  focusBuildingId: string | null;
  /** Shared projection anchor (null for non-geo worlds — placement is geo-only). */
  geoAnchor: GeoAnchor | null;
  placeGhost: Mesh;
  dragGhost: Mesh;
  dragLine: LinesMesh;
}

/** Pick payload union carried on mesh.metadata.pick (zones have no `kind`). */
interface AgentPickInfo {
  kind: 'agent';
  agentId: string;
  agentName: string;
}

export function CampusScene({
  zones,
  storeyHeight,
  snapshot,
  envId,
  devices = EMPTY_DEVICES,
  agents = EMPTY_AGENTS,
  layers = DEFAULT_LAYERS,
  onSelect,
  canBuild = false,
  placementActive = false,
  onPlacePick,
  onPlaceDblClick,
  onCancelPlacement,
  onDeviceMove,
  focusZoneId = null,
  focusOwnerId = null,
  focusedZoneIds,
}: CampusSceneProps) {
  const { t } = useTranslation('world');
  const { t: ti } = useTranslation('interiorWalk');
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<CampusPickInfo | null>(null);
  const runtimeRef = useRef<CampusRuntime | null>(null);
  /** Bumped when the base scene (re)builds; marker families key off it. */
  const [sceneEpoch, setSceneEpoch] = useState(0);
  /** Chip-clear bridge into the scene effect (restores focus dimming). */
  const clearFocusRef = useRef<(() => void) | null>(null);
  /** UX-W4 返回校园: deep-link zone-focus bridge into the scene effect. */
  const focusZoneRef = useRef<((zoneId: string) => void) | null>(null);
  /** UX-W4: mirror of runtime.focusBuildingId for the floor-chip overlay. */
  const [focusBuilding, setFocusBuilding] = useState<string | null>(null);
  /** UX-W4 楼层感知放置: selected storey while placing (floor chips / +/-). */
  const [placeFloor, setPlaceFloor] = useState(0);

  // Latest callbacks/labels for the pointer closures (the base-scene effect
  // runs once per epoch; these must never go stale — batch C8 ref bridge).
  const placementRef = useRef({
    active: false,
    floor: 0,
    onPlacePick,
    onPlaceDblClick,
    onDeviceMove,
    onSelect,
    t,
  });
  placementRef.current = {
    active: canBuild && placementActive,
    floor: placeFloor,
    onPlacePick,
    onPlaceDblClick,
    onDeviceMove: canBuild ? onDeviceMove : undefined,
    onSelect,
    t,
  };

  // UX-W4 agent 活化: latest zone list for the decision→anchor mapping in
  // the live channel (the live effect must not rebuild on zone identity).
  const activityCtxRef = useRef({ zones, storeyHeight });
  activityCtxRef.current = { zones, storeyHeight };

  // 我的视角 (C4): latest perspective inputs for runtime.applyAlpha.
  const perspectiveRef = useRef<{ focusOwnerId: string | null; focusedZoneIds: ReadonlySet<string> }>({
    focusOwnerId: null,
    focusedZoneIds: new Set<string>(),
  });
  perspectiveRef.current = {
    focusOwnerId,
    focusedZoneIds: focusedZoneIds ?? new Set<string>(),
  };

  // Live snapshot: explicit prop wins; otherwise poll the world session
  // (same source as the interior walk — no sim console required).
  const polledSnapshot = useCampusSimSnapshot(snapshot === undefined ? envId : undefined);
  const liveSnapshot = snapshot === undefined ? polledSnapshot : snapshot;
  /** Latest snapshot for the marker-family replay (C2 — never a dep). */
  const liveRef = useRef<EngineSnapshot | null>(null);
  liveRef.current = liveSnapshot;

  // Content signatures (C1): world-stream frames re-identical-ize the arrays
  // without content changes — families rebuild only when the content key
  // actually moves.
  const devicesSignature = useMemo(
    () =>
      devices
        .map(
          d =>
            `${d.id}:${d.zoneId}:${d.role}:${d.name}:${
              d.latLng
                ? `${d.latLng.lat.toFixed(6)},${d.latLng.lng.toFixed(6)}`
                : d.position
                  ? `${d.position.x},${d.position.y}`
                  : '-'
            }`,
        )
        .join('|'),
    [devices],
  );
  const agentsSignature = useMemo(
    () =>
      agents
        .map(a => `${a.id}:${a.name}:${a.managedZoneIds.join(',')}:${a.boundDeviceIds.join(',')}`)
        .join('|'),
    [agents],
  );
  /** Zone geometry signature for marker placement (rooftops/centroids). */
  const zonesSignature = useMemo(
    () =>
      zones
        .map(
          z =>
            `${z.id}:${z.floor ?? 0}:${z.buildingId ?? ''}:${
              z.bounds
                ? `${z.bounds.minX},${z.bounds.maxX},${z.bounds.minY},${z.bounds.maxY},${z.bounds.minZ ?? ''},${z.bounds.maxZ ?? ''}`
                : ''
            }:${z.polygon ? z.polygon.flat().map(n => n.toFixed(6)).join(',') : ''}`,
        )
        .join('|'),
    [zones],
  );

  const buildings = useMemo(
    // Heat comes from the LIVE channel (applyZoneHeat) after the build; the
    // static model stays heat-free so a snapshot tick never rebuilds geometry.
    () => groupZonesByBuilding(zones, { storeyHeight }),
    [zones, storeyHeight],
  );
  // Scene bounds need the flat box/extrusion lists too (fallback zones).
  const boxes = useMemo(() => computeZoneBoxes(zones, { storeyHeight }), [zones, storeyHeight]);
  const extrusions = useMemo(
    () => computeZoneExtrusions(zones, { storeyHeight }),
    [zones, storeyHeight],
  );
  // R101 floor labels (C6): ONE source — lib/buildings floorLabeling handles
  // the 0-based / outdoor-ground conventions; chip, floor tags and tooltip
  // all label through it (no more raw「第 0 层」).
  const floorLabel = useMemo(() => floorLabeling(zones, ti('floorOutdoor')).label, [zones, ti]);

  // UX-W4 楼层感知放置: floors of the focused building (floor chips). Solo
  // pseudo-buildings (__solo__:<zoneId>) never match a declared buildingId,
  // so floor mode stays off for them (floorModeActive).
  const focusedFloors = useMemo(() => {
    if (!focusBuilding) return null;
    const building = buildings.find(entry => entry.buildingId === focusBuilding);
    if (!building) return null;
    return building.floors.map(slab => slab.floor);
  }, [buildings, focusBuilding]);
  const floorModeActive = useMemo(
    () => focusBuilding !== null && zones.some(zone => zone.buildingId === focusBuilding),
    [zones, focusBuilding],
  );
  // Floor selection resets to the building's lowest storey on (re)focus.
  useEffect(() => {
    setPlaceFloor(focusedFloors && focusedFloors.length > 0 ? focusedFloors[0] : 0);
  }, [focusedFloors]);

  // UX-W4 返回校园: ?zone= deep link → focus flight + chip (scene bridge).
  useEffect(() => {
    if (!focusZoneId || sceneEpoch === 0) return;
    focusZoneRef.current?.(focusZoneId);
  }, [sceneEpoch, focusZoneId]);

  // --- Base scene (buildings / ground / labels / camera / picking) ----------
  useEffect(() => {
    const container = containerRef.current;
    const tooltip = tooltipRef.current;
    if (!container || buildings.length === 0) return;
    // Base rebuild (zones changed): the stale chip would reference the OLD
    // scene's slab — cheapest consistent choice is clearing it (batch C8).
    setSelected(null);
    setFocusBuilding(null);

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);

    // preserveDrawingBuffer: with the dirty-flag loop the canvas presents
    // rarely; without the preserved buffer the compositor shows a blank
    // canvas between presents (screenshots/tab-restore included).
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true }, true);
    const scene = new Scene(engine);
    // Probe hook (dev only): screenshot/FPS probes introspect the live scene.
    const debugState = { renders: 0, ticks: 0, downs: 0, deviceDowns: 0, dragStarts: 0, drops: 0 };
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__eafCampus = { scene, engine, debugState };
    }

    // Palette + light rig aligned with the interior baseScene; the sky reads
    // as a cool pale blue (#e8eef5) instead of dead white, fog in sync.
    // Fog must start BEYOND the furthest subject distance (upperRadiusLimit
    // 3× radius + the scene radius itself), otherwise the whole campus sits
    // inside the fog band at the opening pose and washes into the sky color.
    const bounds = computeSceneBoundsWithExtrusions(boxes, extrusions);
    const sceneRadius = bounds ? Math.max(bounds.radius, 8) : 40;
    scene.clearColor = new Color4(0.91, 0.933, 0.961, 1);
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogStart = sceneRadius * 4.5;
    scene.fogEnd = sceneRadius * 9;
    scene.fogColor = new Color3(0.91, 0.933, 0.961);
    const hemi = new HemisphericLight('campus-hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 1.0;
    hemi.groundColor = new Color3(0.38, 0.39, 0.42);
    const sun = new DirectionalLight('campus-sun', new Vector3(-0.4, -1, 0.3), scene);
    sun.intensity = 0.5;

    // --- Camera -------------------------------------------------------------
    const pose = bounds
      ? arcPoseFromPose(initialCameraPose(bounds))
      : { alpha: -Math.PI / 4, beta: Math.PI / 3, radius: 80, target: { x: 0, y: 0, z: 0 } };
    const camera = new ArcRotateCamera(
      'campus-cam',
      pose.alpha,
      pose.beta,
      pose.radius,
      new Vector3(pose.target.x, pose.target.y, pose.target.z),
      scene,
    );
    camera.inertia = 0.85;
    camera.lowerRadiusLimit = 15;
    camera.upperRadiusLimit = Math.max(sceneRadius * 3, 45);
    camera.lowerBetaLimit = 0.12;
    camera.upperBetaLimit = Math.PI / 2 - 0.04;
    camera.panningSensibility = 60;
    camera.wheelDeltaPercentage = 0.01;
    camera.minZ = 0.5;
    camera.maxZ = sceneRadius * 8;
    camera.attachControl(canvas, true);

    // Post pipeline: hooks into the same scene.render() call, so the
    // dirty-flag loop is unaffected (it renders, the pipeline processes).
    if (ENABLE_POST_PIPELINE) {
      const pipeline = new DefaultRenderingPipeline('campus-pipeline', true, scene, [camera]);
      pipeline.fxaaEnabled = true;
      pipeline.bloomEnabled = true;
      pipeline.bloomThreshold = 0.9;
      pipeline.bloomWeight = 0.15;
      pipeline.sharpenEnabled = true;
      pipeline.sharpen.edgeAmount = 0.2;
    }

    // --- Meshes ---------------------------------------------------------------
    const built = buildCampusMeshes(scene, buildings);
    const plan = campusGroundPlan(
      bounds ?? { center: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 }, radius: 20 },
      buildings,
      buildings.map(building => building.buildingId).join('|'),
    );
    buildCampusGround(scene, plan);
    buildCampusTrees(scene, plan);

    // --- Deployment ghosts (Phase 4) ------------------------------------------
    // Hidden until a placement/drag gesture activates them; never frozen,
    // never pickable, never part of a family rebuild.
    const ghostMaterial = new StandardMaterial('campus-ghost-mat', scene);
    ghostMaterial.diffuseColor = new Color3(0.043, 0.455, 0.741); // theme accent
    ghostMaterial.emissiveColor = new Color3(0.1, 0.22, 0.36);
    ghostMaterial.specularColor = Color3.Black();
    ghostMaterial.alpha = 0.55;
    const placeGhost = MeshBuilder.CreateDisc(
      'campus-place-ghost',
      { radius: 2.2, tessellation: 32 },
      scene,
    );
    placeGhost.rotation.x = -Math.PI / 2; // CreateDisc faces +z; turn face-up
    placeGhost.material = ghostMaterial;
    placeGhost.isPickable = false;
    placeGhost.setEnabled(false);
    const dragGhost = MeshBuilder.CreateDisc(
      'campus-drag-ghost',
      { radius: 1.6, tessellation: 24 },
      scene,
    );
    dragGhost.rotation.x = -Math.PI / 2;
    dragGhost.material = ghostMaterial;
    dragGhost.isPickable = false;
    dragGhost.setEnabled(false);
    const dragLine = MeshBuilder.CreateDashedLines(
      'campus-drag-line',
      // A zero-length point pair makes the builder emit empty vertex arrays
      // (startup console warnings); the mesh stays disabled until a drag.
      { points: [Vector3.Zero(), new Vector3(3, 0, 0)], dashSize: 1.2, gapSize: 0.8, updatable: true },
      scene,
    );
    dragLine.color = new Color3(0.043, 0.455, 0.741);
    dragLine.alpha = 0.7;
    dragLine.isPickable = false;
    dragLine.setEnabled(false);

    // --- Labels ---------------------------------------------------------------
    const sh = resolveStoreyHeight(storeyHeight);
    const totalSlabs = buildings.reduce((sum, building) => sum + building.floors.length, 0);
    const showFloorTags = totalSlabs <= LABEL_ALL_THRESHOLD;
    const specs: CampusLabelSpec[] = [];
    for (const building of buildings) {
      const top = built.topOf.get(building.buildingId) ?? (building.maxFloor + 1) * sh;
      specs.push({
        key: `b-${building.buildingId}`,
        kind: 'building',
        text: building.name,
        position: { x: building.centroid.x, y: top + 3, z: building.centroid.z },
      });
      if (showFloorTags && Number.isFinite(building.bbox.maxX)) {
        for (const slab of building.floors) {
          specs.push({
            key: `f-${building.buildingId}-${slab.floor}`,
            kind: 'floor',
            text: floorLabel(slab.floor),
            position: {
              x: building.bbox.maxX + 2,
              y: slab.floor * sh + sh / 2,
              z: building.centroid.z,
            },
          });
        }
      }
    }
    const labelThresholds: CampusLabelThresholds = {
      // Near tier ends at ~1.6× scene radius (past it: building names only);
      // the wide tier covers the whole camera range so building names stay.
      // Opening pose sits at ~1.6× the scene radius; keep floor/agent labels
      // below that so the default campus view shows building names only.
      floorRadius: sceneRadius * 1.15,
      maxRadius: sceneRadius * 3.5,
    };
    const labels = createCampusLabels(scene, specs, labelThresholds);

    // --- Dirty-flag render loop ------------------------------------------------
    let dirty = true;

    // --- Runtime handle shared with the marker/live effects -------------------
    const runtime: CampusRuntime = {
      scene,
      bounds,
      sceneRadius,
      markDirty: () => {
        dirty = true;
      },
      built,
      pickables: new Set<Mesh>(built.pickables),
      labelThresholds,
      labels,
      devicesFamily: null,
      agentsFamily: null,
      edgeLayer: createCollabEdgeLayer(scene),
      alertZoneIds: new Set<string>(),
      alertLatchUntil: new Map<string, number>(),
      heroAlert: null,
      deviceTier: 1,
      panClamp: null,
      focusBuildingId: null,
      applyAlpha: () => {},
      geoAnchor: computePolygonAnchor(zones),
      placeGhost,
      dragGhost,
      dragLine,
    };
    runtimeRef.current = runtime;
    setSceneEpoch(epoch => epoch + 1);

    // Keep panning near the campus — the clamp box lives on the runtime and
    // widens to cover device placements (marker effect, C5), so a device
    // dragged outside the zone geometry stays visible/reachable/draggable.
    if (bounds) {
      const marginX = bounds.size.x / 2 + sceneRadius * 0.8;
      const marginZ = bounds.size.z / 2 + sceneRadius * 0.8;
      runtime.panClamp = {
        minX: bounds.center.x - marginX,
        maxX: bounds.center.x + marginX,
        minZ: bounds.center.z - marginZ,
        maxZ: bounds.center.z + marginZ,
      };
      camera.onAfterCheckInputsObservable.add(() => {
        const box = runtime.panClamp!;
        camera.target.x = clamp(camera.target.x, box.minX, box.maxX);
        camera.target.z = clamp(camera.target.z, box.minZ, box.maxZ);
        camera.target.y = clamp(camera.target.y, 0, bounds.size.y + sceneRadius * 0.5);
      });
    }

    // Single alpha resolver (C4): focus-flight dimming composed with the
    // 我的视角 perspective dim; the perspective/marker effects call it too.
    runtime.applyAlpha = () => {
      const persp = perspectiveRef.current;
      const perspectiveActive = persp.focusOwnerId !== null;
      for (const mesh of built.pickables) {
        const meta = mesh.metadata;
        if (!meta?.pick || 'kind' in meta.pick) continue;
        const material = mesh.material as StandardMaterial;
        let alpha = (meta.baseAlpha as number | undefined) ?? 1;
        if (runtime.focusBuildingId && meta.pick.buildingId !== runtime.focusBuildingId) {
          alpha = Math.min(alpha, FOCUS_DIM_ALPHA);
        }
        if (perspectiveActive && !persp.focusedZoneIds.has(meta.zoneId as string)) {
          alpha = Math.min(alpha, PERSPECTIVE_DIM_ALPHA);
        }
        if (material.alpha !== alpha) material.alpha = alpha;
      }
      runtime.markDirty();
    };

    // Warmup: render every frame for the first ~1.5 s (initial presents can be
    // lost to late layout/resizes clearing the buffer), then idle-heartbeat a
    // frame every 500 ms so a lost present (tab restore, compositor eviction)
    // self-heals. Between interactions the campus is otherwise static.
    const warmupUntil = performance.now() + 1500;
    let lastRenderAt = 0;
    const lastCam = {
      alpha: Number.NaN,
      beta: Number.NaN,
      radius: Number.NaN,
      tx: Number.NaN,
      ty: Number.NaN,
      tz: Number.NaN,
    };
    let lastLabelAt = 0;
    let lastDeviceTier = 0;
    /** Active focus flight tween (null when settled). */
    let flight: {
      startAt: number;
      fromTarget: Vector3;
      toTarget: Vector3;
      fromRadius: number;
      toRadius: number;
    } | null = null;
    engine.runRenderLoop(() => {
      debugState.ticks += 1;
      const now = performance.now();
      // UX-W4 agent 活化: advance migration lerps + edge pulses BEFORE the
      // idle early-out — an in-flight animation keeps the loop rendering
      // until it settles (writes are in-place; nothing rebuilds).
      const agentsAnimating = runtime.agentsFamily?.tick(now) ?? false;
      const edgesAnimating = runtime.edgeLayer.tick(now);
      // Focus flight: drive the camera BEFORE the moved check so the tween
      // renders every frame until it settles.
      if (flight) {
        const t01 = Math.min((now - flight.startAt) / FOCUS_FLIGHT_MS, 1);
        const k = 1 - Math.pow(1 - t01, 3); // ease-out cubic
        camera.target = Vector3.Lerp(flight.fromTarget, flight.toTarget, k);
        camera.radius = flight.fromRadius + (flight.toRadius - flight.fromRadius) * k;
        if (t01 >= 1) flight = null;
      }
      const moved =
        camera.alpha !== lastCam.alpha ||
        camera.beta !== lastCam.beta ||
        camera.radius !== lastCam.radius ||
        camera.target.x !== lastCam.tx ||
        camera.target.y !== lastCam.ty ||
        camera.target.z !== lastCam.tz;
      if (!dirty && !moved && !agentsAnimating && !edgesAnimating && now > warmupUntil && now - lastRenderAt < 500) return;
      lastCam.alpha = camera.alpha;
      lastCam.beta = camera.beta;
      lastCam.radius = camera.radius;
      lastCam.tx = camera.target.x;
      lastCam.ty = camera.target.y;
      lastCam.tz = camera.target.z;
      const deviceTier = deviceScaleTier(camera.radius);
      if (deviceTier !== lastDeviceTier) {
        lastDeviceTier = deviceTier;
        runtime.deviceTier = deviceTier;
        runtime.devicesFamily?.setDistanceScale(deviceTier);
        // Deployment ghosts ride the same tiers (C7) — at campus zoom the
        // fixed 2.2 m disc is sub-pixel.
        placeGhost.scaling.setAll(deviceTier);
        dragGhost.scaling.setAll(deviceTier);
      }
      if (now - lastLabelAt >= LABEL_THROTTLE_MS) {
        lastLabelAt = now;
        labels.update(camera.radius);
        runtime.agentsFamily?.update(camera.radius);
      }
      // Emissive SINGLE WRITER (C3): alert pulse > selection > hover > black,
      // resolved here once per render frame — hover/selection/live-channel
      // never interleave writes, and an alert leaving the set restores the
      // slab automatically on the next render.
      const heroAlert =
        runtime.heroAlert !== null && Date.now() < runtime.heroAlert.untilMs
          ? runtime.heroAlert
          : null;
      const alertActive = runtime.alertZoneIds.size > 0 || heroAlert !== null;
      const pulse = 0.3 + 0.25 * Math.sin(now / 450);
      for (const mesh of runtime.pickables) {
        const base = mesh.metadata?.baseColor as Color3 | undefined;
        if (!base) continue;
        const zoneId = mesh.metadata?.zoneId as string | undefined;
        let target: Color3;
        if (
          alertActive &&
          zoneId &&
          (runtime.alertZoneIds.has(zoneId) || heroAlert?.zoneId === zoneId)
        ) {
          target = new Color3(0.89 * pulse, 0.26 * pulse, 0.25 * pulse);
        } else if (mesh === selectedMesh) {
          target = base.scale(SELECTED_EMISSIVE);
        } else if (mesh === hovered) {
          target = base.scale(HOVER_EMISSIVE);
        } else {
          target = Color3.Black();
        }
        const material = mesh.material as StandardMaterial;
        if (!material.emissiveColor.equals(target)) material.emissiveColor.copyFrom(target);
      }
      if (alertActive) dirty = true; // keep breathing until the alert clears
      scene.render();
      debugState.renders += 1;
      lastRenderAt = now;
      dirty = false;
    });

    // --- Picking + in-scene deployment (Phase 4) --------------------------------
    let hovered: Mesh | null = null;
    let selectedMesh: Mesh | null = null;
    let downX = 0;
    let downY = 0;
    /** Device id pressed on (drag candidate); camera input is detached until up. */
    let downDeviceId: string | null = null;
    /** Active drag gesture (travel exceeded the click tolerance). */
    let draggingDevice: { id: string; origin: Vector3 } | null = null;

    const pickAtPointer = () =>
      scene.pick(scene.pointerX, scene.pointerY, mesh => runtime.pickables.has(mesh as Mesh));

    /** Raycast a horizontal plane at height planeY (lat/lng need only x/z). */
    const planePointAt = (planeY: number): Vector3 | null => {
      const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera);
      if (ray.direction.y >= 0) return null; // looking at the sky
      const travel = (planeY - ray.origin.y) / ray.direction.y;
      if (!Number.isFinite(travel) || travel < 0) return null;
      return ray.origin.add(ray.direction.scale(travel));
    };
    /** Raycast the y=0 ground plane (drag gestures stay ground-bound). */
    const groundPointAt = (): Vector3 | null => planePointAt(0);

    /**
     * UX-W4 楼层感知放置: floor mode is on while a REAL building (declared
     * buildingId, not a solo pseudo-key) is focused — the ghost/click then
     * raycast the selected floor's slab top plane instead of the ground.
     */
    const realBuildingIds = new Set(
      zones.map(zone => zone.buildingId).filter((id): id is string => typeof id === 'string'),
    );
    const placementFloorMode = (): boolean =>
      runtime.focusBuildingId !== null && realBuildingIds.has(runtime.focusBuildingId);
    /** The focused building's zone at the selected floor (first match wins). */
    const placementFloorZoneId = (): string | undefined =>
      zones.find(
        zone =>
          zone.buildingId === runtime.focusBuildingId &&
          (zone.floor ?? 0) === placementRef.current.floor,
      )?.id;

    const endDragVisuals = () => {
      dragGhost.setEnabled(false);
      dragLine.setEnabled(false);
      runtime.markDirty();
    };

    const zoneInfoOf = (mesh: Mesh | null): CampusPickInfo | null => {
      const pick = mesh?.metadata?.pick as CampusPickInfo | AgentPickInfo | undefined;
      if (!pick || 'kind' in pick) return null;
      return pick;
    };

    // Focus flight (Phase 5): clicking a building eases the camera to it and
    // dims the rest (alpha composed in runtime.applyAlpha with perspective
    // dimming, C4); empty click / chip clear restores the overview.
    const buildingById = new Map(buildings.map(building => [building.buildingId, building]));
    const flyToBuilding = (buildingId: string) => {
      const building = buildingById.get(buildingId);
      if (!building || !Number.isFinite(building.bbox.minX)) return;
      const width = building.bbox.maxX - building.bbox.minX;
      const depth = building.bbox.maxZ - building.bbox.minZ;
      const top = built.topOf.get(building.buildingId) ?? (building.maxFloor + 1) * sh;
      flight = {
        startAt: performance.now(),
        fromTarget: camera.target.clone(),
        toTarget: new Vector3(building.centroid.x, top / 2, building.centroid.z),
        fromRadius: camera.radius,
        toRadius: Math.max((Math.hypot(width, depth) / 2) * 2.2, 25),
      };
      runtime.focusBuildingId = building.buildingId;
      setFocusBuilding(building.buildingId);
      runtime.applyAlpha();
    };
    const clearFocus = () => {
      flight = null;
      runtime.focusBuildingId = null;
      setFocusBuilding(null);
      runtime.applyAlpha();
    };
    clearFocusRef.current = clearFocus;

    // UX-W4 返回校园 deep link: world page's ?zone= param → the same chip +
    // focus flight a slab click would produce (zone → pick info via the
    // building model; the slab mesh gets the selection emissive too).
    const pickForZoneId = (zoneId: string): CampusPickInfo | null => {
      for (const building of buildings) {
        for (const slab of building.floors) {
          const ext = slab.extrusions.find(entry => entry.zoneId === zoneId);
          if (ext) {
            return {
              buildingId: building.buildingId,
              buildingName: building.name,
              floor: slab.floor,
              zoneId,
              zoneName: ext.name,
              fallback: false,
            };
          }
          const box = slab.boxes.find(entry => entry.zoneId === zoneId);
          if (box) {
            return {
              buildingId: building.buildingId,
              buildingName: building.name,
              floor: slab.floor,
              zoneId,
              zoneName: box.name,
              fallback: box.fallback,
            };
          }
        }
      }
      return null;
    };
    focusZoneRef.current = (zoneId: string) => {
      const pick = pickForZoneId(zoneId);
      if (!pick) return;
      selectedMesh = null;
      for (const mesh of runtime.pickables) {
        const meta = mesh.metadata?.pick as CampusPickInfo | AgentPickInfo | undefined;
        if (meta && !('kind' in meta) && meta.zoneId === zoneId) {
          selectedMesh = mesh;
          break;
        }
      }
      setSelected(pick);
      flyToBuilding(pick.buildingId);
      runtime.markDirty();
    };

    // Emissive is written ONLY by the render loop (C3 single-writer);
    // interaction handlers move hovered/selectedMesh and mark dirty.
    const clearHover = () => {
      if (hovered) runtime.markDirty();
      hovered = null;
      if (tooltip) tooltip.style.display = 'none';
      canvas.style.cursor = '';
    };

    const tooltipFor = (mesh: Mesh | null, thinInstanceIndex: number): string | null => {
      if (!mesh) return null;
      const tt = placementRef.current.t;
      const pick = mesh.metadata?.pick as CampusPickInfo | AgentPickInfo | undefined;
      if (pick) {
        if ('kind' in pick) return pick.agentName;
        return pick.fallback
          ? `${pick.zoneName} · ${tt('view3d.unboundedHint')}`
          : `${pick.buildingName} · ${floorLabel(pick.floor)}`;
      }
      const device = runtime.devicesFamily
        ? deviceAt(runtime.devicesFamily, mesh, thinInstanceIndex)
        : null;
      return device ? `${device.name} · ${device.type}` : null;
    };

    scene.onPointerObservable.add(pointerInfo => {
      const event = pointerInfo.event as PointerEvent;
      const ctl = placementRef.current;
      if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
        // Drag gesture: ghost + dashed origin line follow the ground point.
        if (draggingDevice) {
          const ground = groundPointAt();
          if (ground) {
            dragGhost.position.set(ground.x, 0.5, ground.z);
            MeshBuilder.CreateDashedLines('campus-drag-line', {
              points: [draggingDevice.origin, new Vector3(ground.x, 0.5, ground.z)],
              dashSize: 1.2,
              gapSize: 0.8,
              instance: dragLine,
            });
            runtime.markDirty();
          }
          return;
        }
        // A pressed device becomes a drag past the click tolerance.
        if (downDeviceId && Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_TOLERANCE_PX) {
          const origin = runtime.devicesFamily?.positionById.get(downDeviceId);
          if (origin) {
            debugState.dragStarts += 1;
            draggingDevice = { id: downDeviceId, origin: new Vector3(origin.x, origin.y, origin.z) };
            dragGhost.setEnabled(true);
            dragLine.setEnabled(true);
          }
          return;
        }
        // Placement mode: ghost follows the raycast (floor-aware while a
        // building is focused, rooftop-aware otherwise), hover tooltips
        // suspend, lat/lng kept warm for the click.
        if (ctl.active && runtime.geoAnchor) {
          clearHover();
          const floorMode = placementFloorMode();
          const planeY = floorMode ? placementFloorY(ctl.floor, sh) : 0;
          const ground = planePointAt(planeY);
          if (!ground) {
            if (placeGhost.isEnabled()) {
              placeGhost.setEnabled(false);
              runtime.markDirty();
            }
            return;
          }
          const lift = floorMode
            ? planeY + 0.4
            : (() => {
                const hit = pickAtPointer();
                return hit?.pickedPoint ? hit.pickedPoint.y + 0.4 : 0.4;
              })();
          placeGhost.position.set(ground.x, lift, ground.z);
          if (!placeGhost.isEnabled()) placeGhost.setEnabled(true);
          canvas.style.cursor = 'crosshair';
          runtime.markDirty();
          return;
        }
        if (placeGhost.isEnabled()) {
          placeGhost.setEnabled(false);
          runtime.markDirty();
        }
        const hit = pickAtPointer();
        const hitMesh = (hit?.pickedMesh as Mesh | null) ?? null;
        if (hitMesh !== hovered) {
          clearHover();
          hovered = hitMesh;
          // Emissive lift is resolved by the render loop (C3); just mark.
          if (hovered) runtime.markDirty();
        }
        if (tooltip) {
          const text = tooltipFor(hitMesh, hit?.thinInstanceIndex ?? -1);
          if (text) {
            tooltip.textContent = text;
            tooltip.style.display = 'block';
            const rect = container.getBoundingClientRect();
            tooltip.style.left = `${event.clientX - rect.left + 12}px`;
            tooltip.style.top = `${event.clientY - rect.top + 12}px`;
          } else {
            tooltip.style.display = 'none';
          }
        }
        canvas.style.cursor = hitMesh ? 'pointer' : '';
      } else if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
        if (event.button !== 0) return; // left button only
        debugState.downs += 1;
        downX = event.clientX;
        downY = event.clientY;
        // Drag candidate: pressing a device detaches the camera for the whole
        // gesture (reattached on up; a sub-tolerance release is just a click).
        // Placement mode wins — clicks there place, never drag.
        if (!ctl.active && ctl.onDeviceMove) {
          const hit = pickAtPointer();
          const hitMesh = (hit?.pickedMesh as Mesh | null) ?? null;
          const device =
            hitMesh && runtime.devicesFamily && (hit?.thinInstanceIndex ?? -1) >= 0
              ? deviceAt(runtime.devicesFamily, hitMesh, hit!.thinInstanceIndex)
              : null;
          if (device) {
            debugState.deviceDowns += 1;
            downDeviceId = device.id;
            camera.detachControl();
          } else {
            Object.assign(debugState, {
              lastDownHit: hitMesh?.name ?? null,
              lastDownThinIdx: hit?.thinInstanceIndex ?? null,
              lastDownCtl: { active: ctl.active, hasMove: !!ctl.onDeviceMove },
            });
          }
        } else {
          Object.assign(debugState, {
            lastDownSkipped: { active: ctl.active, hasMove: !!ctl.onDeviceMove },
          });
        }
      } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
        if (draggingDevice) {
          debugState.drops += 1;
          // Drop: report lat/lng through the page's persist path.
          const ground = groundPointAt();
          if (ground && runtime.geoAnchor && ctl.onDeviceMove) {
            ctl.onDeviceMove(
              draggingDevice.id,
              unprojectGeoPoint(runtime.geoAnchor, ground.x, ground.z),
            );
          }
          draggingDevice = null;
          downDeviceId = null;
          endDragVisuals();
          camera.attachControl(canvas, true);
          return;
        }
        if (downDeviceId) {
          downDeviceId = null;
          camera.attachControl(canvas, true);
        }
        if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_TOLERANCE_PX) return;
        // Placement click outranks selection (geo click routing lives in the page).
        if (ctl.active && runtime.geoAnchor) {
          const floorMode = placementFloorMode();
          const planeY = floorMode ? placementFloorY(ctl.floor, sh) : 0;
          const ground = planePointAt(planeY);
          if (ground) {
            // UX-W4: floor mode pins the placed device to the focused
            // building's zone at the selected storey (devices carry no floor
            // field — zone attribution is the persisted floor signal).
            const floorZoneId = floorMode ? placementFloorZoneId() : undefined;
            ctl.onPlacePick?.(
              unprojectGeoPoint(runtime.geoAnchor, ground.x, ground.z),
              floorZoneId ? { zoneId: floorZoneId } : undefined,
            );
          }
          return;
        }
        const hit = pickAtPointer();
        const hitMesh = (hit?.pickedMesh as Mesh | null) ?? null;
        const pick = hitMesh?.metadata?.pick as CampusPickInfo | AgentPickInfo | undefined;
        if (pick && 'kind' in pick && pick.kind === 'agent') {
          ctl.onSelect?.({ objectType: 'agent', id: pick.agentId });
          return;
        }
        const zonePick = zoneInfoOf(hitMesh);
        if (zonePick) {
          // Zone slab: local selection chip (Building3DView semantics) plus
          // the focus flight to its building.
          selectedMesh = hitMesh;
          runtime.markDirty();
          setSelected(zonePick);
          flyToBuilding(zonePick.buildingId);
          return;
        }
        // Device glyph (thin instance): 2D semantics — sidebar shows the detail.
        const device =
          hitMesh && runtime.devicesFamily && (hit?.thinInstanceIndex ?? -1) >= 0
            ? deviceAt(runtime.devicesFamily, hitMesh, hit!.thinInstanceIndex)
            : null;
        if (device) {
          ctl.onSelect?.({ objectType: 'device', id: device.id });
          return;
        }
        // Empty space: clear both the local chip and the sidebar selection.
        selectedMesh = null;
        setSelected(null);
        clearFocus();
        ctl.onSelect?.(null);
      } else if (pointerInfo.type === PointerEventTypes.POINTERDOUBLETAP) {
        // Zone drawing: dblclick finishes the polygon (geo map semantics).
        if (ctl.active) ctl.onPlaceDblClick?.();
      }
    });
    const onPointerLeave = () => {
      // Pointer lost mid-gesture: cancel the drag (no drop) and restore input.
      if (draggingDevice || downDeviceId) {
        draggingDevice = null;
        downDeviceId = null;
        endDragVisuals();
        camera.attachControl(canvas, true);
      }
      clearHover();
    };
    canvas.addEventListener('pointerleave', onPointerLeave);

    // --- Resize ---------------------------------------------------------------
    const resizeObserver = new ResizeObserver(() => {
      engine.resize();
      runtime.markDirty();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerleave', onPointerLeave);
      runtime.devicesFamily?.dispose();
      runtime.agentsFamily?.dispose();
      runtime.edgeLayer.dispose();
      runtimeRef.current = null;
      clearFocusRef.current = null;
      focusZoneRef.current = null;
      // Probe hook cleanup (C8): a stale window.__eafCampus would let the
      // screenshot probe introspect a disposed scene.
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__eafCampus;
      }
      engine.stopRenderLoop();
      labels.dispose();
      scene.dispose();
      engine.dispose();
      canvas.remove();
    };
    // t/onSelect are stable enough for the picking closures; the view model
    // drives the rebuild (same discipline as Building3DView).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, boxes, extrusions]);

  // --- Marker families (devices / agents) ------------------------------------
  // Structural world edits (device/agent added or moved) rebuild ONLY the
  // marker families inside the live scene — buildings, ground and camera
  // survive. Deps are CONTENT SIGNATURES (C1): world-stream frames re-create
  // identical arrays every few seconds; without the keys every frame rebuilt
  // both families. Live sim data never lands here (see the live channel).
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || sceneEpoch === 0) return;
    const anchor = computePolygonAnchor(zones);
    const devicePlaced = devicePlacements(devices, zones, { storeyHeight, anchor });
    const devicePosById = new Map(devicePlaced.map(p => [p.id, p.position]));
    const agentPlaced = agentPlacements(agents, devicePosById, zones, {
      storeyHeight,
      anchor,
      fallback: runtime.bounds
        ? { x: runtime.bounds.center.x, z: runtime.bounds.center.z }
        : undefined,
    });

    const devicesFamily = buildCampusDevices(runtime.scene, devicePlaced);
    const agentsFamily = buildCampusAgents(runtime.scene, agentPlaced, runtime.labelThresholds);
    runtime.devicesFamily = devicesFamily;
    runtime.agentsFamily = agentsFamily;
    for (const mesh of devicesFamily.meshes) runtime.pickables.add(mesh);
    // Only avatar bodies are pickable (the floating diamond is decorative).
    for (const mesh of agentsFamily.meshes) {
      if (mesh.metadata?.pick) runtime.pickables.add(mesh);
    }
    devicesFamily.setEnabled(layers.devices);
    agentsFamily.setEnabled(layers.agents);

    // C5: widen the pan clamp so devices outside the zone geometry stay
    // reachable (drag-out is a supported flow).
    if (runtime.panClamp) {
      for (const p of devicePlaced) {
        runtime.panClamp.minX = Math.min(runtime.panClamp.minX, p.position.x - 15);
        runtime.panClamp.maxX = Math.max(runtime.panClamp.maxX, p.position.x + 15);
        runtime.panClamp.minZ = Math.min(runtime.panClamp.minZ, p.position.z - 15);
        runtime.panClamp.maxZ = Math.max(runtime.panClamp.maxZ, p.position.z + 15);
      }
    }

    // C2: replay the live channel + perspective + distance tier into the
    // fresh families immediately — never wait for the next 4 s poll tick
    // (fault red / off grey / collab edges / dim survive the rebuild).
    devicesFamily.setDistanceScale(runtime.deviceTier);
    applyLiveToRuntime(runtime, liveRef.current, activityCtxRef.current);
    applyPerspectiveToRuntime(runtime, perspectiveRef.current, devices, agents);
    runtime.markDirty();
    return () => {
      for (const mesh of devicesFamily.meshes) runtime.pickables.delete(mesh);
      for (const mesh of agentsFamily.meshes) runtime.pickables.delete(mesh);
      // On unmount the base-scene cleanup has already disposed the scene
      // (and the families through it) — skip the double dispose.
      if (!runtime.scene.isDisposed) {
        devicesFamily.dispose();
        agentsFamily.dispose();
      }
      if (runtime.devicesFamily === devicesFamily) runtime.devicesFamily = null;
      if (runtime.agentsFamily === agentsFamily) runtime.agentsFamily = null;
    };
    // layers/lambda capture: layer toggles get their own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneEpoch, devicesSignature, agentsSignature, zonesSignature, storeyHeight]);

  // --- Layer toggles (no rebuild) ---------------------------------------------
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.devicesFamily?.setEnabled(layers.devices);
    runtime.agentsFamily?.setEnabled(layers.agents);
    runtime.edgeLayer.setEnabled(layers.edges);
    runtime.markDirty();
  }, [sceneEpoch, layers]);

  // --- 我的视角 dimming (C4, 2D semantics via lib/perspective) -------------------
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    applyPerspectiveToRuntime(runtime, perspectiveRef.current, devices, agents);
    runtime.markDirty();
    // devices/agents ride their content signatures (dim sets follow content).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneEpoch, focusOwnerId, focusedZoneIds, devicesSignature, agentsSignature]);

  // --- Live channel (polled snapshot / stream deltas) ---------------------------
  // Everything here is an IN-PLACE update: slab diffuse write-back, device
  // instance-color buffer write-back, edge registry sync — plus one markDirty.
  // zone-delta/device-delta stream frames take the same path (both updaters
  // accept partial maps); the world view polls because the sim-console stream
  // is not mounted here. Emissive is the render loop's job (C3) — the alert
  // SET is stored on the runtime and the loop resolves pulse/hover/selection.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    applyLiveToRuntime(runtime, liveSnapshot, activityCtxRef.current);
  }, [sceneEpoch, liveSnapshot]);

  // --- Demo hero alert (demo-on-world-page) --------------------------------------
  // The hero event's zone pulses for the whole hero window: at demo tick
  // rates the smoke spike decays in sim-time within ~1 wall-second — far
  // faster than the 4 s snapshot poll — so the alert is driven from the demo
  // run state itself (deterministic), not from parameter thresholds.
  const demoRun = useAppStore(s => s.demoRun);
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (demoRun && !demoRun.done && demoRun.heroZoneId && demoRun.startedAtMs !== undefined) {
      runtime.heroAlert = {
        zoneId: demoRun.heroZoneId,
        untilMs: demoRun.startedAtMs + HERO_ALERT_WINDOW_MS,
      };
    } else {
      runtime.heroAlert = null;
    }
    runtime.markDirty();
  }, [sceneEpoch, demoRun]);

  // --- Deployment mode: Esc cancels, +/- steps the placement floor ----------
  useEffect(() => {
    if (!canBuild || !placementActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancelPlacement?.();
        return;
      }
      // UX-W4 楼层感知放置: +/- 在 focus 楼栋的楼层表内步进（无 focus 楼
      // 栋时无楼层可选，按键忽略）。
      if (!focusedFloors || focusedFloors.length === 0) return;
      const index = Math.max(focusedFloors.indexOf(placeFloor), 0);
      if (event.key === '+' || event.key === '=') {
        setPlaceFloor(focusedFloors[Math.min(index + 1, focusedFloors.length - 1)]);
      } else if (event.key === '-' || event.key === '_') {
        setPlaceFloor(focusedFloors[Math.max(index - 1, 0)]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canBuild, placementActive, onCancelPlacement, focusedFloors, placeFloor]);

  // Floor switch re-lifts an ACTIVE ghost immediately (no pointer move needed).
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !floorModeActive || !(canBuild && placementActive)) return;
    if (!runtime.placeGhost.isEnabled()) return;
    runtime.placeGhost.position.y =
      placementFloorY(placeFloor, resolveStoreyHeight(storeyHeight)) + 0.4;
    runtime.markDirty();
  }, [sceneEpoch, placeFloor, floorModeActive, canBuild, placementActive, storeyHeight]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || (canBuild && placementActive)) return;
    if (runtime.placeGhost.isEnabled()) {
      runtime.placeGhost.setEnabled(false);
      runtime.markDirty();
    }
  }, [sceneEpoch, canBuild, placementActive]);

  if (buildings.length === 0) {
    // Centered inside the 3D container — a bare page-note floats under the
    // layer panels (batch C8).
    return (
      <div className="building3d">
        <p className="page-note building3d__empty">{t('view3d.empty')}</p>
      </div>
    );
  }

  // C6: chip shows the zone name WITHOUT the redundant building prefix
  // (「A栋 · A栋-101」→「A栋 · 101」), floor via the R101 labeler.
  const chipZoneName = selected
    ? selected.zoneName.startsWith(selected.buildingName)
      ? selected.zoneName.slice(selected.buildingName.length).replace(/^[\s\-_—·:：]+/u, '') ||
        selected.zoneName
      : selected.zoneName
    : '';
  // UX-W4 进入室内: the walk always starts at the building's 1F zone
  // (buildingId match + minimum floor; solo zones fall back to themselves).
  const entryZoneId = selected
    ? buildingEntryZoneId(zones, selected.buildingId, selected.zoneId)
    : null;

  return (
    <div className="building3d" ref={containerRef}>
      <div className="building3d__tooltip" ref={tooltipRef} />
      {floorModeActive && canBuild && placementActive && focusedFloors && focusedFloors.length > 1 && (
        <div className="building3d__floor-chips">
          <span className="building3d__floor-chips-label">{t('view3d.placeFloor')}</span>
          {focusedFloors.map(floor => (
            <button
              key={floor}
              type="button"
              className={
                floor === placeFloor
                  ? 'building3d__floor-chip building3d__floor-chip--active'
                  : 'building3d__floor-chip'
              }
              onClick={() => setPlaceFloor(floor)}
            >
              {floorLabel(floor)}
            </button>
          ))}
          <span className="building3d__floor-chips-hint">{t('view3d.placeFloorHint')}</span>
        </div>
      )}
      {selected && (
        <div className="building3d__selection">
          <span className="building3d__selection-name">{selected.buildingName}</span>
          <span className="building3d__selection-meta">
            {chipZoneName} · {floorLabel(selected.floor)}
          </span>
          {/* R82 deep-link convention: /walk?zone=<zoneId> (same as the page
              header); UX-W4 — the entry targets the building's 1F zone. */}
          {envId && entryZoneId && (
            <Link className="link-button" to={`/environments/${envId}/walk?zone=${entryZoneId}`}>
              {ti('entry')}
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              clearFocusRef.current?.();
            }}
          >
            {t('view3d.clearSelection')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Resolve a thin-instance device pick to its id + display info. */
function deviceAt(
  family: CampusDeviceMeshes,
  mesh: Mesh,
  thinInstanceIndex: number,
): { id: string; name: string; type: string } | null {
  if (thinInstanceIndex < 0) return null;
  for (const [kind, ids] of family.idsByKind) {
    if (mesh.name !== `campus-device-${kind}`) continue;
    const id = ids[thinInstanceIndex];
    const info = id ? family.infoById.get(id) : undefined;
    return id && info ? { id, name: info.name, type: info.type } : null;
  }
  return null;
}

/**
 * Live channel application (C2): zone heat, device states, alert set and
 * collab edges — shared by the live effect (poll tick) and the marker effect
 * (replay into freshly rebuilt families). Emissive is NOT written here:
 * the render loop resolves alert-pulse/selection/hover in one place (C3).
 *
 * UX-W4 agent 活化: the snapshot's recentDecisions ring also feeds the
 * decision→zone migration targets (lib/agentActivity does the mapping; the
 * family lerps in place on the render loop's tick).
 */
function applyLiveToRuntime(
  runtime: CampusRuntime,
  snap: EngineSnapshot | null,
  activity?: { zones: readonly EnvZone[]; storeyHeight: number | null | undefined },
): void {
  if (!snap) return;
  runtime.built.applyZoneHeat(new Map(snap.zones.map(zone => [zone.id, zone.parameters])));
  runtime.devicesFamily?.applyStates(
    new Map(snap.devices.map(device => [device.id, { fault: device.fault != null, status: device.status }])),
  );
  // UX-W4: latest fresh decision per agent → avatar migration anchor; agents
  // without a fresh signal drift home (the family treats map-absent as home).
  if (activity && runtime.agentsFamily) {
    const targets = agentActivityTargets(snap.recentDecisions ?? [], Date.now());
    const zoneById = new Map(activity.zones.map(zone => [zone.id, zone]));
    const anchors = new Map<string, Vec3>();
    for (const [agentId, target] of targets) {
      const anchor = activityAnchorForZone(zoneById.get(target.zoneId), {
        storeyHeight: activity.storeyHeight,
        anchor: runtime.geoAnchor,
      });
      // 目标 zone 无几何 = 诚实不动（保留原位/辖区），不猜位置。
      if (anchor) anchors.set(agentId, anchor);
    }
    runtime.agentsFamily.setActivityTargets(anchors);
  }
  // Alert latching: engine smoke decays with a ~69 s (sim) half-life while the
  // overlay polls every 4 s, so a raw threshold read would miss short spikes.
  // Latch each alerting zone for ALERT_LATCH_MS of wall time — the pulse stays
  // visible long enough to notice, and still clears on its own.
  const now = performance.now();
  for (const zoneId of alertingZoneIds(snap.zones)) {
    runtime.alertLatchUntil.set(zoneId, now + ALERT_LATCH_MS);
  }
  for (const [zoneId, until] of runtime.alertLatchUntil) {
    if (until <= now) runtime.alertLatchUntil.delete(zoneId);
  }
  runtime.alertZoneIds = new Set(runtime.alertLatchUntil.keys());
  runtime.edgeLayer.sync(
    collabEdgesFromSnapshot(snap.agents),
    runtime.agentsFamily?.positionById ?? new Map(),
  );
  runtime.markDirty();
}

/**
 * 我的视角 dimming (C4): slabs resolve in runtime.applyAlpha (composed with
 * focus dimming); devices dim via the instance color alpha channel, agents
 * via their material alpha. Null focusOwnerId (global) restores everything.
 */
function applyPerspectiveToRuntime(
  runtime: CampusRuntime,
  perspective: { focusOwnerId: string | null; focusedZoneIds: ReadonlySet<string> },
  devices: readonly WorldModelDevice[],
  agents: readonly WorldModelAgent[],
): void {
  runtime.applyAlpha();
  const ownerId = perspective.focusOwnerId;
  runtime.devicesFamily?.setDimmed(
    ownerId === null
      ? null
      : new Set(devices.filter(d => isDimmed(d.ownerId, ownerId)).map(d => d.id)),
  );
  runtime.agentsFamily?.setDimmed(
    ownerId === null
      ? null
      : new Set(agents.filter(a => isDimmed(a.ownerId, ownerId)).map(a => a.id)),
  );
}
