/**
 * Application store — Zustand slices.
 *
 * 状态管理分工（与 lib/queryClient.ts 头注释、apps/web/README.md 一致）：
 * **服务端状态不归这里** —— 通知、环境列表、工作台概览等 REST 拉取的数据
 * 由 TanStack Query 管理（见 src/hooks/）。本 store 只保留：
 *
 * - `auth` — the logged-in user (from GET /auth/me, never the token) + the
 *   boot session restore. The API client's 401 handler funnels here.
 * - `world` — the currently open environment detail (world view), selection,
 *   layer toggles, world-stream status and the toast queue. World changes
 *   from the WS stream are applied incrementally (lib/worldChange).
 * - `scenarios` — legacy file-scenario browser (kept for one release)
 * - `simulation` — current simulation id (server-authoritative: the UI never
 *   mutates simulation state locally; every action is an API call and the UI
 *   updates from the next snapshot)
 * - `snapshot` — the latest EngineSnapshot (REST poll is the ground truth;
 *   WS snapshots apply only when strictly fresher)
 * - `stream` — WS event stream status + the capped event log
 * - `replay` — client-side snapshot ring buffer + replay cursor. Replay
 *   NEVER mutates the live slices; it only moves the cursor and the
 *   `selectRenderedSnapshot` selector derives what the console shows.
 * - `ui` — pure UI state (theme, agent selection). Page navigation lives in
 *   the router (App.tsx); store actions that must change the page go through
 *   lib/navigation. The simulation console is not a route: it renders as an
 *   overlay whenever `simulationId` is set.
 */

import { create } from 'zustand';

import * as api from '../api/client';
import { ApiClientError } from '../api/client';
import type {
  CreateSimulationResult,
  DeviceDeltaFrame,
  EngineSnapshot,
  SimulationListEntry,
  EnvironmentDetail,
  LlmClientPreset,
  PresenceMessage,
  PresenceUserRef,
  PublicUser,
  ScenarioDefinition,
  ScenarioSummary,
  SystemEventDto,
  WorldChangeMessage,
  WorldSessionStatusMessage,
  ZoneDeltaFrame,
} from '../api/types';
import i18n from '../i18n/config';
import type { TriggerHint } from '../lib/episodes';
import { toLogEntry, type EventLogEntry } from '../lib/eventLog';
import type { LatLng } from '../lib/geo';
import { navigateTo } from '../lib/navigation';
import { queryClient } from '../lib/queryClient';
import { appendPolygonVertex } from '../lib/zoneForm';
import { insertVertexAtEdge, moveVertex, removeVertexAt } from '../lib/zoneGeometry';
import { applyPresenceMessage as reducePresence } from '../lib/presence';
import { appendReplayTime, appendToReplayBuffer } from '../lib/replay';
import { isSnapshotFresher } from '../lib/stream';
import { applySubscriptionState } from '../lib/subscriptions';
import { loadTheme, saveTheme, type ThemeName } from '../lib/theme';
import { actorOf, applyWorldChange, applyWorldSession, describeWorldChange } from '../lib/worldChange';

/** Event log cap (newest-first list). */
export const EVENT_LOG_CAP = 300;

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'down';

// ---------------------------------------------------------------------------
// Slice types
// ---------------------------------------------------------------------------

export interface AuthSlice {
  user: PublicUser | null;
  /** False until the boot GET /auth/me round trip resolves. */
  authChecked: boolean;
  bootstrapAuth: () => Promise<void>;
  /** Returns an error message to display, or null on success. */
  login: (email: string, password: string) => Promise<string | null>;
  register: (displayName: string, email: string, password: string, inviteCode?: string) => Promise<string | null>;
  logout: () => Promise<void>;
  /** API-client 401 hook: drop the session; the guard routes to login. */
  handleUnauthorized: () => void;
}

export interface WorldSelection {
  objectType: 'device' | 'agent' | 'zone';
  id: string;
}

export interface WorldLayers {
  zones: boolean;
  devices: boolean;
  agents: boolean;
  edges: boolean;
}

