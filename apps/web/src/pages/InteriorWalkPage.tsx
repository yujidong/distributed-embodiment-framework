/**
 * InteriorWalkPage — R82: the game-like first-person interior with IoT
 * deploy mode.
 *
 * Route: /environments/:envId/walk?zone=<zoneId>[&room=<code>]
 * (the same ?zone deep-link convention the world page uses).
 *
 * - Walk: WASD + pointer lock, floor rail teleports between storeys, E
 *   inspects the crosshair target (room or device), V toggles dollhouse.
 * - Deploy: pick a device kind in the palette → a ghost follows the
 *   crosshair → click (or E) places it → a real device lands in the env
 *   at those coordinates (geo-tier position, zone resolved from the
 *   placement). E near a placed device toggles it (sim command).
 */

import { ArrowLeft, Building2, Footprints, Wrench, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import { floorLabeling } from '../lib/buildings';
import { footprintFrame, type PlanGeoMapping } from '../lib/interior3d/geoPlan';
import { rasterFromMapData } from '../lib/interior3d/rasterFromMapData';
import { resolveWalkBuilding } from '../lib/interior3d/resolveWalkBuilding';
import { roomLabelText } from '../lib/interior3d/labels';
import { assembleRoomCard, roomOfRaster } from '../lib/interior3d/roomLiveCard';
import type { RasterInterior } from '../components/interior/types';
import { createInteriorWalkScene, type InteriorWalkSceneHandle } from '../components/interior/InteriorWalkScene';
import { Loading } from '../components/ui/Loading';
import { drawingBboxFor } from '../lib/interior3d/deployCatalog';
import {
  FALLBACK_DEVICE_TEMPLATES,
  filterDeviceTemplates,
  groupDeviceTemplatesByCategory,
  templateToDeployKind,
} from '../lib/deviceTemplates';
import { useDeviceTemplates } from '../hooks/useDeviceTemplates';
import { useInteriorDeploy } from '../hooks/useInteriorDeploy';
import { useInteriorSimSnapshot } from '../hooks/useInteriorSimSnapshot';
import { toggleMuted, unlockAudio } from '../components/interior/audio';

/** 操作指南持久化：确认过一次后不再弹出。 */
const ONBOARDING_KEY = 'eaf.walk.onboarded.v1';

/**
 * 场景句柄别名：就地同步方法（syncDevices/setDeployKind/setBeacon…）已并入
 * InteriorWalkSceneHandle 本体，全部为可选 —— 句柄未实现时页面安全跳过。
 */
type WalkSceneHandle = InteriorWalkSceneHandle;

export function InteriorWalkPage() {
  const { envId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation('interiorWalk');
  const zoneParam = searchParams.get('zone');
  const roomParam = searchParams.get('room') ?? undefined;

  const [env, setEnv] = useState<Awaited<ReturnType<typeof api.getEnvironment>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // room code
  const [pickedDeviceId, setPickedDeviceId] = useState<string | null>(null);
  const [raster, setRaster] = useState<RasterInterior | null>(null);
  // 操作指南只在首次访问展示（localStorage 持久化；隐私模式/异常时回退为展示）
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (typeof localStorage === 'undefined') return true;
    try {
      return localStorage.getItem(ONBOARDING_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const [pointerLocked, setPointerLocked] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<WalkSceneHandle | null>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const planImgRef = useRef<HTMLImageElement | null>(null);
  // 准星提示只缓存设备 id；新鲜设备对象每次渲染从 deploy.devices 解析
  const [promptDeviceId, setPromptDeviceId] = useState<string | null>(null);
  const [floor, setFloor] = useState<number | null>(null);
  // 目的地信标（Enter 搜索房间投放）+ 搜索面板 + 音效开关提示
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [beaconRoom, setBeaconRoom] = useState<{ code: string; name: string; x: number; z: number } | null>(null);
  const [beaconDist, setBeaconDist] = useState<number | null>(null);
  const [reachedFlash, setReachedFlash] = useState(false);
  const [soundChip, setSoundChip] = useState<string | null>(null);
  // R97: 开放大厅（无房间数据楼层）提示 + 部署放置失败反馈（准星无效 /
  // 服务端拒绝 —— DEPLOY-F1 按失败类型分文案）
  const [openHall, setOpenHall] = useState(false);
  type PlaceFailKind = 'invalid' | 'forbidden' | 'error' | 'unavailable';
  const [placeFail, setPlaceFail] = useState<PlaceFailKind | null>(null);
  const flashPlaceFail = (kind: PlaceFailKind) => {
    setPlaceFail(kind);
    window.setTimeout(() => setPlaceFail(null), 1800);
  };

  // UX-W3: the deploy palette comes from GET /api/device-templates (73+
  // registry entries, grouped by category + searchable); an unreachable API
  // honestly degrades to the small static wordlist (note shown in the rail).
  const { templates: deployTemplates, degraded: deployDegraded } = useDeviceTemplates();
  const palette = useMemo(
    () => (deployTemplates.length > 0 ? deployTemplates : FALLBACK_DEVICE_TEMPLATES),
    [deployTemplates],
  );
  const deployKinds = useMemo(() => palette.map(templateToDeployKind), [palette]);
  const [deployQuery, setDeployQuery] = useState('');
  const deployGroups = useMemo(
    () => groupDeviceTemplatesByCategory(filterDeviceTemplates(palette, deployQuery)),
    [palette, deployQuery],
  );

  // fetch env once
  useEffect(() => {
    let alive = true;
    api
      .getEnvironment(envId)
      .then(detail => {
        if (alive) setEnv(detail);
      })
      .catch(e => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [envId]);

  // R2-BUG-01: 楼栋推导回落链抽成纯函数 lib/interior3d/resolveWalkBuilding.ts
  // （hinted zone → rooms-pos 楼 → 首个有 buildingId 的楼 → 全部 zone 合成
  // 伪楼栋），参数化模板/生成器/OSM/starter-home 不再 building=null 永转圈。
  // 稳定性关键：memo 以 zone 结构签名为依赖 —— 设备放置会 setEnv(新对象)，
  // 若按 env 身份重建 memo，scene 会跟着重建并把相机弹回出生点。
  const zoneSig = env
    ? env.zones
        .map(z =>
          [
            z.id,
            z.buildingId ?? '',
            z.floor ?? 0,
            (z.rooms ?? []).map(r => (Array.isArray(r.pos) ? 1 : 0)).join(''),
          ].join(':'),
        )
        .join(',')
    : '';
  const building = useMemo(
    () => (env ? resolveWalkBuilding(env.zones, zoneParam) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoneSig 覆盖 zone 结构变化
    [zoneSig, zoneParam],
  );

  // F4: an unknown (or building-less) ?zone= falls back to the resolved
  // building — surface the fallback and correct the URL to the zone actually
  // shown (replace: no history litter). R2-BUG-01: 校正目标由回落链给出
  // （fallbackZoneId），不再只认 rooms-pos 楼。
  const fallbackZone = useMemo(() => {
    if (!building || !zoneParam || !building.fallbackZoneId) return null;
    return building.zones.find(z => z.id === building.fallbackZoneId) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoneSig 覆盖 zone 结构变化
  }, [zoneSig, zoneParam]);
  const [zoneNotice, setZoneNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!fallbackZone || !zoneParam) return;
    setZoneNotice(zoneParam);
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        next.set('zone', fallbackZone.id);
        return next;
      },
      { replace: true },
    );
  }, [fallbackZone, zoneParam, setSearchParams]);
  useEffect(() => {
    if (zoneNotice === null) return;
    const timer = window.setTimeout(() => setZoneNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [zoneNotice]);

  // R101: same ONE labeling source as the world map's floor switcher.
  const floorLabels = useMemo(
    () => floorLabeling(building?.floors.map(f => f.zone) ?? [], t('floorOutdoor')),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoneSig 覆盖 zone 集合变化
    [building, t],
  );

  const current = building?.floors.find(f => f.floor === floor) ?? null;

  // default floor: the hinted one, else the floor with the most rooms
  useEffect(() => {
    if (!building || floor !== null) return;
    const hintedFloor = zoneParam ? building.floors.find(f => f.zone.id === zoneParam) : undefined;
    if (hintedFloor) {
      setFloor(hintedFloor.floor);
      return;
    }
    const best = [...building.floors].sort(
      (a, b) => (b.zone.rooms?.length ?? 0) - (a.zone.rooms?.length ?? 0),
    )[0];
    setFloor(best?.floor ?? 0);
  }, [building, floor, zoneParam]);

  // raster walls for this floor: pre-baked plan raster wins (Taicang guide
  // buildings); UX-W4 — every other environment gets a runtime raster
  // synthesized from map_data (rasterFromMapData). The scene build waits
  // for the pre-baked fetch to settle so Taicang floors don't flash the
  // runtime raster first.
  const [prebakedSettled, setPrebakedSettled] = useState(false);
  useEffect(() => {
    if (floor === null || !building) return;
    const entry = building.floors.find(f => f.floor === floor);
    if (!entry) return;
    let alive = true;
    setRaster(null);
    setPrebakedSettled(false);
    fetch(`/interior/${entry.zone.id}.json`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(data => {
        if (!alive) return;
        setRaster(data);
        setPrebakedSettled(true);
      })
      .catch(() => {
        if (!alive) return;
        setRaster(null);
        setPrebakedSettled(true);
      });
    return () => {
      alive = false;
    };
  }, [floor, building]);

  // UX-W4 runtime raster, cached by zone-STRUCTURE signature: device
  // placement refetches env (same zone content → same signature → no
  // rebuild); zone/room/bounds edits change the signature → re-rasterize.
  const zoneStructSig = useMemo(
    () =>
      env
        ? JSON.stringify(
            env.zones.map(z => [
              z.id,
              z.buildingId ?? null,
              z.floor ?? 0,
              z.polygon ?? null,
              z.bounds ?? null,
              z.rooms ?? null,
              z.adjacentZoneIds ?? null,
            ]),
          )
        : '',
    [env],
  );
  const runtime = useMemo(() => {
    if (!env || !building || floor === null) return null;
    return rasterFromMapData(building.zones, building.buildingId, floor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoneStructSig 覆盖 zone 结构变化
  }, [zoneStructSig, floor, building]);
  const floorRaster: RasterInterior | null = raster ?? runtime?.raster ?? null;

  // 小地图底图预载（运行时栅格无图纸 —— 小地图改画墙体/房间色块）
  useEffect(() => {
    if (!floorRaster?.plan) {
      planImgRef.current = null;
      return;
    }
    const img = new Image();
    img.src = `/interior/${floorRaster.plan.file}`;
    img.onload = () => {
      planImgRef.current = img;
    };
  }, [floorRaster]);

  // plan ↔ geo mapping: drawing bbox (this floor) + footprint frame;
  // UX-W4: runtime rasters carry an exact direct frame instead.
  const geoMapping: PlanGeoMapping | null = useMemo(() => {
    if (!building) return null;
    const ground = building.floors.find(f => f.floor === 0) ?? building.floors[0];
    if (!ground?.zone.polygon) return null;
    const frame = footprintFrame(ground.zone.polygon);
    if (floorRaster?.drawingBbox && floorRaster.imagePx && typeof floorRaster.mpp === 'number') {
      return {
        bbox: { x: floorRaster.drawingBbox.x, y: floorRaster.drawingBbox.y },
        mpp: floorRaster.mpp,
        frame,
      };
    }
    if (!raster && runtime?.geoMapping) return runtime.geoMapping;
    const bbox = drawingBboxFor(building.buildingId, floor ?? 0);
    if (!bbox) return null;
    return { bbox: { x: bbox.x, y: bbox.y }, mpp: bbox.mpp, frame };
  }, [building, floor, floorRaster, raster, runtime]);

  // 自定义移动控制器按键状态
  const moveState = useRef({ forward: false, backward: false, left: false, right: false, sprint: false });

  // R82 phase 2: IoT deploy state machine (palette/ghost/place/toggle)
  const deploy = useInteriorDeploy({
    envId, env, setEnv, current, geoMapping,
    onPlaceFailed: kind => flashPlaceFail(kind),
    onPlaceUnavailable: () => flashPlaceFail('unavailable'),
  });

  // R82: live simulation overlay — zone readings / alerts / events
  const simOverlay = useInteriorSimSnapshot(envId);
  const zoneLive = useMemo(() => {
    if (!current) return null;
    const id = current.zone.id;
    return {
      tempC: simOverlay.tempByZone[id] ?? null,
      co2: simOverlay.co2ByZone[id] ?? null,
      occupancy: simOverlay.occupancyByZone[id] ?? null,
      alert: Boolean(simOverlay.alertByZone[id]),
    };
  }, [simOverlay, current]);
  const floorTemp = zoneLive?.tempC ?? null;

  // 房间语义名（功能化家具按名称关键词选套件）
  const roomNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of current?.zone.rooms ?? []) m[r.code ?? r.name] = r.name;
    return m;
  }, [current]);

  // 在场化身：驻守当前层的仿真 Agent（managedZoneIds 含本层即驻守），
  // 按 agent id 哈希散布到本层房间锚点，确定性 placement 轮询间不跳动
  const presenceList = useMemo(() => {
    if (simOverlay.agents.length === 0 || !current || !floorRaster || floorRaster.labels.length === 0) return [];
    const zoneId = current.zone.id;
    const anchors = floorRaster.labels;
    return simOverlay.agents
      .filter(a => a.managedZoneIds.includes(zoneId))
      .slice(0, 10)
      .map(a => {
        let h = 0;
        for (let i = 0; i < a.id.length; i++) h = (h * 31 + a.id.charCodeAt(i)) >>> 0;
        const anchor = anchors[h % anchors.length];
        return { id: a.id, name: a.name, x: anchor.x, z: anchor.z };
      });
  }, [simOverlay.agents, current, floorRaster]);

  // 准星提示设备对象：每次渲染从当前楼层设备表解析（E 开关后提示立即反映新状态）
  const promptDevice = useMemo(
    () => (promptDeviceId ? deploy.devices.find(d => d.id === promptDeviceId) ?? null : null),
    [promptDeviceId, deploy.devices],
  );

  // 指针锁定状态
  useEffect(() => {
    const onLock = () => setPointerLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onLock);
    return () => document.removeEventListener('pointerlockchange', onLock);
  }, []);

  // 步行音效：AudioContext 必须由用户手势创建（点击画布即解锁）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onCanvasClick = () => unlockAudio();
    canvas.addEventListener('click', onCanvasClick);
    return () => canvas.removeEventListener('click', onCanvasClick);
  }, []);

  // 小地图：图纸底图（预烘焙）或墙体/房间色块（运行时栅格）+ 设备点 +
  // 玩家位置（120ms 刷新）
  useEffect(() => {
    if (!floorRaster) return;
    const timer = window.setInterval(() => {
      const cv = minimapRef.current;
      if (!cv) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const wM = floorRaster.plan?.width ?? floorRaster.width ?? 150;
      const hM = floorRaster.plan?.height ?? floorRaster.height ?? 110;
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (planImgRef.current) {
        ctx.drawImage(planImgRef.current, 0, 0, cv.width, cv.height);
      } else {
        // UX-W4: 无图纸楼层画结构——房间色块 + 墙线（旋转盒按保守 AABB 画）
        ctx.fillStyle = '#e8ecf3';
        ctx.fillRect(0, 0, cv.width, cv.height);
        const px = (x: number) => (x / wM) * cv.width;
        const pz = (z: number) => (z / hM) * cv.height;
        for (const room of floorRaster.rooms ?? []) {
          ctx.fillStyle = `rgba(${Math.round(room.color[0] * 255)},${Math.round(room.color[1] * 255)},${Math.round(room.color[2] * 255)},0.55)`;
          for (const [cx, cz, w, d] of room.boxes) {
            ctx.fillRect(px(cx - w / 2), pz(cz - d / 2), (w / wM) * cv.width, (d / hM) * cv.height);
          }
        }
        ctx.fillStyle = 'rgba(90,98,112,0.85)';
        for (const [cx, cz, w, d] of floorRaster.walls) {
          ctx.fillRect(px(cx - w / 2), pz(cz - d / 2), Math.max(1, (w / wM) * cv.width), Math.max(1, (d / hM) * cv.height));
        }
      }
      const px = (x: number) => (x / wM) * cv.width;
      const pz = (z: number) => (z / hM) * cv.height;
      ctx.fillStyle = '#16a34a';
      for (const d of deploy.devices) {
        ctx.beginPath();
        ctx.arc(px(d.x), pz(d.z), 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const pos = sceneRef.current?.getCameraPos();
      if (pos) {
        // 朝向锥替代玩家圆点：世界前向 = (sin yaw, cos yaw)，小地图 x→右、z→下
        ctx.save();
        ctx.translate(px(pos.x), pz(pos.z));
        ctx.rotate(Math.PI - pos.yaw);
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.lineTo(5.5, 6);
        ctx.lineTo(-5.5, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      // 目的地信标：青色菱形星标（Firewatch/Forza 地图锚点惯例）
      if (beaconRoom) {
        ctx.save();
        ctx.translate(px(beaconRoom.x), pz(beaconRoom.z));
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(-4, -4, 8, 8);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-4, -4, 8, 8);
        ctx.restore();
      }
      // 北向指示（图纸北 = 地图上方）
      ctx.fillStyle = 'rgba(37,50,74,0.75)';
      ctx.font = 'bold 10px Inter, system-ui, sans-serif';
      ctx.fillText('N', cv.width / 2 - 3, 11);
    }, 120);
    return () => window.clearInterval(timer);
  }, [floorRaster, floor, deploy.devices, beaconRoom]);

  // 准星交互提示：3m 内设备 → 提示按 E（350ms 轮询，仅在非部署模式）。
  // 轮询只缓存设备 id，对象由渲染期从 deploy.devices 现取（避免显示开关前的旧状态）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (deploy.deployKind) {
        setPromptDeviceId(null);
        return;
      }
      const id = sceneRef.current?.pickNearestDevice(3)?.id ?? null;
      setPromptDeviceId(prev => (prev === id ? prev : id));
    }, 350);
    return () => window.clearInterval(timer);
  }, [deploy.deployKind, deploy.devices]);

  // 楼层快捷键 1-5 + B 键切部署模式（指针锁定时 UI 不可点，键盘是唯一通道）；
  // 部署模式下：数字键 1-4 切换设备类型，Q / ESC 退出。
  // 搜索面板打开时全局游戏键全部让位给输入框。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return; // 输入框已处理（搜索面板 Enter/Esc）
      // UX-W3: 部署面板现在带搜索/命名输入框——焦点在输入框时游戏键全部让位。
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (searchOpen) return;
      if (deploy.deployKind) {
        if (event.key === 'Escape' || event.key === 'q' || event.key === 'Q') {
          deploy.setDeployKind(null);
          return;
        }
        const n = parseInt(event.key, 10);
        const kind =
          n >= 1 && n <= Math.min(4, deployKinds.length) ? deployKinds[n - 1] : undefined;
        if (kind) deploy.setDeployKind({ ...kind });
        return;
      }
      if (!building) return;
      const n = parseInt(event.key, 10);
      if (n >= 1 && n <= building.floors.length) {
        setFloor(building.floors[n - 1].floor);
        return;
      }
      if (event.key === 'b' || event.key === 'B') {
        deploy.setDeployKind(deployKinds[0] ? { ...deployKinds[0] } : null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [building, deploy, searchOpen, deployKinds]);

  // 自定义移动：WASD + 方向键 + Shift 疾跑（Babylon 内置键盘已移除）
  useEffect(() => {
    const MAP: Record<string, string> = {
      w: 'forward', 'arrowup': 'forward',
      s: 'backward', 'arrowdown': 'backward',
      a: 'left', 'arrowleft': 'left',
      d: 'right', 'arrowright': 'right',
      shift: 'sprint',
    };
    const onDown = (e: KeyboardEvent) => {
      const k = MAP[e.key.toLowerCase()];
      if (k) moveState.current[k as keyof typeof moveState.current] = true;
    };
    const onUp = (e: KeyboardEvent) => {
      const k = MAP[e.key.toLowerCase()];
      if (k) moveState.current[k as keyof typeof moveState.current] = false;
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  // 房间搜索（Enter 呼出，经典游戏“按地图设信标”模式：松开指针 → 检索 → 投放）
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (floorRaster?.labels ?? [])
      .filter(l => l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, floorRaster]);

  const placeBeacon = (code: string, name: string, x: number, z: number) => {
    sceneRef.current?.setBeacon?.({ x, z });
    setBeaconRoom({ code, name, x, z });
    setReachedFlash(false);
    setSearchOpen(false);
    setQuery('');
    // 回到第一人称（游戏“关地图即回到画面”）
    canvasRef.current?.requestPointerLock?.();
  };

  // 信标距离 HUD（300ms 轮询）；抵达 2m 内自动清除并闪光提示
  useEffect(() => {
    if (!beaconRoom) return;
    const timer = window.setInterval(() => {
      const pos = sceneRef.current?.getCameraPos();
      if (!pos) return;
      const d = Math.hypot(pos.x - beaconRoom.x, pos.z - beaconRoom.z);
      if (d < 2) {
        sceneRef.current?.setBeacon?.(null);
        setBeaconRoom(null);
        setBeaconDist(null);
        setReachedFlash(true);
        window.setTimeout(() => setReachedFlash(false), 2200);
        return;
      }
      setBeaconDist(d);
    }, 300);
    return () => window.clearInterval(timer);
  }, [beaconRoom]);

  // 楼层切换 / 换楼：信标是本层坐标，必须清除
  useEffect(() => {
    sceneRef.current?.setBeacon?.(null);
    setBeaconRoom(null);
    setBeaconDist(null);
  }, [floor, building]);

  // E key: deploy → place; else nearest device toggle; else room inspect
  const deployRef = useRef(deploy.deployKind);
  deployRef.current = deploy.deployKind;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return; // 输入框已处理（搜索面板 Enter/Esc）
      if (searchOpen) return; // 搜索面板输入时忽略全局游戏键
      if (event.key === 'Enter' && !deployRef.current) {
        document.exitPointerLock?.();
        setSearchOpen(true);
        return;
      }
      if (event.key === 'm' || event.key === 'M') {
        const muted = toggleMuted();
        setSoundChip(muted ? '🔇' : '🔊');
        window.setTimeout(() => setSoundChip(null), 1600);
        return;
      }
      if (event.key !== 'e' && event.key !== 'E') return;
      if (deployRef.current) {
        if (sceneRef.current?.placeAtCenter()) setPicked(null);
        return;
      }
      const device = sceneRef.current?.pickNearestDevice(3);
      if (device) {
        setPickedDeviceId(device.id);
        deploy.toggleDevice(device);
        return;
      }
      const code = sceneRef.current?.pickAtCenter();
      if (code) setPicked(prev => (prev === code ? null : code));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  // ?zone=<id> without ?room=: spawn inside the hinted zone's own room
  // (ux-w4 probe P3③ — the default spawn could land on another zone's room,
  // e.g. the nurse station pin right under your feet).
  const zoneRoomHint = useMemo(() => {
    if (roomParam !== undefined || zoneParam === null || !floorRaster) return undefined;
    const room = floorRaster.rooms?.find(r => r.zoneId === zoneParam);
    return room?.code;
  }, [roomParam, zoneParam, floorRaster]);

  // (re)build the scene on floor change / raster arrival
  // （部署状态不走重建：由下方 syncDevices/setDeployKind 就地同步，避免相机回出生点；
  //   env 不进依赖 —— building 的 zone 签名已覆盖楼层集合变化，设备放置的
  //   setEnv 新对象不得触发重建）
  // R92: 区域缺边界数据时给出显式降级 UI（此前静默 return → 永久"加载中"）
  // UX-W4: 唯一渲染路径 = rasterPath；floorRaster 为 null（zone 无 bounds
  // 且无 polygon）时走显式降级，不再回退 polygon _stub_。场景构建等
  // 预烘焙 fetch 落定（prebakedSettled），太仓楼层不会先闪运行时栅格。
  const [sceneBuildFailed, setSceneBuildFailed] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  // R2-BUG-01: 计时器不再以 building 为前置——真实失败形态（楼栋推导
  // 落空）恰恰需要超时兜底；文案不赖世界会话（漫游渲染不依赖它）。
  useEffect(() => {
    if (!env) return;
    const timer = window.setTimeout(() => setLoadTimedOut(true), 20000);
    return () => window.clearTimeout(timer);
  }, [env]);

  useEffect(() => {
    if (!canvasRef.current || !env || floor === null || !building || !prebakedSettled) return;
    const entry = building.floors.find(f => f.floor === floor);
    if (!entry) return;
    if (!floorRaster) {
      setSceneBuildFailed(true);
      return;
    }
    setSceneBuildFailed(false);
    const handle = createInteriorWalkScene({
      canvas: canvasRef.current,
      raster: floorRaster,
      codeHint: roomParam ?? zoneRoomHint,
      devices: deploy.devices,
      deployKind: deploy.deployKind,
      movementState: moveState.current,
      onPlace: (x, z) => deploy.place(x, z),
      onPlaceRejected: () => {
        // 准星/点击落在不可放置处：短暂闪提示（与到达信标同一 flash 样式）
        flashPlaceFail('invalid');
      },
      onRoomPick: code => setPicked(code),
      roomNames,
    });
    sceneRef.current = handle;
    setOpenHall(handle.openHall === true);
    return () => {
      handle.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- env 仅作加载门卫，签名见 building
  }, [env === null, floor, building, roomParam, zoneRoomHint, floorRaster, roomNames, prebakedSettled]);

  // 部署状态就地同步（场景句柄可选能力；重建效应在文件序上先执行，切层先重建再同步）
  useEffect(() => {
    sceneRef.current?.syncDevices?.(deploy.devices);
  }, [deploy.devices]);
  useEffect(() => {
    sceneRef.current?.setDeployKind?.(deploy.deployKind);
  }, [deploy.deployKind]);
  useEffect(() => {
    sceneRef.current?.setPresence?.(presenceList);
  }, [presenceList]);

  // UX-W4 实时层：读数/告警到达 → 就地叠加（不重建场景）
  useEffect(() => {
    if (!zoneLive) return;
    if (sceneRef.current?.applyLiveOverlay) {
      sceneRef.current.applyLiveOverlay(zoneLive);
    } else {
      sceneRef.current?.applyTemps?.(zoneLive.tempC);
    }
  }, [zoneLive, floor]);

  // UX-W4 HUD toasts：楼内新事件（snapshot.recentDecisions 差分）与告警
  // 进入/恢复 —— 漫游内 HUD 注记，自动消退，不打断移动。
  const [toasts, setToasts] = useState<Array<{ key: number; kind: 'event' | 'alert'; text: string }>>([]);
  const toastSeq = useRef(0);
  const pushToast = (kind: 'event' | 'alert', text: string) => {
    const key = ++toastSeq.current;
    setToasts(prev => [...prev.slice(-2), { key, kind, text }]);
    window.setTimeout(() => setToasts(prev => prev.filter(t => t.key !== key)), 4200);
  };
  const seenEventsRef = useRef<Set<string> | null>(null);
  const prevAlertsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const zoneIds = new Set(building?.floors.map(f => f.zone.id) ?? []);
    const zoneName = (id: string | undefined) =>
      (id && env?.zones.find(z => z.id === id)?.name) || id || '?';
    // 事件差分：首个快照只播种不播报（历史决策不是"发生"）
    const events = simOverlay.recentEvents;
    if (seenEventsRef.current === null) {
      seenEventsRef.current = new Set(events.map(e => e.id));
    } else {
      const seen = seenEventsRef.current;
      const fresh = events.filter(e => !seen.has(e.id));
      seenEventsRef.current = new Set(events.map(e => e.id));
      for (const e of fresh.slice(-3)) {
        if (e.zoneId && zoneIds.size > 0 && !zoneIds.has(e.zoneId)) continue;
        pushToast('event', t('eventToast', { type: e.type, zone: zoneName(e.zoneId) }));
      }
    }
    // 告警进入差分（恢复不再播 —— 退出集合的 zone 下次进入才算新告警）
    const alerting = Object.keys(simOverlay.alertByZone).filter(id => zoneIds.has(id));
    if (prevAlertsRef.current === null) {
      prevAlertsRef.current = new Set(alerting);
    } else {
      const prev = prevAlertsRef.current;
      for (const id of alerting) {
        if (!prev.has(id)) pushToast('alert', t('alertToast', { zone: zoneName(id) }));
      }
      prevAlertsRef.current = new Set(alerting);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pushToast 为 ref 稳定函数
  }, [simOverlay, building, env, t]);

  if (error) {
    return (
      <div className="interior-walk interior-walk--error">
        <p>{error}</p>
        <Link className="link-button" to={`/environments/${envId}`}>
          {t('back')}
        </Link>
      </div>
    );
  }
  // R2-BUG-01: env 已载但没有任何 zone → 显式降级页（此前永久 Loading）。
  if (env && !building) {
    return (
      <div className="interior-walk interior-walk--error">
        <p className="page-note page-note--error">{t('noWalkableZones')}</p>
        <Link className="link-button" to={`/environments/${envId}`}>
          {t('back')}
        </Link>
      </div>
    );
  }
  if (!env || !building || floor === null || !current) {
    return (
      <div className="interior-walk interior-walk--loading">
        <Loading />
        {loadTimedOut && (
          <p className="page-note page-note--error">{t('loadTimedOut')}</p>
        )}
      </div>
    );
  }
  if (sceneBuildFailed) {
    return (
      <div className="interior-walk interior-walk--error">
        <p className="page-note page-note--error">
          {t('sceneDataMissing')}
        </p>
        <Link className="link-button" to={`/environments/${envId}`}>
          {t('back')}
        </Link>
      </div>
    );
  }

  const pickedRoom =
    picked !== null
      ? current.zone.rooms?.find(r => (r.code ?? r.name) === picked) ??
        (floorRaster?.labels ?? []).find(l => l.code === picked)
      : undefined;
  // UX-W4 E 卡片数据：房间读数（归属 zone 的快照值）+ 房间内设备清单。
  // 纯装配在 lib/interior3d/roomLiveCard（vitest 直测）；普通 const ——
  // 此处已在早退分支之后，不能再用 hook。
  const roomCard =
    picked !== null && floorRaster
      ? assembleRoomCard({
          code: picked,
          raster: floorRaster,
          devices: deploy.devices,
          live: (() => {
            const roomZoneId = roomOfRaster(floorRaster, picked)?.zoneId ?? current.zone.id;
            return {
              tempC: simOverlay.tempByZone[roomZoneId] ?? null,
              co2: simOverlay.co2ByZone[roomZoneId] ?? null,
              occupancy: simOverlay.occupancyByZone[roomZoneId] ?? null,
              alert: Boolean(simOverlay.alertByZone[roomZoneId]),
            };
          })(),
        })
      : null;
  // 温度徽标短标签：楼栋字母（buildingId 形如 bldg-<letter>）+ 楼层；完整楼层名放 title
  const buildingLetter =
    /^bldg-(.+)$/i.exec(building.buildingId)?.[1]?.toUpperCase() ?? building.buildingId;
  const floorLabel = floorLabels.label(floor);
  // 关闭操作指南并持久化（隐私模式等写入失败时静默忽略，下次访问仍会提示）
  const dismissOnboarding = () => {
    setShowOnboarding(false);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      // ignore
    }
  };
  const pickedDevice =
    pickedDeviceId !== null ? deploy.devices.find(d => d.id === pickedDeviceId) ?? null : null;

  return (
    <div className="interior-walk">
      <canvas ref={canvasRef} className="interior-walk__canvas" />
      <div className="interior-walk__topbar">
        <Link className="link-button interior-walk__back" to={`/environments/${envId}${zoneParam ? `?zone=${zoneParam}` : ''}`}>
          <ArrowLeft size={14} /> {t('back')}
        </Link>
        {/* UX-W4 返回校园: 世界页 3D 档 + 焦点恢复（view=3d & ?zone= 深链，
            世界页读参后 focus flight 回楼栋）。 */}
        <Link
          className="link-button interior-walk__back-campus"
          to={`/environments/${envId}?view=3d${zoneParam ? `&zone=${zoneParam}` : ''}`}
        >
          <Building2 size={14} /> {t('backToCampus')}
        </Link>
        <span className="interior-walk__hint">
          <Footprints size={14} />{' '}
          {deploy.deployKind
            ? t('deployHint', { name: deploy.deployKind.name })
            : pointerLocked
              ? t('lockedHint')
              : t('hint')}
        </span>
        {floorTemp !== null && (
          <span className="interior-walk__temp" title={current.zone.name}>
            {`${buildingLetter}栋 ${floorLabel} · ${floorTemp.toFixed(1)}°C`}
          </span>
        )}
      </div>
      {showOnboarding && (
        <div className="interior-walk__onboarding">
          <div className="interior-walk__onboarding-card">
            <h3>{t('onboardingTitle')}</h3>
            <div className="interior-walk__onboarding-grid">
              <div className="interior-walk__onboarding-item">
                <span className="interior-walk__onboarding-key">{t('obClickKey')}</span>
                <span>{t('obClickDesc')}</span>
              </div>
              <div className="interior-walk__onboarding-item">
                <span className="interior-walk__onboarding-key">W A S D</span>
                <span>{t('obMoveDesc')}</span>
              </div>
              <div className="interior-walk__onboarding-item">
                <span className="interior-walk__onboarding-key">B</span>
                <span>{t('obDeployDesc')}</span>
              </div>
              <div className="interior-walk__onboarding-item">
                <span className="interior-walk__onboarding-key">H</span>
                <span>{t('obCutDesc')}</span>
              </div>
              <div className="interior-walk__onboarding-item">
                <span className="interior-walk__onboarding-key">V</span>
                <span>{t('obOrbitDesc')}</span>
              </div>
              <div className="interior-walk__onboarding-item">
                <span className="interior-walk__onboarding-key">1-5</span>
                <span>{t('obFloorDesc')}</span>
              </div>
              <div className="interior-walk__onboarding-item">
                <span className="interior-walk__onboarding-key">E</span>
                <span>{t('obInteractDesc')}</span>
              </div>
            </div>
            <p className="interior-walk__onboarding-tip">{t('onboardingTip')}</p>
            <button className="interior-walk__onboarding-start" onClick={dismissOnboarding}>
              {t('onboardingStart')}
            </button>
          </div>
        </div>
      )}
      <div className={`interior-walk__crosshair${pointerLocked ? ' interior-walk__crosshair--locked' : ''}`} />
      <canvas ref={minimapRef} width={220} height={165} className="interior-walk__minimap" />
      {toasts.length > 0 && (
        <div className="interior-walk__toasts">
          {toasts.map(toast => (
            <div
              key={toast.key}
              className={`interior-walk__toast${toast.kind === 'alert' ? ' interior-walk__toast--alert' : ''}`}
            >
              {toast.text}
            </div>
          ))}
        </div>
      )}
      {promptDevice && !deploy.deployKind && (
        <div className="interior-walk__prompt">
          {t('pressE', { name: promptDevice.name })} ·{' '}
          {promptDevice.on ? t('deviceOn') : t('deviceOff')}
        </div>
      )}
      {beaconRoom && (
        <div className="interior-walk__beacon">
          {t('beaconChip', { name: roomLabelText(beaconRoom), dist: Math.round(beaconDist ?? 0) })}
        </div>
      )}
      {reachedFlash && <div className="interior-walk__reached">{t('beaconReached')}</div>}
      {placeFail && (
        <div className="interior-walk__reached">
          {t(placeFail === 'invalid' ? 'placeInvalid' : placeFail === 'unavailable' ? 'deployUnavailable' : placeFail === 'forbidden' ? 'placeForbidden' : 'placeFailed')}
        </div>
      )}
      {soundChip && <div className="interior-walk__soundchip">{soundChip}</div>}
      {openHall && !showOnboarding && (
        <div className="interior-walk__soundchip">{t('openHallHint')}</div>
      )}
      {zoneNotice && (
        <div className="interior-walk__soundchip">{t('zoneFallback', { zone: zoneNotice })}</div>
      )}
      {searchOpen && (
        <div className="interior-walk__search">
          <div className="interior-walk__search-card">
            <h4>{t('searchTitle')}</h4>
            <input
              className="interior-walk__search-input"
              autoFocus
              placeholder={t('searchPlaceholder')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                // preventDefault：同一按键冒泡到 window 时全局热键已用新闭包
                // 重注册（searchOpen 已翻转），会再次触发开关 —— 必须拦断
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSearchOpen(false);
                  setQuery('');
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (searchResults[0]) {
                    placeBeacon(searchResults[0].code, searchResults[0].name, searchResults[0].x, searchResults[0].z);
                  }
                }
              }}
            />
            <ul className="interior-walk__search-list">
              {searchResults.map(r => (
                <li key={r.code}>
                  <button
                    className="link-button interior-walk__search-hit"
                    onClick={() => placeBeacon(r.code, r.name, r.x, r.z)}
                  >
                    <b>{roomLabelText(r)}</b> {r.name !== r.code ? r.code : ''}
                  </button>
                </li>
              ))}
              {query.trim() !== '' && searchResults.length === 0 && (
                <li className="interior-walk__search-empty">{t('noResults')}</li>
              )}
            </ul>
            <p className="interior-walk__search-tip">{t('searchTip')}</p>
          </div>
        </div>
      )}
      <div className="interior-walk__floor-rail">
        {building.floors.map((f, index) => (
          <button
            key={f.zone.id}
            className={
              f.floor === floor
                ? 'interior-walk__floor interior-walk__floor--active'
                : 'interior-walk__floor'
            }
            onClick={() => {
              setPicked(null);
              setFloor(f.floor);
            }}
          >
            <span className="interior-walk__floor-key">{index + 1}</span>
            {floorLabels.label(f.floor)}
          </button>
        ))}
      </div>
      <div className="interior-walk__deploy">
        <span className="interior-walk__deploy-title">
          <Wrench size={14} /> {t('deploy')}
        </span>
        {/* UX-W3: 全量模板目录（category 分组 + 搜索）；API 失败时诚实降级。 */}
        <input
          className="interior-walk__deploy-search"
          value={deployQuery}
          onChange={event => setDeployQuery(event.target.value)}
          placeholder={t('deploySearchPlaceholder')}
          aria-label={t('deploySearchPlaceholder')}
        />
        <div className="interior-walk__deploy-list">
          {deployGroups.map(group => (
            <div key={group.category || '__none'} className="interior-walk__deploy-group">
              <span className="interior-walk__deploy-cat">
                {group.category || t('deployUncategorized')}
              </span>
              {group.templates.map(template => (
                <button
                  key={template.id}
                  className={
                    deploy.deployKind?.type === template.type
                      ? 'interior-walk__deploy-type interior-walk__deploy-type--active'
                      : 'interior-walk__deploy-type'
                  }
                  title={template.description}
                  onClick={() => {
                    setPicked(null);
                    deploy.setDeployName('');
                    deploy.setDeployKind(prev =>
                      prev?.type === template.type ? null : templateToDeployKind(template),
                    );
                  }}
                >
                  {template.name}
                </button>
              ))}
            </div>
          ))}
        </div>
        {deployDegraded && (
          <span className="interior-walk__deploy-degraded">{t('deployDegraded')}</span>
        )}
        {!geoMapping && (
          <span className="interior-walk__deploy-degraded">{t('deployUnavailable')}</span>
        )}
        {deploy.deployKind && (
          <input
            className="interior-walk__deploy-name"
            value={deploy.deployName}
            onChange={event => deploy.setDeployName(event.target.value)}
            placeholder={t('deployNamePlaceholder', { name: deploy.deployKind.name })}
            aria-label={t('deployNameAria')}
          />
        )}
        {deploy.busy && <span className="interior-walk__deploy-busy">{t('placing')}</span>}
      </div>
      {(pickedRoom || pickedDevice) && (
        <div className="interior-walk__card">
          <button
            className="link-button interior-walk__card-close"
            onClick={() => {
              setPicked(null);
              setPickedDeviceId(null);
            }}
          >
            <X size={14} />
          </button>
          {pickedDevice ? (
            <>
              <h4>{pickedDevice.name}</h4>
              <p>
                {pickedDevice.type} · {pickedDevice.on ? t('deviceOn') : t('deviceOff')}
                {deploy.simId ? '' : ` · ${t('deviceNoSim')}`}
              </p>
            </>
          ) : (
            pickedRoom && (
              <>
                <h4>{roomLabelText({ code: pickedRoom.code ?? pickedRoom.name, name: pickedRoom.name })}</h4>
                <p>
                  {[
                    pickedRoom.code && pickedRoom.code !== pickedRoom.name ? pickedRoom.code : null,
                    pickedRoom.hours ?? null,
                    roomCard?.live.alert ? t('cardAlert') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {roomCard &&
                  (roomCard.live.tempC !== null ||
                    roomCard.live.co2 !== null ||
                    roomCard.live.occupancy !== null) && (
                    <p className="interior-walk__card-live">
                      {[
                        roomCard.live.tempC !== null
                          ? `🌡 ${roomCard.live.tempC.toFixed(1)}°C`
                          : null,
                        roomCard.live.co2 !== null ? `CO₂ ${Math.round(roomCard.live.co2)} ppm` : null,
                        roomCard.live.occupancy !== null
                          ? `👥 ${t('liveOccupancy', { count: roomCard.live.occupancy })}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                {roomCard && roomCard.devices.length > 0 && (
                  <div className="interior-walk__card-devices">
                    <span className="interior-walk__card-devices-title">{t('cardDevices')}</span>
                    {roomCard.devices.map(d => (
                      <button
                        key={d.id}
                        className="link-button interior-walk__card-device"
                        title={t('cardDeviceToggle')}
                        onClick={() => {
                          setPickedDeviceId(d.id);
                          deploy.toggleDevice(d);
                        }}
                      >
                        {d.on ? '●' : '○'} {d.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}
