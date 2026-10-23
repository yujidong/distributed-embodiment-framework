/**
 * NotificationBell — the header's unread-notification doorbell (Fix-16/17).
 *
 * Pull-only by design (the inbox has no WS push): the unread count is a
 * TanStack Query poll (`refetchInterval`) on
 * GET /api/notifications?unread=true&limit=1; clicking opens the 通知 inbox
 * view. Read mutations invalidate the shared `['notifications']` prefix, so
 * the badge refreshes right after anything is marked read.
 */

import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useUnreadNotificationCount } from '../hooks/useNotifications';

export function NotificationBell() {
  const navigate = useNavigate();
  const { t } = useTranslation('notificationBell');
  const { data } = useUnreadNotificationCount();
  // A failed poll keeps the last cached count — Query retries on the next tick.
  const unreadCount = data?.unreadCount ?? 0;

  return (
    <button
      className="icon-button notification-bell"
      title={unreadCount > 0 ? t('unreadTitle', { count: unreadCount }) : t('title')}
      aria-label={t('ariaLabel')}
      onClick={() => navigate('/notifications')}
    >
      <Bell size={16} />
      {unreadCount > 0 && (
        <span className="notification-bell__badge" data-testid="notification-badge">
          {unreadCount}
        </span>
      )}
    </button>
  );
}
