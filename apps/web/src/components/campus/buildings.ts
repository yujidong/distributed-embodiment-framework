/**
 * Campus building meshes for the Babylon campus view:
 *
 * - one ExtrudePolygon slab per (building, floor) polygon footprint —
 *   Babylon's polygon builder already works in the XoZ plane with y up and
 *   extrudes DOWNWARD from y=0, so the slab is positioned with its top at
 *   `baseY + height` (no rotation needed, unlike the three.js Shape path);
 * - bbox boxes for non-polygon zones (force-layout fallback included, drawn
 *   de-emphasized), roof caps brightened on each building's top floor;
 * - white edges (`enableEdgesRendering`) for the low-poly digital-twin look;
 * - one material per slab (hover/selection tint mutates emissive, so
 *   materials must NOT be shared across slabs);
 * - earcut is imported and injected explicitly: Babylon's ESM build
 *   references a bare `earcut` free variable as the default injection, which
 *   is a ReferenceError under Vite unless passed in.
 *
 * Pick metadata hangs off `mesh.metadata.pick` (CampusPickInfo).
 */

import earcut from 'earcut';
import {
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

import { hslaToRgb, saturateHex, type CampusBuilding } from '../../lib/campus3d';
import { zoneHeatFill } from '../../lib/zoneVisual';

export interface CampusPickInfo {
  buildingId: string;
  buildingName: string;
  floor: number;
  /** First zone behind this slab (deduped footprints keep the first zone). */
  zoneId: string;
  zoneName: string;
  fallback: boolean;
}

export interface BuiltCampusMeshes {
  /** Slabs + boxes eligible for hover/click picking. */
  pickables: Mesh[];
  /** Roof-cap anchors: building top center (label placement). */
  topOf: Map<string, number>;
  /**
   * Live heat channel (Phase 2): re-tint every slab/roof from fresh zone
   * parameters IN PLACE (diffuse write-back only — no mesh rebuild).
   * Returns true when any material actually changed (caller marks dirty).
   */
  applyZoneHeat(parametersById: ReadonlyMap<string, Record<string, unknown> | undefined>): boolean;
}

/** Edge overlay tuning (twin-style soft wire over flat fills). */
const EDGE_COLOR = new Color4(0.85, 0.88, 0.92, 0.5);
const EDGE_WIDTH = 1.6;
const FALLBACK_ALPHA = 0.55;
/** Category saturation lift (Phase 5 visual pass — slabs read off the ground). */
const CATEGORY_SATURATION_LIFT = 0.15;
/** Roof caps: light grey-blue anchor with a whisper of the category hue. */
const ROOF_BASE = { r: 0.933, g: 0.949, b: 0.965 }; // #eef2f6
const ROOF_CATEGORY_MIX = 0.18;

function hexToColor3(hex: number): Color3 {
  return new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);
}

/** Category color, saturation-lifted (static look; heat is blended live). */
export function slabBaseColor(hex: number, heatColor: string | null): Color3 {
  if (heatColor !== null) {
    const rgb = hslaToRgb(heatColor);
    if (rgb) return new Color3(rgb.r, rgb.g, rgb.b);
  }
  return hexToColor3(saturateHex(hex, CATEGORY_SATURATION_LIFT));
}

/**
 * Live heat look: full heat tint flattens the whole campus to one hue, so
 * walls blend category→heat only partway (the building keeps its identity)
 * while roof caps carry the heat more strongly (roofs face the camera).
 */
const WALL_HEAT_BLEND = 0.45;
const ROOF_HEAT_BLEND = 0.55;

function heatColorOf(heatColor: string): Color3 | null {
  const rgb = hslaToRgb(heatColor);
  return rgb ? new Color3(rgb.r, rgb.g, rgb.b) : null;
}

function matteMaterial(name: string, diffuse: Color3, scene: Scene, alpha = 1): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse;
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.Black();
  material.alpha = alpha;
  // Footprint winding varies across scenarios; doubleside keeps slabs solid.
  material.backFaceCulling = false;
  return material;
}

function withEdges(mesh: Mesh): Mesh {
  mesh.enableEdgesRendering();
  mesh.edgesWidth = EDGE_WIDTH;
  mesh.edgesColor = EDGE_COLOR;
  return mesh;
}

/** Roof-cap tint: light grey-blue with a whisper of the category hue. */
function roofColor(base: Color3): Color3 {
  return new Color3(
    ROOF_BASE.r + (base.r - ROOF_BASE.r) * ROOF_CATEGORY_MIX,
    ROOF_BASE.g + (base.g - ROOF_BASE.g) * ROOF_CATEGORY_MIX,
    ROOF_BASE.b + (base.b - ROOF_BASE.b) * ROOF_CATEGORY_MIX,
  );
}

/**
 * CampusBuilding list → meshes. Everything is static: world matrices are
 * frozen after placement (the dirty-flag render loop in CampusScene handles
 * camera-driven redraws).
 */
