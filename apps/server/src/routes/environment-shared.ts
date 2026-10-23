/**
 * R78 arch-guard split (file-size ratchet): small pure helpers shared by
 * environments.ts (creation warnings, member/invite resolution). No route
 * registration, no request context beyond the stores named in signatures.
 */

import type { UiLocale } from '@active-collaboration/shared';

import type { AuthUser } from '../auth/index.js';
import { ApiError } from '../errors.js';
import { t } from '../i18n/index.js';
import type { EnvironmentRow, EnvRole } from '../db/environment-store.js';
import { toPublicUser, type PublicUser, type UserRow, type UserStore } from '../db/user-store.js';
import type { NotificationStore } from '../db/notification-store.js';
import { NOTIFICATION_KINDS, notify } from '../notifications.js';

/**
 * DevLoop T-301: zero-zone worlds stay legal (blank canvas) but must not be
 * silent — an empty world dead-ends every downstream bootstrap. T-055 adds
 * the governed builder path (install-zones), so the warning now names BOTH
 * remedies: the owner's template import and any builder's zone proposal.
 */
/**
 * R75: duplicate-name teaching warning. Same-name worlds are legal (the name
 * is not an identity) but must not be silent — the public list cannot
 * disambiguate two same-name cards (the persona round's wrong-world detour).
 * Fired from the SINGLE creation funnel and the rename PATCH, so every path
 * that can produce a duplicate teaches about it.
 */
export const duplicateNameWarning = (count: number, name: string): string =>
  `You already own ${count} other environment${count === 1 ? '' : 's'} named "${name}" — ` +
  'names are not identities: same-name worlds coexist in the public list and are hard to tell ' +
  "apart. Consider a distinct name, or disambiguate by the environment id and the owner shown on each card.";

export const zeroZoneWarning = (imported: boolean): string =>
  (imported
    ? 'The imported scenario produced a world with 0 zones'
    : 'This environment has no zones') +
  ' — zoneless worlds dead-end every device/agent bootstrap (UNKNOWN_ZONE). ' +
  'To populate the world: the owner can import a scenario template ' +
  '(GET /api/scenario-templates → GET /api/scenario-templates/{id} → ' +
  'POST that scenario JSON as the body to POST /api/environments), or any builder can ' +
  'propose zones: POST /api/environments/{id}/zones (auto-converts to an install-zones ' +
  'proposal, T-055) / POST /api/environments/{id}/proposals {kind:"install-zones"}.';

export function withWarnings<T extends Record<string, unknown>>(detail: T, warnings: string[]): T {
  if (warnings.length === 0) return detail;
  return { ...detail, warnings };
}

/**
 * Fix-19 viewer onboarding: the one-line role-boundary notice attached to
 * the environment detail when (and only when) the caller is a viewer.
 * Localized per request via the `chrome.role.viewerNotice` message key.
 */
export const VIEWER_NOTICE_KEY = 'chrome.role.viewerNotice';

/**
 * Membership addition notification (member.added): the added user learns
 * they are a member — the env simply appearing in their list is silent.
 * Fired on both add paths (single invite, batch roster import). refId is
 * the env id; no dedupe — a remove-then-re-add should ring again.
 */
export function notifyMemberAdded(
  ctx: { notificationStore: NotificationStore; userStore: UserStore },
  env: EnvironmentRow,
  recipientId: string,
  actor: AuthUser,
  role: EnvRole,
  locale: UiLocale,
): void {
  notify(ctx.notificationStore, {
    recipientId,
    actorId: actor.id,
    envId: env.id,
    kind: NOTIFICATION_KINDS.memberAdded,
    title: t(locale, 'chrome.notif.memberAdded', { envName: env.name }),
    body: {
      envId: env.id,
      envName: env.name,
      role,
      inviterName: actor.displayName,
    },
    refId: env.id,
  });
}

export const ASSIGNABLE_ROLES: readonly EnvRole[] = ['builder', 'viewer'];

export function parseAssignableRole(value: unknown): EnvRole {
  if (value !== 'builder' && value !== 'viewer') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "role" must be one of ${ASSIGNABLE_ROLES.map(r => `"${r}"`).join(' | ')}`,
    );
  }
  return value;
}

/**
 * Resolve an invitation target: exactly one of `email` / `userId`, pointing
 * at a registered user (404 otherwise). Emails are normalized like the auth
 * layer does (trim + lowercase).
 */
export function resolveInviteTarget(
  ctx: { notificationStore: NotificationStore; userStore: UserStore },
  body: Record<string, unknown>,
): UserRow {
  const hasEmail = typeof body.email === 'string' && body.email.trim().length > 0;
  const hasUserId = typeof body.userId === 'string' && body.userId.length > 0;
  if (body.email !== undefined && !hasEmail) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "email" must be a non-empty string');
  }
  if (body.userId !== undefined && !hasUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "userId" must be a non-empty string');
  }
  if (hasEmail === hasUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body must carry exactly one of "email" or "userId"');
  }
  const target = hasEmail
    ? ctx.userStore.findByEmail((body.email as string).trim().toLowerCase())
    : ctx.userStore.findById(body.userId as string);
  if (!target) {
    throw new ApiError(
      404,
      'USER_NOT_FOUND',
      hasEmail
        ? `No registered user with email "${(body.email as string).trim().toLowerCase()}"`
        : `No registered user with id "${body.userId as string}"`,
    );
  }
  return target;
}
