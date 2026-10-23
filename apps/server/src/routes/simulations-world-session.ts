/**
 * World-session special-casing for the generic simulation lifecycle routes
 * (R37-F1, extracted from routes/simulations.ts for the file-size ratchet).
 *
 * The authoritative world session (`sim-<envId>-world-session`) is addressable
 * through the generic /resume and /stop routes — validation F1 showed those
 * routes actively WEDGED the env when used on a session:
 *
 *  - /resume rebuilt from the checkpoint's FROZEN topology (env rows are the
 *    durable truth — the wake contract rebuilds CURRENT topology) and the
 *    stale session state then made every later arrival throw
 *    WORLD_SESSION_EXISTS into the void;
 *  - /stop left a stopped husk under the deterministic session id that
 *    blocked every later session creation ("no removal endpoint").
 *
 * These helpers give the two routes their session semantics: /resume wakes
 * through the WorldSessionService (current env rows, drift notes,
 * fast-forward); /stop routes to FREEZE semantics (checkpoint + release —
 * design §9 HIBERNATED), degrading to discard+drop when no trajectory dir
 * exists to checkpoint into. Both return undefined when the target is NOT a
 * world session — the caller then runs the generic path unchanged.
 */

import type { FastifyBaseLogger } from 'fastify';

import type { SimulationRecord, SimulationRegistry } from '../simulation-registry.js';
import type { HibernatedSimulationRecord } from '../sim-registry/types.js';
import type { WorldSessionService } from '../world-session.js';
import { ApiError } from '../errors.js';

/** The deterministic world-session id for an env (createEnvSession's convention). */
export function worldSessionIdOf(envId: string): string {
  return `sim-${envId}-world-session`;
}

function isWorldSessionRow(row: { id: string; environmentId?: string }): boolean {
  return row.environmentId !== undefined && row.id === worldSessionIdOf(row.environmentId);
}

/**
 * POST /api/simulations/:id/pause on a world session is REFUSED (F2): the
 * session is a wall-mapped living world — the observer pin's
 * startSessionRuntime would silently un-pause it and every arrival's
 * catch-up fast-forwards to wall-now (advanceTo only refuses 'stopped'),
 * so a 200 {state:'paused'} would lie. The teaching error names the true
 * runtime state and the honest halts (/hibernate freeze, /stop).
 */
export function assertWorldSessionPausable(record: SimulationRecord): void {
  if (record.envSession !== true) return;
  throw new ApiError(
    409,
    'WORLD_SESSION_PAUSE_UNSUPPORTED',
    `Simulation "${record.id}" is the environment's wall-mapped world session (currently ` +
      `${record.runtime.getState()}) — pausing it cannot stick: observers pin the session ` +
      'active and every arrival materializes the world to wall-now, so the pause would be ' +
      `silently revoked. To halt the world use POST /api/simulations/${record.id}/hibernate ` +
      '(freeze with checkpoint, resumable) or /stop.',
  );
}

/**
 * R2-BUG-04: POST /api/simulations/:id/start on a LIVE world session used to
 * be a FAKE success — EngineRuntime.start() on an already-running lazy
 * runtime merely resets the speed field and returns, so the route answered
 * 200 {state:'running'} while the wall-mapped clock sat frozen (no due
 * moments → wakeLazyDriver had nothing to do). Route the arrival through the
 * WorldSessionService instead: wake (if hibernated) + catch up to wall-now
 * (bounded by the T129 sync cap — a longer backlog keeps fast-forwarding in
 * the background, and the honest simTimeSec in the response says so), then
 * answer with the REAL state + simTimeSec. `speed` is rejected: the
 * session's wall rate is owned by the service (1 sim-sec per wall-sec), so
 * a start-time speed would be silently meaningless — retarget a live
 * session's pace through /resume (T43 property retarget). Returns undefined
 * when the record is not a session (generic path unchanged).
 */
export async function startWorldSessionIfAny(
  app: { worldSessions?: { targetFor(envId: string): Promise<SimulationRecord | undefined> } },
  record: SimulationRecord,
  speed: number | undefined,
): Promise<{ id: string; state: string; simTimeSec: number } | undefined> {
  if (record.envSession !== true || record.environmentId === undefined || app.worldSessions === undefined) {
    return undefined;
  }
  if (speed !== undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Simulation "${record.id}" is the environment's wall-mapped world session — its rate is fixed at ` +
        'wall speed (1 sim-sec per wall-sec) and a start-time speed would not be honored. To retarget a ' +
        `live session's pace use POST /api/simulations/${record.id}/resume with {speed} (speed is a ` +
        'property there, not a lifecycle transition).',
    );
  }
  const session = await app.worldSessions.targetFor(record.environmentId);
  if (session === undefined) {
    throw new ApiError(
      503,
      'WORLD_SESSION_WAKE_FAILED',
      `World session "${record.id}" could not be woken/caught up (see server logs) — ` +
        'the environment rows may be invalid for a runtime rebuild',
    );
  }
  return { id: record.id, state: session.runtime.getState(), simTimeSec: session.runtime.getSimTimeSec() };
}