export interface Toast {
  id: number;
  text: string;
  /** T8 分类：info（默认，兼容存量调用）/ success / warn / error。 */
  kind: ToastKind;
  /** UX-W1: optional bold header above the body text. */
  title?: string;
  /** UX-W1: optional action button; clicking runs onClick and dismisses. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

/** UX-W1: Promise-based confirm dialog (replaces window.confirm). */
export type ConfirmTone = 'info' | 'warn' | 'danger';

export interface ConfirmOptions {
  /** Short header; omit for a single-message dialog (body is the message). */
  title?: string;
  body: string;
  confirmText?: string;
  cancelText?: string;
  /** danger = irreversible/destructive (solid red confirm, cancel-focused). */
  tone?: ConfirmTone;
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

/** Catalog click-to-place request (geo worlds): armed from the 名录 tab. */
export interface GeoPlacementRequest {
  modelId: string;
  zoneId: string;
}

/** Ad-hoc device geo position pick (W6-2): armed from the device form. */
export interface DevicePickState {
  armed: boolean;
  /** The map-picked point (set on click; disarms the pick). */
  point: LatLng | null;
}

/** Geo zone polygon drawing (W6-2): armed from 区域管理. */
export interface ZoneDrawState {
  /** false after 完成/dblclick — vertices stay for the metadata form. */
  active: boolean;
  vertices: [number, number][];
  /**
   * UX-W2 vertex-editing mode: set instead of `active` when an EXISTING
   * zone's polygon is being edited (draggable handles on the map; map
   * clicks do NOT append vertices). Cleared by cancelZoneDraw like a draw.
   */
  editingZoneId?: string;
}

export interface WorldSlice {
  world: EnvironmentDetail | null;
  worldLoading: boolean;
  worldError: string | null;
  worldStreamStatus: StreamStatus;
  selection: WorldSelection | null;
  /** Currently focused service in the 服务 marketplace tab (W3). */
  selectedServiceId: string | null;
  /**
   * Currently focused agreement in the 合约 tab (T-066): armed by the
   * notification replyHint affordance; AgreementsPanel opens the detail view.
   */
  selectedAgreementId: string | null;
  /** Ids of services the caller bookmarked in this env (W5 marketplace stars). */
  myServiceSubscriptions: string[];
  layers: WorldLayers;
  toasts: Toast[];
  /** Armed catalog click-to-place request (geo worlds; null = inactive). */
  geoPlacement: GeoPlacementRequest | null;
  /** Armed ad-hoc device geo position pick (W6-2; null = no form picking). */
  devicePick: DevicePickState | null;
  /** Geo zone polygon drawing state (W6-2; null = not drawing). */
  zoneDraw: ZoneDrawState | null;
  /** Users currently connected to this environment's stream (P2e-2 presence). */
  onlineUsers: PresenceUserRef[];
  /** Anonymous viewers (count only — no identity to list). */
  onlineAnonymousCount: number;
  openEnvironment: (id: string) => Promise<void>;
  /** Silent refetch of the open world (world-stream down fallback). */
  reloadWorld: () => Promise<void>;
  closeWorld: () => void;
  selectObject: (selection: WorldSelection | null) => void;
  selectService: (serviceId: string | null) => void;
  /** Focus an agreement in the 合约 tab (T-066 replyHint deep-link). */
  selectAgreement: (agreementId: string | null) => void;
  /** Star/unstar a service in the marketplace (W5); optimistic apply. */
  toggleServiceSubscription: (serviceId: string) => Promise<void>;
  toggleLayer: (key: keyof WorldLayers) => void;
  setWorldStreamStatus: (status: StreamStatus) => void;
  applyWorldMessage: (message: WorldChangeMessage) => void;
  /** R82 fix: world-session creation/status frames → world.worldSession. */
  applyWorldSessionMessage: (message: WorldSessionStatusMessage) => void;
  applyPresenceMessage: (message: PresenceMessage) => void;
  pushToast: (text: string, kind?: ToastKind, options?: { title?: string; action?: ToastAction }) => void;
  dismissToast: (id: number) => void;
  /** UX-W1: pending confirm request rendered by <ConfirmHost/> (null = none). */
  confirmRequest: ConfirmRequest | null;
  /** Open the global confirm dialog; resolves true=confirm / false=cancel. */
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>;
  resolveConfirm: (confirmed: boolean) => void;
  /** Arm click-to-place for a catalog model into a chosen zone (geo). */
  armGeoPlacement: (request: GeoPlacementRequest) => void;
  cancelGeoPlacement: () => void;
  /** Map click while armed: instantiate the model at the clicked lat/lng. */
  completeGeoPlacement: (
    latLng: { lat: number; lng: number },
    options?: { zoneId?: string },
  ) => Promise<void>;
  /** Arm the ad-hoc device form's geo position pick (W6-2). */
  armDevicePick: () => void;
  /** Disarm the pick AND drop the picked point (form close / 清除). */
  cancelDevicePick: () => void;
  /** Map click while the device pick is armed: keep the point, disarm. */
  setDevicePickPoint: (point: LatLng) => void;
  /** Geo zone drawing (W6-2): start appending vertices on map clicks. */
  startZoneDraw: () => void;
  /** Drop the in-progress/finished polygon entirely (取消 / after save). */
  cancelZoneDraw: () => void;
  appendZoneDrawVertex: (point: [number, number]) => void;
  /** End the draw (完成/dblclick); vertices stay for the metadata form. */
  finishZoneDraw: () => void;
  /**
   * UX-W2: arm vertex editing for an EXISTING geo zone — the map renders
   * draggable handles over the current polygon instead of appending clicks.
   */
  startZoneVertexEdit: (zoneId: string, vertices: [number, number][]) => void;
  /** Vertex-edit ops (no-op outside vertex-edit mode). */
  moveZoneDrawVertex: (index: number, point: [number, number]) => void;
  insertZoneDrawVertex: (edgeIndex: number) => void;
  removeZoneDrawVertex: (index: number) => void;
  /**
   * UX-W2 grid bounds drag: id of the zone whose canvas rectangle may be
   * dragged (armed from 区域管理; null = zones not draggable). WorldViewPage
   * PATCHes the translated bounds on drop and disarms.
   */
  zoneBoundsEditId: string | null;
  startZoneBoundsEdit: (zoneId: string) => void;
  cancelZoneBoundsEdit: () => void;
}

export interface ScenariosSlice {
  scenarios: ScenarioSummary[];
  scenariosLoading: boolean;
  scenariosError: string | null;
  /** Currently opened legacy scenario definition (legacy detail/simulation). */
  currentScenario: ScenarioDefinition | null;
  currentScenarioError: string | null;
  loadScenarios: () => Promise<void>;
  openScenario: (id: string) => Promise<void>;
}

export type SimulationSource = 'environment' | 'scenario';

/**
 * Active demo run (plan-r81 B2): started from the world view's「演示模式」
 * button; the DemoModeBanner narrates the scripted arc over the console and
 * STOPS the demo sim when sim time passes endsAtSimTimeSec (F2 — a demo sim
 * has no other stop path).
 */
export interface DemoRunState {
  simId: string;
  envId: string;
  /** Playback rate the demo requested (the banner narrates the measured one). */
  rate: number;
  /** Hero event injected at demo start; null when the arc has none. */
  heroEventId: string | null;
  /** Hero event's zone (drives the 3D alert pulse while the window is open). */
  heroZoneId?: string;
  /** Wall-clock demo start (hero alert window is wall-time based). */
  startedAtMs?: number;
  /**
   * Scenario cinematography: the hero event's `playbackRateOverride` — the
   * banner slows the demo to this rate for the hero window so fast-decaying
   * signals (smoke half-life ~69 sim-s) stay visible at wall time.
   */
  heroPlaybackRateOverride?: number;
  /** Sim-time at which the demo auto-ends (last scripted event + dwell). */
  endsAtSimTimeSec: number;
  /** true once the stop has been issued (terminal banner state). */
  done: boolean;
}

export interface DemoSlice {
  demoRun: DemoRunState | null;
  startDemoRun: (run: Omit<DemoRunState, 'done'>) => void;
  markDemoRunDone: () => void;
  clearDemoRun: () => void;
  /**
   * Demo-only create path (demo-on-world-page architecture): creates the
   * private demo sim WITHOUT touching `simulationId` — setting it would swap
   * the whole route tree to the console overlay (App.tsx) and unmount the
   * world view / 3D campus the demo narrates over.
   */
  createDemoSim: (
    environmentId: string,
    llmClient?: LlmClientPreset,
    zoneIds?: string[],
  ) => Promise<CreateSimulationResult>;
}

export interface SimulationSlice {
  simulationId: string | null;
  // Living-worlds P0: the console backfill assigns the LIST entry, whose
  // state includes 'hibernated' and may carry checkpoint metadata.
  simulationInfo: CreateSimulationResult | SimulationListEntry | null;
  simulationError: string | null;
  /** What the running simulation was created from (decides the back target). */
  simulationSource: SimulationSource | null;
  startSimulationFor: (scenarioId: string, llmClient?: LlmClientPreset) => Promise<void>;
  startSimulationForEnvironment: (
    environmentId: string,
    llmClient?: LlmClientPreset,
    /** A2 zone scoping: top-level body field; omit for the full world. */
    zoneIds?: string[],
  ) => Promise<void>;
  /** Attach the console to an EXISTING simulation (workbench 运行中仿真, W5). */
  openSimulationConsole: (simulationId: string, environmentId: string) => Promise<void>;
  clearSimulation: () => void;
  setSimulationError: (message: string | null) => void;
}

export interface SnapshotSlice {
  snapshot: EngineSnapshot | null;
  /**
   * REST ground-truth entry point. R31 F6: identical-tick deliveries (poll
   * racing the WS snapshot) are skipped — not-fresher + unchanged state is
   * a no-op, so only genuinely new ticks re-render the console.
   */
  setSnapshot: (snapshot: EngineSnapshot) => void;
  /** WS entry point: applies only when strictly fresher than what we have. */
  applyStreamSnapshot: (snapshot: EngineSnapshot) => void;
  /**
   * R31 SF10: WS delta lane — scoped updates that patch ONE zone parameter
   * or ONE device's changed state fields without swapping the whole
   * snapshot object graph. Untouched zones/devices keep their references,
   * so the map's per-node data caches (buildGraph) skip them and only the
   * affected node re-renders.
   */
  applyZoneDelta: (frame: ZoneDeltaFrame) => void;
  applyDeviceDelta: (frame: DeviceDeltaFrame) => void;
  clearSnapshot: () => void;
}

export interface StreamSlice {
  streamStatus: StreamStatus;
  /** Newest first, capped at EVENT_LOG_CAP. */
  eventLog: EventLogEntry[];
  /**
   * Injection trigger hints recorded client-side (W8), keyed by eventId —
   * injected events never echo on the bus, so the episode aggregator uses
   * these to reconstruct the trigger (type/zone/parameter/value).
   */
  triggerHints: Record<string, TriggerHint>;
  setStreamStatus: (status: StreamStatus) => void;
  appendStreamEvents: (events: SystemEventDto[]) => void;
  recordTriggerHint: (eventId: string, hint: TriggerHint) => void;
}

/**
 * Replay playback rate (buffer entries advanced per 250 ms tick). The select
 * offers 1×/4×; a scenario meta `recommendedPlaybackRate` may seed any
 * positive integer as the initial rate (Wave-2 demo hint).
 */
export type ReplaySpeed = number;

export interface ReplaySlice {
  replayBuffer: EngineSnapshot[];
  /** Wall-clock receipt time per buffered snapshot, index-aligned (W8). */
  replayTimes: number[];
  replayActive: boolean;
  replayCursor: number;
  replayPlaying: boolean;
  replaySpeed: ReplaySpeed;
  enterReplay: () => void;
  exitReplay: () => void;
  setReplayCursor: (cursor: number) => void;
  setReplayPlaying: (playing: boolean) => void;
  setReplaySpeed: (speed: ReplaySpeed) => void;
}

export interface UiSlice {
  selectedAgentId: string | null;
  /** 界面主题（lib/theme 持久化到 localStorage，App 同步到 <html data-theme>）。 */
  theme: ThemeName;
  /** Leave the simulation console: clear sim state and route back to the
   *  page the simulation was started from (world view or legacy detail). */
  backToDetail: () => void;
  selectAgent: (id: string | null) => void;
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
}

export type AppStore = AuthSlice &
  WorldSlice &
  ScenariosSlice &
  SimulationSlice &
  DemoSlice &
  SnapshotSlice &
  StreamSlice &
  ReplaySlice &
  UiSlice;

/** Stream/replay state that resets whenever the simulation context changes. */
const STREAM_RESET = {
  streamStatus: 'idle' as StreamStatus,
  eventLog: [] as EventLogEntry[],
  triggerHints: {} as Record<string, TriggerHint>,
};

/** Trigger hints kept per simulation (oldest evicted first). */
const TRIGGER_HINT_CAP = 200;

const REPLAY_RESET = {
  replayBuffer: [] as EngineSnapshot[],
  replayTimes: [] as number[],
  replayActive: false,
  replayCursor: 0,
  replayPlaying: false,
  replaySpeed: 1 as ReplaySpeed,
};

const WORLD_RESET = {
  world: null as EnvironmentDetail | null,
  worldLoading: false,
  worldError: null as string | null,
  worldStreamStatus: 'idle' as StreamStatus,
  selection: null as WorldSelection | null,
  selectedServiceId: null as string | null,
  selectedAgreementId: null as string | null,
  myServiceSubscriptions: [] as string[],
  geoPlacement: null as GeoPlacementRequest | null,
  devicePick: null as DevicePickState | null,
  zoneDraw: null as ZoneDrawState | null,
  onlineUsers: [] as PresenceUserRef[],
  onlineAnonymousCount: 0,
};

const DEFAULT_LAYERS: WorldLayers = { zones: true, devices: true, agents: true, edges: true };

let toastSeq = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * R76-F1: boot session-restore retry delays (1s/2s/4s). A 429/5xx/network
 * failure on GET /auth/me is transient — swallowing it as user=null strands
 * the UI half-logged-in (wizard binds nothing, buttons silently disable).
 */
const BOOTSTRAP_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * R2-UX-23: one boot restore in flight at a time. React StrictMode dev
 * double-mounts App and fires bootstrapAuth twice per session — the second
 * caller rides the in-flight promise instead of issuing a duplicate
 * GET /auth/me (for anonymous boots: ONE expected 401 in the console, not
 * two). Cleared on settle so a later explicit re-check still runs.
 */
let bootstrapInFlight: Promise<void> | null = null;

/** Transient boot failures worth retrying: rate limiting, 5xx, network drops. */
function isTransientBootstrapError(error: unknown): boolean {
  if (error instanceof ApiClientError) return error.status === 429 || error.status >= 500;
  return true; // fetch TypeError (offline/DNS/socket reset) carries no status
}

export const useAppStore = create<AppStore>()((set, get) => ({
  // -------------------------------------------------------------------------
  // auth slice
  // -------------------------------------------------------------------------
  user: null,
  authChecked: false,

  bootstrapAuth: () => {
    if (bootstrapInFlight !== null) return bootstrapInFlight;
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const user = await api.getMe();
          set({ user, authChecked: true });
          return;
        } catch (error) {
          // Only a definitive 401 means "logged out" (the normal anonymous
          // boot). Transient failures retry with backoff; anything else — or
          // retries exhausted — still settles logged out, and the next authed
          // call surfaces the real error.
          if (error instanceof ApiClientError && error.status === 401) break;
          const delay = BOOTSTRAP_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !isTransientBootstrapError(error)) break;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      set({ user: null, authChecked: true });
    })();
    bootstrapInFlight = run;
    // Settle-hook clears the guard; the run never rejects (all paths settle),
    // so this handler chain is only bookkeeping.
    void run.then(
      () => {
        if (bootstrapInFlight === run) bootstrapInFlight = null;
      },
      () => {
        if (bootstrapInFlight === run) bootstrapInFlight = null;
      },
    );
    return run;
  },

