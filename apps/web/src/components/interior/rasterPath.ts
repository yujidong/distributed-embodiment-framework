/**
 * Raster path (preferred): walls/floor/room tints/labels/devices/deploy
 * ghost + dollhouse toggle, all from the extracted plan-mask data.
 *
 * R90 clean-roam pass:
 * - collision-free roaming (Matterport-style): the primary activities are
 *   looking and placing IoT devices — wall/floor colliders cost experience
 *   (stuck states) and are gone; walls are VISUAL only, simplified by
 *   wallCleanup (merge collinear strips, drop noise fragments);
 * - devices sync in place (syncDevices) instead of rebuilding the scene;
 * - deploy ghost resolves the crosshair ray against the floor plane even at
 *   level pitch, and tints red outside the walkable plates;
 * - Sims-style wall cutaway (H) for readable interiors + matte wall material;
 * - room/device labels are distance-culled (nearest N) instead of piling up;
 * - spawn falls back to the largest floor plate (interior by construction),
 *   not labels[0] (which can sit in the drawing margin).
 */

import {
  ActionManager,
  ArcRotateCamera,
  Color3,
  DirectionalLight,
  Engine,
  ExecuteCodeAction,
  Mesh,
  MeshBuilder,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  UniversalCamera,
  Vector3,
} from '@babylonjs/core';

import { Rectangle, TextBlock } from '@babylonjs/gui';

import {
  baseScene,
  EYE_HEIGHT,
  finish,
  makeGui,
  roomLabelCard,
  walkCamera,
} from './sceneShared';
import { footstep } from './audio';
import { isOpenHallRaster, wallEnvelope } from './openHall';
import { resolveHintedSpawn } from '../../lib/interior3d/spawn';
import { roomLabelText } from '../../lib/interior3d/labels';
import { simplifyWalls, type WallBox } from './wallCleanup';
import type {
  DeployKind,
  InteriorDevice,
  InteriorWalkSceneHandle,
  InteriorWalkSceneOptions,
} from './types';

/** 距离裁剪：步行时同屏最多显示最近 N 张房间/设备标签（经典游戏 declutter 做法） */
const MAX_ROOM_CARDS = 8;
const MAX_DEVICE_CARDS = 6;
/** H 键墙体透视比例（腰高墙，Sims 墙体下翻模式） */
const CUTAWAY_SCALE = 0.35;

type CardRef = { card: Rectangle; mesh: Mesh };

