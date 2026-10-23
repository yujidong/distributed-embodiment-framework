/**
 * Notification queries (Fix-16/17) — the inbox list + the header bell's
 * unread-count poll, migrated from hand-rolled fetch/useEffect to TanStack
 * Query (see lib/queryClient.ts for the state-management split).
 *
 * The inbox is pull-only (no WS push): the bell polls via `refetchInterval`
 * and both read mutations apply an optimistic cache update, then invalidate
 * the `['notifications']` prefix so list + badge re-sync from the server.
 *
 * T-030: the list is an INFINITE query — the server caps a page at 200 and
 * everything older is reachable only via the `?before=` cursor (same
 * contract as the activity feed). The page button (load-older) walks
 * `fetchNextPage`; read mutations invalidate the whole query so every
 * loaded page re-syncs.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';

import * as api from '../api/client';
import type { NotificationListResult } from '../api/types';
import i18n from '../i18n/config';
import { queryKeys } from '../lib/queryClient';
import { useAppStore } from '../store/useAppStore';

/** Bell poll cadence (unchanged from the pre-Query setInterval). */
export const NOTIFICATION_POLL_INTERVAL_MS = 30_000;

/** One inbox page — a full page means older rows may exist (load-older). */
export const NOTIFICATION_PAGE_SIZE = 50;

type InboxPageParam = string | null;

/** GET /api/notifications — the paged inbox (NotificationsPage). */
export function useNotificationList() {
  return useInfiniteQuery({
    queryKey: queryKeys.notifications.list(),
    queryFn: ({ pageParam }) =>
      api.listNotifications({
        limit: NOTIFICATION_PAGE_SIZE,
        ...(pageParam !== null ? { before: pageParam } : {}),
      }),
    initialPageParam: null as InboxPageParam,
    // A full page probably has older rows behind it: the next cursor is the
    // createdAt of the page's last row (strictly older). A short page is the
    // end of the history — undefined stops the load-older affordance.
    getNextPageParam: lastPage =>
      lastPage.notifications.length >= NOTIFICATION_PAGE_SIZE && lastPage.notifications.length > 0
        ? lastPage.notifications[lastPage.notifications.length - 1].createdAt
        : undefined,
  });
}

/** Flatten the loaded pages into one newest-first list (page order preserves it). */
export function flattenInboxPages(data: InfiniteData<NotificationListResult> | undefined) {
  return data ? data.pages.flatMap(page => page.notifications) : null;
}

/** GET /api/notifications?unread=true&limit=1 — badge count only (bell). */
export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: () => api.listNotifications({ unread: true, limit: 1 }),
    refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
  });
}

/**
 * Optimistically mark `id` read inside the cached (paged) list result. The
 * row may sit on ANY loaded page; `unreadCount` mirrors on every page, so
 * only the first page's copy is decremented (settle re-syncs them all).
 */
function applyRead(
  data: InfiniteData<NotificationListResult>,
  id: string,
  readAt: string,
): InfiniteData<NotificationListResult> {
  const target = data.pages.flatMap(page => page.notifications).find(n => n.id === id);
  if (!target || target.readAt !== null) return data;
  return {
    ...data,
    pages: data.pages.map((page, index) => ({
      ...page,
      notifications: page.notifications.map(n => (n.id === id ? { ...n, readAt } : n)),
      unreadCount: index === 0 ? Math.max(page.unreadCount - 1, 0) : page.unreadCount,
    })),
  };
}

/** POST /api/notifications/:id/read — optimistic, toasts on failure. */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onMutate: async id => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all });
      const previous = queryClient.getQueryData<InfiniteData<NotificationListResult>>(
        queryKeys.notifications.list(),
      );
      if (previous) {
        queryClient.setQueryData(
          queryKeys.notifications.list(),
          applyRead(previous, id, new Date().toISOString()),
        );
      }
      return { previous };
    },
    onError: (error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.notifications.list(), context.previous);
      }
      useAppStore.getState().pushToast(i18n.t('useNotificationsLib:markReadFailed', { message: error.message }), 'error');
    },
    onSettled: () => {
      // Refreshes the list AND the bell's unread count (shared key prefix).
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
}

/** POST /api/notifications/read-all — optimistic, toasts on failure. */
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all });
      const previous = queryClient.getQueryData<InfiniteData<NotificationListResult>>(
        queryKeys.notifications.list(),
      );
      if (previous) {
        const readAt = new Date().toISOString();
        queryClient.setQueryData(queryKeys.notifications.list(), {
          ...previous,
          pages: previous.pages.map(page => ({
            ...page,
            notifications: page.notifications.map(n => ({ ...n, readAt: n.readAt ?? readAt })),
            unreadCount: 0,
          })),
        });
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.notifications.list(), context.previous);
      }
      useAppStore.getState().pushToast(i18n.t('useNotificationsLib:markAllReadFailed', { message: error.message }), 'error');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
}
