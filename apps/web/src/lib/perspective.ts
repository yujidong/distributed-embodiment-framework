/**
 * Perspective helpers (W5) — 全局视角 / 我的视角 for the world view.
 *
 * The perspective is a pure render-mode decision: the world model is
 * unchanged, but in "我的视角" every object NOT owned by the caller renders
 * dimmed (~25% opacity) and non-interactive, and the zone focus highlight
 * follows the caller's own managed zones instead of the selection. Both map
 * tiers (grid reactflow + geo Leaflet) consume the same `focusOwnerId` prop
 * and this module's `isDimmed` predicate, so the two canvases can never
 * drift apart on what "mine" means.
 *
 * The choice persists per environment in localStorage.
 */

export type Perspective = 'global' | 'me';

const STORAGE_PREFIX = 'eaf-perspective-';

/** Load the persisted perspective for an environment (default 全局视角). */
export function loadPerspective(envId: string): Perspective {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${envId}`) === 'me' ? 'me' : 'global';
  } catch {
    // localStorage unavailable (privacy mode) — fall through to default.
    return 'global';
  }
}

/** Persist the perspective choice for an environment. */
export function savePerspective(envId: string, perspective: Perspective): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${envId}`, perspective);
  } catch {
    // Non-fatal: the choice just won't survive a reload.
  }
}

/**
 * The owner id whose objects stay fully lit, or null when everything renders
 * normally (global perspective, or 我的视角 without a logged-in user — an
 * anonymous visitor owns nothing, so dimming would be meaningless).
 */
export function focusOwnerIdOf(perspective: Perspective, userId: string | null): string | null {
  return perspective === 'me' && userId !== null ? userId : null;
}

/**
 * Should an object owned by `ownerId` render dimmed under `focusOwnerId`?
 * Objects without an owner (legacy scenario models) are never dimmed.
 */
export function isDimmed(ownerId: string | null, focusOwnerId: string | null): boolean {
  return focusOwnerId !== null && ownerId !== null && ownerId !== focusOwnerId;
}

/** Union of the zones managed by the caller's own agents (我的视角 focus). */
export function myManagedZoneIds(
  agents: ReadonlyArray<{ ownerId: string | null; managedZoneIds: string[] }>,
  focusOwnerId: string | null,
): Set<string> {
  const zones = new Set<string>();
  if (focusOwnerId === null) return zones;
  for (const agent of agents) {
    if (agent.ownerId !== focusOwnerId) continue;
    for (const zoneId of agent.managedZoneIds) zones.add(zoneId);
  }
  return zones;
}