  login: async (email, password) => {
    const t = i18n.getFixedT(i18n.language, 'toasts');
    try {
      await api.login({ email, password });
      // The store keeps the /me profile, never the token (httpOnly cookie).
      // The /login route guard redirects away (honoring the original
      // target) as soon as `user` lands here.
      const user = await api.getMe();
      set({ user });
      return null;
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        return t('loginFailed');
      }
      return errorMessage(error);
    }
  },

  register: async (displayName, email, password, inviteCode) => {
    const t = i18n.getFixedT(i18n.language, 'toasts');
    try {
      await api.register({ email, password, displayName, ...(inviteCode ? { inviteCode } : {}) });
      await api.login({ email, password });
      const user = await api.getMe();
      set({ user });
      return null;
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.status === 409) return t('alreadyRegistered');
        if (error.status === 400) return error.message;
        // Alpha capacity gating (EAF_INVITE_ONLY): map the invite gate's
        // codes to APP-language teaching copy (the server message follows
        // Accept-Language, which can diverge from the UI language).
        if (error.code === 'INVITE_REQUIRED') return t('inviteRequired');
        if (error.code === 'INVITE_INVALID') return t('inviteInvalid');
        if (error.code === 'INVITE_GONE') return t('inviteGone');
      }
      return errorMessage(error);
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      // Logout is idempotent — a network failure still clears local state.
    }
    get().clearSimulation();
    get().clearSnapshot();
    // Server state lives in the Query cache — drop it with the session.
    queryClient.clear();
    set({ user: null, ...WORLD_RESET });
    navigateTo('/login');
  },

  handleUnauthorized: () => {
    if (get().user === null) return;
    get().clearSimulation();
    get().clearSnapshot();
    queryClient.clear();
    set({ user: null });
    const t = i18n.getFixedT(i18n.language, 'toasts');
    get().pushToast(t('sessionExpired'));
  },

  // -------------------------------------------------------------------------
  // world slice
  // -------------------------------------------------------------------------
  ...WORLD_RESET,
  layers: DEFAULT_LAYERS,
  toasts: [],

  openEnvironment: async id => {
    set({ ...WORLD_RESET, worldLoading: true });
    try {
      const world = await api.getEnvironment(id);
      set({
        world,
        worldLoading: false,
        myServiceSubscriptions: world.mySubscriptions ?? [],
      });
    } catch (error) {
      // R2-UX-21c: env 404 used to leak the raw English server sentence
      // inside the Chinese「加载失败」shell — localize by error code.
      if (error instanceof ApiClientError && error.status === 404) {
        const t = i18n.getFixedT(i18n.language, 'world');
        set({ worldLoading: false, worldError: t('envNotFound') });
        return;
      }
      set({ worldLoading: false, worldError: errorMessage(error) });
    }
  },

  reloadWorld: async () => {
    const id = get().world?.id;
    if (!id) return;
    try {
      const world = await api.getEnvironment(id);
      set({ world, myServiceSubscriptions: world.mySubscriptions ?? [] });
    } catch {
      // Silent fallback path — the next focus event tries again.
    }
  },

  closeWorld: () => set({ ...WORLD_RESET }),

  selectObject: selection => set({ selection }),

  selectService: selectedServiceId => set({ selectedServiceId }),

  selectAgreement: selectedAgreementId => set({ selectedAgreementId }),

  toggleServiceSubscription: async serviceId => {
    const subscribed = get().myServiceSubscriptions.includes(serviceId);
    try {
      if (subscribed) await api.unsubscribeService(serviceId);
      else await api.subscribeService(serviceId);
      set(state => ({
        myServiceSubscriptions: applySubscriptionState(
          state.myServiceSubscriptions,
          serviceId,
          !subscribed,
        ),
      }));
    } catch (error) {
      const t = i18n.getFixedT(i18n.language, 'toasts');
      get().pushToast(
        t(subscribed ? 'unbookmarkFailed' : 'bookmarkFailed', { error: errorMessage(error) }),
      );
    }
  },

  toggleLayer: key => set(state => ({ layers: { ...state.layers, [key]: !state.layers[key] } })),

  setWorldStreamStatus: worldStreamStatus => set({ worldStreamStatus }),

  applyWorldMessage: message => {
    const { world, user } = get();
    if (message.objectType === 'environment' && message.action === 'deleted') {
      if (world) {
        const t = i18n.getFixedT(i18n.language, 'toasts');
        get().pushToast(t('envDeleted'));
        // Batched with the navigation below: the world route unmounts before
        // its loader effect could re-open the deleted environment.
        get().closeWorld();
        navigateTo('/environments');
      }
      return;
    }
    if (!world) return;
    set({ world: applyWorldChange(world, message) });
    // A deleted service must not stay focused in the marketplace tab.
    if (message.objectType === 'service' && message.action === 'deleted') {
      const deletedId = (message.object as { id?: unknown }).id;
      if (typeof deletedId === 'string' && get().selectedServiceId === deletedId) {
        set({ selectedServiceId: null });
      }
    }
    // Own edits already got local feedback (dialog close / optimistic apply).
    const actorId = actorOf(message);
    if (actorId && user && actorId === user.id) return;
    const text = describeWorldChange(message);
    if (text) get().pushToast(text);
  },

  applyWorldSessionMessage: message => {
    const { world } = get();
    if (!world) return;
    set({ world: applyWorldSession(world, message) });
  },

  applyPresenceMessage: message => {
    set(state => ({
      onlineUsers: reducePresence(state.onlineUsers, message),
      ...(message.action === 'snapshot'
        ? { onlineAnonymousCount: message.anonymousCount }
        : {}),
    }));
  },

  pushToast: (text, kind = 'info', options) => {
    toastSeq += 1;
    const id = toastSeq;
    set(state => ({ toasts: [...state.toasts.slice(-4), { id, text, kind, ...options }] }));
    // T8: 错误类延长驻留（8s，误触/失败原因需要读清），其余 4s。
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
  },

  dismissToast: id => set(state => ({ toasts: state.toasts.filter(t => t.id !== id) })),

  confirmRequest: null,

  requestConfirm: options =>
    new Promise<boolean>(resolve => {
      // A second request supersedes the pending one (treated as cancelled).
      get().confirmRequest?.resolve(false);
      set({ confirmRequest: { ...options, resolve } });
    }),

  resolveConfirm: confirmed => {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    request?.resolve(confirmed);
  },

  armGeoPlacement: request => set({ geoPlacement: request }),

  cancelGeoPlacement: () => set({ geoPlacement: null }),

  completeGeoPlacement: async (latLng, options) => {
    const { world, geoPlacement } = get();
    if (!world || !geoPlacement) return;
    // Disarm synchronously BEFORE the request: while the POST is in flight a
    // double-click's second pointerup would otherwise find the placement still
    // armed and instantiate a second device (2D geo and 3D share this path).
    set({ geoPlacement: null });
    const t = i18n.getFixedT(i18n.language, 'toasts');
    try {
      const device = await api.instantiateDevice(world.id, {
        modelId: geoPlacement.modelId,
        // UX-W4 楼层感知放置: the 3D campus view may pin the click to the
        // focused building's zone at the selected storey (devices carry no
        // floor field — zone attribution is the persisted floor signal).
        zoneId: options?.zoneId ?? geoPlacement.zoneId,
        position: latLng,
      });
      // Optimistic apply; the world-stream broadcast dedupes by id.
      get().applyWorldMessage({ kind: 'world', action: 'created', objectType: 'device', object: device });
      get().pushToast(t('devicePlaced', { name: device.name }));
    } catch (error) {
      // Re-arm so the user can click again or cancel.
      set({ geoPlacement });
      get().pushToast(t('placeFailed', { error: errorMessage(error) }));
    }
  },

  armDevicePick: () => set({ devicePick: { armed: true, point: null } }),

  cancelDevicePick: () => set({ devicePick: null }),

  setDevicePickPoint: point => {
    const { devicePick } = get();
    if (!devicePick?.armed) return;
    set({ devicePick: { armed: false, point } });
  },

  startZoneDraw: () => set({ zoneDraw: { active: true, vertices: [] } }),

  cancelZoneDraw: () => set({ zoneDraw: null }),

  appendZoneDrawVertex: point => {
    const { zoneDraw } = get();
    if (!zoneDraw?.active) return;
    // Consecutive (near-)duplicates merge — a finishing dblclick fires clicks.
    set({ zoneDraw: { ...zoneDraw, vertices: appendPolygonVertex(zoneDraw.vertices, point) } });
  },

  finishZoneDraw: () => {
    const { zoneDraw } = get();
    if (!zoneDraw?.active) return;
    set({ zoneDraw: { ...zoneDraw, active: false } });
  },

  startZoneVertexEdit: (zoneId, vertices) =>
    set({ zoneDraw: { active: false, vertices: [...vertices], editingZoneId: zoneId } }),

  moveZoneDrawVertex: (index, point) => {
    const { zoneDraw } = get();
    if (zoneDraw?.editingZoneId === undefined) return;
    set({ zoneDraw: { ...zoneDraw, vertices: moveVertex(zoneDraw.vertices, index, point) } });
  },

  insertZoneDrawVertex: edgeIndex => {
    const { zoneDraw } = get();
    if (zoneDraw?.editingZoneId === undefined) return;
    set({ zoneDraw: { ...zoneDraw, vertices: insertVertexAtEdge(zoneDraw.vertices, edgeIndex) } });
  },

  removeZoneDrawVertex: index => {
    const { zoneDraw } = get();
    if (zoneDraw?.editingZoneId === undefined) return;
    // The min-3 ring constraint lives in the lib — null = refusal, no-op.
    const next = removeVertexAt(zoneDraw.vertices, index);
    if (next === null) return;
    set({ zoneDraw: { ...zoneDraw, vertices: next } });
  },

  zoneBoundsEditId: null,
  startZoneBoundsEdit: zoneId => set({ zoneBoundsEditId: zoneId }),
  cancelZoneBoundsEdit: () => set({ zoneBoundsEditId: null }),

  // -------------------------------------------------------------------------
  // scenarios slice (legacy browser)
  // -------------------------------------------------------------------------
  scenarios: [],
  scenariosLoading: false,
  scenariosError: null,
  currentScenario: null,
  currentScenarioError: null,

  loadScenarios: async () => {
    set({ scenariosLoading: true, scenariosError: null });
    try {
      const scenarios = await api.listScenarios();
      set({ scenarios, scenariosLoading: false });
    } catch (error) {
      set({ scenariosLoading: false, scenariosError: errorMessage(error) });
    }
  },

  openScenario: async id => {
    set({ currentScenario: null, currentScenarioError: null });
    try {
      const scenario = await api.getScenario(id);
      set({ currentScenario: scenario });
    } catch (error) {
      set({ currentScenarioError: errorMessage(error) });
    }
  },

  // -------------------------------------------------------------------------
  // simulation slice
  // -------------------------------------------------------------------------
  simulationId: null,
  simulationInfo: null,
  simulationError: null,
  simulationSource: null,

  // -------------------------------------------------------------------------
  // demo slice (plan-r81 B2)
  // -------------------------------------------------------------------------
  demoRun: null,
  startDemoRun: run => set({ demoRun: { ...run, done: false } }),
  markDemoRunDone: () =>
    set(state => (state.demoRun === null ? {} : { demoRun: { ...state.demoRun, done: true } })),
  clearDemoRun: () => set({ demoRun: null }),
  createDemoSim: (environmentId, llmClient = 'auto', zoneIds) =>
    api.createSimulationForEnvironment(environmentId, { llmClient }, zoneIds),

  startSimulationFor: async (scenarioId, llmClient = 'auto') => {
    set({ simulationError: null });
    try {
      // Server-authoritative: we only record the id the server handed out;
      // all state flows back through snapshots.
      const info = await api.createSimulation(scenarioId, { llmClient });
      // Setting simulationId opens the console overlay (App renders
      // SimulationView whenever a simulation is attached).
      set({
        simulationId: info.id,
        simulationInfo: info,
        simulationSource: 'scenario',
      });
      const snapshot = await api.getSnapshot(info.id);
      get().setSnapshot(snapshot);
    } catch (error) {
      set({ simulationError: simulationErrorMessage(error) });
    }
  },

  startSimulationForEnvironment: async (environmentId, llmClient = 'auto', zoneIds) => {
    set({ simulationError: null });
    try {
      const info = await api.createSimulationForEnvironment(environmentId, { llmClient }, zoneIds);
      set({
        simulationId: info.id,
        simulationInfo: info,
        simulationSource: 'environment',
      });
      const snapshot = await api.getSnapshot(info.id);
      get().setSnapshot(snapshot);
    } catch (error) {
      set({ simulationError: simulationErrorMessage(error) });
    }
  },

  openSimulationConsole: async (simulationId, environmentId) => {
    set({ simulationError: null });
    // R80: take the console route — the console owns a URL now, and the
    // App's route-exit effect (which clears the console when the route
    // leaves /simulations/) needs this to not fight the open.
    navigateTo(`/simulations/${simulationId}`);
    try {
      // The console's environment panels render from the world detail — load
      // it unless the world view already has this env open.
      if (get().world?.id !== environmentId) {
        const world = await api.getEnvironment(environmentId);
        set({ world, myServiceSubscriptions: world.mySubscriptions ?? [] });
      }
      set({
        simulationId,
        simulationInfo: null,
        simulationSource: 'environment',
        ...STREAM_RESET,
        ...REPLAY_RESET,
      });
      const snapshot = await api.getSnapshot(simulationId);
      get().setSnapshot(snapshot);
      // Backfill the sim info (LLM mode/model/warning for the status bar)
      // from the list endpoint — the console opened from a sim id has no
      // create response to show. Best-effort: the bar degrades gracefully.
      try {
        const entry = (await api.listSimulations()).find(sim => sim.id === simulationId);
        if (entry) set({ simulationInfo: entry });
      } catch {
        // Non-fatal: the status bar falls back to snapshot-derived mode.
      }
    } catch (error) {
      // T-028/EA-F08: the workbench 运行中仿真 attach is a DEAD click when
      // this fails — simulationId is never set, so the console (the only UI
      // that renders simulationError) never mounts. Surface a toast from
      // here so the caller sees the failure (stale cached sim id, pruned
      // sim, network) instead of nothing.
      const message = simulationErrorMessage(error);
      set({ simulationError: message });
      get().pushToast(
        i18n.getFixedT(i18n.language, 'toasts')('attachSimulationFailed', { error: message }),
      );
    }
  },

  clearSimulation: () =>
    set({
      simulationId: null,
      simulationInfo: null,
      simulationError: null,
      simulationSource: null,
      // demoRun survives the console: a demo run is page-scoped (world view
      // banner owns its lifecycle), not console-scoped — opening/closing the
      // console mid-demo must not orphan the banner's stop path.
      ...STREAM_RESET,
      ...REPLAY_RESET,
    }),

  setSimulationError: message => set({ simulationError: message }),

  // -------------------------------------------------------------------------
  // snapshot slice
  // -------------------------------------------------------------------------
  snapshot: null,

  setSnapshot: snapshot =>
    set(state => {
      // R31 F6 freshness guard: the REST poll used to replace the snapshot
      // unconditionally — a poll landing after the WS already delivered the
      // SAME tick swapped an identical-content object (both paths JSON.parse
      // fresh, so array references always differ and only the tick identity
      // can dedupe them) and cost a full console re-render pass for nothing.
      // Not-fresher + unchanged state ⇒ no-op. `state` rides along in the
      // guard so pause/stop transitions at a frozen tickCount still land.
      const current = state.snapshot;
      if (current && current.state === snapshot.state && !isSnapshotFresher(snapshot, current)) {
        return state;
      }
      const replayBuffer = appendToReplayBuffer(state.replayBuffer, snapshot);
      return {
        snapshot,
        replayBuffer,
        replayTimes: appendReplayTime(state.replayTimes, state.replayBuffer, replayBuffer, Date.now()),
      };
    }),

  applyStreamSnapshot: snapshot =>
    set(state => {
      if (!isSnapshotFresher(snapshot, state.snapshot)) return state;
      const replayBuffer = appendToReplayBuffer(state.replayBuffer, snapshot);
      return {
        snapshot,
        replayBuffer,
        replayTimes: appendReplayTime(state.replayTimes, state.replayBuffer, replayBuffer, Date.now()),
      };
    }),

  // R31 SF10 — see SnapshotSlice docs. Both appliers share one contract:
  // before the initial full snapshot there is nothing to patch (return
  // unchanged), a frame for an unknown id is topology drift (the server's
  // 30s resync / topology-change full snapshot corrects it), and a frame
  // whose values already match is a no-op (no identity change ⇒ no render).
  applyZoneDelta: frame =>
    set(state => {
      const current = state.snapshot;
      if (!current) return state;
      const index = current.zones.findIndex(zone => zone.id === frame.zoneId);
      if (index === -1) return state;
      const zone = current.zones[index]!;
      // The web reads occupancy from zone.parameters (readOccupancy); the
      // server's occupancy ride-along rides as param 'occupancy'.
      if (zone.parameters[frame.param] === frame.newValue) return state;
      const zones = [...current.zones];
      zones[index] = {
        ...zone,
        parameters: { ...zone.parameters, [frame.param]: frame.newValue },
      };
      const snapshot = { ...current, zones, simTimeSec: frame.simTimeSec };
      const replayBuffer = appendToReplayBuffer(state.replayBuffer, snapshot);
      return {
        snapshot,
        replayBuffer,
        replayTimes: appendReplayTime(state.replayTimes, state.replayBuffer, replayBuffer, Date.now()),
      };
    }),

  applyDeviceDelta: frame =>
    set(state => {
      const current = state.snapshot;
      if (!current) return state;
      const index = current.devices.findIndex(device => device.id === frame.deviceId);
      if (index === -1) return state;
      const device = current.devices[index]!;
      const stateChanges: Record<string, unknown> = {};
      let fault: (typeof device)['fault'] | undefined;
      let hasFault = false;
      for (const [field, change] of Object.entries(frame.changedFields)) {
        if (field === 'fault') {
          fault = (change.to ?? null) as (typeof device)['fault'];
          hasFault = true;
        } else if (device.state[field] !== change.to) {
          stateChanges[field] = change.to;
        }
      }
      const stateChanged = Object.keys(stateChanges).length > 0;
      const faultChanged = hasFault && fault !== device.fault;
      if (!stateChanged && !faultChanged) return state;
      const devices = [...current.devices];
      devices[index] = {
        ...device,
        ...(stateChanged ? { state: { ...device.state, ...stateChanges } } : {}),
        ...(faultChanged ? { fault } : {}),
      };
      const snapshot = { ...current, devices, simTimeSec: frame.simTimeSec };
      const replayBuffer = appendToReplayBuffer(state.replayBuffer, snapshot);
      return {
        snapshot,
        replayBuffer,
        replayTimes: appendReplayTime(state.replayTimes, state.replayBuffer, replayBuffer, Date.now()),
      };
    }),

  clearSnapshot: () => set({ snapshot: null, ...REPLAY_RESET }),

  // -------------------------------------------------------------------------
  // stream slice
  // -------------------------------------------------------------------------
  ...STREAM_RESET,

  setStreamStatus: streamStatus => set({ streamStatus }),

  appendStreamEvents: events =>
    set(state => {
      if (events.length === 0) return state;
      const entries = events.map(toLogEntry);
      // Incoming batches are oldest→newest; the log is newest-first.
      const eventLog = [...entries.reverse(), ...state.eventLog].slice(0, EVENT_LOG_CAP);
      return { eventLog };
    }),

  recordTriggerHint: (eventId, hint) =>
    set(state => {
      if (!eventId) return state;
      const triggerHints = { ...state.triggerHints, [eventId]: hint };
      // FIFO eviction: keys keep first-insertion order, oldest drops out.
      const keys = Object.keys(triggerHints);
      if (keys.length > TRIGGER_HINT_CAP) {
        delete triggerHints[keys[0]];
      }
      return { triggerHints };
    }),

  // -------------------------------------------------------------------------
  // replay slice
  // -------------------------------------------------------------------------
  ...REPLAY_RESET,

  enterReplay: () =>
    set(state => ({
      replayActive: true,
      replayPlaying: false,
      replayCursor: Math.max(state.replayBuffer.length - 1, 0),
    })),

  exitReplay: () => set({ replayActive: false, replayPlaying: false }),

  setReplayCursor: cursor =>
    set(state => ({
      replayCursor: Math.min(Math.max(cursor, 0), Math.max(state.replayBuffer.length - 1, 0)),
    })),

  setReplayPlaying: replayPlaying => set({ replayPlaying }),

  setReplaySpeed: replaySpeed => set({ replaySpeed }),

  // -------------------------------------------------------------------------
  // ui slice
  // -------------------------------------------------------------------------
  selectedAgentId: null,
  theme: loadTheme(),

  backToDetail: () => {
    const source = get().simulationSource;
    const worldId = get().world?.id;
    const scenarioId = get().currentScenario?.meta.id;
    get().clearSimulation();
    get().clearSnapshot();
    set({ selectedAgentId: null });
    navigateTo(
      source === 'environment'
        ? worldId
          ? `/environments/${worldId}`
          : '/environments'
        : scenarioId
          ? `/scenarios/${scenarioId}`
          : '/scenarios',
    );
  },

  selectAgent: id => set({ selectedAgentId: id }),

  setTheme: theme => {
    saveTheme(theme);
    set({ theme });
  },

  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    saveTheme(theme);
    set({ theme });
  },
}));

/** Expired sessions funnel here from the API client (any 401 on authed calls). */
api.setUnauthorizedHandler(() => useAppStore.getState().handleUnauthorized());

function simulationErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'LLM_NOT_CONFIGURED') {
    const t = i18n.getFixedT(i18n.language, 'toasts');
    return t('llmNotConfigured');
  }
  return errorMessage(error);
}
