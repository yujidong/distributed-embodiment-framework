/**
 * Outbound notification webhook (Wave-4b, roadmap Wave 4「通知通道扩展」)
 *
 * The Fix-16 inbox is pull-only; this is the push side: after notify()
 * persists a row, the recipient's configured webhook (`users.webhook_url`,
 * PUT /api/me/notification-webhook) receives the FULL notification as a JSON
 * POST — the same wire shape as GET /api/notifications entries.
 *
 * Semantics (also documented in openapi.yaml):
 * - fire-and-forget: delivery never blocks nor fails the request that
 *   produced the notification;
 * - 5s timeout per attempt; a failure (network error, timeout, non-2xx) is
 *   retried ONCE, then dropped with a warning log — the inbox row remains
 *   the durable copy;
 * - email is intentionally not implemented (no SMTP infrastructure): a
 *   webhook bridges any channel the user wants (mail gateways, IM bots…).
 */

import type { NotificationRow } from './db/notification-store.js';
import type { UserStore } from './db/user-store.js';
import { notificationToJson } from './notifications.js';

export const WEBHOOK_TIMEOUT_MS = 5000;

export interface NotificationWebhookOptions {
  userStore: UserStore;
  /** fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout; defaults to 5s. */
  timeoutMs?: number;
  /** Failure reporter; defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * Build the NotificationStore.onCreated hook. The returned function never
 * throws: a recipient without a webhook is a no-op, and delivery failures
 * surface only through `warn`.
 */
export function createNotificationWebhookDispatcher(
  options: NotificationWebhookOptions,
): (row: NotificationRow) => void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const warn = options.warn ?? (message => console.warn(message));
  return row => {
    const url = options.userStore.findById(row.user_id)?.webhook_url;
    if (url == null) return;
    const payload = JSON.stringify(notificationToJson(row));
    void postWithRetry(fetchImpl, url, payload, timeoutMs).catch(error => {
      const detail = error instanceof Error ? error.message : String(error);
      warn(`notification-webhook: delivery of ${row.id} to user ${row.user_id} gave up: ${detail}`);
    });
  };
}

/** POST the payload; on any failure retry exactly once, then throw. */
async function postWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  payload: string,
  timeoutMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
