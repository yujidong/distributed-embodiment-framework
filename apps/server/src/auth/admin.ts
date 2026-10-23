/**
 * Admin identity — the ONE truth for "does this identity pass an
 * ADMIN_EMAILS gate" (R21 audit §3.1 / Task-0 hotfix).
 *
 * History: six call sites each re-implemented the comparison, and
 * routes/auth.ts compared the RAW email while config.ts lowercases
 * ADMIN_EMAILS — a mixed-case `users.email` row (legacy DB, direct store
 * seed, or a BuildServerOptions caller bypassing config parsing) got
 * `isAdmin:false` from /api/auth/me while every other gate said admin.
 * Canonicalization lives HERE now; login/register share the same
 * `normalizeEmail`, so the producer and the comparators cannot drift.
 */

/** Canonical email form — the same normalization login/register apply. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True when `email` names an admin. Both sides are canonicalized:
 * config.ts lowercases ADMIN_EMAILS, but callers that pass the list
 * directly (BuildServerOptions, test fixtures) may not.
 */
export function isAdminEmail(
  email: string | null | undefined,
  adminEmails: readonly string[],
): boolean {
  if (typeof email !== 'string' || email.length === 0) return false;
  const canonical = normalizeEmail(email);
  return adminEmails.some(admin => normalizeEmail(admin) === canonical);
}
