/**
 * NotificationsPage — the Fix-16/17 inbox view: newest-first list from
 * GET /api/notifications (a TanStack Query — see hooks/useNotifications),
 * per-row 标记已读 and a 全部已读 bulk action, both optimistic with rollback.
 * Rows deep-link back to their environment when they carry an envId.
 *
 * B3 grouping: two tabs —「需要我处理」(inbound requests waiting on the
 * user's decision, see lib/notifications) with an unread-count badge, and
 *「全部动态」(the full feed, the pre-B3 behavior).
 *
 * T-066 (surface 1): rows carrying a machine-readable replyHint render it as
 * an inline decide affordance —「← 该你操作了」+ a direct link that opens the
 * agreement in the environment's 合约 tab (see ReplyHintAffordance).
 */

import { useState } from 'react';
import { ArrowLeft, BellOff, History, Inbox } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  flattenInboxPages,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationList,
} from '../hooks/useNotifications';
import type { AppNotification } from '../api/types';
import {
  bucketNotifications,
  notificationKindCategoryKey,
  replyHintOf,
} from '../lib/notifications';
import { formatRelativeTime } from '../lib/relativeTime';
import { useAppStore } from '../store/useAppStore';
import { Icon } from '../components/ui/Icon';

type InboxTab = 'all' | 'actionable';

