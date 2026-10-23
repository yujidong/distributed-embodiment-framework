/**
 * 墙体几何探针入口（R93）：跳过登录/API，直接用 /interior/<zone>.json
 * 驱动 createInteriorWalkScene，供 Playwright 截 dollhouse/第一人称对比图。
 * 句柄暴露在 window.__walk（finish() 也会写 __interiorScene）。
 */

import { createInteriorWalkScene } from './components/interior/InteriorWalkScene';
import type { RasterInterior } from './components/interior/types';

const params = new URLSearchParams(location.search);
const zone = params.get('zone') ?? 'bldg-d-f1';
const canvas = document.getElementById('c') as HTMLCanvasElement;

const raster = (await fetch(`/interior/${zone}.json`).then(r => r.json())) as RasterInterior;

const handle = createInteriorWalkScene({
  canvas,
  // polygonPath 专用字段：raster 在场时不会读取，给最小合法形状即可
  data: { outline: [], bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, rooms: [] },
  spawn: { position: { x: 0, z: 0 }, yaw: 0 },
  raster,
  movementState: { forward: false, backward: false, left: false, right: false, sprint: false },
});

(window as unknown as Record<string, unknown>).__walk = handle;
(window as unknown as Record<string, unknown>).__probeReady = true;
