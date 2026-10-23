/**
 * SimulationView — live simulation console (W7 canvas-first layout):
 *
 * - detail header + ControlBar (the merged status header: state pill, live
 *   readouts, activity indicator, running-quiet guidance chip);
 * - the map fills the whole main area; AC collaborations render AS A LAYER
 *   ON THE MAP (edges between agent markers, derived from the event log via
 *   lib/collabGraph — the standalone CollaborationGraph is retired from the
 *   layout; decision bubbles stay);
 * - right drawer (injection + live panels) collapses to a thin rail, bottom
 *   event-log drawer expands from a header row — both persist; 专注模式
 *   (button or 'f') hides both for a pure map view; 演示模式 (ControlBar
 *   button, Esc to exit) goes further — only the map, a big-font environment
 *   readout bar (PresentReadout), the enlarged episode timeline and a minimal
 *   play/pause/speed bar stay on screen;
 * - ReplayBar: client-side timeline replay over the snapshot ring buffer,
 *   full-width at the bottom above the event drawer.
 *
 * The simulation may come from an environment (P2a: `simulationSource
 * 'environment'`, world detail in the store) or a legacy file scenario; both
 * are adapted into the shared world model, and `scenarioFromEnvironment`
 * reshapes the environment for the legacy scenario-based panels.
 *
 * Data flow (server-authoritative):
 * - REST snapshot poll every 1500 ms stays the GROUND TRUTH and also feeds
 *   the replay ring buffer. Requests never overlap; the interval is cleared
 *   on unmount.
 * - The WS event stream (useSimulationStream) enriches: events → event log /
 *   collaboration map layer; stream snapshots apply only when strictly fresher.
 * - Replay mode never mutates the live slices: `selectRenderedSnapshot`
 *   picks the buffered snapshot at the replay cursor for the map/panels.
 *
 * Decision bubbles: new entries in `recentDecisions` (live snapshot only)
 * float a ~5s bubble near the deciding agent's first managed zone; at most
 * MAX_BUBBLES_PER_ZONE concurrent bubbles per zone (newest win).
 *
 * Activity rings: devices whose state changed between the last two rendered
 * snapshots get a ~2s pulse ring on their dot (live mode only).
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, ChevronUp } from 'lucide-react';
// 可拖拽分栏：控制台两抽屉（右/底）由固定尺寸改为用户可拖、autoSaveId 持久化。
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import * as api from '../api/client';
import {
  capCollabEdges,
  collabEdgesEqual,
  dedupeCollabEdges,
  deriveCollabEdges,
  filterRecentCollabEdges,
  type CollabEdge,
} from '../lib/collabGraph';
import { localizedText } from '../lib/locale';
import {
  hasPersistedConsoleLayout,
  loadConsoleLayoutForEntry,
  saveConsoleLayout,
  toggleEventDrawer,
  toggleFocusMode,
  togglePanel,
  toggleRightDrawer,
} from '../lib/consoleLayout';
import { colorForUserId } from '../lib/memberColors';
import { selectRenderedSnapshot } from '../lib/replay';
import { useSimulationEpisodes } from '../lib/useEpisodes';
import { useEnvTimeseries } from '../lib/useEnvTimeseries';
import { useSimulationStream } from '../lib/useSimulationStream';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import {
  scenarioFromEnvironment,
  worldModelFromEnvironment,
  worldModelFromScenario,
} from '../lib/worldModel';
import { useAppStore } from '../store/useAppStore';
import { ControlBar } from '../components/ControlBar';
import { DeviceActionSheet } from '../components/DeviceActionSheet';
import { DemoPlaylistBar } from '../components/DemoPlaylistBar';
import { demoPlayableState, extractDemoEvents, nextSceneIndex, stepToInChunks } from '../lib/demoPlaylist';
import { AgentChatPanel } from '../components/AgentChatPanel';
import { CollaborationsPanel } from '../components/CollaborationsPanel';
import { HeroLine } from '../components/HeroLine';
import { LlmStatusBar } from '../components/LlmStatusBar';
// Canvas-level code splitting: the console's map canvases pull leaflet /
// reactflow — they load on first mount instead of joining this chunk.
import type { DecisionBubble, WorldSelection } from '../components/worldmap/WorldMap';
import { EpisodesPanel } from '../components/EpisodesPanel';
import { EvalReportPanel } from '../components/EvalReportPanel';
import { EventInjectPanel } from '../components/EventInjectPanel';
import { FaultPanel } from '../components/FaultPanel';
import { EventLogPanel } from '../components/EventLogPanel';
import { LivePanels } from '../components/LivePanels';
import { PresentReadout } from '../components/PresentReadout';
import { ReplayBar } from '../components/ReplayBar';
import { Icon } from '../components/ui/Icon';
import { Loading } from '../components/ui/Loading';

const GeoWorldMap = lazy(() =>
  import('../components/worldmap/GeoWorldMap').then(m => ({ default: m.GeoWorldMap })),
);
const WorldMap = lazy(() => import('../components/worldmap/WorldMap').then(m => ({ default: m.WorldMap })));

const POLL_INTERVAL_MS = 1500;

/** Stable empty edge array (R31 F2): replay mode's overlay stays identity-
 * stable so the map graph memo holds while scrubbing the timeline. */
const EMPTY_COLLAB_EDGES: readonly CollabEdge[] = [];

