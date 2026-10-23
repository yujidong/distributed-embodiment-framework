/**
 * Notification inbox routes (Fix-16, roadmap Fix-16)
 *
 * - `GET  /api/notifications?unread=&limit=&before=`  the caller's own
 *     inbox, newest first; `unread=true` filters to unread. The response
 *     always carries `unreadCount` (the doorbell number) regardless of the
 *     filter. `before` (ISO, T-030) pages backwards past the newest-200
 *     clamp — the same cursor contract as the activity feed's `?before=`
 *     (strictly older rows; pass the createdAt of the last row of the
 *     previous page).
 * - `POST /api/notifications/:id/read`        mark one of the caller's
 *     notifications read (idempotent). Another user's id answers 404 exactly
 *     like an unknown id — the inbox is strictly private.
 * - `POST /api/notifications/read-all`        mark everything read; returns
 *     how many changed.
 *
 * Notifications are PULL-only by design: the world stream already carries
 * the live governance/agreement events; this inbox is what survives a
 * disconnected websocket — no WS push of notification rows (保持简单).
 */

import type { FastifyInstance } from 'fastify';

import type { NotificationRow, NotificationStore } from '../db/notification-store.js';
import { NOTIFICATION_KINDS, notificationToJson } from '../notifications.js';
import { ApiError } from '../errors.js';

export interface NotificationRoutesContext {
  notificationStore: NotificationStore;
  /**
   * P3 (R11, u3-F3): read-time replyHint revalidation — the inbox row is a
   * SNAPSHOT of "your move" taken when the agreement notification was
   * minted; once the agreement moved on (decided / countered away /
   * terminated), the stored flag lies on the same screen as the terminated
   * row. The list route re-checks agreement.proposed / agreement.countered
   * hints against the LIVE agreement status and flips `yourMove` to false
   * when the ball is no longer in the reader's court. Optional so
   * degenerate harnesses can omit it; a missing agreement row also clears
   * the flag (an unverifiable move is not advertised).
   */
  agreementStore?: { getAgreement(id: string): { status: string } | undefined };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** T59: the known-kind vocabulary the `kind` filter validates against. */
const NOTIFICATION_KIND_VALUES: readonly string[] = Object.values(NOTIFICATION_KINDS);

/** The agreement status each replyHint-bearing kind assumes when minted. */
const REPLY_HINT_EXPECTED_STATUS: Record<string, string> = {
  [NOTIFICATION_KINDS.agreementProposed]: 'proposed',
  [NOTIFICATION_KINDS.agreementCountered]: 'countered',
};

/** P3 (u3-F3): flip a stale `yourMove` off when the agreement moved on. */
function revalidateReplyHint(
  row: NotificationRow,
  json: ReturnType<typeof notificationToJson>,
  agreementStore: NotificationRoutesContext['agreementStore'],
): ReturnType<typeof notificationToJson> {
  const expected = REPLY_HINT_EXPECTED_STATUS[row.kind];
  if (expected === undefined || agreementStore === undefined || row.ref_id === null) return json;
  const body = json.body;
  if (typeof body !== 'object' || body === null) return json;
  const hint = (body as Record<string, unknown>).replyHint;
  if (typeof hint !== 'object' || hint === null || (hint as { yourMove?: unknown }).yourMove !== true) {
    return json;
  }
  const agreement = agreementStore.getAgreement(row.ref_id);
  if (agreement !== undefined && agreement.status === expected) return json;
  return {
    ...json,
    body: {
      ...(body as Record<string, unknown>),
      replyHint: { ...(hint as Record<string, unknown>), yourMove: false },
    },
  };
}

export function registerNotificationRoutes(app: FastifyInstance, ctx: NotificationRoutesContext): void {
  app.get('/api/notifications', { preHandler: app.authenticate }, async request => {
    const user = request.user!;
    const query = request.query as Record<string, unknown>;

    let unreadOnly = false;
    if (query.unread !== undefined) {
      if (query.unread !== 'true' && query.unread !== 'false') {
        throw new ApiError(400, 'BAD_REQUEST', 'Query "unread" must be "true" | "false"');
      }
      unreadOnly = query.unread === 'true';
    }

    let limit = DEFAULT_LIMIT;
    if (query.limit !== undefined) {
      const parsed = Number(query.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Query "limit" must be a positive integer');
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    // T-030 (R10 EB-F10): the backwards cursor — rows strictly older than
    // the ISO timestamp (typically the createdAt of the last row of the
    // previous page). Without it everything past the newest 200 was
    // unreachable via the API.
    if (query.before !== undefined && Number.isNaN(Date.parse(String(query.before)))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Query "before" must be an ISO timestamp');
    }
    const before = query.before !== undefined ? String(query.before) : undefined;

    // T59 (R6, u1-F8): server-side kind filter — the inbox mute face
    // (`eaf notifications list --kind proposal.auto_applied`). Filtering
    // AFTER the limit would make the pagination lie about what a page holds.
    if (query.kind !== undefined) {
      const kind = String(query.kind);
      if (kind.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Query "kind" must be a non-empty kind name when provided');
      }
      if (!NOTIFICATION_KIND_VALUES.includes(kind)) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Query "kind" names no known notification kind: "${kind}" — known kinds: ${NOTIFICATION_KIND_VALUES.join(', ')}`,
        );
      }
    }
    const kind = query.kind !== undefined ? String(query.kind) : undefined;

    const rows = ctx.notificationStore.listForUser(user.id, { unreadOnly, limit, before, kind });
    return {
      // P3 (u3-F3): every row's move-affordance is revalidated against the
      // live agreement status — the inbox never advertises a move that is
      // no longer yours (the notification store row keeps its history).
      notifications: rows.map(row => revalidateReplyHint(row, notificationToJson(row), ctx.agreementStore)),
      unreadCount: ctx.notificationStore.countUnread(user.id),
    };
  });

  app.post('/api/notifications/:id/read', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as { id: string };
    const row = ctx.notificationStore.markRead(id, request.user!.id);
    if (!row) {
      throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', `Notification "${id}" not found`);
    }
    return notificationToJson(row);
  });

  app.post('/api/notifications/read-all', { preHandler: app.authenticate }, async request => {
    return { marked: ctx.notificationStore.markAllRead(request.user!.id) };
  });
}
