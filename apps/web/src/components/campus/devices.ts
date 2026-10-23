/**
 * Campus device markers — one low-poly glyph per IoT device, rendered as
 * thin instances grouped by role shape (sphere = sensor, box = actuator,
 * disc = hybrid/unknown): three draw calls total regardless of device count.
 *
 * - Per-instance COLOR buffer (stride 4, dynamic): the base tint is the 2D
 *   role palette (lib/campus3d `deviceMarkerColorHex`), and live snapshot
 *   updates (fault → danger red, off → dimmed) are pure buffer write-backs —
 *   materials stay diffuse-white so the instance color IS the final tint and
 *   `applyStates` never touches meshes/materials;
 * - per-instance picking: `thinInstanceEnablePicking` + the picking info's
 *   `thinInstanceIndex` resolve back to the device id via `idsByKind`;
 * - thin instances REPLACE the source mesh draw (draw count == instances
 *   count, composed with the source world matrix) — sources stay at identity
 *   scale (zero-scaling would collapse every instance; same for the trees);
 *
 * Placement is pure (lib/campus3d `devicePlacements`); this file only maps
 * placements to GPU buffers.
 */

import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

import {
  DEVICE_ROLE_COLORS,
  deviceMarkerColorHex,
  deviceMarkerKind,
  type CampusDevicePlacement,
  type DeviceMarkerKind,
  type Vec3,
} from '../../lib/campus3d';

export interface CampusDeviceMeshes {
  /** Thin-instance host meshes (layer toggling / dispose). */
  meshes: Mesh[];
  /** kind → device ids in instance order (thinInstanceIndex lookup). */
  idsByKind: ReadonlyMap<DeviceMarkerKind, readonly string[]>;
  /** device id → display info (tooltips). */
  infoById: ReadonlyMap<string, { name: string; type: string; role: string }>;
  /** device id → marker anchor (drag-line origin while repositioning). */
  positionById: ReadonlyMap<string, Vec3>;
  /** Snapshot status → per-instance color write-back (no mesh rebuild). */
  applyStates(states: ReadonlyMap<string, { fault: boolean; status?: string }>): void;
  /**
   * 我的视角 (W5): dim devices NOT owned by the focus owner via the instance
   * color buffer's alpha channel (single-buffer discipline — applyStates
   * preserves the dim alpha). Null restores full opacity.
   */
  setDimmed(dimIds: ReadonlySet<string> | null): void;
  /**
   * Distance-tier scaling: rewrites the instance MATRIX buffers with a new
   * uniform glyph scale (thin-instance matrices ARE the world matrices — the
   * source mesh's own scaling does not propagate). Called on tier changes
   * only, from the render loop.
   */
  setDistanceScale(scale: number): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/** Marker glyph sizes (meters) — Ø/side ~2.2 m so glyphs read at mid zoom. */
const GLYPH_SIZE: Record<DeviceMarkerKind, number> = { sphere: 1.1, box: 2.2, disc: 2.2 };
/** Self-glow lift per glyph (× the kind's role color) for mid-range legibility. */
const GLYPH_EMISSIVE = 0.35;
/** 我的视角 dimmed-device alpha (2D maps dim to ~25% opacity). */
const DIM_ALPHA = 0.3;

function glyphMesh(kind: DeviceMarkerKind, scene: Scene): Mesh {
  // Names carry the KIND (campus-device-sphere|box|disc): `deviceAt` in
  // CampusScene resolves picked instances by matching `campus-device-${kind}`.
  switch (kind) {
    case 'sphere':
      return MeshBuilder.CreateIcoSphere(
        'campus-device-sphere',
        { radius: GLYPH_SIZE.sphere, subdivisions: 1, flat: true },
        scene,
      );
    case 'box':
      return MeshBuilder.CreateBox('campus-device-box', { size: GLYPH_SIZE.box }, scene);
    case 'disc':
      return MeshBuilder.CreateCylinder(
        'campus-device-disc',
        { height: 0.6, diameter: GLYPH_SIZE.disc, tessellation: 8 },
        scene,
      );
  }
}

/** Role color per glyph kind (1:1 role→kind mapping; disc = hybrid tone). */
const KIND_EMISSIVE_HEX: Record<DeviceMarkerKind, number> = {
  sphere: DEVICE_ROLE_COLORS.sensor,
  box: DEVICE_ROLE_COLORS.actuator,
  disc: DEVICE_ROLE_COLORS.hybrid,
};

function hexToColor3(hex: number): Color3 {
  return new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);
}