/** R15-B2: how long each demo scene stays frozen for the audience (wall). */
const DEMO_DWELL_MS = 4000;/** Decisions younger than this highlight the affected zones. */
const HIGHLIGHT_WINDOW_MS = 4000;
const BUBBLE_TTL_MS = 5000;
const MAX_BUBBLES_PER_ZONE = 3;
/** Prune the seen-decision key set well past the server's ring buffer size. */
const MAX_SEEN_DECISIONS = 2000;
/** How long a device dot keeps its activity ring after a state change. */
const ACTIVITY_RING_MS = 2000;

/**
 * 窄屏（≤1280px）默认分栏收窄一档：Panel 的 defaultSize 是静态百分比且只在
 * 无持久化布局（autoSaveId 无记录）时生效，挂载时读一次视口宽度即可；
 * 内边距侧的收窄见 styles.css 末尾的 @media (max-width: 1280px)。
 */
function narrowViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 1280;
}

/**
 * UX-W1: ≤1024px 视口右抽屉是悬浮开合的覆盖式抽屉（样式见 styles.css
 * UX-W1 段），首次进控制台默认收起、地图优先。
 */
function drawerViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 1024;
}
/**
 * W2 first-visit console tips: dismissed state persists under its own key
 * (simple boolean flag — lighter than folding into the ConsoleLayout v2 blob).
 */
const CONSOLE_TIPS_KEY = 'ac.consoleTips.dismissed';

function loadConsoleTipsDismissed(): boolean {
  try {
    return window.localStorage.getItem(CONSOLE_TIPS_KEY) === '1';
  } catch {
    return false;
  }
}

interface LiveBubble extends DecisionBubble {
  expiresAt: number;
}

/**
 * A5 progressive disclosure: right-drawer panels sit behind collapsible
 * section headers (link-button + chevron, same pattern as LivePanels); the
 * open state persists via ConsoleLayout.panels. The panels' own h3 titles
 * are hidden by CSS (.console-section > .live-panel > .side-panel__title)
 * so the header stays the single title.
 */
function ConsoleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="console-section">
      <button className="link-button console-section__header" onClick={onToggle}>
        <Icon icon={open ? ChevronDown : ChevronRight} size={14} /> {title}
      </button>
      {open && children}
    </div>
  );
}