export function NotificationsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation('notificationsPage');

  const { data, error, isLoading, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useNotificationList();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const [tab, setTab] = useState<InboxTab>('all');

  const notifications = flattenInboxPages(data);
  // The doorbell count is page-independent — every page mirrors it.
  const unreadCount = data?.pages[0]?.unreadCount ?? 0;
  const { actionable, actionableUnread } = bucketNotifications(notifications ?? []);
  const visible: AppNotification[] | null =
    notifications === null ? null : tab === 'actionable' ? actionable : notifications;

  return (
    <div className="home-page">
      <div className="home-toolbar">
        <div>
          <h3 className="workbench__greeting">{t('title')}</h3>
          <p className="page-note workbench__tagline">{t('unreadCount', { count: unreadCount })}</p>
        </div>
        <div className="workbench__actions">
          <button disabled={unreadCount === 0} onClick={() => markAll.mutate()}>
            {t('markAllRead')}
          </button>
          <Link className="link-button" to="/">
            <Icon icon={ArrowLeft} size={14} /> {t('backToWorkbench')}
          </Link>
        </div>
      </div>
      <div className="home-tabs inbox-tabs">
        <button
          className={tab === 'actionable' ? 'home-tab home-tab--active' : 'home-tab'}
          onClick={() => setTab('actionable')}
        >
          {t('tabActionable')}
          {actionableUnread > 0 && <span className="badge badge--user">{actionableUnread}</span>}
        </button>
        <button
          className={tab === 'all' ? 'home-tab home-tab--active' : 'home-tab'}
          onClick={() => setTab('all')}
        >
          {t('tabAll')}
        </button>
      </div>
      {error && (
        <div className="page-note page-note--error">
          <p>{t('loadFailed', { message: error.message })}</p>
          <button onClick={() => void refetch()}>{t('retry')}</button>
        </div>
      )}
      {visible === null && !error && isLoading && <p className="page-note">{t('loading')}</p>}
      {visible !== null && visible.length === 0 &&
        (tab === 'actionable' && (notifications ?? []).length > 0 ? (
          <div className="empty-state">
            <Icon icon={Inbox} size={28} className="empty-state__icon" />
            <p className="empty-state__title">{t('emptyActionableTitle')}</p>
            <p className="empty-state__note">{t('emptyActionableNote')}</p>
          </div>
        ) : (
          <div className="empty-state">
            <Icon icon={BellOff} size={28} className="empty-state__icon" />
            <p className="empty-state__title">{t('emptyTitle')}</p>
            <p className="empty-state__note">{t('emptyNote')}</p>
          </div>
        ))}
      <div className="object-list">
        {(visible ?? []).map(notification => (
          <div
            key={notification.id}
            className={`object-list__item notification-row${
              notification.readAt === null ? ' notification-row--unread' : ''
            }`}
          >
            <span className="object-list__name" title={notification.title}>
              {notification.title}
              {(notification.repeatCount ?? 1) > 1 && (
                <span className="notification-repeat-badge" title={t('repeatTitle', { count: notification.repeatCount })}>
                  ×{notification.repeatCount}
                </span>
              )}
            </span>
            {/* T4: kind 徽标本地化（原始英文 token 保留在 title），时间改
                相对时间（title 保留绝对 ISO）。 */}
            <span className="badge" title={notification.kind}>
              {(() => {
                const categoryKey = notificationKindCategoryKey(notification.kind);
                return categoryKey === null ? notification.kind : t(categoryKey);
              })()}
            </span>
            <span className="object-list__meta" title={notification.createdAt}>
              {formatRelativeTime(notification.createdAt)}
            </span>
            <span className="notification-row__actions">
              {notification.envId && (
                <button
                  className="link-button"
                  onClick={() => navigate(`/environments/${notification.envId}`)}
                >
                  {t('openEnv')}
                </button>
              )}
              {notification.readAt === null && (
                <button className="link-button" onClick={() => markRead.mutate(notification.id)}>
                  {t('markRead')}
                </button>
              )}
            </span>
            <ReplyHintAffordance notification={notification} />
          </div>
        ))}
      </div>
      {/* T-030: the server caps a page at 200 — everything older is reachable
          only via the ?before= cursor (the activity feed's paging contract).
          A full page offers load-older; a short page ends the history. */}
      {tab === 'all' && notifications !== null && notifications.length > 0 && (
        <div className="inbox-load-older">
          {hasNextPage ? (
            <button
              className="link-button"
              data-testid="notifications-load-older"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              <Icon icon={History} size={14} />
              {isFetchingNextPage ? t('loadingOlder') : t('loadOlder')}
            </button>
          ) : (
            <span className="page-note">{t('noMoreOlder')}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * T-066 (surface 1): the machine-readable replyHint on agreement lifecycle
 * notifications becomes an inline decide affordance — yourMove rows say
 * 「← 该你操作了」 with a direct link into the environment's 合约 tab
 * (the agreement opens in the detail view); rows whose move sits with the
 * counterparty render the distinct waiting state instead.
 * UX-W5: proposal replyHints (proposal.escalated / proposal.reminded — body
 * carries proposalId, no agreementId) deep-link the new 收件箱 governance
 * tab (?tab=governance) where the inline 批准/驳回 lives.
 */
function ReplyHintAffordance({ notification }: { notification: AppNotification }) {
  const navigate = useNavigate();
  const selectAgreement = useAppStore(s => s.selectAgreement);
  const { t } = useTranslation('notificationsPage');
  const hint = replyHintOf(notification.body);
  if (hint === null) return null;
  const agreementId =
    typeof notification.body.agreementId === 'string' ? notification.body.agreementId : null;
  const proposalId =
    typeof notification.body.proposalId === 'string' ? notification.body.proposalId : null;
  const openAgreement = () => {
    if (notification.envId === null || agreementId === null) return;
    selectAgreement(agreementId);
    navigate(`/environments/${notification.envId}?tab=agreements`);
  };
  const openGovernanceInbox = () => {
    if (notification.envId === null) return;
    navigate(`/environments/${notification.envId}?tab=governance`);
  };
  const decideTarget =
    agreementId !== null && notification.envId !== null
      ? openAgreement
      : proposalId !== null && notification.envId !== null
        ? openGovernanceInbox
        : null;
  return (
    <div className="notification-row__reply">
      {hint.yourMove ? (
        <>
          <span className="notification-row__your-move" data-testid="reply-hint-your-move">
            {t('yourMove')}
          </span>
          {decideTarget !== null && (
            <button className="primary-button notification-row__decide" onClick={decideTarget}>
              {t('goDecide')}
            </button>
          )}
        </>
      ) : (
        <span className="notification-row__waiting" data-testid="reply-hint-waiting">
          {t('waitingOnCounterpart')}
        </span>
      )}
      {/* R2-UX-10: 不再裸露 API 路径——行尾说「去哪里处理」（原始 endpoint
          留在 title 调试面）。 */}
      <span className="object-list__meta" title={hint.endpoint}>
        {agreementId !== null
          ? t('replyHintLocationAgreements')
          : t('replyHintLocationGovernance')}
      </span>
    </div>
  );
}