export function buildCampusDevices(
  scene: Scene,
  placements: readonly CampusDevicePlacement[],
): CampusDeviceMeshes {
  const byKind = new Map<DeviceMarkerKind, CampusDevicePlacement[]>();
  for (const placement of placements) {
    const kind = deviceMarkerKind(placement.role);
    const list = byKind.get(kind) ?? [];
    list.push(placement);
    byKind.set(kind, list);
  }

  const meshes: Mesh[] = [];
  const meshByKind = new Map<DeviceMarkerKind, Mesh>();
  const idsByKind = new Map<DeviceMarkerKind, readonly string[]>();
  /** kind → mutable per-instance color buffer (r,g,b,a × instance). */
  const colorBuffers = new Map<DeviceMarkerKind, Float32Array>();
  /** device id → slot in its kind's buffers. */
  const slotOf = new Map<string, { kind: DeviceMarkerKind; index: number; role: string }>();
  const infoById = new Map<string, { name: string; type: string; role: string }>();
  const positionById = new Map<string, Vec3>();
  /** kind → ordered placements (matrix buffer rebuilds read positions). */
  const placementsByKind = new Map<DeviceMarkerKind, readonly CampusDevicePlacement[]>();

  /** Rebuild a kind's instance matrices with a uniform glyph scale. */
  const writeMatrices = (kind: DeviceMarkerKind, scale: number) => {
    const list = placementsByKind.get(kind) ?? [];
    const mesh = meshByKind.get(kind);
    if (!mesh || list.length === 0) return;
    const buffer = new Float32Array(list.length * 16);
    const scaleVec = new Vector3(scale, scale, scale);
    list.forEach((placement, index) => {
      Matrix.Compose(
        scaleVec,
        Quaternion.Identity(),
        new Vector3(placement.position.x, placement.position.y, placement.position.z),
      ).copyToArray(buffer, index * 16);
    });
    mesh.thinInstanceSetBuffer('matrix', buffer, 16, true);
  };

  for (const [kind, list] of byKind) {
    const mesh = glyphMesh(kind, scene);
    // Diffuse white: the per-instance color buffer carries the actual tint.
    const material = new StandardMaterial(`campus-device-${kind}-mat`, scene);
    material.diffuseColor = Color3.White();
    material.specularColor = Color3.Black();
    // Tinted self-glow (role hue × 0.35) lifts glyphs out of slab shadows.
    material.emissiveColor = hexToColor3(KIND_EMISSIVE_HEX[kind]).scale(GLYPH_EMISSIVE);
    // Instance-color alpha (我的视角 dim) only blends when the material counts
    // as transparent — mesh.hasVertexAlpha ignores instance buffers, so pin
    // the material a hair below 1 (visually opaque, blending enabled).
    material.alpha = 0.999;
    mesh.material = material;

    const colors = new Float32Array(list.length * 4);
    list.forEach((placement, index) => {
      const tint = hexToColor3(deviceMarkerColorHex({ role: placement.role }));
      colors.set([tint.r, tint.g, tint.b, 1], index * 4);
      slotOf.set(placement.id, { kind, index, role: placement.role });
      infoById.set(placement.id, {
        name: placement.name,
        type: placement.type,
        role: placement.role,
      });
      positionById.set(placement.id, placement.position);
    });
    // Dynamic buffer: live status updates write back in place.
    mesh.thinInstanceSetBuffer('color', colors, 4, false);
    mesh.thinInstanceEnablePicking = true;
    mesh.isPickable = true;
    // Thin-instance rendering draws ONLY the instances (_renderWithThinInstances
    // uses instancesCount as the draw count) and composes them with the mesh's
    // own world matrix — keep the source at identity (zero-scaling it would
    // collapse every instance).
    mesh.freezeWorldMatrix();

    meshes.push(mesh);
    meshByKind.set(kind, mesh);
    idsByKind.set(
      kind,
      list.map(placement => placement.id),
    );
    colorBuffers.set(kind, colors);
    placementsByKind.set(kind, list);
  }

  let distanceScale = 1;
  for (const kind of placementsByKind.keys()) writeMatrices(kind, distanceScale);

  /** 我的视角 dim set (C4): ids render at reduced alpha in the color buffer. */
  let dimIds: ReadonlySet<string> | null = null;
  const dimAlpha = (id: string): number => (dimIds?.has(id) ? DIM_ALPHA : 1);

  let enabled = true;
  return {
    meshes,
    idsByKind,
    infoById,
    positionById,
    applyStates(states) {
      const touched = new Set<Mesh>();
      for (const [id, state] of states) {
        const slot = slotOf.get(id);
        if (!slot) continue;
        const buffer = colorBuffers.get(slot.kind)!;
        const tint = hexToColor3(
          deviceMarkerColorHex({ role: slot.role, fault: state.fault, status: state.status }),
        );
        const offset = slot.index * 4;
        if (
          buffer[offset] === tint.r &&
          buffer[offset + 1] === tint.g &&
          buffer[offset + 2] === tint.b
        ) {
          continue;
        }
        // Alpha channel belongs to the perspective dim — preserve it.
        buffer.set([tint.r, tint.g, tint.b, dimAlpha(id)], offset);
        touched.add(meshByKind.get(slot.kind)!);
      }
      for (const mesh of touched) mesh.thinInstanceBufferUpdated('color');
    },
    setDimmed(next) {
      dimIds = next;
      const touched = new Set<Mesh>();
      for (const [id, slot] of slotOf) {
        const buffer = colorBuffers.get(slot.kind)!;
        const alpha = dimAlpha(id);
        const offset = slot.index * 4 + 3;
        if (buffer[offset] === alpha) continue;
        buffer[offset] = alpha;
        touched.add(meshByKind.get(slot.kind)!);
      }
      for (const mesh of touched) mesh.thinInstanceBufferUpdated('color');
    },
    setDistanceScale(scale: number) {
      if (scale === distanceScale) return;
      distanceScale = scale;
      for (const kind of placementsByKind.keys()) writeMatrices(kind, scale);
    },
    setEnabled(next: boolean) {
      enabled = next;
      for (const mesh of meshes) mesh.setEnabled(enabled);
    },
    dispose() {
      // disposeMaterialAndTextures=true — the per-kind materials are ours;
      // without it every family rebuild leaks them (batch C1).
      for (const mesh of meshes) mesh.dispose(false, true);
    },
  };
}
