/**
 * Environment-list queries — the 我的/公开 home (EnvironmentsHomePage),
 * migrated from the zustand `environments` slice to TanStack Query
 * (see lib/queryClient.ts for the state-management split).
 *
 * The list itself is one cached query; every card mutation (删除 / 可见性 /
 * 加入 / 离开) invalidates it so the home re-syncs from the server, matching
 * the old action-then-`loadEnvironments()` semantics.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as api from '../api/client';
import type { EnvVisibility } from '../api/types';
import { queryKeys } from '../lib/queryClient';

/**
 * GET /api/environments — R15-D2: the 我的/公开 home needs both halves, so
 * it asks for the full visible set and splits client-side per tab.
 */
export function useEnvironmentList() {
  return useQuery({
    queryKey: queryKeys.environments.list('all'),
    queryFn: () => api.listEnvironments('all'),
  });
}

/** GET /api/environments (server default) — just the caller's worlds. */
export function useMyEnvironments() {
  return useQuery({
    queryKey: queryKeys.environments.list('mine'),
    queryFn: () => api.listEnvironments('mine'),
  });
}

/**
 * GET /api/me/quotas — R78-B: creation surfaces show usage up front (the
 * 429-at-submit surprise was R77 F4). 60s staleness; failures leave the
 * quota unknown (pure layer never blocks on missing limits).
 */
export function useMyQuotas() {
  return useQuery({
    queryKey: queryKeys.me.quotas(),
    queryFn: () => api.getMyQuotas(),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * GET /api/health — R74: the public decision-posture probe. The home page
 * polls it cheaply (60s) to keep the rule-test banner honest across a server
 * restart that enables or loses the LLM backend.
 */
export function usePublicHealth() {
  return useQuery({
    queryKey: queryKeys.health.public(),
    queryFn: () => api.getPublicHealth(),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * GET /api/environments/:id/roster-report — the owner-only grading export
 * (Fix-37), consumed by the world sidebar's 评分报告 tab.
 */
export function useRosterReport(envId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.environments.rosterReport(envId ?? ''),
    queryFn: () => api.getRosterReport(envId!),
    enabled: envId !== undefined,
  });
}

/** Shared invalidation for every environment-list mutation. */
function useInvalidateEnvironments() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
}

export function useRemoveEnvironment() {
  const invalidate = useInvalidateEnvironments();
  return useMutation({
    mutationFn: (id: string) => api.deleteEnvironment(id),
    onSuccess: invalidate,
  });
}

export function useSetEnvironmentVisibility() {
  const invalidate = useInvalidateEnvironments();
  return useMutation({
    mutationFn: ({ id, visibility }: { id: string; visibility: EnvVisibility }) =>
      api.patchEnvironment(id, { visibility }),
    onSuccess: invalidate,
  });
}

export function useJoinEnvironment() {
  const invalidate = useInvalidateEnvironments();
  return useMutation({
    mutationFn: (id: string) => api.joinEnvironment(id),
    onSuccess: invalidate,
  });
}

export function useLeaveEnvironment() {
  const invalidate = useInvalidateEnvironments();
  return useMutation({
    mutationFn: (id: string) => api.leaveEnvironment(id),
    onSuccess: invalidate,
  });
}