/**
 * POST /api/simulations/:id/resume on a HIBERNATED world session: wake
 * through the WorldSessionService — current env topology, not the
 * checkpoint's frozen copy. Throws WORLD_SESSION_WAKE_FAILED (503) when the
 * wake cannot land; returns undefined when the id is not a session.
 */
export async function resumeWorldSessionIfAny(
  app: { worldSessions?: WorldSessionService; log: FastifyBaseLogger },
  hibernated: HibernatedSimulationRecord,
): Promise<{ id: string; state: string; simTimeSec: number } | undefined> {
  if (!isWorldSessionRow(hibernated) || app.worldSessions === undefined) return undefined;
  const record = await app.worldSessions.targetFor(hibernated.environmentId!);
  if (record === undefined) {
    throw new ApiError(
      503,
      'WORLD_SESSION_WAKE_FAILED',
      `World session "${hibernated.id}" could not be woken from its checkpoint (see server logs) — ` +
        'the environment rows may be invalid for a runtime rebuild',
    );
  }
  return { id: hibernated.id, state: record.runtime.getState(), simTimeSec: record.runtime.getSimTimeSec() };
}

/**
 * R6-A-F01: adopt an external freeze of the env's session sim into the
 * WorldSessionService, so the env detail surfaces `worldSession.status:
 * 'hibernated'` with the checkpoint metadata (hibernatedAt /
 * checkpointAtSec / simStartEpochMs) instead of a bare "idle" view with
 * the anchor gone. Shared by the generic /hibernate route and /stop's
 * FREEZE semantics; no-op for non-session sims or when the service is
 * absent.
 */
export function adoptWorldSessionHibernateIfAny(
  app: { worldSessions?: WorldSessionService },
  record: SimulationRecord,
  frozen: { id: string; hibernatedAt: string; checkpoint: { simTimeSec: number } },
  simStartEpochMs: number,
): void {
  if (record.envSession !== true || record.environmentId === undefined) return;
  app.worldSessions?.adoptExternalHibernate(record.environmentId, {
    record: {
      id: frozen.id,
      hibernatedAt: frozen.hibernatedAt,
      checkpoint: { simTimeSec: frozen.checkpoint.simTimeSec },
    },
    simStartEpochMs,
  });
}

/**
 * R6-A-F01: POST /api/simulations/:id/hibernate — hibernate with the world-
 * session adoption folded in: freezing the env's session sim through this
 * generic route used to skip the WorldSessionService, leaving the env
 * detail at a bare status "idle" with no hibernatedAt/checkpoint metadata
 * and the wall anchor gone (docs/deployment.md §6 promises the hibernated
 * view). Non-session sims get the plain registry hibernate, unchanged.
 */
export async function hibernateWithSessionAdoption(
  app: { worldSessions?: WorldSessionService },
  registry: SimulationRegistry,
  record: SimulationRecord,
): Promise<HibernatedSimulationRecord> {
  // Capture the anchor before the release (the /stop discipline) so the
  // adoption keeps it.
  const simStartEpochMs = record.envSession === true ? record.runtime.getSimStartEpochMs() : undefined;
  const frozen = await registry.hibernate(record.id);
  if (simStartEpochMs !== undefined) {
    adoptWorldSessionHibernateIfAny(app, record, frozen, simStartEpochMs);
  }
  return frozen;
}

/**
 * POST /api/simulations/:id/stop on a LIVE world session: FREEZE semantics —
 * checkpoint + release (design §9 HIBERNATED) keeps history and
 * re-creatability; a plain stop leaves a husk that wedges the env behind
 * WORLD_SESSION_EXISTS. Without a trajectory dir (nowhere to checkpoint)
 * the session is stopped AND dropped so the env is immediately
 * re-creatable. Returns undefined when the record is not a session.
 */
export async function stopWorldSessionIfAny(
  app: { worldSessions?: WorldSessionService },
  registry: SimulationRegistry,
  record: SimulationRecord,
): Promise<{ id: string; state: 'hibernated'; hibernatedAt: string } | { id: string; state: 'stopped' } | undefined> {
  if (record.envSession !== true || record.environmentId === undefined) return undefined;
  if (record.trajectoryDir !== undefined && app.worldSessions !== undefined) {
    // Capture the anchor before the release (the stopped runtime keeps it,
    // but the running one is the authoritative read while live).
    const simStartEpochMs = record.runtime.getSimStartEpochMs();
    const frozen = await registry.hibernate(record.id);
    adoptWorldSessionHibernateIfAny(app, record, frozen, simStartEpochMs);
    return { id: record.id, state: 'hibernated', hibernatedAt: frozen.hibernatedAt };
  }
  registry.stopAndRemove(record.id);
  app.worldSessions?.dropForEnv(record.environmentId);
  return { id: record.id, state: 'stopped' };
}
