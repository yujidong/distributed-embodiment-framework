/**
 * Workbench queries (W5) — GET /api/me/overview for the 工作台 landing,
 * migrated from the zustand `workbench` slice to TanStack Query
 * (see lib/queryClient.ts for the state-management split).
 *
 * 取消收藏 keeps its old optimistic semantics: the cached overview is
 * recomputed via lib/workbench's `unsubscribeFromOverview` on mutate and
 * rolled back on error; a settled mutation invalidates so the server stays
 * the ground truth. The world view's marketplace stars (still zustand
 * run-time state) are kept consistent from here as before.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as api from '../api/client';
import type { MeOverview } from '../api/types';
import i18n from '../i18n/config';
import { queryKeys } from '../lib/queryClient';
import { applySubscriptionState } from '../lib/subscriptions';
import { unsubscribeFromOverview } from '../lib/workbench';
import { useAppStore } from '../store/useAppStore';

/** GET /api/me/overview — the 工作台 payload. */
export function useOverview() {
  return useQuery({
    queryKey: queryKeys.me.overview(),
    queryFn: () => api.getMyOverview(),
  });
}

/** DELETE the caller's subscription — optimistic overview recompute. */
export function useUnsubscribeFromWorkbench() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) => api.unsubscribeService(serviceId),
    onMutate: async serviceId => {
      await queryClient.cancelQueries({ queryKey: queryKeys.me.overview() });
      const previous = queryClient.getQueryData<MeOverview>(queryKeys.me.overview());
      if (previous) {
        queryClient.setQueryData(
          queryKeys.me.overview(),
          unsubscribeFromOverview(previous, serviceId),
        );
      }
      // Keep the world view's stars consistent when it is open on that env.
      useAppStore.setState(state => ({
        myServiceSubscriptions: applySubscriptionState(
          state.myServiceSubscriptions,
          serviceId,
          false,
        ),
      }));
      return { previous };
    },
    onError: (error, _serviceId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.me.overview(), context.previous);
      }
      useAppStore.getState().pushToast(i18n.t('useOverviewLib:unsubscribeFailed', { message: error.message }));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me.overview() });
    },
  });
}
