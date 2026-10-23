/**
 * Notification grouping (B3) — the inbox splits into「需要我处理」(inbound
 * requests waiting on the user's decision) and「全部动态」(the full feed).
 *
 * The notification schema carries no actor/mention fields, so "actionable"
 * is approximated by kind: the kinds emitted when someone ELSE asks the
 * recipient for a decision (server: apps/server/src/notifications.ts
 * NOTIFICATION_KINDS). Kept as pure functions so the bucketing is testable
 * without rendering the page.
 */

/** Kinds that mean "someone is waiting on my decision". */
export const ACTIONABLE_NOTIFICATION_KINDS: readonly string[] = [
  'proposal.escalated',
  'agreement.proposed',
  // T-059 (T-066): the counter-offer lands on the CONSUMER's table and the
  // remind nudge lands on the CURRENT decider — both arrive exactly when the
  // recipient's move is pending.
  'agreement.countered',
  'agreement.reminded',
];

// T4: kind 徽标的 i18n 映射——按前缀归类（原始 kind 保留在 title 提示里）。
const KIND_CATEGORY_KEYS: Record<string, string> = {
  proposal: 'kindCategory.proposal',
  agreement: 'kindCategory.agreement',
  collaboration: 'kindCategory.collaboration',
  member: 'kindCategory.member',
  service: 'kindCategory.service',
  ask: 'kindCategory.ask',
  share: 'kindCategory.share',
  governance: 'kindCategory.governance',
};

/** kind → 分类 i18n key（未知前缀返回 null，调用方回落原始 kind）。 */
export function notificationKindCategoryKey(kind: string): string | null {
  const prefix = kind.split('.')[0] ?? '';
  return KIND_CATEGORY_KEYS[prefix] ?? null;
}

export function isActionableNotification(kind: string): boolean {
  return ACTIONABLE_NOTIFICATION_KINDS.includes(kind);
}

/**
 * T-059 (§5.3) machine-readable reply affordance on agreement lifecycle
 * notifications: the body names WHERE the decision goes
 * (`POST /api/agreements/:id/decide`), the allowed verdicts, and whose move
 * it is. Parsed defensively — older notifications carry no replyHint and
 * unknown shapes read as "no hint" rather than crashing the inbox.
 */
export interface ReplyHint {
  endpoint: string;
  allowedDecisions: string[];
  yourMove: boolean;
}

export function replyHintOf(body: Record<string, unknown>): ReplyHint | null {
  const raw = body.replyHint;
  if (typeof raw !== 'object' || raw === null) return null;
  const hint = raw as Record<string, unknown>;
  if (typeof hint.endpoint !== 'string' || hint.endpoint.length === 0) return null;
  const allowedDecisions = Array.isArray(hint.allowedDecisions)
    ? hint.allowedDecisions.filter((d): d is string => typeof d === 'string')
    : [];
  return {
    endpoint: hint.endpoint,
    allowedDecisions,
    yourMove: hint.yourMove === true,
  };
}

export interface NotificationBuckets<T> {
  /** 需要我处理 — actionable kinds, newest first (input order preserved). */
  actionable: T[];
  /** Unread count inside the actionable bucket (drives the tab badge). */
  actionableUnread: number;
}

/** Bucket an inbox list by kind; the input order is preserved. */
export function bucketNotifications<T extends { kind: string; readAt: string | null }>(
  notifications: readonly T[],
): NotificationBuckets<T> {
  const actionable = notifications.filter(n => isActionableNotification(n.kind));
  return {
    actionable,
    actionableUnread: actionable.filter(n => n.readAt === null).length,
  };
}