export function createFromRaster(opts: InteriorWalkSceneOptions): InteriorWalkSceneHandle {
  const raster = opts.raster as NonNullable<InteriorWalkSceneOptions['raster']>;
  const canvas = opts.canvas;
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = baseScene(engine);

  const wallHeight = raster.wallHeight || 2.6;
  // UX-W4: runtime rasters (no plan underlay) carry top-level width/height.
  const wM = raster.plan?.width ?? raster.width ?? 150;
  const hM = raster.plan?.height ?? raster.height ?? 110;
  const floorBoxes = raster.floor;

  // 行走碰撞地台：墙包络整体一块（隐形）。地板条板拼图会产生内部接缝 ——
  // 椭球恰好与接缝平面相切时（出生/走位压在条板边界上），Babylon 碰撞器
  // 判每步水平位移为碰撞（实测全向 0.04m 卡死）。视觉地板仍是图纸平面，
  // canPlace/出生逻辑继续用 raster.floor 数据，只是碰撞不走条板。
  //（floorBoxes 仍用于 placeable() 与家具避让；此变量保留占位说明）

  // campus yard: 参照地面（室外也有落点与远景，门洞外不再是虚空）。
  // 用薄盒子而非平面：顶面碰撞稳定，椭球不会与平面贴在碰撞 epsilon 边界上
  const yardSize = Math.max(wM, hM) * 4 + 300;
  const yard = MeshBuilder.CreateBox('yard', { width: yardSize, height: 0.1, depth: yardSize }, scene);
  const yardMat = new StandardMaterial('yardMat', scene);
  yardMat.diffuseColor = new Color3(0.55, 0.63, 0.47);
  yardMat.specularColor = new Color3(0.02, 0.02, 0.02);
  yard.material = yardMat;
  yard.position.set(wM / 2, -0.1, hM / 2);

  // plan-textured walking surface — walls sit on their own plan lines
  if (raster.plan) {
    const ground = MeshBuilder.CreateGround('planTex', { width: wM, height: hM }, scene);
    const tex = new Texture(`/interior/${raster.plan.file}`, scene);
    tex.vScale = -1; // drawing north edge at -z
    tex.level = 0.82; // 压暗图纸白底，俯视不再过曝
    const mat = new StandardMaterial('planMat', scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex; // 自发光：走廊阴影里图纸依然可读
    mat.emissiveColor = new Color3(0.72, 0.72, 0.72);
    mat.diffuseColor = new Color3(0.32, 0.32, 0.32);
    mat.specularColor = new Color3(0.01, 0.01, 0.01);
    ground.material = mat;
    ground.position.set(wM / 2, 0.005, hM / 2);
    // 地面不参与碰撞：椭球底与平面正好压在碰撞 epsilon 边界，重力平衡下
    // 每一步水平位移都会被判成碰撞（实测全向 0.04m）；行走碰撞面 = 地板板
    ground.checkCollisions = false;
  }

  // 建筑包络（墙盒 bbox）：flood 泄漏会让 plates 覆盖率暴跌（D-4F 实测 16%），
  // 放置门禁需要与 plates 无关的兜底 —— 包络内且不在墙体里即可放置
  const wallBbox = wallEnvelope(raster.walls);
  // 开放大厅回退（R97，B1 停车场式大空间）：rooms/floor 为空且"墙体"是密集
  // 图纸线杂（车位线误识别，包络覆盖率 >40%，正常层 3~6%）——内部线杂不砌，
  // 只保留外周包络墙，空间仍可读；放置/出生判定同步走包络（详见 openHall.ts）
  const openHall = isOpenHallRaster(raster);
  const perimeterWalls = (): WallBox[] => {
    if (!wallBbox) return [];
    const t = 0.3;
    const cx = (wallBbox.minX + wallBbox.maxX) / 2;
    const cz = (wallBbox.minZ + wallBbox.maxZ) / 2;
    const w = wallBbox.maxX - wallBbox.minX + t;
    const d = wallBbox.maxZ - wallBbox.minZ + t;
    return [
      [cx, wallBbox.minZ, w, t],
      [cx, wallBbox.maxZ, w, t],
      [wallBbox.minX, cz, t, d],
      [wallBbox.maxX, cz, t, d],
    ];
  };

  // 墙包络碰撞地台（真实可行走区由墙决定；视觉地板 = 图纸平面）
  // 墙体清理：共线条带合并、平行双线合一、孤立碎片丢弃（详见 wallCleanup）
  // UX-W4：运行时栅格的 polygon 周界墙已是干净的旋转盒——绕过清理管线
  // （轴合并会丢 rot），直接拼在清理结果后。
  const doorPts = (raster.doors ?? []).map(([x, z]) => [x, z] as [number, number]);
  const preRotated = raster.walls.filter(w => w[4] !== undefined);
  const axisWalls = raster.walls.filter(w => w[4] === undefined);
  const wallBoxes = openHall
    ? perimeterWalls()
    : [...simplifyWalls(axisWalls, doorPts), ...preRotated];

  // walls: visual only（无碰撞漫游 —— 墙是空间语言，不是障碍）
  const buildWallMesh = (): Mesh | null => {
    const meshes: Mesh[] = [];
    for (const [cx, cz, w, d, rot] of wallBoxes) {
      const seg = MeshBuilder.CreateBox(
        `w-${cx}-${cz}`,
        { width: w, height: wallHeight, depth: d },
        scene,
      );
      seg.position.set(cx, wallHeight / 2, cz);
      // 弧/斜墙（R94）：rot 是平面角（x→z），Babylon rotation.y 取反
      // （rotation.y=α 把 +X 映到 (cosα, -sinα)）。MergeMeshes 烘世界矩阵。
      if (rot) {
        seg.rotation.y = -rot;
        seg.computeWorldMatrix(true);
      }
      meshes.push(seg);
    }
    if (meshes.length === 0) return null;
    const merged = Mesh.MergeMeshes(meshes, true, true);
    if (merged) merged.name = 'wallsVis';
    return merged;
  };
  const wallVis = buildWallMesh();
  const wallMat = new StandardMaterial('wallMat', scene);
  wallMat.diffuseColor = new Color3(0.58, 0.6, 0.65);
  wallMat.specularColor = new Color3(0.04, 0.04, 0.04);
  if (wallVis) wallVis.material = wallMat;
  let cutaway = true; // 默认腰高墙：一眼读出房间布局，H 恢复全高
  const applyCutaway = () => {
    if (wallVis) wallVis.scaling.y = cutaway ? CUTAWAY_SCALE : 1;
  };
  applyCutaway();

  // pastel room tints — floor-zone color blocks (low-poly archviz 做法：
  // 地面分区色读房间功能；0.05m 高避免了竖向玻璃叠层的锯齿与视线暗带)
  const roomMats = new Map<string, StandardMaterial>();
  const pastelFallback = new Map<string, Color3>();
  const hasPlates = floorBoxes.length > 0;
  const onPlate = (x: number, z: number): boolean => {
    if (!hasPlates) return true;
    for (const [cx, cz, w, d] of floorBoxes) {
      if (Math.abs(x - cx) <= w / 2 && Math.abs(z - cz) <= d / 2) return true;
    }
    return false;
  };
  // 建筑包络 wallBbox 已在墙体构建前算出（开放大厅判定也要用）
  const inWallBox = (x: number, z: number): boolean => {
    for (const [cx, cz, w, d] of raster.walls) {
      if (Math.abs(x - cx) < w / 2 && Math.abs(z - cz) < d / 2) return true;
    }
    return false;
  };
  // 房间补丁/家具的保留判定：plates 覆盖率可能因 flood 泄漏很低，
  // 只要落在墙包络内就保留（真正的边距杂块在包络外，仍被过滤）
  const inEnvelope = (x: number, z: number): boolean => {
    if (onPlate(x, z)) return true;
    if (!wallBbox) return true;
    return x >= wallBbox.minX && x <= wallBbox.maxX && z >= wallBbox.minZ && z <= wallBbox.maxZ;
  };
  const placeable = (x: number, z: number): boolean => {
    if (onPlate(x, z)) return true;
    if (!wallBbox) return true;
    const within =
      x >= wallBbox.minX && x <= wallBbox.maxX && z >= wallBbox.minZ && z <= wallBbox.maxZ;
    // 开放大厅：内部线杂墙已不砌，包络内即可放置
    if (openHall) return within;
    return within && !inWallBox(x, z);
  };
  for (const room of raster.rooms ?? []) {
    const meshes: Mesh[] = [];
    for (const [cx, cz, w, d] of room.boxes) {
      // 边距杂散区域过滤：房间补丁必须落在建筑包络内
      if (!inEnvelope(cx, cz)) continue;
      const patch = MeshBuilder.CreateBox(
        `rz-${room.code}-${cx}-${cz}`,
        // +0.02 重叠：消除行程条带之间的拼缝条纹
        { width: w + 0.02, height: 0.05, depth: d + 0.02 },
        scene,
      );
      patch.position.set(cx, 0.025, cz);
      meshes.push(patch);
    }
    if (meshes.length === 0) continue;
    const merged = Mesh.MergeMeshes(meshes, true, true);
    if (!merged) continue;
    merged.name = `roomzone-${room.code}`;
    merged.isPickable = false;
    const mat = new StandardMaterial(`roomMat-${room.code}`, scene);
    mat.diffuseColor = new Color3(room.color[0], room.color[1], room.color[2]);
    mat.alpha = 0.45; // 地面分区色：第一人称斜视角下也可读
    mat.backFaceCulling = false;
    merged.material = mat;
    roomMats.set(room.code, mat);
    pastelFallback.set(room.code, new Color3(room.color[0], room.color[1], room.color[2]));
  }

  // --- 功能化家具套件（低模游戏的做法：用剪影原型而非贴图表达功能） ---
  // 房间语义名（zone.rooms）按关键词选套件：实验室=长实验台、会议室=大桌、
  // 办公=工位排、教室=课桌阵、机房=机柜排… 未命名房间退回随机散块。
  // 套件家具参与碰撞（沿墙/居中布局，不堵门口）；随机散块不碰撞。
  type KitKind = 'lab' | 'meeting' | 'office' | 'classroom' | 'shop' | 'rack' | 'dining' | 'random';
  const kitFor = (rawName: string): KitKind => {
    const n = rawName.toLowerCase();
    if (/lab|实验|bench|工作台/.test(n)) return 'lab';
    if (/会议|研讨|meeting|conference/.test(n)) return 'meeting';
    if (/办公|office|工位|工作室|行政|学院|室$/.test(n)) return 'office';
    if (/教室|class|阶梯|lecture|报告/.test(n)) return 'classroom';
    if (/店|shop|retail|便利|超市|展示/.test(n)) return 'shop';
    if (/机房|机电|配电|设备|机械|server|机柜/.test(n)) return 'rack';
    if (/餐|dining|cafe|咖啡|canteen|食堂|厨房/.test(n)) return 'dining';
    return 'random';
  };
  const furnWood = new StandardMaterial('furnWood', scene);
  furnWood.diffuseColor = new Color3(0.66, 0.55, 0.4);
  furnWood.specularColor = new Color3(0.03, 0.03, 0.03);
  const furnMetal = new StandardMaterial('furnMetal', scene);
  furnMetal.diffuseColor = new Color3(0.55, 0.58, 0.62);
  const furnDark = new StandardMaterial('furnDark', scene);
  furnDark.diffuseColor = new Color3(0.26, 0.28, 0.32);
  const furnSoft = new StandardMaterial('furnSoft', scene);
  furnSoft.diffuseColor = new Color3(0.45, 0.55, 0.65);
  // 门板专用（比家具木色略深）：独立桶 → 不参与碰撞，虚掩门板不挡门洞
  const furnDoor = new StandardMaterial('furnDoor', scene);
  furnDoor.diffuseColor = new Color3(0.5, 0.36, 0.24);
  furnDoor.specularColor = new Color3(0.03, 0.03, 0.03);
  const furnBuckets = new Map<StandardMaterial, Mesh[]>();
  const put = (mat: StandardMaterial, mesh: Mesh) => {
    mesh.material = mat;
    mesh.isPickable = false;
    const bucket = furnBuckets.get(mat) ?? [];
    bucket.push(mesh);
    furnBuckets.set(mat, bucket);
  };
  const box = (w: number, h: number, d: number, x: number, y: number, z: number): Mesh => {
    const m = MeshBuilder.CreateBox('f', { width: w, height: h, depth: d }, scene);
    m.position.set(x, y, z);
    return m;
  };
  const furnSeedRand = (seed: number) => {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  let furnSeed = 0;
  for (const room of raster.rooms ?? []) {
    const boxes = room.boxes.filter(([cx, cz]) => inEnvelope(cx, cz));
    if (boxes.length === 0) continue;
    // 房间范围 = 行程条带的包围盒
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [cx, cz, w, d] of boxes) {
      minX = Math.min(minX, cx - w / 2); maxX = Math.max(maxX, cx + w / 2);
      minZ = Math.min(minZ, cz - d / 2); maxZ = Math.max(maxZ, cz + d / 2);
    }
    const rw = maxX - minX;
    const rd = maxZ - minZ;
    // 小房间不塞带碰撞的套件（家具会封死出生点与走位）—— 退回无碰撞散块
    const kind: KitKind =
      Math.min(rw, rd) < 3.2 || rw * rd < 12 ? 'random' : kitFor(opts.roomNames?.[room.code] ?? '');
    if (kind === 'random') {
      // 未命名房间：保持旧的随机散块（不碰撞）
      const count = Math.min(6, 2 + Math.floor(boxes.length / 6));
      for (let i = 0; i < count; i++) {
        const bx = boxes[Math.floor(furnSeedRand(furnSeed + i * 7.3) * boxes.length)];
        const w = 0.5 + furnSeedRand(furnSeed + i * 13.7) * 0.8;
        const d = 0.4 + furnSeedRand(furnSeed + i * 21.3) * 0.5;
        const h = 0.38 + furnSeedRand(furnSeed + i * 5.1) * 0.25;
        const jx = bx[0] + (furnSeedRand(furnSeed + i * 31.7) - 0.5) * bx[2] * 0.4;
        const jz = bx[1] + (furnSeedRand(furnSeed + i * 43.3) - 0.5) * bx[3] * 0.4;
        put(furnWood, box(w, h, d, jx, h / 2, jz));
      }
      furnSeed += 100;
      continue;
    }
    // 可用内区（离墙 0.5m）
    const ix0 = minX + 0.5, ix1 = maxX - 0.5, iz0 = minZ + 0.5, iz1 = maxZ - 0.5;
    const iw = Math.max(0.8, ix1 - ix0);
    const id = Math.max(0.8, iz1 - iz0);
    let icx = (ix0 + ix1) / 2;
    let icz = (iz0 + iz1) / 2;
    const alongX = rw >= rd;
    // 避让出生锚点：房间标签 pin 1.2m 内不放家具 —— 整套家具沿长轴平移
    // （?room= 深链出生在标签附近，不能被桌子卡在墙角）
    for (const l of raster.labels) {
      if (l.x < minX || l.x > maxX || l.z < minZ || l.z > maxZ) continue;
      if (Math.hypot(l.x - icx, l.z - icz) >= 1.2) continue;
      const shift = 1.25;
      if (alongX) {
        const sign = l.x > icx ? -1 : 1;
        icx = Math.min(Math.max(icx + sign * shift, ix0 + 0.3), ix1 - 0.3);
      } else {
        const sign = l.z > icz ? -1 : 1;
        icz = Math.min(Math.max(icz + sign * shift, iz0 + 0.3), iz1 - 0.3);
      }
      break;
    }
    if (kind === 'lab') {
      // 两条平行实验台 + 圆凳
      const benchLen = Math.max(1.2, (alongX ? iw : id) - 0.6);
      for (const side of [-1, 1]) {
        const bx = alongX ? icx : icx + side * Math.min(1.1, iw / 4);
        const bz = alongX ? icz + side * Math.min(1.1, id / 4) : icz;
        put(furnMetal, alongX ? box(benchLen, 0.08, 0.8, bx, 0.86, bz) : box(0.8, 0.08, benchLen, bx, 0.86, bz));
        put(furnDark, alongX ? box(benchLen, 0.78, 0.7, bx, 0.43, bz) : box(0.7, 0.78, benchLen, bx, 0.43, bz));
      }
      put(furnWood, box(0.5, 0.04, 0.5, icx, 0.94, icz)); // 台面仪器
    } else if (kind === 'meeting') {
      const tLen = Math.max(1.2, (alongX ? iw : id) - 0.8);
      put(furnWood, alongX ? box(tLen, 0.07, 1.1, icx, 0.74, icz) : box(1.1, 0.07, tLen, icx, 0.74, icz));
      put(furnMetal, alongX ? box(tLen - 0.6, 0.68, 0.5, icx, 0.35, icz) : box(0.5, 0.68, tLen - 0.6, icx, 0.35, icz));
      const chairs = Math.min(6, Math.max(4, Math.floor(tLen / 0.9)));
      for (let c = 0; c < chairs; c++) {
        const off = (c / (chairs - 1) - 0.5) * (tLen - 0.8);
        const cxx = alongX ? icx + off : icx + (c % 2 === 0 ? -0.95 : 0.95);
        const czz = alongX ? icz + (c % 2 === 0 ? -0.95 : 0.95) : icz + off;
        put(furnSoft, box(0.42, 0.5, 0.42, cxx, 0.28, czz));
      }
    } else if (kind === 'office') {
      const desks = Math.min(4, Math.max(2, Math.floor((alongX ? iw : id) / 1.5)));
      for (let k = 0; k < desks; k++) {
        const off = (k / Math.max(1, desks - 1) - 0.5) * (alongX ? iw - 1.4 : id - 1.4);
        const dx = alongX ? icx + off : icx;
        const dz = alongX ? icz : icz + off;
        put(furnWood, box(1.3, 0.05, 0.65, dx, 0.73, dz));
        put(furnMetal, box(1.1, 0.68, 0.5, dx, 0.35, dz));
        put(furnSoft, alongX ? box(0.42, 0.85, 0.42, dx, 0.45, dz + 0.62) : box(0.42, 0.85, 0.42, dx + 0.62, 0.45, dz));
      }
    } else if (kind === 'classroom') {
      const rows = Math.min(3, Math.max(2, Math.floor(id / 1.6)));
      const cols = Math.min(3, Math.max(2, Math.floor(iw / 1.3)));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const dx = icx + (c / Math.max(1, cols - 1) - 0.5) * (iw - 1);
          const dz = iz0 + 0.7 + r * ((id - 1.2) / Math.max(1, rows - 1 || 1));
          put(furnWood, box(0.75, 0.05, 0.55, dx, 0.72, dz));
          put(furnMetal, box(0.6, 0.68, 0.45, dx, 0.36, dz));
        }
      }
    } else if (kind === 'shop') {
      const shelves = Math.min(3, Math.max(2, Math.floor((alongX ? iw : id) / 2.2)));
      for (let s = 0; s < shelves; s++) {
        const off = (s / Math.max(1, shelves - 1) - 0.5) * (alongX ? iw - 1.6 : id - 1.6);
        put(furnMetal, alongX ? box(1.7, 1.8, 0.42, icx + off, 0.9, icz) : box(0.42, 1.8, 1.7, icx, 0.9, icz + off));
      }
    } else if (kind === 'rack') {
      const rows = 2;
      const perRow = Math.min(4, Math.max(2, Math.floor((alongX ? iw : id) / 1.1)));
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < perRow; k++) {
          const off = (k / Math.max(1, perRow - 1) - 0.5) * (alongX ? iw - 1 : id - 1);
          const rx = alongX ? icx + off : icx + (r === 0 ? -0.6 : 0.6);
          const rz = alongX ? icz + (r === 0 ? -0.6 : 0.6) : icz + off;
          put(furnDark, box(0.6, 2.05, 0.9, rx, 1.03, rz));
        }
      }
    } else if (kind === 'dining') {
      const tables = Math.min(4, Math.max(2, Math.floor((alongX ? iw : id) / 2)));
      for (let tIdx = 0; tIdx < tables; tIdx++) {
        const off = (tIdx / Math.max(1, tables - 1) - 0.5) * (alongX ? iw - 1.6 : id - 1.6);
        const tx = alongX ? icx + off : icx;
        const tz = alongX ? icz : icz + off;
        const tbl = MeshBuilder.CreateCylinder(`f-${room.code}-t${tIdx}`, { diameter: 0.85, height: 0.74 }, scene);
        tbl.position.set(tx, 0.37, tz);
        put(furnWood, tbl);
        put(furnSoft, box(0.36, 0.46, 0.36, tx + 0.7, 0.23, tz));
      }
    } else {
      const count = 3;
      for (let i = 0; i < count; i++) {
        put(furnWood, box(0.7, 0.6 + furnSeedRand(furnSeed + i) * 0.4, 0.55, icx + (furnSeedRand(furnSeed + i * 3.1) - 0.5) * iw * 0.5, 0.35, icz + (furnSeedRand(furnSeed + i * 5.7) - 0.5) * id * 0.5));
      }
      furnSeed += 100;
    }
  }
  // 家具/门板一律不参与碰撞：房间行程 bbox 高估真实房间（条带外溢），
  // 家具碰撞会把出生点困死（实测 D-4021 全向 0.04m）。行走碰撞世界 =
  // 墙 + 地板板；穿桌是可接受的软瑕疵，困住是硬失败。
  const kitMeshes: Mesh[] = [];
  for (const [, meshes] of furnBuckets) {
    if (meshes.length === 0) continue;
    const merged = Mesh.MergeMeshes(meshes, true, true);
    if (!merged) continue;
    merged.isPickable = false;
    kitMeshes.push(merged);
  }

  // 门洞地垫：雕刻门洞处的琥珀色地标（经典游戏用色块门毯标出可通行处）
  if ((raster.doors?.length ?? 0) > 0) {
    const matQuads: Mesh[] = [];
    (raster.doors ?? []).forEach(([dx, dz], i) => {
      const q = MeshBuilder.CreateGround(`doormat-${i}`, { width: 1.0, height: 1.0 }, scene);
      q.position.set(dx, 0.012, dz);
      matQuads.push(q);
    });
    const mergedMats = Mesh.MergeMeshes(matQuads, true, true);
    if (mergedMats) {
      mergedMats.name = 'doorMats';
      const dmMat = new StandardMaterial('doorMatMat', scene);
      dmMat.diffuseColor = new Color3(1, 0.72, 0.3);
      dmMat.emissiveColor = new Color3(0.3, 0.19, 0.05);
      dmMat.alpha = 0.5;
      dmMat.backFaceCulling = false;
      mergedMats.material = dmMat;
      mergedMats.isPickable = false;
    }
  }

  // 天花板 + 灯带网格（archviz 惯例）：单面朝下 —— 第一人称抬头有顶，
  // dollhouse 俯视因背面剔除自动消失；不加入阴影投射器，室内保持假光照
  if (wallBbox) {
    const cw = wallBbox.maxX - wallBbox.minX;
    const cd = wallBbox.maxZ - wallBbox.minZ;
    const ccx = (wallBbox.minX + wallBbox.maxX) / 2;
    const ccz = (wallBbox.minZ + wallBbox.maxZ) / 2;
    const ceil = MeshBuilder.CreateGround('ceiling', { width: cw, height: cd }, scene);
    ceil.rotation.x = Math.PI; // 法线朝下
    ceil.position.set(ccx, wallHeight - 0.02, ccz);
    const ceilMat = new StandardMaterial('ceilMat', scene);
    ceilMat.diffuseColor = new Color3(0.88, 0.89, 0.92);
    ceilMat.emissiveColor = new Color3(0.3, 0.3, 0.33); // 自发光提亮，室内不发闷
    ceilMat.specularColor = new Color3(0.02, 0.02, 0.02);
    ceil.material = ceilMat;
    ceil.isPickable = false;
    // 灯带：~7m 网格的发光面板（自发光，无实光源 —— 低模游戏的假光做法）
    const panelMeshes: Mesh[] = [];
    for (let gx = wallBbox.minX + 3.5; gx < wallBbox.maxX - 1; gx += 7) {
      for (let gz = wallBbox.minZ + 3.5; gz < wallBbox.maxZ - 1; gz += 7) {
        const p = MeshBuilder.CreateGround(`lightpanel-${gx.toFixed(0)}-${gz.toFixed(0)}`, { width: 1.9, height: 0.7 }, scene);
        p.rotation.x = Math.PI;
        p.position.set(gx, wallHeight - 0.07, gz);
        panelMeshes.push(p);
      }
    }
    if (panelMeshes.length > 0) {
      const mergedPanels = Mesh.MergeMeshes(panelMeshes, true, true);
      if (mergedPanels) {
        mergedPanels.name = 'lightPanels';
        const pm = new StandardMaterial('lightPanelMat', scene);
        pm.emissiveColor = new Color3(1.0, 0.98, 0.88);
        pm.diffuseColor = new Color3(0.2, 0.2, 0.2);
        pm.disableLighting = true;
        mergedPanels.material = pm;
        mergedPanels.isPickable = false;
      }
    }
  }

  // 门框 + 半开门板（Gone Home/Firewatch 的"虚掩门"语言：开口方向与
  // 可通行性一眼可读）。朝向取自宿主墙盒的长轴，开角/开启侧按门点哈希
  // 变化避免整层门一个姿态。门板不参与碰撞，导航路径不受影响。
  if ((raster.doors?.length ?? 0) > 0) {
    const doorDirIsX = (x: number, z: number): boolean => {
      for (const [cx, cz, w, d] of raster.walls) {
        if (
          x >= cx - w / 2 - 0.35 && x <= cx + w / 2 + 0.35 &&
          z >= cz - d / 2 - 0.35 && z <= cz + d / 2 + 0.35
        ) {
          return w >= d;
        }
      }
      return true;
    };
    const leafMeshes: Mesh[] = [];
    (raster.doors ?? []).forEach((door, i) => {
      const [dx, dz] = door;
      // 运行时栅格自带门洞朝向（宿主墙轴向）；预烘焙仍靠宿主墙盒探测
      const alongX = door[2] ? door[2] === 'x' : doorDirIsX(dx, dz);
      const hash = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const openA = 0.96 + hash * 0.5; // 55°~84° 虚掩
      const side = hash > 0.5 ? 1 : -1;
      const LEAF_W = 0.92;
      const LEAF_H = 2.02;
      // 门框：两根门柱 + 上亮楣
      const jambW = alongX ? 0.1 : 0.18;
      const jambD = alongX ? 0.18 : 0.1;
      for (const s of [-1, 1]) {
        put(furnDark, box(jambW, LEAF_H + 0.08, jambD, dx + (alongX ? s * 0.51 : 0), (LEAF_H + 0.08) / 2, dz + (alongX ? 0 : s * 0.51)));
      }
      put(furnDark, alongX
        ? box(1.12, wallHeight - LEAF_H - 0.08, 0.16, dx, LEAF_H + 0.08 + (wallHeight - LEAF_H - 0.08) / 2, dz)
        : box(0.16, wallHeight - LEAF_H - 0.08, 1.12, dx, LEAF_H + 0.08 + (wallHeight - LEAF_H - 0.08) / 2, dz));
      // 门板：铰链在门洞一侧边缘，绕铰链旋开 openA
      const hx = alongX ? dx - (LEAF_W / 2) * 1 : dx;
      const hz = alongX ? dz : dz - (LEAF_W / 2);
      const leafDirX = alongX ? Math.cos(openA) : side * Math.sin(openA);
      const leafDirZ = alongX ? side * Math.sin(openA) : Math.cos(openA);
      const leaf = MeshBuilder.CreateBox(`doorleaf-${i}`, { width: LEAF_W, height: LEAF_H, depth: 0.055 }, scene);
      leaf.position.set(hx + leafDirX * (LEAF_W / 2), LEAF_H / 2, hz + leafDirZ * (LEAF_W / 2));
      leaf.rotation.y = Math.atan2(-leafDirZ, leafDirX);
      put(furnDoor, leaf);
      leafMeshes.push(leaf);
      // 门把手（小深色块，提升读法）
      const knob = MeshBuilder.CreateBox(`doorknob-${i}`, { width: 0.05, height: 0.05, depth: 0.12 }, scene);
      knob.position.set(
        hx + leafDirX * (LEAF_W - 0.12) - (alongX ? 0 : 0.05),
        1.02,
        hz + leafDirZ * (LEAF_W - 0.12) - (alongX ? 0.05 : 0),
      );
      put(furnDark, knob);
      leafMeshes.push(knob);
    });
    // 门板/门框已经 put() 进材质桶，随家具统一合并
    void leafMeshes;
  }

  // 软阴影：仅硬件 GL 开启（SwiftShader/llvmpipe 软渲染下代价过高）
  const sun = scene.lights.find(l => l.name === 'sun') as DirectionalLight | undefined;
  const softwareRender = (() => {
    try {
      const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      return /swiftshader|llvmpipe|software/i.test(renderer);
    } catch {
      return true;
    }
  })();
  if (sun && !softwareRender && wallVis) {
    const shadows = new ShadowGenerator(1024, sun);
    shadows.useBlurExponentialShadowMap = true;
    shadows.blurKernel = 8;
    shadows.darkness = 0.32;
    shadows.addShadowCaster(wallVis);
    for (const m of kitMeshes) shadows.addShadowCaster(m);
    const planGround = scene.getMeshByName('planTex');
    if (planGround) planGround.receiveShadows = true;
    yard.receiveShadows = true;
  }

  // spawn: hinted room marker → largest floor plate center（室内 by
  // construction；labels[0] 可能落在图纸边距图例旁，已废弃该回退）。
  // 板候选必须落在墙包络内 —— flood 泄漏会在图纸边距生成杂散板口袋
  const hint = opts.codeHint ? raster.labels.find(l => l.code === opts.codeHint) : undefined;
  let anchor: { x: number; z: number };
  let anchorPlate: [number, number, number, number] | null = null;
  if (hint) {
    anchor = { x: hint.x, z: hint.z };
  } else {
    let best: { plate: [number, number, number, number]; area: number } | null = null;
    for (const [cx, cz, w, d] of floorBoxes) {
      if (wallBbox) {
        const withinEnv =
          cx >= wallBbox.minX && cx <= wallBbox.maxX && cz >= wallBbox.minZ && cz <= wallBbox.maxZ;
        if (!withinEnv) continue;
      }
      const area = w * d;
      if (!best || area > best.area) best = { plate: [cx, cz, w, d], area };
    }
    anchor = best ? { x: best.plate[0], z: best.plate[1] } : { x: wM / 2, z: hM / 2 };
    anchorPlate = best?.plate ?? null;
  }
  const center = new Vector3(wM / 2, 0, hM / 2);
  const dxc = center.x - anchor.x;
  const dzc = center.z - anchor.z;
  // 唯一的出生约束是视觉性的：别把相机放进墙体盒子里（无碰撞漫游，
  // 墙体只是视觉 —— 但镜头在墙里会满屏灰）
  // 旋转盒取保守轴对齐包围（出生检查只需别把相机放进墙体，略大无妨）
  const inSolidWall = (x: number, z: number): boolean =>
    wallBoxes.some(([cx, cz, w, d, rot]) => {
      if (!rot) return Math.abs(x - cx) < w / 2 && Math.abs(z - cz) < d / 2;
      const c = Math.abs(Math.cos(rot));
      const s = Math.abs(Math.sin(rot));
      return Math.abs(x - cx) < (w * c + d * s) / 2 && Math.abs(z - cz) < (w * s + d * c) / 2;
    });
  // R2-BUG-02：提示房间出生 = anchor 朝楼心一侧 4m、面朝房间标记（纯函数
  // lib/interior3d/spawn.ts）。修复前 yaw 背对楼心 + backOff 把出生点推到
  // anchor 楼外侧 —— 相机出生在楼外又面朝楼外，1F 首屏只剩天空与草地。
  let spawn: { x: number; z: number };
  let yaw: number;
  if (hint) {
    const resolved = resolveHintedSpawn(anchor, { x: center.x, z: center.z }, inSolidWall);
    spawn = { x: resolved.x, z: resolved.z };
    yaw = resolved.yaw;
  } else {
    // 板心出生：原地（板心室内 by construction，无需墙内松弛）
    spawn = { x: anchor.x, z: anchor.z };
    // 朝向（R95）：板心出生沿 plate 长轴 + 净空更大的一侧（走廊/大厅纵深
    // 视角 —— 首屏即见连续墙体纵深，而不是面向空旷庭院）。净空 = 沿方向
    // 步进到首个墙盒的距离（旋转盒保守 AABB）。
    if (anchorPlate) {
      const [, , pw, pd] = anchorPlate;
      const ax = pw >= pd ? 1 : 0;
      const az = pw >= pd ? 0 : 1;
      const clearance = (sx: number, sz: number): number => {
        for (let t = 0.5; t <= 40; t += 0.5) {
          if (inSolidWall(spawn.x + ax * sx * t, spawn.z + az * sz * t)) return t;
        }
        return 40;
      };
      const fwd = clearance(1, 1);
      const bwd = clearance(-1, -1);
      // 平手时偏向面向建筑中心的一侧
      const centerSign = dxc * ax + dzc * az >= 0 ? 1 : -1;
      const sign = fwd === bwd ? centerSign : fwd > bwd ? 1 : -1;
      yaw = Math.atan2(ax * sign, az * sign);
    } else {
      // 无地板板（退化栅格）：面朝楼心
      yaw = Math.atan2(dxc, dzc);
    }
  }
  const position = new Vector3(spawn.x, EYE_HEIGHT, spawn.z);
  // 移除 Babylon 内置键盘（方向键默认绑视角旋转导致乱跳）
  // 自定义移动控制器在 onBeforeRenderObservable 中手动计算移动向量
  const camera = walkCamera(scene, canvas, position, yaw);
  camera.inputs.removeByType('KeyboardInputElement');
  camera.speed = 0;
  camera.inertia = 0;
  camera.applyGravity = false;
  camera.checkCollisions = false;


  // --- 自定义移动控制器（经典 FPS 手感） ---
  // 水平移动 = 射线滑行（ray-cast movement，Minecraft/WoW 式）：三道体高
  // 标准射线探墙，命中则单轴滑行。不走 camera._collideWithWorld —— 实测
  // Babylon 9 该路径在"任意碰撞体存在"时会把位移吞成 ~1%（重试预算被
  // 贴地擦碰耗尽），且 cameraDirection 已被重定义为原始输入通道。
  // 垂直（重力/落地）仍走引擎原生路径：needMoveForGravity + applyGravity。
  // 手感三件套（Quake/HL 式）：速度指数趋近（ACCEL/s）起步刹车有重量；
  // 头部随步频正弦浮动（振幅克制防晕动，落脚点触发程序化脚步声）；
  // 疾跑 FOV 轻推（Halo/CoD 的速度感）。
  const MOVE_SPEED = 2.2; // m/s
  const SPRINT_MUL = 1.8;
  const ACCEL = 12; // 速度趋近速率（1/s）
  const BOB_AMP = 0.032; // 头部浮动振幅（m）
  const STRIDE = 0.78; // 步幅（m）→ 步频随速度
  const moveState = opts.movementState;
  let velX = 0;
  let velZ = 0;
  let bobPhase = 0;
  let bobOffset = 0;
  let prevBobSin = 0;
  const baseFov = camera.fov;
  // 平面范围限制（防走飞）
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    if (dt <= 0 || dt > 0.5) return;
    const yaw = camera.rotation.y;
    let mx = 0, mz = 0;
    if (moveState.forward) { mx += Math.sin(yaw); mz += Math.cos(yaw); }
    if (moveState.backward) { mx -= Math.sin(yaw); mz -= Math.cos(yaw); }
    if (moveState.left) { mx += Math.cos(yaw); mz -= Math.sin(yaw); }
    if (moveState.right) { mx -= Math.cos(yaw); mz += Math.sin(yaw); }
    const len = Math.hypot(mx, mz);
    const speed = MOVE_SPEED * (moveState.sprint ? SPRINT_MUL : 1);
    const targetVX = len > 0 ? (mx / len) * speed : 0;
    const targetVZ = len > 0 ? (mz / len) * speed : 0;
    const k = 1 - Math.exp(-ACCEL * dt);
    velX += (targetVX - velX) * k;
    velZ += (targetVZ - velZ) * k;
    // 无碰撞写入（探索优先）；限制在图纸周边一定范围
    camera.position.x = clamp(camera.position.x + velX * dt, -30, wM + 30);
    camera.position.z = clamp(camera.position.z + velZ * dt, -30, hM + 30);

    const hs = Math.hypot(velX, velZ);
    if (hs > 0.15) {
      bobPhase += (hs / STRIDE) * Math.PI * 2 * dt;
      const s = Math.sin(bobPhase);
      const gait = Math.min(1, hs / MOVE_SPEED);
      // 只向上抬（≥5mm）：向下压会让椭球陷入地台 —— 碰撞器不去穿透，
      // 陷入后一切水平位移被拒绝（玩家原地卡死）
      bobOffset = 0.005 + Math.abs(s) * BOB_AMP * gait;
      camera.rotation.z = Math.sin(bobPhase * 0.5) * 0.0035; // 轻微侧摆
      if (prevBobSin > 0 && s <= 0) footstep(gait); // 波谷 = 脚落地
      prevBobSin = s;
    } else {
      bobOffset *= Math.exp(-10 * dt);
      camera.rotation.z *= Math.exp(-10 * dt);
      prevBobSin = 0;
    }
    camera.position.y = EYE_HEIGHT + bobOffset; // 高度恒定（无重力）

    const sprintFov = baseFov + (moveState.sprint && hs > MOVE_SPEED * 0.9 ? 0.07 : 0);
    camera.fov += (sprintFov - camera.fov) * Math.min(1, dt * 6);
  });

  // room pins + labels（labelTexts 注册供实时温度读数更新）
  const gui = makeGui(scene);
  const pylonMat = new StandardMaterial('pinMat', scene);
  pylonMat.diffuseColor = new Color3(1, 0.48, 0.27);
  const actionManager = new ActionManager(scene);
  const labelTexts = new Map<string, TextBlock>();
  // R2-FEAT-12: code → 显示名（实时刷新重建文本时用同一规则，id 不裸显）
  const labelDisplay = new Map<string, string>();
  const roomCards: CardRef[] = [];
  for (const label of raster.labels) {
    const pin = MeshBuilder.CreateCylinder(
      `room-${label.code}`,
      { diameter: 0.16, height: 1.4, tessellation: 10 },
      scene,
    );
    pin.position.set(label.x, 0.7, label.z);
    pin.material = pylonMat;
    pin.actionManager = actionManager;
    pin.actionManager.registerAction(
      new ExecuteCodeAction(ActionManager.OnPickTrigger, () => opts.onRoomPick?.(label.code)),
    );
    const text = new TextBlock();
    const display = roomLabelText(label);
    labelDisplay.set(label.code, display);
    text.text = display;
    text.color = '#25324a';
    text.fontSize = 22;
    text.fontFamily = 'Inter, system-ui, sans-serif';
    text.resizeToFit = true;
    text.paddingLeft = '6px';
    text.paddingRight = '6px';
    labelTexts.set(label.code, text);
    const card = roomLabelCard(gui, pin, label.code, text);
    roomCards.push({ card, mesh: pin });
  }

  // IoT devices — mesh 表 + 增量同步（不再依赖场景重建）
  const matOn = new StandardMaterial('devOn', scene);
  matOn.diffuseColor = new Color3(0.3, 0.85, 0.45);
  matOn.emissiveColor = new Color3(0.08, 0.3, 0.12);
  const matOff = new StandardMaterial('devOff', scene);
  matOff.diffuseColor = new Color3(0.5, 0.56, 0.66);
  let devices: InteriorDevice[] = [...(opts.devices ?? [])];
  const deviceEntries = new Map<string, { mesh: Mesh; card: Rectangle; text: TextBlock }>();
  const deviceCards: CardRef[] = [];
  const upsertDevice = (d: InteriorDevice) => {
    const isSensor = d.type.includes('sensor') || d.type.includes('counter');
    let entry = deviceEntries.get(d.id);
    if (!entry) {
      const dev = MeshBuilder.CreateBox(
        `device-${d.id}`,
        isSensor ? { width: 0.22, height: 0.3, depth: 0.12 } : { width: 0.7, height: 0.5, depth: 0.35 },
        scene,
      );
      dev.isPickable = false;
      const text = new TextBlock();
      text.fontSize = 18;
      text.resizeToFit = true;
      const card = new Rectangle();
      card.thickness = 1;
      card.color = 'rgba(255,255,255,0.9)';
      card.background = 'rgba(13,17,23,0.82)';
      card.adaptWidthToChildren = true;
      card.adaptHeightToChildren = true;
      card.cornerRadius = 4;
      card.addControl(text);
      gui.addControl(card); // 先挂根再 link（见 roomLabelCard 注释）
      card.linkWithMesh(dev);
      card.linkOffsetY = -40;
      entry = { mesh: dev, card, text };
      deviceEntries.set(d.id, entry);
      deviceCards.push({ card, mesh: dev });
    }
    entry.mesh.position.set(d.x, isSensor ? 1.5 : 0.25, d.z);
    entry.mesh.material = d.on ? matOn : matOff;
    entry.text.text = `${d.on ? '●' : '○'} ${d.name}`;
    entry.text.color = d.on ? '#4ade80' : '#94a3b8';
  };
  const syncDevicesImpl = (next: InteriorDevice[]) => {
    const keep = new Set(next.map(d => d.id));
    for (const [id, entry] of deviceEntries) {
      if (keep.has(id)) continue;
      entry.mesh.dispose();
      gui.removeControl(entry.card);
      deviceEntries.delete(id);
      const idx = deviceCards.findIndex(r => r.card === entry.card);
      if (idx >= 0) deviceCards.splice(idx, 1);
    }
    for (const d of next) upsertDevice(d);
    devices = [...next];
  };
  for (const d of devices) upsertDevice(d);

  // deploy ghost: 准星射线与地平面求交（平视时取前方 3m），落在可行走
  // 地板上呈蓝色、楼外/墙体上呈红色且拒绝放置（base-builder 惯例）
  let ghost: Mesh | null = null;
  let ghostMat: StandardMaterial | null = null;
  let ghostRing: Mesh | null = null;
  let ghostPos = { x: position.x, z: position.z };
  let canPlace = false;
  let deployKind: DeployKind | null = opts.deployKind ?? null;
  const GHOST_OK = new Color3(0.3, 0.7, 1);
  const GHOST_OK_E = new Color3(0.15, 0.35, 0.5);
  const GHOST_BAD = new Color3(1, 0.38, 0.32);
  const GHOST_BAD_E = new Color3(0.45, 0.14, 0.1);
  const ensureGhost = () => {
    if (ghost) return;
    ghost = MeshBuilder.CreateCylinder(
      'deployGhost',
      { diameter: 0.5, height: 0.9, tessellation: 16 },
      scene,
    );
    ghostMat = new StandardMaterial('ghostMat', scene);
    ghostMat.alpha = 0.5;
    ghost.material = ghostMat;
    ghost.isPickable = false;
    // 感知覆盖环：放置即见设备语义覆盖范围（IoT 半径 8m）
    ghostRing = MeshBuilder.CreateTorus(
      'ghostRing',
      { diameter: 16, thickness: 0.06, tessellation: 48 },
      scene,
    );
    const ringMat = new StandardMaterial('ghostRingMat', scene);
    ringMat.diffuseColor = new Color3(0.3, 0.7, 1);
    ringMat.emissiveColor = new Color3(0.12, 0.3, 0.42);
    ringMat.alpha = 0.16;
    ghostRing.material = ringMat;
    ghostRing.isPickable = false;
    const follow = () => {
      if (!ghost || !deployKind || !ghostMat) return;
      const cam = scene.activeCamera;
      if (!cam) return;
      const dir = cam.getForwardRay().direction;
      let t: number;
      if (Math.abs(dir.y) > 0.08) t = (0.9 - cam.position.y) / dir.y;
      else t = 3; // 平视：俯仰无关的固定前方定位
      if (t <= 0 || t > 30) t = 3;
      ghostPos = { x: cam.position.x + dir.x * t, z: cam.position.z + dir.z * t };
      ghost.position.set(ghostPos.x, 0.45, ghostPos.z);
      if (ghostRing) ghostRing.position.set(ghostPos.x, 0.03, ghostPos.z);
      canPlace = placeable(ghostPos.x, ghostPos.z);
      ghostMat.diffuseColor = canPlace ? GHOST_OK : GHOST_BAD;
      ghostMat.emissiveColor = canPlace ? GHOST_OK_E : GHOST_BAD_E;
    };
    scene.onBeforeRenderObservable.add(follow);
  };
  const setDeployKindImpl = (kind: DeployKind | null) => {
    deployKind = kind;
    if (kind) {
      ensureGhost();
      ghost?.setEnabled(true);
      ghostRing?.setEnabled(true);
    } else {
      ghost?.setEnabled(false);
      ghostRing?.setEnabled(false);
    }
  };
  if (deployKind) setDeployKindImpl(deployKind);

  // V key: dollhouse orbit ↔ first person
  const orbit = new ArcRotateCamera(
    'orbit',
    -Math.PI / 2 + 0.5,
    0.72,
    Math.max(wM, hM) * 0.85,
    center,
    scene,
  );
  let orbitMode = false;
  const setOrbit = (on: boolean) => {
    orbitMode = on;
    if (on) {
      document.exitPointerLock?.();
      camera.detachControl();
      orbit.attachControl(canvas, true);
      scene.activeCamera = orbit;
    } else {
      orbit.detachControl();
      camera.attachControl(canvas, true);
      scene.activeCamera = camera;
    }
  };
  const onKeyV = (e: KeyboardEvent) => { if (e.key !== 'v' && e.key !== 'V') return; setOrbit(!orbitMode); };
  window.addEventListener('keydown', onKeyV);

  // H key: 墙体透视开关（The Sims walls-down；碰撞高度不变）
  const onKeyH = (e: KeyboardEvent) => {
    if (e.key !== 'h' && e.key !== 'H') return;
    cutaway = !cutaway;
    applyCutaway();
  };
  window.addEventListener('keydown', onKeyH);

  // click: first click locks the pointer; while locked, click places the
  // ghosted device (deploy mode) — game-consistent build interaction
  const tryPlace = (): boolean => {
    if (!deployKind || !opts.onPlace) return false;
    // 拒绝时给页面一个反馈通道（R97：此前瞄无效位置按 E/点击完全静默）
    if (!canPlace) {
      opts.onPlaceRejected?.();
      return false;
    }
    opts.onPlace(ghostPos.x, ghostPos.z);
    return true;
  };
  const onClick = () => {
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
      return;
    }
    tryPlace();
  };
  canvas.addEventListener('click', onClick);

  // 实时叠加：房间材质着色 + 标签牌追加读数（°C / 👥occupancy / ⚠告警）
  const tempColor = (t: number): Color3 => {
    const clamp = Math.min(1, Math.max(0, (t - 18) / 12));
    if (clamp < 0.5) {
      const k = clamp / 0.5;
      return new Color3(0.3 + k * 0.15, 0.5 + k * 0.25, 0.9 - k * 0.45);
    }
    const k = (clamp - 0.5) / 0.5;
    return new Color3(0.45 + k * 0.45, 0.75 - k * 0.4, 0.45 - k * 0.15);
  };
  // UX-W4 live state：applyTemps 只写温度（兼容旧调用），applyLiveOverlay
  // 全量写；两类入口汇合到同一个 renderLive，全部原地材质/文本写回。
  const liveState = { tempC: null as number | null, occupancy: null as number | null, alert: false };
  const renderLive = () => {
    for (const [code, mat] of roomMats) {
      const pastel =
        pastelFallback.get(code) ?? new Color3(0.8, 0.8, 0.8);
      // 温度以 35% 混入身份色：全楼同温时房间仍是可辨识的 pastel，
      // 温差出现时整体偏向冷暖
      mat.diffuseColor =
        liveState.tempC !== null ? Color3.Lerp(pastel, tempColor(liveState.tempC), 0.35) : pastel;
      if (!liveState.alert && mat.emissiveColor.r !== 0) {
        mat.emissiveColor.set(0, 0, 0);
      }
    }
    for (const [code, text] of labelTexts) {
      let s = labelDisplay.get(code) ?? code;
      if (liveState.tempC !== null) s += `  ${liveState.tempC.toFixed(1)}°C`;
      if (liveState.occupancy !== null) s += ` · 👥${liveState.occupancy}`;
      text.text = liveState.alert ? `⚠ ${s}` : s;
    }
  };
  const applyTempsImpl = (tempC: number | null) => {
    liveState.tempC = tempC;
    renderLive();
  };
  const applyLiveOverlayImpl = (overlay: {
    tempC: number | null;
    occupancy: number | null;
    co2: number | null;
    alert: boolean;
  }) => {
    // co2 走 E 卡片（标签牌再放就糊了）；此处只驱动 tint/标签/告警脉冲
    liveState.tempC = overlay.tempC;
    liveState.occupancy = overlay.occupancy;
    liveState.alert = overlay.alert;
    renderLive();
  };
  // 告警红脉冲：房间色块 emissive 呼吸（材质原地写，无重建）
  scene.onBeforeRenderObservable.add(() => {
    if (!liveState.alert) return;
    const k = 0.16 + 0.12 * Math.sin(performance.now() / 280);
    for (const [, mat] of roomMats) mat.emissiveColor.set(k, k * 0.12, k * 0.1);
  });

  // 目的地信标（Forza/Firewatch 式目标光柱）：穿墙可见的竖直光柱 + 地面环
  let beacon: { x: number; z: number } | null = null;
  const beaconBeam = MeshBuilder.CreateCylinder(
    'beaconBeam',
    { diameterTop: 0.25, diameterBottom: 0.6, height: 40, tessellation: 12 },
    scene,
  );
  const beaconRing = MeshBuilder.CreateTorus(
    'beaconRing',
    { diameter: 2.2, thickness: 0.08, tessellation: 40 },
    scene,
  );
  const beaconMat = new StandardMaterial('beaconMat', scene);
  beaconMat.emissiveColor = new Color3(0.15, 0.8, 0.95);
  beaconMat.diffuseColor = new Color3(0.1, 0.5, 0.6);
  beaconMat.alpha = 0.3;
  beaconMat.backFaceCulling = false;
  beaconBeam.material = beaconMat;
  beaconRing.material = beaconMat;
  beaconBeam.isPickable = false;
  beaconRing.isPickable = false;
  beaconBeam.isVisible = false;
  beaconRing.isVisible = false;
  const setBeaconImpl = (pos: { x: number; z: number } | null) => {
    beacon = pos;
    beaconBeam.isVisible = beaconRing.isVisible = pos !== null;
    if (pos) {
      beaconBeam.position.set(pos.x, 20, pos.z);
      beaconRing.position.set(pos.x, 0.05, pos.z);
    }
  };
  const getBeaconPosImpl = () => (beacon ? { ...beacon } : null);

  // 在场化身：驻守本层的仿真 Agent（引擎无个体坐标，managedZoneIds 是
  // 静态职责 —— 化身语义 = "该层的驻守管理者"）。差分创建/移除，位置
  // 向目标渐变插值（4s 轮询的跳变被时间常数抹平），站立微呼吸浮动。
  const presence = new Map<string, { mesh: Mesh; card: Rectangle; target: { x: number; z: number }; phase: number }>();
  const presenceCards: CardRef[] = [];
  const presenceMat = new StandardMaterial('presenceMat', scene);
  presenceMat.diffuseColor = new Color3(0.16, 0.55, 0.62);
  presenceMat.emissiveColor = new Color3(0.04, 0.18, 0.22);
  const setPresenceImpl = (list: Array<{ id: string; name: string; x: number; z: number }>) => {
    const keep = new Set(list.map(p => p.id));
    for (const [id, ref] of presence) {
      if (keep.has(id)) continue;
      ref.mesh.dispose();
      gui.removeControl(ref.card);
      const idx = presenceCards.findIndex(r => r.card === ref.card);
      if (idx >= 0) presenceCards.splice(idx, 1);
      presence.delete(id);
    }
    for (const p of list) {
      let ref = presence.get(p.id);
      if (!ref) {
        const mesh = MeshBuilder.CreateCapsule(`presence-${p.id}`, { radius: 0.26, height: 1.68 }, scene);
        mesh.position.set(p.x, 0.84, p.z);
        mesh.material = presenceMat;
        mesh.isPickable = false;
        const text = new TextBlock();
        text.text = `◆ ${p.name}`;
        text.color = '#a5f3fc';
        text.fontSize = 16;
        text.resizeToFit = true;
        const card = new Rectangle();
        card.thickness = 1;
        card.color = 'rgba(165,243,252,0.75)';
        card.background = 'rgba(8,47,56,0.85)';
        card.adaptWidthToChildren = true;
        card.adaptHeightToChildren = true;
        card.cornerRadius = 4;
        card.addControl(text);
        gui.addControl(card);
        card.linkWithMesh(mesh);
        card.linkOffsetY = -52;
        ref = { mesh, card, target: { x: p.x, z: p.z }, phase: Math.random() * 6.28 };
        presence.set(p.id, ref);
        presenceCards.push({ card, mesh });
      }
      ref.target = { x: p.x, z: p.z };
    }
  };
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    if (dt <= 0 || dt > 0.5) return;
    for (const ref of presence.values()) {
      const k = Math.min(1, dt * 1.2);
      ref.mesh.position.x += (ref.target.x - ref.mesh.position.x) * k;
      ref.mesh.position.z += (ref.target.z - ref.mesh.position.z) * k;
      ref.phase += dt;
      ref.mesh.position.y = 0.84 + Math.sin(ref.phase * 1.7) * 0.02;
    }
  });

  // 近距设备查询（handle 与高亮循环共用）
  const nearestDevice = (maxDist: number): InteriorDevice | null => {
    const cam = scene.activeCamera;
    if (!cam) return null;
    let best: InteriorDevice | null = null;
    let bestDist = maxDist;
    for (const d of devices) {
      const dist = Math.hypot(d.x - cam.position.x, d.z - cam.position.z);
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    return best;
  };

  // 标签距离裁剪（150ms 节流）：步行只看最近几张，俯视全显
  let cullAcc = 0;
  let highlightId: string | null = null;
  const highlightMat = matOn.clone('devHighlight');
  scene.onBeforeRenderObservable.add(() => {
    cullAcc += engine.getDeltaTime();
    if (cullAcc < 150) return;
    cullAcc = 0;
    const cam = scene.activeCamera;
    if (!cam) return;
    const cull = (refs: CardRef[], max: number) => {
      const sorted = refs
        .map(r => ({
          r,
          d: (r.mesh.position.x - cam.position.x) ** 2 + (r.mesh.position.z - cam.position.z) ** 2,
        }))
        .sort((a, b) => a.d - b.d);
      sorted.forEach((s, i) => { s.r.card.isVisible = i < max; });
    };
    if (orbitMode) {
      // 俯视也做上限裁剪：61 张卡同屏糊成一片，最近 24 张足够读图
      cull(roomCards, 24);
      cull(deviceCards, 12);
      cull(presenceCards, 10);
      return;
    }
    cull(roomCards, MAX_ROOM_CARDS);
    cull(deviceCards, MAX_DEVICE_CARDS);
    cull(presenceCards, 4);
    // 近距设备高亮（可交互物的游戏惯例）：进入 3m 半径提亮，离开还原
    const nearId = nearestDevice(3)?.id ?? null;
    if (nearId !== highlightId) {
      if (highlightId) {
        const prev = deviceEntries.get(highlightId);
        if (prev) prev.mesh.material = devices.find(d => d.id === highlightId)?.on ? matOn : matOff;
      }
      highlightId = nearId;
    }
    if (highlightId) {
      const entry = deviceEntries.get(highlightId);
      const dev = devices.find(d => d.id === highlightId);
      if (entry && dev) {
        entry.mesh.material = highlightMat;
        const base = dev.on ? matOn : matOff;
        highlightMat.diffuseColor = base.diffuseColor.scale(1.25);
        highlightMat.emissiveColor = base.emissiveColor.add(new Color3(0.12, 0.12, 0.1));
      }
    }
  });

  let disposed = false;
  engine.runRenderLoop(() => {
    if (!disposed) scene.render();
  });
  const onResize = () => engine.resize();
  window.addEventListener('resize', onResize);

  // 恢复步行相机为活跃相机（orbit 创建可能覆盖）
  scene.activeCamera = camera;

  return finish(
    {
      scene,
      openHall,
      pickAtCenter() {
        if (orbitMode) return null;
        const pick = scene.pick(canvas.clientWidth / 2, canvas.clientHeight / 2, mesh =>
          mesh.name.startsWith('room-'),
        );
        const mesh = pick?.pickedMesh;
        return pick?.hit && mesh ? mesh.name.replace(/^room-/, '') : null;
      },
      placeAtCenter() {
        return tryPlace();
      },
      pickNearestDevice(maxDist: number) {
        return nearestDevice(maxDist);
      },
      applyTemps: applyTempsImpl,
      applyLiveOverlay: applyLiveOverlayImpl,
      syncDevices: syncDevicesImpl,
      setDeployKind: setDeployKindImpl,
      setBeacon: setBeaconImpl,
      getBeaconPos: getBeaconPosImpl,
      setPresence: setPresenceImpl,
      getCameraPos() {
        const cam = scene.activeCamera as UniversalCamera;
        return { x: cam.position.x, z: cam.position.z, yaw: cam.rotation.y };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        window.removeEventListener('resize', onResize);
        window.removeEventListener('keydown', onKeyV);
        window.removeEventListener('keydown', onKeyH);
        canvas.removeEventListener('click', onClick);
        gui.dispose();
        scene.dispose();
        engine.dispose();
      },
    },
    undefined,
  );
}
