/**
 * TanStack Query setup — the single QueryClient + the query-key convention.
 *
 * 状态管理分工约定（详见 apps/web/README.md「状态管理约定」）：
 * - **服务端状态归 TanStack Query**：任何来自 REST API、以"拉取/缓存/失效"
 *   为生命周期的数据（通知、环境列表、工作台概览……）一律用 useQuery /
 *   useMutation，不再手写 fetch-进-store。
 * - **UI / 会话 / 运行期流式状态留 zustand**（store/useAppStore.ts）：auth
 *   会话、世界视图的 WS 增量、仿真 snapshot/stream/replay、主题等。
 *
 * Query key 约定：数组形式，第一段为资源域，后续为作用域/参数，例如
 * `['notifications', 'list']`、`['environments', 'list']`、`['me', 'overview']`。
 * 失效时按前缀失效（如 `['notifications']` 同时刷新列表与未读数）。
 * 本文件集中维护 key factory，禁止在组件里散落手写 key。
 */

import { QueryClient } from '@tanstack/react-query';

/** Central query-key factory — every useQuery/useMutation key comes from here. */
export const queryKeys = {
  health: {
    all: ['health'] as const,
    /** R74: the public /api/health probe (decision posture for the home banner). */
    public: () => [...queryKeys.health.all, 'public'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: () => [...queryKeys.notifications.all, 'list'] as const,
    unreadCount: () => [...queryKeys.notifications.all, 'unread-count'] as const,
  },
  environments: {
    all: ['environments'] as const,
    /** R15-D2: 'mine' (default) or 'all' — the server-side list filter. */
    list: (filter: 'mine' | 'all' = 'mine') => [...queryKeys.environments.all, 'list', filter] as const,
    detail: (envId: string) => [...queryKeys.environments.all, 'detail', envId] as const,
    /** R40-A1: the env's governance proposals (list + decide/remind/revert). */
    proposals: (envId: string) => [...queryKeys.environments.all, 'proposals', envId] as const,
    /** R40-B3: the env's living-world sandbox forks (list + stop). */
    sandboxes: (envId: string) => [...queryKeys.environments.all, 'sandboxes', envId] as const,
    rosterReport: (envId: string) => [...queryKeys.environments.all, 'roster-report', envId] as const,
    /** T-016: batch-eval job history (summary rows) + by-id detail. */
    evalRuns: (envId: string) => [...queryKeys.environments.all, 'eval-runs', envId] as const,
    evalRunDetail: (jobId: string) => ['eval-runs', 'detail', jobId] as const,
    /** R6-D-F01: the arrival digest (achievement timeline source). */
    digest: (envId: string) => [...queryKeys.environments.all, 'digest', envId] as const,
    /** R6-D-M1: the L1-L6 quest state (quests panel source). */
    questState: (envId: string) => [...queryKeys.environments.all, 'quest-state', envId] as const,
  },
  simulations: {
    all: ['simulations'] as const,
    evalReport: (simId: string) => [...queryKeys.simulations.all, 'eval-report', simId] as const,
  },
  blueprints: {
    all: ['blueprints'] as const,
    list: () => [...queryKeys.blueprints.all, 'list'] as const,
  },
  scenarioTemplates: {
    all: ['scenario-templates'] as const,
    list: (lang: string) => [...queryKeys.scenarioTemplates.all, 'list', lang] as const,
  },
  /** UX-W3: the built-in device-template registry (read-only, process-stable). */
  deviceTemplates: {
    all: ['device-templates'] as const,
    list: () => [...queryKeys.deviceTemplates.all, 'list'] as const,
  },
  flows: {
    all: ['flows'] as const,
    list: (envId: string) => [...queryKeys.flows.all, 'list', envId] as const,
    runs: (flowId: string) => [...queryKeys.flows.all, 'runs', flowId] as const,
  },
  me: {
    all: ['me'] as const,
    overview: () => [...queryKeys.me.all, 'overview'] as const,
    /** R78-B: quota introspection (creation-surface badges). */
    quotas: () => [...queryKeys.me.all, 'quotas'] as const,
  },
  /** UX-W5: the governance inbox's agreement mailboxes (provider/consumer). */
  agreements: {
    all: ['agreements'] as const,
    mailbox: (envId: string, role: 'provider' | 'consumer') =>
      [...queryKeys.agreements.all, 'mailbox', envId, role] as const,
  },
  shares: {
    all: ['shares'] as const,
    view: (shareId: string) => [...queryKeys.shares.all, 'view', shareId] as const,
  },
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Lists/overview change via mutations we invalidate ourselves, and
        // the hot slices poll on their own cadence — 30s staleness avoids
        // refetch storms on remount without going meaningfully stale.
        staleTime: 30_000,
        // One retry rides out a flaky network; persistent failures surface
        // as the query error state instead of hanging the page. 401 is not
        // retried — it means "not signed in" (the auth guard routes to the
        // login page); retrying just logs console noise on every mount.
        retry: (failureCount, error) => {
          if (error instanceof Error && error.message.includes('401')) return false;
          return failureCount < 1;
        },
        // Window-focus refetches duplicate the WS streams and poll timers
        // that already keep the hot data fresh — opt in per query instead.
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** The app's singleton client (main.tsx mounts it; logout clears it). */
export const queryClient = createQueryClient();
