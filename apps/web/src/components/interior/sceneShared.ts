/**
 * Shared scene plumbing for the interior render paths: engine/scene setup,
 * the first-person camera, pointer-lock, GUI label cards, and the
 * create/dispose finisher that both paths return through.
 */

import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Mesh,
  Scene,
  UniversalCamera,
  Vector3,
} from '@babylonjs/core';
import { AdvancedDynamicTexture, Rectangle, TextBlock } from '@babylonjs/gui';

import type { InteriorWalkSceneHandle } from './types';

export const EYE_HEIGHT = 1.6;
export const WALL_HEIGHT = 2.6;

export function baseScene(engine: Engine): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.93, 0.95, 0.98, 1);
  scene.collisionsEnabled = true;
  scene.gravity = new Vector3(0, -0.6, 0);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogStart = 80;
  scene.fogEnd = 260;
  scene.fogColor = new Color3(0.93, 0.95, 0.98);
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 1.0;
  hemi.groundColor = new Color3(0.38, 0.39, 0.42); // 背光面反弹，墙内侧不死黑
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.3), scene);
  sun.intensity = 0.45;
  return scene;
}

export function walkCamera(
  scene: Scene,
  canvas: HTMLCanvasElement,
  position: Vector3,
  yaw: number,
): UniversalCamera {
  const camera = new UniversalCamera('walk', position, scene);
  camera.rotation.set(0, yaw, 0);
  camera.minZ = 0.1;
  camera.speed = 0.35;
  camera.inertia = 0.75;
  camera.angularSensibility = 1800;
  camera.applyGravity = true;
  camera.checkCollisions = true;
  camera.ellipsoid = new Vector3(0.4, 0.8, 0.4);
  camera.attachControl(canvas, true);
  scene.activeCamera = camera;
  return camera;
}

export function makeGui(scene: Scene): AdvancedDynamicTexture {
  const gui = AdvancedDynamicTexture.CreateFullscreenUI('ui', true, scene);
  gui.idealWidth = 1200;
  return gui;
}

export function roomLabelCard(
  gui: AdvancedDynamicTexture,
  pylon: Mesh,
  code: string,
  textBlock?: TextBlock,
): Rectangle {
  // R2-FEAT-12: 调用方传入 textBlock 时已填好显示名（name 主 code 次），
  // 不得覆盖；只有自建 TextBlock 时才用 code 兜底。
  const text = textBlock ?? new TextBlock();
  if (!textBlock) text.text = code;
  text.color = '#25324a';
  text.fontSize = 22;
  text.fontFamily = 'Inter, system-ui, sans-serif';
  text.resizeToFit = true;
  text.paddingLeft = '6px';
  text.paddingRight = '6px';
  const card = new Rectangle();
  card.thickness = 1;
  card.color = '#ffffff';
  card.background = 'rgba(255,255,255,0.8)';
  card.adaptWidthToChildren = true;
  card.adaptHeightToChildren = true;
  card.cornerRadius = 4;
  card.alpha = 0.95;
  card.addControl(text);
  // 必须先挂到 GUI 根再 linkWithMesh —— Babylon 拒绝为非根级控件建立链接
  // （顺序颠倒时所有卡牌堆叠在屏幕正中且 console 刷 Cannot link a control…）
  gui.addControl(card);
  card.linkWithMesh(pylon);
  card.linkOffsetY = -66;
  return card;
}

/** Registers the debug hook and wraps dispose so callers can add cleanup. */
export function finish(
  handle: InteriorWalkSceneHandle,
  extraDispose?: () => void,
): InteriorWalkSceneHandle {
  const { dispose } = handle;
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__interiorScene = handle;
  }
  return {
    ...handle,
    dispose() {
      extraDispose?.();
      dispose();
    },
  };
}
