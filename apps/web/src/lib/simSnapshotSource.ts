/**
 * Snapshot source selection (F2/F3) — the live overlays (campus 3D,
 * interior walk) poll ONE simulation's snapshot per environment.
 *
 * Ranking: the authoritative world session (`kind === 'world-session'`)
 * always wins — a leftover demo sim must never hijack the overlay just
 * because its id sorts first; then `running`, then the remaining active
 * states, with id length as the stable tie-break.
 *
 * F3: a stopped sim's snapshot endpoint still answers 200 with frozen data,
 * so the hooks count consecutive `stopped` reads and re-list after
 * SNAPSHOT_STOPPED_FALLBACK_STRIKES to fall back to the world session.
 */

import type { SimulationListEntry } from '../api/types';

const ACTIVE_STATES: ReadonlySet<SimulationListEntry['state']> = new Set([
  'running',
  'created',
  'paused',
]);

/** Consecutive stopped snapshots before re-listing for a fallback source. */
export const SNAPSHOT_STOPPED_FALLBACK_STRIKES = 2;

function rank(sim: SimulationListEntry): number {
  if (sim.kind === 'world-session') return 0;
  return sim.state === 'running' ? 1 : 2;
}

/** Pick the simulation whose snapshot feeds the overlay, or null. */
export function pickSnapshotSim(
  simulations: readonly SimulationListEntry[],
  envId: string,
  /** Live demo run (or any sim the user is actively watching) wins outright. */
  preferredId?: string | null,
): SimulationListEntry | null {
  const candidates = simulations.filter(
    s => s.environmentId === envId && ACTIVE_STATES.has(s.state),
  );
  if (preferredId) {
    const preferred = candidates.find(s => s.id === preferredId);
    if (preferred) return preferred;
  }
  candidates.sort((a, b) => rank(a) - rank(b) || a.id.length - b.id.length);
  return candidates[0] ?? null;
}
