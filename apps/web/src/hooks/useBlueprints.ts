/**
 * Blueprint queries (Fix-38) — the world sidebar's 蓝图 tab
 * (BlueprintsPanel), following the useFlows.ts pattern: a cached list query
 * plus an install mutation that invalidates the environment detail (devices/
 * agents changed) and the env's flow list afterwards, and reloads the open
 * world in the zustand store (R14: the world view does not read the detail
 * through react-query, so invalidation alone left it stale).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as api from '../api/client';
import { queryKeys } from '../lib/queryClient';
import { useAppStore } from '../store/useAppStore';

/** GET /api/blueprints — built-in + custom templates. */
export function useBlueprintList() {
  return useQuery({
    queryKey: queryKeys.blueprints.list(),
    queryFn: () => api.getBlueprints(),
  });
}

/**
 * POST /api/environments/:envId/blueprints/:bpId/install — resolves template
 * variables and creates devices + agents + flows in the target zone.
 */
export function useInstallBlueprint(envId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bpId, zoneId }: { bpId: string; zoneId: string }) =>
      api.installBlueprint(envId, bpId, { zoneId }),
    onSuccess: () => {
      // Installed devices/agents live on the environment detail; flows have
      // their own list query. The OPEN world, however, lives in the zustand
      // store (openEnvironment), not in react-query — invalidating the detail
      // key alone leaves the world view (counts, map, AppOverview, the P1-2
      // health card) stale until a manual reload, so refresh it directly.
      void queryClient.invalidateQueries({ queryKey: queryKeys.environments.detail(envId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.flows.list(envId) });
      // R6-D-M1: installing devices/agents advances the quest backbone.
      void queryClient.invalidateQueries({ queryKey: queryKeys.environments.questState(envId) });
      if (useAppStore.getState().world?.id === envId) {
        void useAppStore.getState().reloadWorld();
      }
    },
  });
}