export function buildCampusMeshes(
  scene: Scene,
  buildings: readonly CampusBuilding[],
): BuiltCampusMeshes {
  const pickables: Mesh[] = [];
  const topOf = new Map<string, number>();
  /** Slabs + roof caps that follow the live zone heat fill. */
  const heatables: Mesh[] = [];

  for (const building of buildings) {
    let top = 0;
    for (const slab of building.floors) {
      for (const ext of slab.extrusions) {
        top = Math.max(top, ext.baseY + ext.height);
        // CreatePolygon reads the footprint from each vector's X/Z components
        // (polygonBuilder.pure.js: `new Vector2(shape[i].x, shape[i].z)`) and
        // extrudes DOWNWARD from y=0, so the slab's top sits at position.y.
        const shape = ext.points.map(point => new Vector3(point.x, 0, point.z));
        const mesh = MeshBuilder.ExtrudePolygon(
          `bldg-${building.buildingId}-f${slab.floor}`,
          { shape, depth: ext.height },
          scene,
          earcut,
        );
        mesh.position.y = ext.baseY + ext.height;
        const base = slabBaseColor(ext.color, ext.heatColor);
        mesh.material = matteMaterial(`${mesh.name}-mat`, base, scene);
        withEdges(mesh);
        mesh.metadata = {
          pick: {
            buildingId: building.buildingId,
            buildingName: building.name,
            floor: slab.floor,
            zoneId: ext.zoneId,
            zoneName: ext.name,
            fallback: false,
          } satisfies CampusPickInfo,
          baseColor: base,
          categoryHex: ext.color,
          zoneId: ext.zoneId,
          baseAlpha: 1,
        };
        mesh.freezeWorldMatrix();
        pickables.push(mesh);
        heatables.push(mesh);

        // Roof cap on the top floor only (intermediate caps are hidden
        // inside the stack anyway).
        if (slab.floor === building.maxFloor) {
          const cap = MeshBuilder.CreatePolygon(
            `${mesh.name}-roof`,
            { shape },
            scene,
            earcut,
          );
          cap.position.y = ext.baseY + ext.height + 0.05;
          cap.material = matteMaterial(`${cap.name}-mat`, roofColor(base), scene);
          cap.isPickable = false;
          // Category-tinted rim on the roof so the cap doesn't read as pure white.
          cap.enableEdgesRendering();
          cap.edgesWidth = EDGE_WIDTH;
          cap.edgesColor = new Color4(base.r, base.g, base.b, 0.45);
          cap.metadata = { categoryHex: ext.color, zoneId: ext.zoneId, roof: true };
          cap.freezeWorldMatrix();
          heatables.push(cap);
        }
      }

      for (const box of slab.boxes) {
        top = Math.max(top, box.position.y + box.size.y / 2);
        const mesh = MeshBuilder.CreateBox(`bldg-${building.buildingId}-${box.zoneId}`, {
          width: box.size.x,
          height: box.size.y,
          depth: box.size.z,
        }, scene);
        mesh.position.set(box.position.x, box.position.y, box.position.z);
        const base = slabBaseColor(box.color, box.heatColor);
        mesh.material = matteMaterial(
          `${mesh.name}-mat`,
          base,
          scene,
          box.fallback ? FALLBACK_ALPHA : 1,
        );
        withEdges(mesh);
        mesh.metadata = {
          pick: {
            buildingId: building.buildingId,
            buildingName: building.name,
            floor: slab.floor,
            zoneId: box.zoneId,
            zoneName: box.name,
            fallback: box.fallback,
          } satisfies CampusPickInfo,
          baseColor: base,
          categoryHex: box.color,
          zoneId: box.zoneId,
          baseAlpha: box.fallback ? FALLBACK_ALPHA : 1,
        };
        mesh.freezeWorldMatrix();
        pickables.push(mesh);
        heatables.push(mesh);
      }
    }
    topOf.set(building.buildingId, top);
  }

  return {
    pickables,
    topOf,
    applyZoneHeat(parametersById) {
      let changed = false;
      for (const mesh of heatables) {
        const meta = mesh.metadata as { zoneId: string; categoryHex: number; roof?: boolean };
        const heat = zoneHeatFill(parametersById.get(meta.zoneId));
        const categoryBase = hexToColor3(saturateHex(meta.categoryHex, CATEGORY_SATURATION_LIFT));
        const heatTint = heat !== null ? heatColorOf(heat) : null;
        let target: Color3;
        if (meta.roof) {
          const roofBase = roofColor(categoryBase);
          target = heatTint ? Color3.Lerp(roofBase, heatTint, ROOF_HEAT_BLEND) : roofBase;
        } else {
          target = heatTint
            ? Color3.Lerp(categoryBase, heatTint, WALL_HEAT_BLEND)
            : categoryBase;
        }
        const material = mesh.material as StandardMaterial;
        if (!material.diffuseColor.equals(target)) {
          material.diffuseColor.copyFrom(target);
          changed = true;
        }
        // Hover/selection emissive math keys off baseColor — keep it in sync.
        if (!meta.roof) mesh.metadata.baseColor = target;
      }
      return changed;
    },
  };
}
