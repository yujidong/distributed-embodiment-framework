/**
 * Active-simulation lookup (R12-5c-B) — before starting a new simulation from
 * the world view we check whether the environment already has one the user
 * can attach to, so clicking 运行仿真 never silently spawns duplicates
 * (simulations count against a per-user quota). DOM-free so the derivation
 * stays unit-testable; the page component stays thin wiring.
 */

import type { SimulationListEntry } from '../api/types';

/** States in which a simulation still holds resources and can be attached to. */
const ACTIVE_STATES: ReadonlySet<SimulationListEntry['state']> = new Set([
  'created',
  'running',
  'paused',
]);

/** The caller's attachable (created/running/paused) simulations of one environment. */
export function activeSimulationsOf(
  simulations: readonly SimulationListEntry[],
  envId: string,
): SimulationListEntry[] {
  return simulations.filter(sim => sim.environmentId === envId && ACTIVE_STATES.has(sim.state));
}
