/**
 * Campus GUI labels: building-name cards pinned above each building, plus
 * per-floor tags and agent nameplates when zoomed in. Labels are Babylon GUI
 * controls linked to invisible anchor meshes (linkWithMesh projects the
 * anchor's bounding center; the anchor itself never renders).
 *
 * Distance tiers (measured against whole-campus clutter at radius ~900 m):
 * - building names: visible out to `maxRadius` (wide tier — they carry the
 *   overview);
 * - floor tags + agent nameplates: only inside the NEAR tier
 *   (`floorRadius`) — at campus zoom they stack into unreadable piles.
 * The component calls `update(radius)` throttled (~150 ms), mirroring the
 * interior rasterPath declutter cadence.
 */

import { Mesh, MeshBuilder, Scene } from '@babylonjs/core';
import { AdvancedDynamicTexture, Rectangle, TextBlock } from '@babylonjs/gui';

export interface CampusLabelSpec {
  key: string;
  kind: 'building' | 'floor' | 'agent';
  text: string;
  /** Anchor position in scene meters (x = east, y = up, z = south). */
  position: { x: number; y: number; z: number };
}

export interface CampusLabelThresholds {
  /** Near tier: below this camera radius, floor tags + agent nameplates show. */
  floorRadius: number;
  /** Building-name tier: past this radius all labels hide. */
  maxRadius: number;
}

export interface CampusLabels {
  update(cameraRadius: number): void;
  /**
   * UX-W4 agent 活化：移动某个锚点（名牌随 avatar 迁移）。锚点初始
   * freezeWorldMatrix —— 首次移动时解冻，之后每帧直接写 position（动画
   * 期间不再 refreeze，迁移的 avatar 数量小，矩阵重算开销可忽略）。
   */
  moveAnchor?(key: string, position: { x: number; y: number; z: number }): void;
  dispose(): void;
}

function labelCard(gui: AdvancedDynamicTexture, anchor: Mesh, text: string): Rectangle {
  const block = new TextBlock();
  block.text = text;
  block.color = '#25324a';
  block.fontSize = 15;
  block.fontFamily = 'Inter, system-ui, sans-serif';
  block.resizeToFit = true;
  block.paddingLeft = '5px';
  block.paddingRight = '5px';
  const card = new Rectangle();
  card.thickness = 1;
  card.color = '#ffffff';
  card.background = 'rgba(255,255,255,0.82)';
  card.adaptWidthToChildren = true;
  card.adaptHeightToChildren = true;
  card.cornerRadius = 4;
  card.alpha = 0.95;
  card.addControl(block);
  // Link only AFTER attaching to the GUI root — Babylon refuses to link
  // non-root controls (same discipline as interior sceneShared.roomLabelCard).
  gui.addControl(card);
  card.linkWithMesh(anchor);
  return card;
}

export function createCampusLabels(
  scene: Scene,
  specs: readonly CampusLabelSpec[],
  thresholds: CampusLabelThresholds,
): CampusLabels {
  const gui = AdvancedDynamicTexture.CreateFullscreenUI('campus-ui', true, scene);
  gui.idealWidth = 1200;

  const entries: Array<{ kind: CampusLabelSpec['kind']; card: Rectangle }> = [];
  const anchors: Mesh[] = [];
  const anchorByKey = new Map<string, Mesh>();
  for (const spec of specs) {
    const anchor = MeshBuilder.CreateBox(`label-${spec.key}`, { size: 0.01 }, scene);
    anchor.position.set(spec.position.x, spec.position.y, spec.position.z);
    anchor.isVisible = false;
    anchor.isPickable = false;
    anchor.freezeWorldMatrix();
    anchors.push(anchor);
    anchorByKey.set(spec.key, anchor);
    entries.push({ kind: spec.kind, card: labelCard(gui, anchor, spec.text) });
  }

  return {
    update(cameraRadius: number): void {
      const showBuildings = cameraRadius <= thresholds.maxRadius;
      const showNear = cameraRadius <= thresholds.floorRadius;
      for (const entry of entries) {
        // 'building' rides the wide tier; 'floor' and 'agent' are near-only.
        entry.card.isVisible = entry.kind === 'building' ? showBuildings : showNear;
      }
    },
    moveAnchor(key: string, position: { x: number; y: number; z: number }): void {
      const anchor = anchorByKey.get(key);
      if (!anchor) return;
      anchor.unfreezeWorldMatrix();
      anchor.position.set(position.x, position.y, position.z);
    },
    dispose(): void {
      // Anchors are real scene meshes — without this they accumulate in
      // scene.meshes across family rebuilds (batch C1).
      for (const anchor of anchors) anchor.dispose(false, true);
      gui.dispose();
    },
  };
}
