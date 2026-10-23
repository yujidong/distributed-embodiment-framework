/**
 * WorldViewPage — the environment detail ("world view"), the core P2c screen:
 *
 * - left: the shared WorldMap canvas (LOD device dots, agent layer, layer
 *   toggles overlay); builder+ can drag dots to reposition (PATCH position
 *   on drop);
 * - right: collapsible tabbed sidebar (设备 / Agent / 名录 / 成员);
 * - world sync via useWorldStream + toasts for other members' edits;
 * - 运行仿真 starts a simulation from this environment (environmentId) and
 *   hands over to the sim console.
 *
 * Read-only for viewers and anonymous visitors (public envs reached via the
 * /environments/:envId route, including legacy `?env=` share links that
 * redirect here): all write affordances stay hidden.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronsLeft, ChevronsRight, Footprints, MonitorPlay, Pencil, TriangleAlert } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import * as api from '../api/client';
import { ApiClientError } from '../api/client';
import type { EnvActivityEntry, EnvironmentDetail, EnvZone, LlmClientPreset, SimulationListEntry } from '../api/types';
import { activeSimulationsOf } from '../lib/activeSimulations';
import { DEMO_DEFAULT_RATE, demoEndSimTimeSec } from '../lib/demoRun';
import { formatSimTime } from '../lib/simStatus';
import { colorForUserId } from '../lib/memberColors';
import { loadMapHintDismissed, saveMapHintDismissed } from '../lib/mapHint';
import {
  focusOwnerIdOf,
  loadPerspective,
  myManagedZoneIds,
  savePerspective,
  type Perspective,
} from '../lib/perspective';
// 可拖拽分栏：世界视图右侧栏由手搓 pointermove 拖拽改为 PanelGroup，
// 宽度百分比经 autoSaveId 持久化。
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useWorldStream } from '../lib/useWorldStream';
import { worldModelFromEnvironment } from '../lib/worldModel';
import { alertingZoneIds } from '../lib/campus3d';
import { useCampusSimSnapshot } from '../hooks/useCampusSimSnapshot';
import { canFinishPolygon, mapDataWithUpdatedZone } from '../lib/zoneForm';
import { translateBounds } from '../lib/zoneGeometry';
import { resolveScopedZoneIds, toggleZoneExclusion } from '../lib/zoneScope';
import { useRoleLabel } from '../i18n/index';
import { usePopoverDismiss } from '../hooks/usePopoverDismiss';
import { useTranslation } from 'react-i18next';
import { LLM_HINT_KEYS, LLM_OPTION_KEYS } from '../lib/llmOptions';
import { useAppStore, type WorldLayers } from '../store/useAppStore';
import { WorldSidebar, type SidebarTab } from '../components/world/WorldSidebar';
import { BannerStack, type BannerStackItem } from '../components/BannerStack';
import { Icon } from '../components/ui/Icon';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { Loading } from '../components/ui/Loading';

// Canvas-level code splitting: the three canvas views pull the heaviest
// vendors in the console — babylon (~1MB), leaflet, reactflow — and only ONE
// is ever mounted at a time, so each loads on first activation instead of
// weighing down the world view's initial chunk. The Suspense fallback below
// covers the first-switch fetch (cached afterwards).
// 3D slot: Babylon CampusScene (low-poly digital twin — the legacy three.js
// Building3DView was removed in the campus-3d cleanup).
const CampusScene = lazy(() =>
  import('../components/campus/CampusScene').then(m => ({ default: m.CampusScene })),
);
const GeoWorldMap = lazy(() =>
  import('../components/worldmap/GeoWorldMap').then(m => ({ default: m.GeoWorldMap })),
);
const WorldMap = lazy(() => import('../components/worldmap/WorldMap').then(m => ({ default: m.WorldMap })));

const LAYER_LABEL_KEYS: Record<keyof WorldLayers, string> = {
  zones: 'layers.zones',
  devices: 'layers.devices',
  agents: 'layers.agents',
  edges: 'layers.edges',
};

/** Canvas view switch (V3 trial): mapType picks the default; 3D is local-only. */
type CanvasView = 'grid' | 'geo' | '3d';

const CANVAS_VIEWS: readonly CanvasView[] = ['grid', 'geo', '3d'];

/** Descriptions longer than this clamp to two lines with an expand toggle. */
const DESCRIPTION_CLAMP_CHARS = 160;

/**
 * 窄屏（≤1280px）默认分栏收窄一档：Panel 的 defaultSize 只在无持久化布局
 * （autoSaveId 无记录）时生效，挂载时读一次视口宽度即可。
 */
function narrowViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 1280;
}

const SIDEBAR_TABS: readonly SidebarTab[] = [
  'appOverview',
  // R6-D-F01: 成就 timeline joins the allow-list (?tab=achievements).
  'achievements',
  // R6-D-M1: 关卡 quest panel joins the allow-list (?tab=quests).
  'quests',
  'devices',
  'agents',
  'services',
  'agreements',
  // UX-W5: 收件箱 governance inbox joins the allow-list (?tab=governance) —
  // the notification replyHint deep-link for pending proposals lands here.
  'governance',
  'catalog',
  'blueprints',
  'deployment',
  // T-028/EA-F04: 'replayShare' joins the allow-list — /environments/:id?tab=
  // replayShare used to silently fall back to the devices tab.
  'replayShare',
  'evalRuns',
  'rosterReport',
  // R40-B3/R59: sandboxes and externalChannel join the allow-list — ?tab=
  // sandboxes / ?tab=externalChannel used to silently fall back to devices.
  'sandboxes',
  'externalChannel',
  'members',
];

/** ?tab= deep-link parsing — unknown values fall back to the devices tab. */
function parseSidebarTab(value: string | null): SidebarTab {
  return SIDEBAR_TABS.includes(value as SidebarTab) ? (value as SidebarTab) : 'devices';
}

/**
 * UX-03: unknown-tab detection for the deep-link toast — returns the raw
 * unknown value, null when the param is absent or a known tab. parseSidebarTab
 * keeps the fallback; this only decides whether to tell the user.
 */
export function unknownSidebarTab(value: string | null): string | null {
  if (value === null) return null;
  return SIDEBAR_TABS.includes(value as SidebarTab) ? null : value;
}

/**
 * Role guard for deep links (Fix-37): 评分报告 is owner-only — a ?tab=
 * rosterReport link opened by a non-owner falls back to the devices tab
 * instead of hitting the owner-gated route.
 */
function guardSidebarTabByRole(tab: SidebarTab, myRole: EnvironmentDetail['myRole']): SidebarTab {
  if (tab === 'rosterReport' && myRole !== 'owner') return 'devices';
  return tab;
}

