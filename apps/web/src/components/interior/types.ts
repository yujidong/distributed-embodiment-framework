/**
 * Interior-walk contracts (R82 phase 2) — the vocabulary shared by the two
 * render paths (raster / polygon), the deploy hook, and the page. Keeping
 * the types here (not in the facade) avoids circular imports between the
 * paths and the facade that dispatches to them.
 */

import type { InteriorFloorData, Spawn } from '../../lib/interior3d/projection';

export const EYE_HEIGHT = 1.6;
export const WALL_HEIGHT = 2.6;

/** Raster-extracted interior (plan-local meters, z southward). */
export interface RasterInterior {
  /** [cx, cz, w, d, rot?] — rot = plan radians (x→z), absent = axis-aligned. */
  walls: Array<[number, number, number, number, number?]>;
  floor: Array<[number, number, number, number]>;
  wallHeight: number;
  labels: Array<{ code: string; name: string; hours?: string; x: number; z: number }>;
  /** Floor-plan underlay: image file + drawing size in meters. */
  plan?: { file: string; width: number; height: number };
  /**
   * UX-W4: plan size in meters when there is NO underlay image (runtime
   * raster from map_data) — rasterPath falls back to these for wM/hM.
   */
  width?: number;
  height?: number;
  /** Drawing extent on the source page (full-image px) + page pixel size. */
  drawingBbox?: { x: [number, number]; y: [number, number] };
  imagePx?: [number, number];
  /** Meters per source-image pixel. */
  mpp?: number;
  /**
   * Carved door-gap centers [[x, z], ...] (plan meters) for threshold
   * markers; the runtime rasterizer appends an orientation ('x' = the host
   * wall runs along x) so door frames sit right without a host-wall probe.
   */
  doors?: Array<[number, number] | [number, number, 'x' | 'z']>;
  /** Enclosed room regions with pastel floor tint (from plan flood fill). */
  rooms?: Array<{
    code: string;
    name: string;
    color: [number, number, number];
    boxes: Array<[number, number, number, number]>;
    /** UX-W4: owning zone (runtime rasterizer) for per-zone live readouts. */
    zoneId?: string;
  }>;
}

/** An IoT device to visualize, in plan meters. */
export interface InteriorDevice {
  id: string;
  name: string;
  type: string;
  x: number;
  z: number;
  on: boolean;
}

/** A deployable device kind (deploy palette entry). */
export interface DeployKind {
  type: string;
  name: string;
  capabilities: string[];
}

export interface InteriorWalkSceneOptions {
  canvas: HTMLCanvasElement;
  /**
   * Legacy polygon-path floor geometry. UX-W4: the polygon path is gone
   * (the runtime rasterizer covers every zone with bounds OR a polygon);
   * kept optional for the debug probe's call shape — never read.
   */
  data?: InteriorFloorData;
  spawn?: Spawn;
  /** Raster-extracted interior — wins over `data`. */
  raster?: RasterInterior;
  /** Room code to spawn at (raster mode). */
  codeHint?: string;
  /** IoT devices to visualize (raster mode). */
  devices?: InteriorDevice[];
  /** When set, the crosshair carries a placement ghost; click places here. */
  deployKind?: DeployKind | null;
  /** Deploy: place the ghosted device at the crosshair (plan meters). */
  onPlace?: (x: number, z: number) => void;
  /** Deploy: the crosshair target is not placeable — page shows feedback (R97). */
  onPlaceRejected?: () => void;
  /** Called when the user clicks a room marker. */
  onRoomPick?: (code: string) => void;
  /** 房间号 → 语义名称（来自 zone.rooms），功能化家具按名称关键词选家具套件。 */
  roomNames?: Record<string, string>;
  /** Shared mutable movement state — page writes key states, scene reads each frame. */
  movementState: { forward: boolean; backward: boolean; left: boolean; right: boolean; sprint: boolean };
}

/** UX-W4: live overlay payload for `applyLiveOverlay` (null = no reading). */
export interface InteriorLiveOverlay {
  tempC: number | null;
  occupancy: number | null;
  co2: number | null;
  alert: boolean;
}

export interface InteriorWalkSceneHandle {
  scene: import('@babylonjs/core').Scene;
  /** True when the floor fell back to open-hall rendering (no room data, R97). */
  openHall?: boolean;
  dispose(): void;
  /** Ray-pick from the crosshair; room code or null. */
  pickAtCenter(): string | null;
  /** Deploy mode: place the ghosted device at the crosshair; true if placed. */
  placeAtCenter(): boolean;
  /** Nearest device within maxDist of the walker. Null when none. */
  pickNearestDevice(maxDist: number): InteriorDevice | null;
  /** Live overlay: tint rooms + label readouts by floor temperature (°C). */
  applyTemps?(tempC: number | null): void;
  /**
   * UX-W4 live layer: per-floor readings (temperature / occupancy / co2)
   * plus the alert flag (red pulse on room tints + ⚠ label badge). All
   * writes are in-place material/label updates — never a scene rebuild.
   */
  applyLiveOverlay?(overlay: InteriorLiveOverlay): void;
  /** Diff-sync device meshes in place — create/remove/recolor without a scene rebuild. */
  syncDevices?(devices: InteriorDevice[]): void;
  /** Switch the deploy kind (ghost on/off) in place — without a scene rebuild. */
  setDeployKind?(kind: DeployKind | null): void;
  /** 目的地信标（Forza/Firewatch 式目标光柱）；null 清除。 */
  setBeacon?(pos: { x: number; z: number } | null): void;
  /** 当前信标位置（页面 HUD 距离读取用）。 */
  getBeaconPos?(): { x: number; z: number } | null;
  /** 在场化身（驻守本层的仿真 Agent）：差分创建/移除，位置渐变插值。 */
  setPresence?(list: Array<{ id: string; name: string; x: number; z: number }>): void;
  /** Walker position + yaw (plan meters) for the minimap. */
  getCameraPos(): { x: number; z: number; yaw: number };
}
