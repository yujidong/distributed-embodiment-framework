/**
 * Flow queries — the 业务流 editor (FlowsPage), following the
 * useEnvironments.ts pattern: cached queries plus mutations that invalidate
 * the env's flow list afterwards.
 *
 * Runs are a per-flow ledger query the run-history drawer polls lazily
 * (enabled only while the drawer is open).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as api from '../api/client';
import type { CreateFlowInput, EnvironmentDetail, PatchFlowInput } from '../api/types';
import { queryKeys } from '../lib/queryClient';

/** The environment detail (zones/agents feed the editor's dropdowns). */
export function useEnvironmentDetail(envId: string | undefined) {
  return useQuery<EnvironmentDetail>({
    queryKey: queryKeys.environments.detail(envId ?? ''),
    queryFn: () => api.getEnvironment(envId!),
    enabled: envId !== undefined,
  });
}

/** GET /api/environments/:envId/flows — the env's flow list. */
export function useFlowList(envId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.flows.list(envId ?? ''),
    queryFn: () => api.listFlows(envId!),
    enabled: envId !== undefined,
  });
}

/** GET /api/flows/:id/runs — fetched on demand (run-history drawer open). */
export function useFlowRuns(flowId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.flows.runs(flowId ?? ''),
    queryFn: () => api.listFlowRuns(flowId!),
    enabled: enabled && flowId !== undefined,
  });
}

/** The flow list's latest-run status dot (limit=1, separate cache entry). */
export function useLatestFlowRun(flowId: string) {
  return useQuery({
    queryKey: [...queryKeys.flows.runs(flowId), 'latest'] as const,
    queryFn: async () => (await api.listFlowRuns(flowId, 1))[0] ?? null,
  });
}

/** Shared invalidation for every flow mutation of one environment. */
function useInvalidateFlows(envId: string | undefined) {
  const queryClient = useQueryClient();
  return (flowId?: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.flows.list(envId ?? '') });
    if (flowId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.flows.runs(flowId) });
    }
  };
}

export function useCreateFlow(envId: string | undefined) {
  const invalidate = useInvalidateFlows(envId);
  return useMutation({
    mutationFn: (input: CreateFlowInput) => api.createFlow(envId!, input),
    onSuccess: flow => invalidate(flow.id),
  });
}

export function usePatchFlow(envId: string | undefined) {
  const invalidate = useInvalidateFlows(envId);
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchFlowInput }) =>
      api.patchFlow(id, patch),
    onSuccess: flow => invalidate(flow.id),
  });
}

export function useDeleteFlow(envId: string | undefined) {
  const invalidate = useInvalidateFlows(envId);
  return useMutation({
    mutationFn: (id: string) => api.deleteFlow(id),
    onSuccess: () => invalidate(),
  });
}
