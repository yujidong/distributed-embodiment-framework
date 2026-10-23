/**
 * Campus ground dressing for the Babylon campus view: a soft-grey ground
 * disc with a drawn 10 m grid (DynamicTexture — @babylonjs/materials is not
 * a dependency, so no GridMaterial), an optional flat ring-road torus past
 * the building cluster, and deterministic low-poly greenery (cone + sphere
 * crown over a cylinder trunk) rendered as THREE thin-instanced meshes —
 * one draw call per tree part regardless of tree count.
 *
 * Layout comes from `campusGroundPlan` (lib/campus3d, unit-tested); this
 * file only maps the plan to meshes.
 */

import {
  Color3,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

import type { CampusGroundPlan } from '../../lib/campus3d';

/** Grid cell drawn on the ground texture, in meters. */
const GRID_CELL_M = 10;
/** Visual pass (Phase 5): cold grey-green ground, legible grid, asphalt road. */
const GROUND_FILL = '#d4e0d8';
const GROUND_GRID = 'rgba(150,165,156,0.85)'; // ~#96a59c lines over the fill
const RIM_COLOR = new Color3(0.753, 0.812, 0.769); // #c0cfc4 campus rim disc
const ROAD_COLOR = '#8f9aa6';
const ROAD_DASH = 'rgba(255,255,255,0.85)';
/** Trees were nearly invisible at campus zoom — uniform visibility boost. */
const TREE_SCALE_BOOST = 1.4;

function matte(name: string, color: Color3, scene: Scene): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  return material;
}

/** Ground disc + grid texture + painted ring road + campus rim. */
export function buildCampusGround(scene: Scene, plan: CampusGroundPlan): Mesh[] {
  const meshes: Mesh[] = [];

  // Slightly larger, darker rim disc underneath — a readable campus boundary.
  const rim = MeshBuilder.CreateDisc(
    'campus-ground-rim',
    { radius: plan.radius * 1.04, tessellation: 64 },
    scene,
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(plan.center.x, -0.03, plan.center.z);
  rim.material = matte('campus-ground-rim-mat', RIM_COLOR, scene);
  rim.isPickable = false;
  rim.freezeWorldMatrix();
  meshes.push(rim);

  const ground = MeshBuilder.CreateDisc(
    'campus-ground',
    { radius: plan.radius, tessellation: 64 },
    scene,
  );
  // CreateDisc faces +z; -90° about X turns it face-up (y+), mirroring z —
  // irrelevant for the symmetric grid texture.
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(plan.center.x, 0, plan.center.z);
  const texture = new DynamicTexture('campus-ground-tex', { width: 1024, height: 1024 }, scene, true);
  const context = texture.getContext();
  context.fillStyle = GROUND_FILL;
  context.fillRect(0, 0, 1024, 1024);
  const cellPx = (1024 * GRID_CELL_M) / (plan.radius * 2);
  context.strokeStyle = GROUND_GRID;
  context.lineWidth = 2.5;
  context.beginPath();
  for (let p = 0; p <= 1024; p += cellPx) {
    context.moveTo(p, 0);
    context.lineTo(p, 1024);
    context.moveTo(0, p);
    context.lineTo(1024, p);
  }
  context.stroke();

  // Ring road painted INTO the ground texture (the flattened torus was
  // invisible at grazing angles): asphalt band + dashed white center line.
  if (plan.roadRing) {
    const { innerRadius, outerRadius } = plan.roadRing;
    const toPx = (meters: number) => (meters / plan.radius) * 512;
    const midPx = toPx((innerRadius + outerRadius) / 2);
    context.strokeStyle = ROAD_COLOR;
    context.lineWidth = toPx(outerRadius - innerRadius);
    context.beginPath();
    context.arc(512, 512, midPx, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = ROAD_DASH;
    context.lineWidth = Math.max(toPx(0.4), 2);
    context.setLineDash([toPx(3), toPx(2.4)]);
    context.beginPath();
    context.arc(512, 512, midPx, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
  }
  texture.update();
  const groundMaterial = new StandardMaterial('campus-ground-mat', scene);
  groundMaterial.diffuseTexture = texture;
  groundMaterial.specularColor = Color3.Black();
  ground.material = groundMaterial;
  ground.isPickable = false;
  ground.freezeWorldMatrix();
  meshes.push(ground);

  return meshes;
}

/** Low-poly tree part heights (before per-tree scale). */
const TRUNK_HEIGHT = 1.4;
const CONE_HEIGHT = 2.2;
const CROWN_LIFT = 0.4;

/**
 * Greenery via thin instances: trunk / cone / sphere-crown are three source
 * meshes (three draw calls) instanced once per tree. Thin instances replace
 * the source draw, so sources stay at identity scale (see devices.ts note).
 */
export function buildCampusTrees(scene: Scene, plan: CampusGroundPlan): Mesh[] {
  if (plan.trees.length === 0) return [];

  const trunk = MeshBuilder.CreateCylinder(
    'campus-tree-trunk',
    { height: TRUNK_HEIGHT, diameter: 0.35, tessellation: 6 },
    scene,
  );
  const cone = MeshBuilder.CreateCylinder(
    'campus-tree-cone',
    { height: CONE_HEIGHT, diameterTop: 0, diameterBottom: 1.8, tessellation: 6 },
    scene,
  );
  const crown = MeshBuilder.CreateIcoSphere(
    'campus-tree-crown',
    { radius: 0.9, subdivisions: 1, flat: true },
    scene,
  );
  trunk.material = matte('campus-tree-trunk-mat', new Color3(0.45, 0.32, 0.22), scene);
  cone.material = matte('campus-tree-cone-mat', new Color3(0.27, 0.52, 0.31), scene);
  crown.material = matte('campus-tree-crown-mat', new Color3(0.38, 0.63, 0.37), scene);

  const parts: Array<{ mesh: Mesh; baseY: number }> = [
    { mesh: trunk, baseY: TRUNK_HEIGHT / 2 },
    { mesh: cone, baseY: TRUNK_HEIGHT + CONE_HEIGHT / 2 },
    { mesh: crown, baseY: TRUNK_HEIGHT + CONE_HEIGHT + CROWN_LIFT },
  ];
  for (const spot of plan.trees) {
    const boosted = spot.scale * TREE_SCALE_BOOST;
    const scale = new Vector3(boosted, boosted, boosted);
    const rotation = Quaternion.FromEulerAngles(0, spot.rotation, 0);
    for (const { mesh, baseY } of parts) {
      mesh.thinInstanceAdd(
        Matrix.Compose(scale, rotation, new Vector3(spot.x, baseY * boosted, spot.z)),
      );
    }
  }
  for (const { mesh } of parts) {
    mesh.isPickable = false;
    // Thin instances replace the source draw entirely (draw count ==
    // instancesCount, composed with the mesh world matrix) — the source stays
    // at identity scale; zero-scaling it would zero every tree.
    mesh.freezeWorldMatrix();
    mesh.thinInstanceRefreshBoundingInfo();
  }
  return parts.map(part => part.mesh);
}