export function SimulationView() {
  const world = useAppStore(s => s.world);
  const currentScenario = useAppStore(s => s.currentScenario);
  const snapshot = useAppStore(s => s.snapshot);
  const simulationInfo = useAppStore(s => s.simulationInfo);
  const renderedSnapshot = useAppStore(selectRenderedSnapshot);
  const replayActive = useAppStore(s => s.replayActive);
  const simulationId = useAppStore(s => s.simulationId);
  const setSnapshot = useAppStore(s => s.setSnapshot);
  const setSimulationError = useAppStore(s => s.setSimulationError);
  const backToDetail = useAppStore(s => s.backToDetail);
  const { t } = useTranslation('simView');

  const [bubbles, setBubbles] = useState<LiveBubble[]>([]);
  const seenDecisionsRef = useRef<Set<string>>(new Set());
  // 演示模式（Wave-2）：纯前端开关，隐藏全部管理 UI，只留地图/读数/叙事。
  const [present, setPresent] = useState(false);
  // W2 first-visit tips: shown once (non-present mode), dismiss persists.
  const [tipsDismissed, setTipsDismissed] = useState(loadConsoleTipsDismissed);
  // W4: object picked on the console map — zone picks drive the PresentReadout
  // / EnvSeriesPanel linkage; agent picks highlight the marker and draw its
  // device binding edges. Local state (the store's world selection belongs to
  // the world view).
  const [mapSelection, setMapSelection] = useState<WorldSelection | null>(null);
  const mapSelectedZoneId = mapSelection?.objectType === 'zone' ? mapSelection.id : null;
  // UX-W1-B: a picked device dot opens the DeviceActionSheet (quick commands)
  // docked over the map's bottom edge. Execute stays owner/builder-only —
  // viewers and anonymous readers of a public environment see the command
  // face without the execute button; the legacy scenario console has no
  // membership concept and keeps full access.
  const mapSelectedDeviceId = mapSelection?.objectType === 'device' ? mapSelection.id : null;
  // R31 F14: identity-stable map onSelect — an inline closure re-created the
  // prop on every render, invalidating the grid map's buildGraph memo (the
  // setter from useState is stable, so the deps list is empty).
  const handleMapSelect = useCallback((next: WorldSelection | null) => {
    setMapSelection(next);
  }, []);
  const dismissTips = () => {
    setTipsDismissed(true);
    try {
      window.localStorage.setItem(CONSOLE_TIPS_KEY, '1');
    } catch {
      // Non-fatal: the tips just reappear on the next visit.
    }
  };

  // W7 canvas-first layout: drawer/focus state, persisted in localStorage.
  // R84-F6: a fresh console mount never starts in focus mode (see
  // loadConsoleLayoutForEntry) — entering into a drawers-hidden console hid
  // the chat with zero feedback.
  const [layout, setLayout] = useState(() => {
    const entry = loadConsoleLayoutForEntry();
    // UX-W1: ≤1024px 视口的首次进入右抽屉默认收起（地图优先，悬浮钮开合）；
    // 已持久化过布局的用户选择不受影响。
    if (entry.rightOpen && drawerViewport() && !hasPersistedConsoleLayout()) {
      return { ...entry, rightOpen: false };
    }
    return entry;
  });
  // W8: the bottom drawer defaults to the episode narrative; the raw event
  // log stays available as the secondary tab.
  const [drawerTab, setDrawerTab] = useState<'episodes' | 'raw' | 'eval'>('episodes');
  const applyLayout = (updater: (current: typeof layout) => typeof layout) => {
    setLayout(current => {
      const next = updater(current);
      saveConsoleLayout(next);
      return next;
    });
  };

  // R79 (A3): the Agent 对话 section must exist the moment a simulation is
  // known. Before the first snapshot lands (or on a stopped sim whose store
  // snapshot cleared) renderedSnapshot is null and the section vanished
  // entirely — the R79 personas' "控制台无对话面板" — even though the drawer
  // itself was open. Fall back to the world's agent list until then.
  const chatAgentsFallback = useMemo(
    () => (world?.agents ?? []).map(agent => ({ id: agent.id, name: agent.name })),
    [world],
  );

  // 专注模式 keyboard shortcut ('f'); ignored while typing in a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'f' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      applyLayout(toggleFocusMode);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Esc exits 演示模式 (registered only while it is active).
  useEffect(() => {
    if (!present) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPresent(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [present]);

  // AC collaboration map layer (W7): derive edges from the event log with a
  // 1s wall-clock ticker so terminal edges fade out on schedule. Replay
  // suppresses the live overlay (like decision bubbles).
  const eventLog = useAppStore(s => s.eventLog);
  const [collabNow, setCollabNow] = useState(() => Date.now());
  const hasCollabEvents = eventLog.some(e => e.family === 'collaboration');
  const collabEdges = useMemo(() => {
    // The store log is newest-first; derivation expects chronological order.
    const chronological = [...eventLog.map(e => e.event)].reverse();
    return capCollabEdges(dedupeCollabEdges(deriveCollabEdges(chronological, collabNow)));
  }, [eventLog, collabNow]);
  // R31 F3: the ticker only exists while an edge can still age out (edges
  // live ≤ ACTIVE_KEEP_MS after their last event), and each tick advances
  // `collabNow` ONLY when the re-derived set actually differs (an edge
  // crossed its keep window). A no-change second therefore costs one cheap
  // derivation over the capped log and ZERO re-renders — the pre-R31
  // behavior rebuilt the whole map at 1 Hz forever after any collaboration.
  const eventLogRef = useRef(eventLog);
  eventLogRef.current = eventLog;
  const collabEdgesRef = useRef(collabEdges);
  collabEdgesRef.current = collabEdges;
  useEffect(() => {
    if (!hasCollabEvents || collabEdges.length === 0) return;
    const handle = window.setInterval(() => {
      const next = Date.now();
      const chronological = [...eventLogRef.current.map(e => e.event)].reverse();
      const nextEdges = capCollabEdges(
        dedupeCollabEdges(deriveCollabEdges(chronological, next)),
      );
      if (collabEdgesEqual(nextEdges, collabEdgesRef.current)) return;
      setCollabNow(next);
    }, 1000);
    return () => window.clearInterval(handle);
  }, [hasCollabEvents, collabEdges.length]);
  // R14 P0-3: by default the map draws only edges active in the last 60s —
  // a busy collaboration run otherwise turns into spaghetti. The「显示全部
  // 协作边」toggle restores the full derived set.
  const [showAllCollabEdges, setShowAllCollabEdges] = useState(false);

  // R31 F2: the edges handed to the map layers are MEMOIZED — an inline
  // array here rebuilt every render (1s tickers, bubbles, layout toggles…)
  // defeated buildGraph's memo and re-triggered the geo overlay effect even
  // when not a single edge changed. The `[]` branch keeps a module-level
  // constant so replay mode yields a stable identity too.
  const renderedCollabEdges = useMemo(
    () =>
      replayActive
        ? EMPTY_COLLAB_EDGES
        : showAllCollabEdges
          ? collabEdges
          : filterRecentCollabEdges(collabEdges, collabNow),
    [replayActive, showAllCollabEdges, collabEdges, collabNow],
  );

  // The console renders from an environment (world view) or a legacy scenario.
  const consoleScenario = useMemo(
    () => (world ? scenarioFromEnvironment(world) : currentScenario),
    [world, currentScenario],
  );
  const mapModel = useMemo(
    () => (world ? worldModelFromEnvironment(world) : currentScenario ? worldModelFromScenario(currentScenario) : null),
    [world, currentScenario],
  );
  // UX-W1-B: the picked device's model row + live snapshot row for the
  // DeviceActionSheet (rendered below, docked inside .console-main).
  const actionSheetDevice = useMemo(
    () => (mapSelectedDeviceId ? mapModel?.devices.find(d => d.id === mapSelectedDeviceId) ?? null : null),
    [mapModel, mapSelectedDeviceId],
  );
  const actionSheetLive = useMemo(
    () => (mapSelectedDeviceId ? renderedSnapshot?.devices.find(d => d.id === mapSelectedDeviceId) : undefined),
    [renderedSnapshot, mapSelectedDeviceId],
  );
  const actionSheetZoneName = useMemo(() => {
    if (!actionSheetDevice) return undefined;
    return mapModel?.zones.find(z => z.id === actionSheetDevice.zoneId)?.name;
  }, [mapModel, actionSheetDevice]);
  const canExecuteDeviceCommand =
    world === null || world.myRole === 'owner' || world.myRole === 'builder';
  // R14 P1-3: the narrative timeline derives from decisions (injected events
  // never echo on the bus), so the drawer header counts EPISODES from the
  // same derivation as the panel — a raw eventLog count would read「0 条事
  // 件」while the activity indicator (decision-driven) says「距上次活动 8s」.
  const { episodes } = useSimulationEpisodes(mapModel);
  const memberColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of world?.members ?? []) {
      // userId is redacted for non-member viewers (Fix-4) — skip id-less entries.
      if (member.userId !== undefined) {
        map.set(member.userId, colorForUserId(member.userId));
      }
    }
    return map;
  }, [world]);

  // Wave-2 demo hints: the hero event (meta.heroEventId resolved against the
  // scenario's event list) drives ControlBar's「高光时刻」jump; only legacy
  // scenario simulations carry it — environment imports have no scenario
  // source link, so their consoleScenario.meta never sets heroEventId.
  const heroEvent = useMemo(() => {
    const id = consoleScenario?.meta.heroEventId;
    if (!id) return null;
    const event = consoleScenario?.events.find(e => e.id === id);
    if (!event || event.atSimTimeSec === undefined) return null;
    return { id, atSimTimeSec: event.atSimTimeSec };
  }, [consoleScenario]);

  // R15-B2: one-click「应用高光」player. Scene sequencing: jump (step --to,
  // the event fires on the way) → pause for the audience → dwell → next.
  // Refs keep the setTimeout chain free of stale closures; the wall clock
  // (not sim speed) paces the dwell so every scene is readable.
  const demoScenes = useMemo(
    () => extractDemoEvents(consoleScenario?.events ?? []),
    [consoleScenario],
  );
  const demoScenesRef = useRef(demoScenes);
  demoScenesRef.current = demoScenes;
  const [demoIndex, setDemoIndex] = useState<number | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const demoTimerRef = useRef<number | null>(null);
  const demoPlayState = demoPlayableState(demoScenes, snapshot?.simTimeSec);

  const clearDemoTimer = () => {
    if (demoTimerRef.current !== null) {
      window.clearTimeout(demoTimerRef.current);
      demoTimerRef.current = null;
    }
  };
  const playDemoScene = async (index: number): Promise<void> => {
    if (!simulationId) return;
    const scenes = demoScenesRef.current;
    if (index >= scenes.length) {
      setDemoIndex(null); // script finished — leave the sim paused on the finale
      return;
    }
    const scene = scenes[index]!;
    setDemoBusy(true);
    try {
      const current = useAppStore.getState().snapshot?.simTimeSec ?? 0;
      if (scene.atSimTimeSec > current) {
        // T-114: walk in ≤EAF_MAX_STEP_TICKS chunks — one big step --to
        // (28800s on a fresh 1× sim) would 422 STEP_TOO_LARGE and abort
        // the demo. The landed sim time (the server may overshoot each
        // target by < speed) paces the next chunk; the sim's own speed
        // sizes them.
        const speed = useAppStore.getState().snapshot?.speed ?? 1;
        await stepToInChunks(
          scene.atSimTimeSec,
          current,
          speed,
          async target => (await api.stepSimulationTo(simulationId, target)).simTimeSec,
        );
        await api.pauseSimulation(simulationId).catch(() => {
          // created-state sims cannot pause — the scene is still on stage.
        });
      }
      if (scene.zoneId) setMapSelection({ objectType: 'zone', id: scene.zoneId });
      setDemoIndex(index);
      clearDemoTimer();
      demoTimerRef.current = window.setTimeout(() => void playDemoScene(index + 1), DEMO_DWELL_MS);
    } catch (error) {
      setSimulationError(error instanceof Error ? error.message : String(error));
      setDemoIndex(null);
    } finally {
      setDemoBusy(false);
    }
  };
  const startDemo = () => {
    if (!simulationId) return;
    const index = nextSceneIndex(demoScenesRef.current, snapshot?.simTimeSec ?? 0);
    if (index >= demoScenesRef.current.length) return;
    setDemoIndex(index);
    void playDemoScene(index);
  };
  const stopDemo = () => {
    clearDemoTimer();
    setDemoIndex(null);
  };
  useEffect(() => clearDemoTimer, []);

  // 演示模式读数条的聚焦 zone：地图上点选的 zone → 选中 Agent 的第一个管
  // 辖 zone → hero 事件 zone → 第一个 zone。
  const selectedAgentId = useAppStore(s => s.selectedAgentId);
  const presentZoneId = useMemo(() => {
    const zones = renderedSnapshot?.zones ?? [];
    if (mapSelectedZoneId && zones.some(z => z.id === mapSelectedZoneId)) {
      return mapSelectedZoneId;
    }
    if (selectedAgentId) {
      const managed = renderedSnapshot?.agents.find(a => a.id === selectedAgentId)
        ?.managedZoneIds[0];
      if (managed) return managed;
    }
    if (heroEvent) {
      const event = consoleScenario?.events.find(e => e.id === heroEvent.id);
      if (event && zones.some(z => z.id === event.zoneId)) return event.zoneId;
    }
    return zones[0]?.id ?? null;
  }, [renderedSnapshot, mapSelectedZoneId, selectedAgentId, heroEvent, consoleScenario]);

  useSimulationStream(simulationId);

  // 环境时序缓冲（W: 环境曲线面板）：只累积 LIVE snapshot，回放游标移动
  // 不污染曲线；重复 tick 由 appendSnapshot identity 去重。
  const envSeries = useEnvTimeseries(snapshot);

  // REST ground-truth polling (+ replay buffer append via setSnapshot).
  // T-028/EA-F05: a poll failure stamps simulationError, and ONLY the poll's
  // own next success clears it again (pollErrorRef) — one flaky round trip
  // (laptop sleep/wake, WiFi blip) used to leave a permanent "操作失败" line;
  // control-action errors are NOT cleared by the poll (they keep their
  // message until the next control click, as before).
  // R31 F12: the cadence is visibility-gated (useVisibleInterval) — no
  // polling in a hidden tab, one catch-up tick on return. A resolved round
  // trip is dropped when the console has since switched simulations (the
  // store id check replaces the old effect's `cancelled` flag).
  const pollErrorRef = useRef(false);
  const pollInFlightRef = useRef(false);
  useVisibleInterval(() => {
    const simId = useAppStore.getState().simulationId;
    if (!simId) return;
    void (async () => {
      // Skip while stopped (final snapshot stays on screen) and never
      // overlap requests — a slow round trip skips this tick.
      if (pollInFlightRef.current) return;
      if (useAppStore.getState().snapshot?.state === 'stopped') return;
      pollInFlightRef.current = true;
      try {
        const fresh = await api.getSnapshot(simId);
        if (useAppStore.getState().simulationId === simId) {
          setSnapshot(fresh);
          if (pollErrorRef.current) {
            pollErrorRef.current = false;
            setSimulationError(null);
          }
        }
      } catch (error) {
        if (useAppStore.getState().simulationId === simId) {
          pollErrorRef.current = true;
          setSimulationError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        pollInFlightRef.current = false;
      }
    })();
  }, POLL_INTERVAL_MS, simulationId !== null);

  // Decision bubbles: spawn on unseen decisions from the LIVE snapshot.
  useEffect(() => {
    if (!snapshot) return;
    const now = Date.now();
    const seen = seenDecisionsRef.current;
    if (seen.size > MAX_SEEN_DECISIONS) {
      seen.clear();
      for (const d of snapshot.recentDecisions) seen.add(`${d.agentId}:${d.eventId}:${d.at}`);
    }
    const fresh: LiveBubble[] = [];
    for (const decision of snapshot.recentDecisions) {
      const key = `${decision.agentId}:${decision.eventId}:${decision.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const agent = snapshot.agents.find(a => a.id === decision.agentId);
      const zoneId = agent?.managedZoneIds[0];
      if (!zoneId) continue;
      fresh.push({
        id: key,
        zoneId,
        text: decision.decision,
        source: decision.decisionSource,
        expiresAt: now + BUBBLE_TTL_MS,
      });
    }
    if (fresh.length === 0) return;
    setBubbles(prev => {
      const next = [...prev.filter(b => b.expiresAt > now), ...fresh];
      // Cap per zone, newest win.
      const kept = new Map<string, number>();
      return next.filter(bubble => {
        const count = kept.get(bubble.zoneId) ?? 0;
        if (count >= MAX_BUBBLES_PER_ZONE) return false;
        kept.set(bubble.zoneId, count + 1);
        return true;
      });
    });
  }, [snapshot]);

  // Bubble expiry sweep.
  useEffect(() => {
    if (bubbles.length === 0) return;
    const handle = window.setInterval(() => {
      const now = Date.now();
      setBubbles(prev => (prev.some(b => b.expiresAt <= now) ? prev.filter(b => b.expiresAt > now) : prev));
    }, 1000);
    return () => window.clearInterval(handle);
  }, [bubbles.length]);

  // Zones to pulse: zones of scheduled events that recently fired, plus the
  // managed zones of agents with a decision in the last few seconds. Driven
  // by the rendered snapshot so replay shows that moment's highlights.
  const highlightZoneIds = useMemo(() => {
    const zones = new Set<string>();
    if (!renderedSnapshot) return zones;
    const now = Date.now();
    const agentZones = new Map(renderedSnapshot.agents.map(a => [a.id, a.managedZoneIds]));
    for (const decision of renderedSnapshot.recentDecisions) {
      const at = Date.parse(decision.at);
      if (Number.isNaN(at) || now - at > HIGHLIGHT_WINDOW_MS) continue;
      const event = consoleScenario?.events.find(e => e.id === decision.eventId);
      if (event) zones.add(event.zoneId);
      for (const zoneId of agentZones.get(decision.agentId) ?? []) {
        zones.add(zoneId);
      }
    }
    return zones;
  }, [renderedSnapshot, consoleScenario]);

  // Activity rings: dots of devices whose state changed in the latest
  // rendered snapshot pulse briefly (live mode only, not while replaying).
  const [activeDeviceIds, setActiveDeviceIds] = useState<ReadonlySet<string>>(new Set());
  // R31 F11: per-device {state reference → cached serialization} — the
  // reference is checked BEFORE JSON.stringify. On the WS delta path only
  // the changed device gets a fresh state object, so 38 of 39 devices skip
  // serialization entirely each tick.
  const prevDeviceStatesRef = useRef<Map<string, { state: unknown; serialized: string }>>(new Map());
  useEffect(() => {
    if (!renderedSnapshot || replayActive) return;
    const prev = prevDeviceStatesRef.current;
    const next = new Map<string, { state: unknown; serialized: string }>();
    const changed: string[] = [];
    for (const device of renderedSnapshot.devices) {
      const cached = prev.get(device.id);
      if (cached && cached.state === device.state) {
        next.set(device.id, cached);
        continue;
      }
      const serialized = JSON.stringify(device.state);
      next.set(device.id, { state: device.state, serialized });
      if (cached && cached.serialized !== serialized) changed.push(device.id);
    }
    prevDeviceStatesRef.current = next;
    if (changed.length === 0) return;
    setActiveDeviceIds(current => new Set([...current, ...changed]));
    const handle = window.setTimeout(() => {
      setActiveDeviceIds(current => {
        const updated = new Set(current);
        for (const id of changed) updated.delete(id);
        return updated;
      });
    }, ACTIVITY_RING_MS);
    return () => window.clearTimeout(handle);
  }, [renderedSnapshot, replayActive]);

  if (!consoleScenario || !mapModel) {
    return (
      <div className="page-note page-note--error">
        <p>{t('missingScenario')}</p>
        <button onClick={backToDetail}>{t('back')}</button>
      </div>
    );
  }

  // 事件抽屉头部行在折叠态（分栏之外的独立行）与打开态（分栏 Panel 内）各渲染
  // 一次——抽成共享片段，两处语义保持一致（整开/整关按钮 + 统计摘要）。
  const eventDrawerHeader = (
    <button
      className="event-drawer__header"
      onClick={() => applyLayout(toggleEventDrawer)}
      title={layout.eventOpen ? t('collapseNarrative') : t('expandNarrative')}
    >
      <span>
        {t('narrativeSummary', {
          episodes: episodes.length,
          events: eventLog.length,
          action: layout.eventOpen ? t('narrativeActionCollapse') : t('narrativeActionExpand'),
        })}
      </span>
      <span className="event-drawer__chevron">
        <Icon icon={layout.eventOpen ? ChevronDown : ChevronUp} size={13} />
      </span>
    </button>
  );

  return (
    <div
      className={`simulation-view${layout.focus ? ' simulation-view--focus' : ''}${
        present ? ' simulation-view--present' : ''
      }`}
    >
      {!present && (
        <header className="detail-header">
          <button className="link-button" onClick={backToDetail}>
            <Icon icon={ArrowLeft} size={14} /> {t('back')}
          </button>
          <div className="detail-header__meta">
            <h2>{localizedText(consoleScenario.meta.name) ?? consoleScenario.meta.id} — {t('consoleTitle')}</h2>
            <span className="detail-header__id">{simulationId}</span>
          </div>
          <button
            className={`focus-toggle${layout.focus ? ' focus-toggle--active' : ''}`}
            title={t('focusToggleTitle')}
            onClick={() => applyLayout(toggleFocusMode)}
          >
            {layout.focus ? t('focusExit') : t('focusEnter')}
          </button>
        </header>
      )}
      {/* T3 三层收敛之①状态带：ControlBar（控制 + 读数）+ 头条（HeroLine）
          + LLM 状态 + 演示剧本合成一条状态带，不再各自占一行散落首屏。 */}
      {present ? (
        <>
          <ControlBar snapshot={snapshot} present onExitPresent={() => setPresent(false)} />
          {/* R15-B2: the demo script player stays visible in present mode too —
              演示模式 + 播放剧本 is the demo-day combo. */}
          <DemoPlaylistBar
            scenes={demoScenes}
            currentIndex={demoIndex}
            state={demoPlayState}
            busy={demoBusy}
            onStart={startDemo}
            onStop={stopDemo}
          />
        </>
      ) : (
        <div className="status-band">
          <ControlBar
            snapshot={snapshot}
            heroEvent={heroEvent}
            onEnterPresent={() => setPresent(true)}
          />
          <div className="status-band__meta">
            {/* R14 P0-2「正在发生」头条：最新决策（含 reasoning）> 最新事件 > 占位。
                UX-06：initiate_ac 头条点名伙伴 agent 并跟随握手终结态。 */}
            <HeroLine
              snapshot={snapshot}
              scenarioEvents={consoleScenario.events}
              simulationId={simulationId}
              stopped={snapshot?.state === 'stopped'}
            />
            {/* 显眼的 LLM 状态行（可用性修复）：模式 + 模型名 + 降级 warning。
                sim info 缺失时（从列表直开控制台）退化为按快照 agent 标志推导模式。 */}
            <LlmStatusBar
              llm={simulationInfo?.llm ?? (snapshot?.agents.some(a => a.llmEnabled) ? 'llm' : 'rule-only')}
              llmModel={simulationInfo?.llmModel}
              llmWarning={simulationInfo?.llmWarning}
            />
            <DemoPlaylistBar
              scenes={demoScenes}
              currentIndex={demoIndex}
              state={demoPlayState}
              busy={demoBusy}
              onStart={startDemo}
              onStop={stopDemo}
            />
          </div>
        </div>
      )}
      {present && <PresentReadout snapshot={renderedSnapshot} zoneId={presentZoneId} />}
      {!present && !tipsDismissed && (
        <div className="console-tips" data-testid="console-tips">
          <span className="console-tips__title">{t('tips.title')}</span>
          <ul className="console-tips__list">
            <li>{t('tips.speed')}</li>
            <li>{t('tips.drawer')}</li>
            <li>{t('tips.eval')}</li>
          </ul>
          <button className="link-button console-tips__dismiss" onClick={dismissTips}>
            {t('tips.dismiss')}
          </button>
        </div>
      )}
      {present ? (
        // 演示模式维持原样的纯地图布局（不挂分栏）：叙事时间线放大版取代
        // 回放条与事件抽屉。
        <>
          <div className="console-body">
            <main className="console-main">
              <Suspense fallback={<Loading className="console-map__fallback" label={t('loading')} />}>
                {world?.mapType === 'geo' && world.mapCenter ? (
                  <GeoWorldMap
                    model={mapModel}
                    center={world.mapCenter}
                    zoom={world.mapZoom ?? undefined}
                    snapshot={renderedSnapshot}
                    highlightZoneIds={highlightZoneIds}
                    bubbles={replayActive ? [] : bubbles}
                    activeDeviceIds={activeDeviceIds}
                    memberColorById={memberColorById}
                    collabEdges={renderedCollabEdges}
                    selection={mapSelection}
                    onSelect={handleMapSelect}
                  />
                ) : (
                  <WorldMap
                    model={mapModel}
                    snapshot={renderedSnapshot}
                    highlightZoneIds={highlightZoneIds}
                    bubbles={replayActive ? [] : bubbles}
                    activeDeviceIds={activeDeviceIds}
                    memberColorById={memberColorById}
                    collabEdges={renderedCollabEdges}
                    selection={mapSelection}
                    onSelect={handleMapSelect}
                  />
                )}
              </Suspense>
            </main>
          </div>
          <div className="present-episodes">
            <EpisodesPanel model={mapModel} episodes={episodes} variant="present" />
          </div>
        </>
      ) : (
        <>
          {/*
            可拖拽分栏（react-resizable-panels）：垂直组 = 主区 / 底部事件抽屉，
            主区内嵌水平组 = 地图 / 右抽屉。抽屉开合仍是条件渲染（折叠时整个
            Panel 不挂载，开合语义与 localStorage 布局不变）；百分比尺寸由
            autoSaveId 持久化。Panel 显式 id/order——条件渲染会改变子节点序号，
            没有稳定 id 时 autoSave 还原会错位。专注模式不挂两个抽屉 Panel。
          */}
          <PanelGroup direction="vertical" autoSaveId="ac.consolePanels.v1" className="console-panels">
            <Panel id="console-main" order={1} defaultSize={65} minSize={30} className="console-panels__main">
              <PanelGroup
                direction="horizontal"
                autoSaveId="ac.consolePanelsH.v1"
                className="console-body"
              >
                <Panel id="console-map" order={1} defaultSize={76} minSize={40} className="console-panel--map">
                  <main className="console-main">
                    {hasCollabEvents && !replayActive && (
                      // R14 P0-3: 协作边默认只画最近 60s 有活动的；此开关可全开。
                      <div className="layer-toggles console-collab-toggle">
                        <label className="layer-toggle" title={t('collabShowAllHint')}>
                          <input
                            type="checkbox"
                            checked={showAllCollabEdges}
                            onChange={() => setShowAllCollabEdges(v => !v)}
                          />
                          {t('collabShowAll')}
                        </label>
                      </div>
                    )}
                    <Suspense fallback={<Loading className="console-map__fallback" label={t('loading')} />}>
                      {world?.mapType === 'geo' && world.mapCenter ? (
                        // Geo map tier (§11.4): the console renders on the same Leaflet
                        // canvas as the world view — live zone params, decision pulse,
                        // activity rings and bubbles overlay the real geography.
                        <GeoWorldMap
                          model={mapModel}
                          center={world.mapCenter}
                          zoom={world.mapZoom ?? undefined}
                          snapshot={renderedSnapshot}
                          highlightZoneIds={highlightZoneIds}
                          bubbles={replayActive ? [] : bubbles}
                          activeDeviceIds={activeDeviceIds}
                          memberColorById={memberColorById}
                          collabEdges={renderedCollabEdges}
                          selection={mapSelection}
                          onSelect={handleMapSelect}
                        />
                      ) : (
                        <WorldMap
                          model={mapModel}
                          snapshot={renderedSnapshot}
                          highlightZoneIds={highlightZoneIds}
                          bubbles={replayActive ? [] : bubbles}
                          activeDeviceIds={activeDeviceIds}
                          memberColorById={memberColorById}
                          collabEdges={renderedCollabEdges}
                          selection={mapSelection}
                          onSelect={handleMapSelect}
                        />
                      )}
                    </Suspense>
                    {actionSheetDevice && simulationId && (
                      // UX-W1-B: 设备直达操作卡——点选设备点即出，关掉即清空选择。
                      <DeviceActionSheet
                        simulationId={simulationId}
                        device={actionSheetDevice}
                        live={actionSheetLive}
                        {...(actionSheetZoneName !== undefined ? { zoneName: actionSheetZoneName } : {})}
                        canExecute={canExecuteDeviceCommand}
                        onClose={() => setMapSelection(null)}
                      />
                    )}
                  </main>
                  {!layout.focus && (
                    // 抽屉开合钮吸附在地图 Panel 右缘（原先是行间独立一列，
                    // 分栏后该列位置被拖拽把手取代）。绝对定位悬浮在地图上方。
                    <button
                      className="console-drawer__collapse"
                      title={layout.rightOpen ? t('collapseRight') : t('expandRight')}
                      aria-label={layout.rightOpen ? t('collapseRight') : t('expandRight')}
                      onClick={() => applyLayout(toggleRightDrawer)}
                    >
                      <Icon icon={layout.rightOpen ? ChevronsRight : ChevronsLeft} size={14} />
                      {/* R12-5c-B: 竖排文字标签 — 只有 « 图标时两个学生角色都没找到入口。 */}
                      <span className="console-drawer__collapse-label">{t('rightRailLabel')}</span>
                    </button>
                  )}
                </Panel>
                {!layout.focus && layout.rightOpen && (
                  <>
                    <PanelResizeHandle className="resize-handle resize-handle--vertical" />
                    {/* defaultSize 24% ≈ 旧固定 340px（1440px 宽视口）；窄屏 19%。 */}
                    <Panel
                      id="console-drawer"
                      order={2}
                      defaultSize={narrowViewport() ? 19 : 24}
                      minSize={15}
                      maxSize={45}
                      className="console-panel--drawer"
                    >
                      <aside className="console-drawer">
                        <ConsoleSection
                          title={t('panels.inject')}
                          open={layout.panels.inject}
                          onToggle={() => applyLayout(current => togglePanel(current, 'inject'))}
                        >
                          <EventInjectPanel scenario={consoleScenario} />
                        </ConsoleSection>
                        <ConsoleSection
                          title={t('panels.fault')}
                          open={layout.panels.fault}
                          onToggle={() => applyLayout(current => togglePanel(current, 'fault'))}
                        >
                          <FaultPanel scenario={consoleScenario} />
                        </ConsoleSection>
                        {simulationId && renderedSnapshot ? (
                          <ConsoleSection
                            title={t('panels.collab')}
                            open={layout.panels.collab}
                            onToggle={() => applyLayout(current => togglePanel(current, 'collab'))}
                          >
                            <CollaborationsPanel
                              simulationId={simulationId}
                              agents={renderedSnapshot.agents}
                              stopped={snapshot?.state === 'stopped'}
                            />
                          </ConsoleSection>
                        ) : null}
                        {simulationId ? (
                          <ConsoleSection
                            title={t('panels.chat')}
                            open={layout.panels.chat}
                            onToggle={() => applyLayout(current => togglePanel(current, 'chat'))}
                          >
                            <AgentChatPanel
                              simulationId={simulationId}
                              agents={renderedSnapshot?.agents ?? chatAgentsFallback}
                              stopped={snapshot?.state === 'stopped'}
                            />
                          </ConsoleSection>
                        ) : null}
                        {renderedSnapshot ? (
                          // T3: 实时读数 4 面板组同样收进折叠 section（默认折叠，按需
                          // 展开）——右抽屉成为唯一的信息抽屉，首屏只留地图。
                          <ConsoleSection
                            title={t('panels.live')}
                            open={layout.panels.live}
                            onToggle={() => applyLayout(current => togglePanel(current, 'live'))}
                          >
                            <LivePanels
                              snapshot={renderedSnapshot}
                              envSeries={envSeries}
                              mapSelectedZoneId={mapSelectedZoneId}
                              liveSnapshot={snapshot}
                            />
                          </ConsoleSection>
                        ) : (
                          <p className="page-note">{t('waitingSnapshot')}</p>
                        )}
                      </aside>
                    </Panel>
                  </>
                )}
              </PanelGroup>
              {/* ReplayBar 留在主区 Panel 底部——主区与事件抽屉之间的原位置。 */}
              <ReplayBar
                events={consoleScenario.events}
                recommendedRate={consoleScenario.meta.recommendedPlaybackRate}
              />
            </Panel>
            {!layout.focus && layout.eventOpen && (
              <>
                <PanelResizeHandle className="resize-handle resize-handle--horizontal" />
                {/* 打开态抽屉高度交给分栏（默认 35%，对应旧固定 35% 高；窄屏 30%）。 */}
                <Panel
                  id="console-events"
                  order={2}
                  defaultSize={narrowViewport() ? 30 : 35}
                  minSize={15}
                  maxSize={60}
                  className="console-panel--events"
                >
                  <div className="event-drawer event-drawer--open">
                    {eventDrawerHeader}
                    <div className="event-drawer__body">
                      <div className="event-drawer__tabs" role="tablist">
                        <button
                          role="tab"
                          aria-selected={drawerTab === 'episodes'}
                          className={`event-drawer__tab${drawerTab === 'episodes' ? ' event-drawer__tab--active' : ''}`}
                          onClick={() => setDrawerTab('episodes')}
                        >
                          {t('tabEpisodes')}
                        </button>
                        <button
                          role="tab"
                          aria-selected={drawerTab === 'raw'}
                          className={`event-drawer__tab${drawerTab === 'raw' ? ' event-drawer__tab--active' : ''}`}
                          onClick={() => setDrawerTab('raw')}
                        >
                          {t('tabRaw')}
                        </button>
                        <button
                          role="tab"
                          aria-selected={drawerTab === 'eval'}
                          className={`event-drawer__tab${drawerTab === 'eval' ? ' event-drawer__tab--active' : ''}`}
                          onClick={() => setDrawerTab('eval')}
                        >
                          {t('tabEval')}
                        </button>
                      </div>
                      {drawerTab === 'episodes' ? (
                        <EpisodesPanel model={mapModel} episodes={episodes} />
                      ) : drawerTab === 'raw' ? (
                        <EventLogPanel decisions={renderedSnapshot?.recentDecisions ?? []} />
                      ) : simulationId ? (
                        <EvalReportPanel simulationId={simulationId} />
                      ) : (
                        <p className="page-note">{t('eval.noSimulation')}</p>
                      )}
                    </div>
                  </div>
                </Panel>
              </>
            )}
          </PanelGroup>
          {!layout.focus && !layout.eventOpen && (
            // 折叠态事件抽屉：只有头部行（展开入口），不占分栏。
            <div className="event-drawer">{eventDrawerHeader}</div>
          )}
        </>
      )}
    </div>
  );
}
