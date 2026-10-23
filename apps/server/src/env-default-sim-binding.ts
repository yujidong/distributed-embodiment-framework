/**
 * T122 (R17-u3 / R19-u4) — the PATCH `defaultSimulationId` validation,
 * extracted from routes/environments.ts (R21-W5 file-budget discipline).
 *
 * The owner binds one simulation of the env as the DEFAULT world for the
 * ask/what-if/read default lanes. Contract:
 * - `null` clears the binding;
 * - a value must name an EXISTING simulation of THIS environment (the
 *   platform world session is not bindable — it IS the fallback world);
 * - running is NOT required at bind time (bind now, start later): liveness
 *   is re-judged at every USE, where a stopped/deleted binding is inert and
 *   the lanes disclose the fall-back (never a silent world switch).
 */

import { ApiError } from './errors.js';

/** Structural slice of the simulation registry the validation needs. */
export interface DefaultSimBindingRegistry {
  get(simulationId: string):
    | { id: string; environmentId?: string; envSession?: boolean }
    | undefined;
}

/**
 * Validate one PATCH `defaultSimulationId` value. Returns the value to
 * store (`null` = clear, string = the verified sim id); throws the teaching
 * ApiError on every refusal shape (unknown sim / foreign env / world
 * session / unverifiable registry).
 */
export function parseDefaultSimulationIdPatch(
  raw: unknown,
  env: { id: string },
  registry: DefaultSimBindingRegistry | undefined,
): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "defaultSimulationId" must be a non-empty string or null',
    );
  }
  if (registry === undefined) {
    // Degenerate harness: an unverifiable reference is not stored (reuses
    // the registered SIMULATION_UNAVAILABLE code, arch-guard d).
    throw new ApiError(
      503,
      'SIMULATION_UNAVAILABLE',
      'The simulation registry is not wired into this deployment — the default-simulation binding cannot be verified and was not stored',
    );
  }
  const sim = registry.get(raw);
  if (sim === undefined) {
    throw new ApiError(
      404,
      'SIMULATION_NOT_FOUND',
      `Simulation "${raw}" not found — the default-simulation binding ` +
        'names a live (running/paused) simulation; `eaf sim list --env ' +
        `${env.id}\` prints the current roster`,
    );
  }
  if (sim.environmentId !== undefined && sim.environmentId !== env.id) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Simulation "${sim.id}" belongs to environment "${sim.environmentId}", not "${env.id}" — ` +
        'the default-simulation binding must name a simulation of THIS environment',
    );
  }
  if (sim.envSession === true) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Simulation "${sim.id}" is this environment's authoritative world session — it is already ` +
        'the fallback default world and cannot be bound as defaultSimulationId',
    );
  }
  return sim.id;
}