export function WorldViewPage() {
  const world = useAppStore(s => s.world);
  const worldLoading = useAppStore(s => s.worldLoading);
  const worldError = useAppStore(s => s.worldError);
  const worldStreamStatus = useAppStore(s => s.worldStreamStatus);
  const selection = useAppStore(s => s.selection);
  const layers = useAppStore(s => s.layers);
  const user = useAppStore(s => s.user);
  const simulationError = useAppStore(s => s.simulationError);
  const openEnvironment = useAppStore(s => s.openEnvironment);
  const roleLabel = useRoleLabel();
  const { t: tw } = useTranslation('world');
  const { t: ti } = useTranslation('interiorWalk');
  const { t: td } = useTranslation('worldDraw');
  const { t: tc } = useTranslation('common');
  const selectObject = useAppStore(s => s.selectObject);
  const toggleLayer = useAppStore(s => s.toggleLayer);
  const startSimulationForEnvironment = useAppStore(s => s.startSimulationForEnvironment);
  const createDemoSim = useAppStore(s => s.createDemoSim);
  const openSimulationConsole = useAppStore(s => s.openSimulationConsole);
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const geoPlacement = useAppStore(s => s.geoPlacement);
  const completeGeoPlacement = useAppStore(s => s.completeGeoPlacement);
  const devicePick = useAppStore(s => s.devicePick);
  const setDevicePickPoint = useAppStore(s => s.setDevicePickPoint);
  const cancelDevicePick = useAppStore(s => s.cancelDevicePick);
  const zoneDraw = useAppStore(s => s.zoneDraw);
  const appendZoneDrawVertex = useAppStore(s => s.appendZoneDrawVertex);
  const finishZoneDraw = useAppStore(s => s.finishZoneDraw);
  const cancelZoneDraw = useAppStore(s => s.cancelZoneDraw);
  // UX-W2 zone geometry editing (geo vertex handles + grid bounds drag).
  const moveZoneDrawVertex = useAppStore(s => s.moveZoneDrawVertex);
  const insertZoneDrawVertex = useAppStore(s => s.insertZoneDrawVertex);
  const removeZoneDrawVertex = useAppStore(s => s.removeZoneDrawVertex);
  const zoneBoundsEditId = useAppStore(s => s.zoneBoundsEditId);
  const cancelZoneBoundsEdit = useAppStore(s => s.cancelZoneBoundsEdit);

  const [llmClient, setLlmClient] = useState<LlmClientPreset>('auto');
  // Long generated-city descriptions (~500 chars) push the map below the
  // fold; the header clamps them to two lines until expanded.
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  // R2-FEAT-04: owner-only inline rename (PATCH /api/environments/:id name
  // existed server-side; no UI ever exposed it).
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  // R12-5c-B: before starting a new sim we check for an existing active one;
  // non-null = the "进入现有仿真 / 新建仿真" chooser is open.
  const [simChoice, setSimChoice] = useState<SimulationListEntry[] | null>(null);
  const [simCheckPending, setSimCheckPending] = useState(false);
  // A2 zone scoping: zones the user UNCHECKED for the next sim run (empty =
  // full world → no zoneIds field sent). Reset whenever another env opens.
  const [excludedZoneIds, setExcludedZoneIds] = useState<ReadonlySet<string>>(new Set());
  const [zoneScopeOpen, setZoneScopeOpen] = useState(false);
  // UX-W5: 头部减负——LLM 选择器 / zone 范围 / 演示模式 / 业务流链接收进
  // 「⋯ 更多」菜单；会话概念引导（世界会话 vs 私有仿真）是运行按钮旁的
  // 说明 popover。两者同享 Esc/外部点击关闭纪律。
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [sessionGuideOpen, setSessionGuideOpen] = useState(false);
  // V6: zoneScope / run-sim popover 支持 Esc 与点击外部关闭。
  const zoneScopeRef = useRef<HTMLDivElement | null>(null);
  const runSimRef = useRef<HTMLDivElement | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionGuideRef = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(zoneScopeRef, zoneScopeOpen, () => setZoneScopeOpen(false));
  usePopoverDismiss(runSimRef, simChoice !== null, () => setSimChoice(null));
  usePopoverDismiss(headerMenuRef, headerMenuOpen, () => setHeaderMenuOpen(false));
  usePopoverDismiss(sessionGuideRef, sessionGuideOpen, () => setSessionGuideOpen(false));
  // W1b onboarding deep-link: ?tab=blueprints opens the sidebar straight on
  // the 蓝图 tab (invalid/missing values fall back to devices).
  const [searchParams, setSearchParams] = useSearchParams();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() =>
    parseSidebarTab(searchParams.get('tab')),
  );
  // T-028/EA-F04: tab switches write ?tab= back to the URL (replace, not
  // push — a tab switch is not a page navigation) so the documented
  // deep-link pattern (`?tab=blueprints` used by OnboardingChecklist) keeps
  // working when a user copies the URL AFTER navigating.
  const selectSidebarTab = (tab: SidebarTab) => {
    setSidebarTab(tab);
    setSearchParams(
      params => {
        const next = new URLSearchParams(params);
        next.set('tab', tab);
        return next;
      },
      { replace: true },
    );
  };
  const navigate = useNavigate();
  // UX-W1: ≤1024px 视口右侧栏变抽屉（悬浮钮开合），默认收起；宽屏保持默认展开。
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 1024,
  );
  // UX-03: an unknown ?tab= deep link used to silently land on the devices
  // tab — tell the user once (valid/absent values stay quiet; tab switches
  // rewrite the param, so only deep-link entries can fire this).
  const unknownTabNotifiedRef = useRef<string | null>(null);
  useEffect(() => {
    const unknown = unknownSidebarTab(searchParams.get('tab'));
    if (unknown === null || unknownTabNotifiedRef.current === unknown) return;
    unknownTabNotifiedRef.current = unknown;
    pushToast(tw('sidebar.unknownTabToast', { tab: unknown }));
  }, [searchParams, pushToast, tw]);
  // 侧栏宽度由 PanelGroup 管理（autoSaveId 持久化）；折叠后再展开恢复上次布局。
  // W4: one-time map-interaction hint (dismiss persisted in localStorage).
  const [mapHintDismissed, setMapHintDismissed] = useState(loadMapHintDismissed);
  // 视角切换 (W5): 全局视角 / 我的视角 — persisted per environment.
  const [perspective, setPerspective] = useState<Perspective>('global');
  // V3 trial: local canvas view override (null = follow the world mapType).
  const [canvasView, setCanvasView] = useState<CanvasView | null>(null);
  // Fix-19: the activity feed expands lazily (fetched on first open).
  const [activityOpen, setActivityOpen] = useState(false);
  const [activity, setActivity] = useState<EnvActivityEntry[] | null>(null);
  // V5: 加载失败不再吞成「暂无动态」空态——独立错误态 + 重试。
  const [activityError, setActivityError] = useState<string | null>(null);
  // T-713 (R29, orchestrator): the world session's topology-drift warnings
  // (typed on WorldSessionStatus since T-037 but never rendered) — a
  // dismissible teaching banner; dismissal resets when another env opens.
  const [driftDismissed, setDriftDismissed] = useState(false);
  // plan-r81 B2:「演示模式」one-click demo run (only for demo-annotated
  // worlds). Busy while the fresh sim is created and the hero event lands.
  const [demoBusy, setDemoBusy] = useState(false);
  const startDemoRun = useAppStore(s => s.startDemoRun);
  const clearDemoRun = useAppStore(s => s.clearDemoRun);

  useWorldStream(world?.id ?? null);

  // R2-FEAT-02: world-page live snapshot — the page's only realtime channel
  // (useWorldStream) carries edit/session frames, no zone telemetry. Poll the
  // world-session snapshot (same source discipline as the campus 3D overlay)
  // and feed the two flat canvases + the safety banner, so an in-progress
  // high-temperature/smoke event is visible without opening a sim console.
  const liveSnapshot = useCampusSimSnapshot(world?.id);
  const alertingZones = useMemo(() => {
    if (!liveSnapshot) return [];
    const ids = alertingZoneIds(liveSnapshot.zones);
    if (ids.size === 0) return [];
    return liveSnapshot.zones.filter(zone => ids.has(zone.id));
  }, [liveSnapshot]);

  // Route-driven loading: the env id comes from /environments/:envId; the
  // store's world slice is refilled whenever the param points elsewhere.
  // (openEnvironment sets worldLoading synchronously, so a StrictMode
  // double-effect does not double-fetch.)
  const { envId: routeEnvId } = useParams<{ envId: string }>();
  useEffect(() => {
    if (!routeEnvId) return;
    const { world: current, worldLoading } = useAppStore.getState();
    if (current?.id === routeEnvId || worldLoading) return;
    void openEnvironment(routeEnvId);
  }, [routeEnvId, openEnvironment, world?.id]);

  // Restore the persisted perspective whenever another environment opens.
  const worldId = world?.id ?? null;
  useEffect(() => {
    if (worldId) setPerspective(loadPerspective(worldId));
    // Fix-19: reset the lazily loaded activity feed for the new world.
    setActivityOpen(false);
    setActivity(null);
    setActivityError(null);
    // A2: zone exclusions from the previous world must not leak over.
    setExcludedZoneIds(new Set());
    setZoneScopeOpen(false);
    // R12-5c-B: the existing-sim chooser belongs to the previous world.
    setSimChoice(null);
    // V3: the canvas view override follows the new world's mapType again.
    setCanvasView(null);
    // T-713: the previous world's dismissed drift banner does not carry over.
    setDriftDismissed(false);
  }, [worldId]);

  // W4: selecting a zone on the map opens the sidebar on the devices tab,
  // which renders the zone detail (device list scoped to that zone). An
  // explicit ?tab= deep link wins — the ?zone=+?tab=catalog combination
  // must not be dragged back to devices (ux-w4 probe P3②).
  useEffect(() => {
    if (selection?.objectType === 'zone') {
      if (!searchParams.get('tab')) setSidebarTab('devices');
      setSidebarOpen(true);
    }
  }, [selection, searchParams]);

  // R82: ?zone=<id> deep link — select a zone directly. Stacked geo floors
  // (same footprint, one polygon per storey) can't be click-reached reliably;
  // a shareable per-zone link also makes floor/room details addressable.
  const zoneParam = searchParams.get('zone');
  useEffect(() => {
    if (!zoneParam || !world) return;
    if (!world.zones.some(z => z.id === zoneParam)) return;
    if (selection?.objectType === 'zone' && selection.id === zoneParam) return;
    useAppStore.setState({ selection: { objectType: 'zone', id: zoneParam } });
  }, [zoneParam, world, selection]);

  // UX-W4 返回校园: ?view=3d|geo|grid deep link (the walk page's「返回校园」
  // lands here) — override the canvas view; combined with ?zone= the 3D
  // campus restores the building focus the user left from. worldId is a dep
  // so the override re-applies AFTER the worldId effect's setCanvasView(null)
  // on async world load — without it a cold ?view=3d load always lost the
  // race (ux-w4 probe B4); effect order (reset first, override second) makes
  // the param win the same commit.
  const viewParam = searchParams.get('view');
  useEffect(() => {
    if (viewParam === '3d' || viewParam === 'geo' || viewParam === 'grid') {
      setCanvasView(viewParam);
    }
  }, [viewParam, worldId]);

  const dismissMapHint = () => {
    setMapHintDismissed(true);
    saveMapHintDismissed();
  };

  const loadActivity = () => {
    if (!worldId) return;
    setActivityError(null);
    void api
      .getEnvironmentActivity(worldId)
      .then(setActivity)
      .catch((error: unknown) => {
        setActivity(null);
        setActivityError(error instanceof Error ? error.message : String(error));
      });
  };

  const toggleActivity = () => {
    const next = !activityOpen;
    setActivityOpen(next);
    if (next && activity === null && activityError === null) {
      loadActivity();
    }
  };

  const switchPerspective = (next: Perspective) => {
    setPerspective(next);
    if (worldId) savePerspective(worldId, next);
  };

  const memberColorById = useMemo(() => {
    const map = new Map<string, string>();
    if (!world) return map;
    for (const member of world.members) {
      // userId is redacted for non-members (Fix-4) — skip id-less entries.
      if (member.userId !== undefined) {
        map.set(member.userId, colorForUserId(member.userId));
      }
    }
    // Object owners who left the env keep their color (legend lists members).
    for (const device of world.devices) {
      if (!map.has(device.owner.id)) map.set(device.owner.id, colorForUserId(device.owner.id));
    }
    for (const agent of world.agents) {
      if (!map.has(agent.owner.id)) map.set(agent.owner.id, colorForUserId(agent.owner.id));
    }
    return map;
  }, [world]);

  const model = useMemo(() => (world ? worldModelFromEnvironment(world) : null), [world]);

  // 我的视角: whose objects stay lit (null = global render). Anonymous
  // visitors own nothing, so the toggle is hidden and this stays null.
  const focusOwnerId = focusOwnerIdOf(perspective, user?.id ?? null);

  const focusedZoneIds = useMemo(() => {
    if (!world || !model) return new Set<string>();
    // 我的视角: highlight every zone managed by MY agents (not the selection).
    if (focusOwnerId !== null) return myManagedZoneIds(model.agents, focusOwnerId);
    if (selection?.objectType !== 'agent') return new Set<string>();
    const agent = world.agents.find(a => a.id === selection.id);
    return new Set(agent?.managedZoneIds ?? []);
  }, [world, model, selection, focusOwnerId]);

  // R31 F14: map handlers must be identity-stable — closures recreated on
  // every WorldViewPage render (sidebar drag, tab switch, toast) invalidated
  // the grid map's buildGraph memo and rebuilt the whole graph. Store
  // actions are stable references; the few derived booleans ride the deps.
  const canBuild = world?.myRole === 'owner' || world?.myRole === 'builder';
  /**
   * Shared device-position persist (R98 proposal conversion + optimistic
   * apply). Grid drops send world-unit `{x, y}`; geo/3D drops send lat/lng —
   * the wire field is a free-form record resolved by readLatLng/readPosition.
   */
  const persistDevicePosition = useCallback(
    (deviceId: string, position: { x: number; y: number } | { lat: number; lng: number }) => {
      void (async () => {
        try {
          const device = await api.patchDevice(deviceId, { position });
          // R98: a builder's drag converts into a modify-object proposal —
          // the device moves only when the pipeline approves it.
          if (api.isProposalConversion(device)) {
            // F4: a rule-mode low-risk proposal lands as `applied` (already
            // in effect) — don't tell the user it still waits for approval.
            if (device.status === 'applied') {
              pushToast(tw('moveDeviceProposalApplied', { id: device.id }));
            } else if (device.status !== 'rejected') {
              pushToast(tw('moveDeviceProposal', { id: device.id }));
            }
            return;
          }
          // Optimistic apply; the stream broadcast dedupes by id.
          applyWorldMessage({
            kind: 'world',
            action: 'updated',
            objectType: 'device',
            object: device,
          });
        } catch (error) {
          pushToast(
            tw('moveDeviceFailed', { error: error instanceof Error ? error.message : String(error) }),
          );
          // Role changes reach the member via inbox, not the world stream —
          // a 403 here usually means a mid-session demotion/removal: refetch
          // the world so myRole/canBuild self-heal instead of staying stale.
          if ((error as { status?: number } | null)?.status === 403 && world) {
            void openEnvironment(world.id);
          }
        }
      })();
    },
    [applyWorldMessage, pushToast, tw, world, openEnvironment],
  );
  const handleDeviceDragStop = useCallback(
    (deviceId: string, position: { x: number; y: number }) => persistDevicePosition(deviceId, position),
    [persistDevicePosition],
  );
  /** 3D campus view: drag drop on the ground plane, geo position (lat/lng). */
  const handleDeviceMove3d = useCallback(
    (deviceId: string, latLng: { lat: number; lng: number }) => persistDevicePosition(deviceId, latLng),
    [persistDevicePosition],
  );
  /** undefined for viewers — the map then renders dots non-draggable. */
  const onDeviceDragStop = canBuild ? handleDeviceDragStop : undefined;

  /**
   * UX-W2 grid bounds drag (owner-only — the mapData PATCH route rejects
   * builders): the dropped top-left corner becomes the zone's new
   * bounds.min, the rectangle's size rides along (translate, not resize).
   */
  const handleZoneDragStop = useCallback(
    (zoneId: string, min: { x: number; y: number }) => {
      if (!world || world.myRole !== 'owner') return;
      const zone = world.zones.find(entry => entry.id === zoneId);
      if (!zone?.bounds) return;
      const updated: EnvZone = {
        ...zone,
        bounds: translateBounds(zone.bounds, min.x - zone.bounds.minX, min.y - zone.bounds.minY),
      };
      void (async () => {
        try {
          const updatedEnv = await api.patchEnvironment(world.id, {
            mapData: mapDataWithUpdatedZone(world, updated),
          });
          applyWorldMessage({
            kind: 'world',
            action: 'updated',
            objectType: 'environment',
            object: updatedEnv,
          });
          pushToast(tw('zoneMoved', { name: zone.name ?? zone.id }));
        } catch (error) {
          pushToast(
            tw('zoneMoveFailed', { error: error instanceof Error ? error.message : String(error) }),
          );
        } finally {
          cancelZoneBoundsEdit();
        }
      })();
    },
    [world, applyWorldMessage, pushToast, tw, cancelZoneBoundsEdit],
  );
  const onZoneDragStop =
    canBuild && zoneBoundsEditId !== null ? handleZoneDragStop : undefined;

  // Geo click routing priority (W6-2): zone drawing > device position pick
  // > catalog click-to-place.
  const zoneDrawActive = zoneDraw?.active ?? false;
  const devicePickArmed = devicePick?.armed ?? false;
  const handleMapClick = useCallback(
    (latLng: { lat: number; lng: number }, context?: { zoneId?: string }) => {
      if (zoneDrawActive) {
        appendZoneDrawVertex([latLng.lat, latLng.lng]);
        return;
      }
      if (devicePickArmed) {
        setDevicePickPoint(latLng);
        return;
      }
      // UX-W4: the 3D floor-aware placement passes the storey's zone through
      // (zoneDraw/devicePick flows ignore the context).
      void completeGeoPlacement(latLng, context?.zoneId ? { zoneId: context.zoneId } : undefined);
    },
    [zoneDrawActive, devicePickArmed, appendZoneDrawVertex, setDevicePickPoint, completeGeoPlacement],
  );
  const handleMapDblClick = useCallback(() => {
    if (zoneDrawActive) finishZoneDraw();
  }, [zoneDrawActive, finishZoneDraw]);

  // Esc in the 3D placement mode: cancel whichever geo flow is armed.
  const cancelGeoPlacement = useAppStore(s => s.cancelGeoPlacement);
  const handleCancelPlacement = useCallback(() => {
    if (zoneDrawActive || zoneDraw?.editingZoneId !== undefined) cancelZoneDraw();
    else if (devicePickArmed) cancelDevicePick();
    else cancelGeoPlacement();
  }, [zoneDrawActive, zoneDraw?.editingZoneId, devicePickArmed, cancelZoneDraw, cancelDevicePick, cancelGeoPlacement]);

  if (worldError) {
    return (
      <div className="page-note page-note--error">
        <p>{tw('loadFailed', { error: worldError })}</p>
        <button onClick={() => navigate('/environments')}>{tw('backToEnvironments')}</button>
      </div>
    );
  }
  if (worldLoading || !world || !model) {
    return worldLoading ? (
      <p className="page-note">{tw('loading')}</p>
    ) : (
      <div className="page-note">
        <p>{tw('noEnvOpen')}</p>
        <button onClick={() => navigate('/environments')}>{tw('backToEnvironments')}</button>
      </div>
    );
  }

  const canRunSimulation = world.visibility === 'public' || world.myRole !== null;
  // R40-B3: narrowed alias for the world session (TS cannot narrow
  // world.worldSession inside the banner's click closures).
  const worldSession = world.worldSession ?? null;
  // A2 zone scoping: undefined = full world (no zoneIds sent); an empty array
  // means the user unchecked everything — block the run instead of starting a
  // world with zero zones.
  const scopedZoneIds = resolveScopedZoneIds(world.zones.map(zone => zone.id), excludedZoneIds);
  const noZonesSelected = scopedZoneIds !== undefined && scopedZoneIds.length === 0;

  /**
   * plan-r81 B2「演示模式」: start a FRESH private sim (never the shared
   * world session — the injected hero event must not disturb it), play at
   * the demo's recommended rate (default 10×), inject the hero event up
   * front (the engine consumes its scripted duplicate), then hand the run
   * to the DemoModeBanner, which narrates the arc and stops the sim at the
  /**
   * plan-r81 B2「演示模式」: start a FRESH private sim (never the shared
   * world session — the injected hero event must not disturb it), play at
   * the demo's recommended rate (default 10×), inject the hero event up
   * front (the engine consumes its scripted duplicate), then hand the run
   * to the DemoModeBanner, which narrates the arc and stops the sim at the
   * end (F2 — a demo sim has no other stop path, so a previous unfinished
   * demo is retired here too).
   *
   * Demo-on-world-page architecture: the sim is created through the
   * demo-only store action `createDemoSim`, which does NOT set
   * `simulationId` — the demo stays on the world page (3D campus keeps
   * showing the hero event's heat/alert pulse via the overlay hooks'
   * demoRun preference) instead of swapping to the sim console. Failures
   * throw into the catch below (demoFailed toast).
   */
  const startDemo = async () => {
    const demo = world.demo;
    if (demo === null || demo === undefined) return;
    setDemoBusy(true);
    try {
      const previousDemo = useAppStore.getState().demoRun;
      if (previousDemo !== null) {
        // Retire the previous demo sim before stacking a fresh one (F2).
        void api.stopSimulation(previousDemo.simId).catch(() => undefined);
        clearDemoRun();
      }
      const info = await createDemoSim(world.id, llmClient, scopedZoneIds);
      const simId = info.id;
      const rate = demo.recommendedPlaybackRate ?? DEMO_DEFAULT_RATE;
      const heroEventId = demo.heroEventId ?? null;
      const hero = heroEventId !== null ? world.events.find(e => e.id === heroEventId) : undefined;
      // Cinematography: the hero event may declare a playbackRateOverride
      // (structural read — the wire type is Record<string, unknown>).
      const heroOverrideRaw =
        hero !== undefined
          ? (hero as { cinematography?: Record<string, unknown> }).cinematography
              ?.playbackRateOverride
          : undefined;
      const heroPlaybackRateOverride =
        typeof heroOverrideRaw === 'number' && Number.isFinite(heroOverrideRaw) && heroOverrideRaw > 0
          ? heroOverrideRaw
          : undefined;
      // Start AT the hero rate when one is declared: at the full demo rate the
      // hero's fast-decaying signals (smoke) are gone before the banner could
      // slow anything down — the banner restores `rate` after the window.
      await api.startSimulation(simId, heroPlaybackRateOverride ?? rate);
      if (hero !== undefined) {
        // The web ScenarioEvent patch type omits severity (the wire's
        // EnvMapEvent carries it) — read it structurally.
        const { severity } = hero as { severity?: 'low' | 'medium' | 'high' | 'critical' };
        await api.injectEvent(simId, {
          id: hero.id,
          type: hero.type,
          zoneId: hero.zoneId,
          ...(hero.parameter !== undefined ? { parameter: hero.parameter } : {}),
          ...(hero.value !== undefined ? { value: hero.value } : {}),
          ...(severity !== undefined ? { severity } : {}),
        });
      }
      startDemoRun({
        simId,
        envId: world.id,
        rate,
        heroEventId,
        ...(hero?.zoneId !== undefined ? { heroZoneId: hero.zoneId } : {}),
        startedAtMs: Date.now(),
        ...(heroPlaybackRateOverride !== undefined ? { heroPlaybackRateOverride } : {}),
        endsAtSimTimeSec: demoEndSimTimeSec(world.events),
      });
    } catch (error) {
      pushToast(
        tw('demoMode.startFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setDemoBusy(false);
    }
  };
  // Geo map tier (§11.4): real-geography canvas; anything without a map
  // center defensively falls back to the grid canvas.
  const isGeo = world.mapType === 'geo' && world.mapCenter !== null;
  // Canvas view: local switcher state, defaulting to the world mapType (the
  // geo tier still requires a map center — without it geo falls back to grid).
  const activeView: CanvasView = canvasView ?? (isGeo ? 'geo' : 'grid');

  // Geo click routing priority (W6-2): zone drawing > device position pick
  // > catalog click-to-place. The banner matches whichever mode is on top.
  const zoneDrawVertices = zoneDraw?.vertices ?? [];
  // UX-W2: an existing zone's polygon is being vertex-edited on the map.
  const vertexEditZoneId = zoneDraw?.editingZoneId ?? null;

  // UX-W1: 世界页横幅统一收纳进 BannerStack —— 实况告警(安全) > 拓扑漂移
  // (治理) > 世界会话(信息) > 世界导读(信息)，超过 2 条折叠为「还有 N 条」。
  // 漂移横幅的关闭走栈的关闭钮（原行内 dismiss 移除，避免双关闭）；
  // 会话/导读/告警不可关。
  const driftWarning = world.worldSession?.driftWarning ?? [];
  const worldBannerItems: BannerStackItem[] = [];
  if (alertingZones.length > 0) {
    // R2-FEAT-02: zones whose live parameters crossed a critical threshold
    // (zoneAlertLevel, same source as the campus 3D alert pulse). Safety tone
    // tops the stack; zone display names (name 主 id 次) — an operator must
    // recognize the卖场, not decode ward-f0-r0.
    const names = alertingZones.map(zone => {
      const name = world.zones.find(z => z.id === zone.id)?.name ?? zone.name;
      return name !== undefined && name !== '' && name !== zone.id ? name : zone.id;
    });
    worldBannerItems.push({
      id: 'zone-alerts',
      tone: 'safety',
      content: (
        <div className="world-alert-banner" role="alert">
          <strong className="world-alert-banner__title">
            <Icon icon={TriangleAlert} size={14} />
            {tw('alerts.title', { count: alertingZones.length })}
          </strong>
          <span className="world-alert-banner__zones">{names.join('、')}</span>
        </div>
      ),
    });
  }
  if (driftWarning.length > 0 && !driftDismissed) {
    worldBannerItems.push({
      id: 'drift',
      tone: 'governance',
      onDismiss: () => setDriftDismissed(true),
      content: (
        // T-713: world-session topology drift (T-037 semantics — the resumed
        // session adopts the env's CURRENT topology; the banner teaches what
        // moved while the world was hibernated).
        <div className="drift-banner" role="alert">
          <div className="drift-banner__body">
            <strong className="drift-banner__title">
              <Icon icon={TriangleAlert} size={14} /> {tw('drift.title')}
            </strong>
            <ul className="drift-banner__list">
              {driftWarning.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      ),
    });
  }
  if (worldSession !== null) {
    worldBannerItems.push({
      id: 'world-session',
      tone: 'info',
      content: (
        // R40-B3: the world session's lifecycle surface — status badge plus
        // wake (hibernated → deterministic fast-forward on next arrival) and
        // hibernate (freeze to checkpoint, release the runtime). The session
        // sim is owner/builder-operable per its contract.
        <div className="world-session-banner">
          <span className={`world-session-banner__status world-session-banner__status--${worldSession.status}`}>
            {tw(`session.status_${worldSession.status}`)}
          </span>
          <span className="world-session-banner__simtime" title={tw('session.simTimeTitle')}>
            {formatSimTime(worldSession.simTimeSec)}
          </span>
          {worldSession.status === 'hibernated' && canBuild && worldSession.simulationId !== undefined && (
            <button
              type="button"
              onClick={() => {
                void api.resumeSimulation(worldSession.simulationId!).catch((error: unknown) => {
                  pushToast(error instanceof Error ? error.message : String(error));
                });
                void openEnvironment(world.id);
              }}
            >
              {tw('session.wake')}
            </button>
          )}
          {worldSession.status !== 'hibernated' && canBuild && worldSession.simulationId !== undefined && (
            <button
              type="button"
              onClick={() => {
                // 休眠即冻结世界会话（释放运行时）——代价与停止仿真同级，
                // 与唤醒（已有确认）对称地加二次确认。
                void confirm({ body: tw('session.hibernateConfirm'), tone: 'warn' }).then(ok => {
                  if (!ok) return;
                  void api.hibernateSimulation(worldSession.simulationId!).then(() => {
                    pushToast(tw('session.hibernatedToast'));
                    void openEnvironment(world.id);
                  }).catch((error: unknown) => {
                    pushToast(error instanceof Error ? error.message : String(error));
                  });
                });
              }}
            >
              {tw('session.hibernate')}
            </button>
          )}
        </div>
      ),
    });
  }
  worldBannerItems.push({
    id: 'world-guide',
    tone: 'info',
    content: (
      <section className="world-guide">
        {world.guide && (
          <>
            <h3 className="world-guide__title">{tw('guide.title')}</h3>
            {world.guide.purpose && <p>{tw('guide.purpose', { text: world.guide.purpose })}</p>}
            {world.myRole === 'viewer' && world.guide.roleGuide?.viewer && (
              <p>{tw('guide.youCan', { text: world.guide.roleGuide.viewer })}</p>
            )}
            {(world.myRole === 'owner' || world.myRole === 'builder') &&
              world.guide.roleGuide?.builder && <p>{tw('guide.youCan', { text: world.guide.roleGuide.builder })}</p>}
            {world.guide.zoneGuide && <p>{tw('guide.zoneGuide', { text: world.guide.zoneGuide })}</p>}
            {world.guide.serviceMap && <p>{tw('guide.serviceMap', { text: world.guide.serviceMap })}</p>}
          </>
        )}
        <button className="link-button" onClick={toggleActivity}>
          {activityOpen ? tw('activity.hide') : tw('activity.show')}
        </button>
        {activityOpen &&
          (activityError !== null ? (
            <div className="page-note page-note--error">
              <p>{tw('activity.loadFailed', { error: activityError })}</p>
              <button className="link-button" onClick={loadActivity}>
                {tw('activity.retry')}
              </button>
            </div>
          ) : activity === null ? (
            <p className="page-note">{tw('activity.loading')}</p>
          ) : activity.length === 0 ? (
            <p className="page-note">{tw('activity.empty')}</p>
          ) : (
            <ul className="activity-list">
              {activity.map((entry, index) => (
                <li key={`${entry.kind}-${entry.objectId}-${entry.time}-${index}`}>
                  <span className="activity-list__time">
                    {new Date(entry.time).toLocaleString()}
                  </span>{' '}
                  {entry.actor?.displayName ?? '—'} · {entry.summary}
                </li>
              ))}
            </ul>
          ))}
      </section>
    ),
  });

  // R2-FEAT-04: owner rename — PATCH name, optimistic store apply (the
  // world-stream broadcast dedupes by id like every other env update).
  const submitRename = async () => {
    const next = renameValue.trim();
    if (renameBusy || next === '' || next === world.name) {
      if (next === world.name) setRenameOpen(false);
      return;
    }
    setRenameBusy(true);
    try {
      const updated = await api.patchEnvironment(world.id, { name: next });
      applyWorldMessage({ kind: 'world', action: 'updated', objectType: 'environment', object: updated });
      pushToast(tw('renameEnv.savedToast', { name: next }));
      setRenameOpen(false);
    } catch (error) {
      pushToast(
        tw('renameEnv.failed', {
          error: error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error),
        }),
      );
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <div className="detail-page">
      <header className="detail-header">
        <Link className="link-button" to="/environments">
          <Icon icon={ArrowLeft} size={14} /> {tw('back')}
        </Link>
        <div className="detail-header__meta">
          {renameOpen && world.myRole === 'owner' ? (
            <span className="detail-header__rename">
              <input
                value={renameValue}
                aria-label={tw('renameEnv.inputAria')}
                onChange={event => setRenameValue(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void submitRename();
                  if (event.key === 'Escape') setRenameOpen(false);
                }}
              />
              <button
                className="primary-button"
                disabled={renameBusy || renameValue.trim() === ''}
                onClick={() => void submitRename()}
              >
                {tw('renameEnv.save')}
              </button>
              <button className="link-button" disabled={renameBusy} onClick={() => setRenameOpen(false)}>
                {tw('renameEnv.cancel')}
              </button>
            </span>
          ) : (
            <h2>
              {world.name}
              {world.myRole === 'owner' && (
                <button
                  className="detail-header__rename-toggle"
                  title={tw('renameEnv.open')}
                  aria-label={tw('renameEnv.open')}
                  onClick={() => {
                    setRenameValue(world.name);
                    setRenameOpen(true);
                  }}
                >
                  <Icon icon={Pencil} size={14} />
                </button>
              )}
            </h2>
          )}
          <span className="detail-header__id">{world.id}</span>
          <span className="badge">{world.mapType}</span>
          <span className={`badge ${world.visibility === 'public' ? 'badge--seed' : ''}`}>
            {world.visibility === 'public' ? tw('visibility.public') : tw('visibility.private')}
          </span>
          {world.myRole && <span className="badge badge--user">{roleLabel(world.myRole)}</span>}
          {user === null && (
            <span className="badge badge--readonly" title={tw('guest.badgeTitle')}>
              {tw('guest.badge')}
            </span>
          )}
          {world.myRole === 'viewer' && (
            <span className="badge badge--readonly" title={tw('viewer.readOnlyBadge')}>
              {tw('viewer.readOnlyBadge')}
            </span>
          )}
          {world.viewerNotice && <span className="viewer-notice">{world.viewerNotice}</span>}
          <span
            className={`stream-badge ${worldStreamStatus === 'down' ? 'stream-badge--down' : ''}`}
          >
            {worldStreamStatus === 'open'
              ? tw('streamStatus.live')
              : worldStreamStatus === 'down'
                ? tw('streamStatus.down')
                : tw('streamStatus.connecting')}
          </span>
        </div>
        <p
          className={
            descriptionExpanded || world.description.length <= DESCRIPTION_CLAMP_CHARS
              ? 'detail-header__description'
              : 'detail-header__description detail-header__description--clamped'
          }
        >
          {world.description}
          {world.description.length > DESCRIPTION_CLAMP_CHARS && (
            <button
              type="button"
              className="detail-header__description-toggle"
              onClick={() => setDescriptionExpanded(value => !value)}
            >
              {descriptionExpanded ? tw('descriptionCollapse') : tw('descriptionExpand')}
            </button>
          )}
        </p>
        {canRunSimulation && user === null && (
          /* plan-r81 B1: anonymous visitors of a public world read everything
             but operate nothing — the run/sim cluster collapses to a login
             prompt (the server already 403s anonymous control of the shared
             world session; anonymous ad-hoc sims are not a demo-day path). */
          <p className="guest-prompt">
            <Link className="link-button" to="/login">
              {tw('guest.loginToRun')}
            </Link>
          </p>
        )}
        {canRunSimulation && user !== null && (
          <>
            {/* R82: first-person interior walk — same ?zone deep-link convention.
                R2-BUG-01: 未选中 zone 时补默认 zone（第一个 zone），消除必挂的
                无 zone URL；环境无 zone 时漫游页会给显式降级页。 */}
            <Link className="link-button interior-walk__entry" to={`/environments/${routeEnvId}/walk${(() => {
              const walkZoneId = selection?.objectType === 'zone' ? selection.id : world.zones[0]?.id;
              return walkZoneId ? `?zone=${walkZoneId}` : '';
            })()}`}>
              <Footprints size={14} /> {ti('entry')}
            </Link>
            <div className="run-sim" ref={runSimRef}>
              {/* R75/F3: the shared world session is the DEFAULT target —
                  多用户环境的「运行仿真」进入/唤醒世界会话（所有成员共享同一
                  仿真实例，Agent 互相可见、协作真实发生），私有仿真降级为
                  次级入口（区域沙箱等用途）。 */}
              {worldSession?.simulationId !== undefined ? (
                <>
                  <button
                    className="primary-button"
                    disabled={simCheckPending}
                    title={tw('worldSessionRun.title')}
                    onClick={() => {
                      const simId = worldSession.simulationId!;
                      if (worldSession.status === 'hibernated') {
                        setSimCheckPending(true);
                        void api
                          .resumeSimulation(simId)
                          .then(() => openSimulationConsole(simId, world.id))
                          .catch((error: unknown) => {
                            pushToast(tw('worldSessionRun.wakeFailed', { error: String(error) }));
                          })
                          .finally(() => setSimCheckPending(false));
                      } else {
                        void openSimulationConsole(simId, world.id);
                      }
                    }}
                  >
                    {tw('worldSessionRun.button')}
                  </button>
                  <button
                    className="link-button"
                    disabled={noZonesSelected}
                    title={tw('worldSessionRun.privateTitle')}
                    onClick={() => {
                      // The pre-F3 behavior, kept for private sandboxes
                      // (zone-scoped experiments etc.).
                      void startSimulationForEnvironment(world.id, llmClient, scopedZoneIds);
                    }}
                  >
                    {tw('worldSessionRun.private')}
                  </button>
                </>
              ) : (
              <button
                className="primary-button"
                disabled={noZonesSelected || simCheckPending}
                title={noZonesSelected ? tw('zoneScope.noneSelected') : undefined}
                onClick={() => {
                  // R12-5c-B: never silently spawn a duplicate — when the env
                  // already has an active sim, offer 进入现有仿真 / 新建仿真.
                  // A failed list lookup must not block starting (old path).
                  setSimCheckPending(true);
                  void api
                    .listSimulations()
                    .then(simulations => {
                      const active = activeSimulationsOf(simulations, world.id);
                      if (active.length === 0) {
                        void startSimulationForEnvironment(world.id, llmClient, scopedZoneIds);
                      } else {
                        setSimChoice(active);
                      }
                    })
                    .catch(() => {
                      void startSimulationForEnvironment(world.id, llmClient, scopedZoneIds);
                    })
                    .finally(() => setSimCheckPending(false));
                }}
              >
                {tw('runSimulation')}
              </button>
              )}
              {simChoice !== null && simChoice[0] && (
                <div className="run-sim__popover" role="dialog" aria-label={tw('existingSim.aria')}>
                  <p className="run-sim__hint">
                    {tw('existingSim.title', { count: simChoice.length })}
                  </p>
                  {/* W2: 多个活跃仿真时给选择列表（曾只进入第一个）。 */}
                  {simChoice.length === 1 ? (
                    <button
                      className="primary-button"
                      onClick={() => {
                        const target = simChoice[0];
                        setSimChoice(null);
                        void openSimulationConsole(target.id, world.id);
                      }}
                    >
                      {tw('existingSim.enter')}
                    </button>
                  ) : (
                    <ul className="run-sim__list">
                      {simChoice.map(sim => (
                        <li key={sim.id}>
                          <button
                            className="primary-button run-sim__list-item"
                            onClick={() => {
                              setSimChoice(null);
                              void openSimulationConsole(sim.id, world.id);
                            }}
                          >
                            {tw('existingSim.enterItem', {
                              id: sim.id,
                              state: sim.state,
                              time: formatSimTime(sim.simTimeSec),
                            })}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    onClick={() => {
                      setSimChoice(null);
                      void startSimulationForEnvironment(world.id, llmClient, scopedZoneIds);
                    }}
                  >
                    {tw('existingSim.new')}
                  </button>
                  <button className="link-button" onClick={() => setSimChoice(null)}>
                    {tw('existingSim.dismiss')}
                  </button>
                </div>
              )}
            </div>
            {/* UX-W5: 会话概念人话引导——运行按钮旁一句情境说明 + 「区别？」
                popover（文字+说明形态，不打断流）。 */}
            <div className="session-guide" ref={sessionGuideRef}>
              <p className="session-guide__hint">{tw('sessionGuide.hint')}</p>
              <button
                type="button"
                className="link-button session-guide__toggle"
                aria-expanded={sessionGuideOpen}
                onClick={() => setSessionGuideOpen(open => !open)}
              >
                {tw('sessionGuide.toggle')}
              </button>
              {sessionGuideOpen && (
                <div className="session-guide__popover" role="note">
                  <p>{tw('sessionGuide.worldSession')}</p>
                  <p>{tw('sessionGuide.privateSim')}</p>
                </div>
              )}
            </div>
          </>
        )}
        {/* UX-W5 头部减负：核心动作（进入世界仿真 / 运行仿真）是唯一 primary；
            次级能力收进「⋯ 更多」菜单——业务流深链（任何登录用户）、LLM
            选择器、zone 范围与演示模式（可运行仿真时）。菜单项保留原功能
            与深链语义，仅换收纳位置。 */}
        {user !== null && (
          <div className="header-menu" ref={headerMenuRef}>
            <button
              type="button"
              className="header-menu__toggle"
              aria-expanded={headerMenuOpen}
              title={tw('headerMenu.title')}
              onClick={() => setHeaderMenuOpen(open => !open)}
            >
              {tw('headerMenu.button')}
            </button>
            {headerMenuOpen && (
              <div className="header-menu__popover" role="menu" aria-label={tw('headerMenu.aria')}>
                <Link
                  className="link-button header-menu__item"
                  to={`/environments/${world.id}/flows`}
                  onClick={() => setHeaderMenuOpen(false)}
                >
                  {tw('flowEditorLink')}
                </Link>
                {canRunSimulation && (
                  <>
                    <div className="llm-select-group">
                      <label className="llm-select">
                        {tw('llmMode')}
                        <select
                          value={llmClient}
                          onChange={event => setLlmClient(event.target.value as LlmClientPreset)}
                        >
                          {(Object.keys(LLM_OPTION_KEYS) as Array<LlmClientPreset>).map(value => (
                            <option key={value} value={value}>
                              {tw(LLM_OPTION_KEYS[value])}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="llm-select-group__hint">{tw(LLM_HINT_KEYS[llmClient])}</p>
                    </div>
                    {world.zones.length > 0 && (
                      <div className="zone-scope" ref={zoneScopeRef}>
                        <button
                          type="button"
                          className="zone-scope__toggle"
                          title={tw('zoneScope.title')}
                          onClick={() => setZoneScopeOpen(open => !open)}
                        >
                          {tw('zoneScope.summary', {
                            selected: world.zones.length - excludedZoneIds.size,
                            total: world.zones.length,
                          })}
                        </button>
                        {zoneScopeOpen && (
                          <div className="zone-scope__popover">
                            {world.zones.map(zone => (
                              <label key={zone.id} className="zone-scope__item">
                                <input
                                  type="checkbox"
                                  checked={!excludedZoneIds.has(zone.id)}
                                  onChange={() =>
                                    setExcludedZoneIds(current => toggleZoneExclusion(current, zone.id))
                                  }
                                />
                                {zone.name ?? zone.id}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {/* plan-r81 B2「演示模式」: only worlds carrying demo metadata
                        (T-032: tagline/heroEventId/recommendedPlaybackRate) get the
                        one-click demo entry. R2-UX-08: worlds WITHOUT demo metadata
                        get a disabled entry whose tooltip says why (and how to
                        author one) — a hidden entry teaches nothing. */}
                    {world.demo !== null && world.demo !== undefined ? (
                      <button
                        type="button"
                        className="control-button demo-mode-button"
                        disabled={demoBusy || noZonesSelected}
                        title={tw('demoMode.buttonTitle')}
                        onClick={() => {
                          setHeaderMenuOpen(false);
                          void startDemo();
                        }}
                      >
                        <MonitorPlay size={14} aria-hidden />{' '}
                        {demoBusy ? tw('demoMode.starting') : tw('demoMode.button')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="control-button demo-mode-button"
                        disabled
                        title={tw('demoMode.noScriptTitle')}
                      >
                        <MonitorPlay size={14} aria-hidden /> {tw('demoMode.button')}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </header>
      {simulationError && <div className="error-banner">{tw('simStartFailed', { error: simulationError })}</div>}
      {/* UX-W1: 会话 / 漂移 / 导读三条横幅统一进 BannerStack（条目内容在
          return 前的 worldBannerItems 组装，语义注释随迁）。 */}
      <BannerStack items={worldBannerItems} />
      {world.zones.length === 0 && (
        <p className="page-note">
          {tw('zones.emptyTitle')}
          {world.myRole === 'owner' ? tw('zones.emptyOwner') : tw('zones.emptyNonOwner')}
        </p>
      )}
      <div className="detail-body">
        {/*
          可拖拽分栏（react-resizable-panels）：画布 / 右侧栏。侧栏开合仍是
          条件渲染（折叠时不挂 Panel）；宽度百分比由 autoSaveId 持久化，
          maxSize 50% 放宽了旧手搓拖拽的 640px 封顶。Panel 显式 id/order
          ——条件渲染下没有稳定 id 时 autoSave 还原会错位。
        */}
        <PanelGroup direction="horizontal" autoSaveId="ac.worldPanels.v1" className="detail-body__panels">
          <Panel id="world-canvas" order={1} defaultSize={75} minSize={40} className="world-panel--canvas">
        <main className="world-canvas">
          <div className="layer-toggles">
            {(Object.keys(LAYER_LABEL_KEYS) as Array<keyof WorldLayers>).map(key => (
              <label key={key} className="layer-toggle">
                <input type="checkbox" checked={layers[key]} onChange={() => toggleLayer(key)} />
                {tw(LAYER_LABEL_KEYS[key])}
              </label>
            ))}
          </div>
          <div
            className="perspective-control canvas-view-control"
            role="group"
            aria-label={tw('view.aria')}
          >
            {CANVAS_VIEWS.map(view => (
              <button
                key={view}
                className={
                  activeView === view
                    ? 'perspective-control__button perspective-control__button--active'
                    : 'perspective-control__button'
                }
                onClick={() => setCanvasView(view)}
              >
                {tw(`view.${view}`)}
              </button>
            ))}
          </div>
          {user !== null && (
            <div className="perspective-control" role="group" aria-label={tw('perspective.aria')}>
              <button
                className={
                  perspective === 'global'
                    ? 'perspective-control__button perspective-control__button--active'
                    : 'perspective-control__button'
                }
                onClick={() => switchPerspective('global')}
              >
                {tw('perspective.global')}
              </button>
              <button
                className={
                  perspective === 'me'
                    ? 'perspective-control__button perspective-control__button--active'
                    : 'perspective-control__button'
                }
                onClick={() => switchPerspective('me')}
              >
                {tw('perspective.mine')}
              </button>
            </div>
          )}
          {focusOwnerId !== null && (
            <div className="perspective-banner">{tw('perspective.banner', { name: user?.displayName ?? '' })}</div>
          )}
          <Suspense fallback={<Loading className="world-canvas__fallback" label={tc('loading')} />}>
            {/* Placement banners ride all three canvas tiers (F7: the grid
                tier used to hide them, leaving an armed pick with no visible
                exit); the flows arm only through builder UI, so no extra
                role gate here. */}
            {(zoneDrawActive || devicePickArmed || geoPlacement !== null || vertexEditZoneId !== null || zoneBoundsEditId !== null) && (
              <>
                {zoneDrawActive && (
                  <div className="placement-banner placement-banner--interactive">
                    <span>{td('drawZoneBanner', { count: zoneDrawVertices.length })}</span>
                    <button
                      disabled={!canFinishPolygon(zoneDrawVertices)}
                      onClick={finishZoneDraw}
                    >
                      {td('finishDraw')}
                    </button>
                    <button onClick={cancelZoneDraw}>{td('cancelDraw')}</button>
                  </div>
                )}
                {!zoneDrawActive && vertexEditZoneId !== null && (
                  <div className="placement-banner placement-banner--interactive">
                    <span>{td('vertexEditBanner')}</span>
                    <button onClick={cancelZoneDraw}>{td('cancelDraw')}</button>
                  </div>
                )}
                {!zoneDrawActive && zoneBoundsEditId !== null && (
                  <div className="placement-banner placement-banner--interactive">
                    <span>{td('boundsEditBanner')}</span>
                    <button onClick={cancelZoneBoundsEdit}>{td('cancelDraw')}</button>
                  </div>
                )}
                {!zoneDrawActive && devicePickArmed && (
                  <div className="placement-banner placement-banner--interactive">
                    <span>{td('devicePickBanner')}</span>
                    <button onClick={cancelDevicePick}>{td('cancelPick')}</button>
                  </div>
                )}
                {!zoneDrawActive && !devicePickArmed && geoPlacement && (
                  <div className="placement-banner">
                    {activeView === '3d' ? td('geoPlacementBanner3d') : td('geoPlacementBanner')}
                  </div>
                )}
              </>
            )}
            {activeView === '3d' ? (
              <CampusScene
                zones={world.zones}
                storeyHeight={world.storeyHeight}
                envId={world.id}
                devices={model?.devices ?? []}
                agents={model?.agents ?? []}
                layers={layers}
                onSelect={selectObject}
                canBuild={canBuild}
                placementActive={
                  canBuild && (geoPlacement !== null || zoneDrawActive || devicePickArmed)
                }
                onPlacePick={handleMapClick}
                onPlaceDblClick={handleMapDblClick}
                onCancelPlacement={handleCancelPlacement}
                onDeviceMove={canBuild ? handleDeviceMove3d : undefined}
                focusZoneId={zoneParam}
                focusOwnerId={focusOwnerId}
                focusedZoneIds={focusedZoneIds}
              />
            ) : activeView === 'geo' && world.mapCenter ? (
              <GeoWorldMap
                model={model}
                center={world.mapCenter}
                zoom={world.mapZoom ?? undefined}
                layers={layers}
                selection={selection}
                snapshot={liveSnapshot}
                onSelect={selectObject}
                memberColorById={memberColorById}
                focusedZoneIds={focusedZoneIds}
                focusOwnerId={focusOwnerId}
                placementActive={
                  canBuild && (geoPlacement !== null || zoneDrawActive || devicePickArmed)
                }
                onMapClick={handleMapClick}
                drawActive={zoneDrawActive}
                drawVertices={zoneDrawVertices}
                onMapDblClick={handleMapDblClick}
                vertexEditActive={vertexEditZoneId !== null}
                onVertexMove={(index, latLng) => moveZoneDrawVertex(index, [latLng.lat, latLng.lng])}
                onVertexInsert={insertZoneDrawVertex}
                onVertexRemove={removeZoneDrawVertex}
              />
            ) : (
              <WorldMap
                model={model}
                layers={layers}
                selection={selection}
                onSelect={selectObject}
                snapshot={liveSnapshot}
                memberColorById={memberColorById}
                focusedZoneIds={focusedZoneIds}
                focusOwnerId={focusOwnerId}
                onDeviceDragStop={onDeviceDragStop}
                editableZoneId={canBuild ? zoneBoundsEditId : null}
                onZoneDragStop={onZoneDragStop}
                floorPlans={world.floorPlans ?? []}
              />
            )}
          </Suspense>
          {!mapHintDismissed && (
            <div className="map-hint" role="note">
              <span className="map-hint__text">{tw('mapHint.text')}</span>
              <button type="button" className="map-hint__dismiss" onClick={dismissMapHint}>
                {tw('mapHint.dismiss')}
              </button>
            </div>
          )}
        </main>
          {/* 侧栏开合钮吸附在画布 Panel 右缘（原先是行间独立一列，分栏后
              该位置被拖拽把手取代）。 */}
          <button
            className="world-sidebar__collapse"
            title={sidebarOpen ? td('collapseSidebar') : td('expandSidebar')}
            onClick={() => setSidebarOpen(open => !open)}
          >
            <Icon icon={sidebarOpen ? ChevronsRight : ChevronsLeft} size={14} />
          </button>
          </Panel>
          {sidebarOpen && <PanelResizeHandle className="resize-handle resize-handle--vertical" />}
          {sidebarOpen && (
            // defaultSize 25% ≈ 旧默认 360px（1440px 视口，窄屏 21%）；minSize
            // 20% ≈ 旧 320px 下限，maxSize 50% 放宽旧 640px 封顶（宽屏可读名单/报表）。
            <Panel id="world-sidebar" order={2} defaultSize={narrowViewport() ? 21 : 25} minSize={20} maxSize={50} className="world-panel--sidebar">
              <WorldSidebar
                world={world}
                tab={guardSidebarTabByRole(sidebarTab, world.myRole)}
                onTabChange={selectSidebarTab}
              />
            </Panel>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
