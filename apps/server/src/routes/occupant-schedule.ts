/**
 * Occupant-schedule route (FEAT-07) — env owner installs/replaces/clears a
 * zone's occupantSchedule at runtime, WITHOUT rebuilding the environment.
 *
 * - `PATCH /api/environments/:id/zones/:zoneId/occupant-schedule`
 *     owner only. Body `{schedule?: {count, startSimTimeSec, endSimTimeSec,
 *     repeatDaily?} | null, overlay?: {schedule, startsAtSimSec,
 *     endsAtSimSec} | null}` — at least one of the two keys; null clears the
 *     respective timetable. The value constraints mirror the scenario
 *     schema's occupantSchedule/occupantScheduleOverlay blocks
 *     (scenario-schema.ts); shape violations are 400 BAD_REQUEST and a
 *     degenerate overlay window (endsAtSimSec <= startsAtSimSec) is 422
 *     OCCUPANT_OVERLAY_WINDOW_INVALID — both with a TEACHING message (the
 *     legal shape and the ranges, same style as the mapData validators).
 *     The write lands in map_data (durable truth — the next world
 *     materialize picks it up) AND is pushed into every live env-backed
 *     runtime through OccupantScheduleSync (service-catalog-sync mirror
 *     discipline); the response reports how many live runtimes took it
 *     (`appliedRuntimes: 0` = no live session — honest, not an error).
 *
 * FEAT-07 phase-2 (calendar overlay): the overlay is a TEMPORARY timetable
 * replacing the base schedule inside the absolute sim-time window
 * `[startsAtSimSec, endsAtSimSec)` (exam-week extended library hours); the
 * base timetable governs again at the window end (core seam
 * `updateZoneOccupantSchedule` — enter/exit transitions are occupancy due
 * moments with the patch catch-up discipline: in-window arrive corrects
 * the headcount, a past depart never zeroes).
 *
 * Split out of routes/environments.ts at the arch-guard file-size ceiling
 * (the delegations.ts pattern).
 */

import type { FastifyInstance } from 'fastify';

import type { ChangePipeline } from '../change-pipeline.js';
import { ApiError } from '../errors.js';
import { getEnvironmentOrThrow, requireEnvRole } from '../env-access.js';
import { zonesOf } from '../env-serializers.js';
import { parseMapData, type EnvironmentStore, type EnvZone } from '../db/environment-store.js';
import type { OccupantScheduleSync } from '../sim-registry/occupant-schedule-sync.js';

type OccupantSchedule = NonNullable<EnvZone['occupantSchedule']>;
type OccupantScheduleOverlay = NonNullable<EnvZone['occupantScheduleOverlay']>;

export interface OccupantScheduleRoutesContext {
  envStore: EnvironmentStore;
  /** Fix-1: unified change recording (command_log + actor-carrying broadcast). */
  pipeline: ChangePipeline;
  /**
   * FEAT-07: the live-runtime push seam. Optional so minimal test contexts
   * degrade to "DB only" (appliedRuntimes: 0 in the response).
   */
  occupantScheduleSync?: OccupantScheduleSync;
}

/** The parsed PATCH body — absent keys mean "leave that timetable untouched". */
export interface OccupantSchedulePatch {
  schedule?: OccupantSchedule | null;
  overlay?: OccupantScheduleOverlay | null;
}

export function registerOccupantScheduleRoutes(
  app: FastifyInstance,
  ctx: OccupantScheduleRoutesContext,
): void {
  app.patch(
    '/api/environments/:id/zones/:zoneId/occupant-schedule',
    { preHandler: app.authenticate },
    async request => {
      const { id, zoneId } = request.params as { id: string; zoneId: string };
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      const patch = parseOccupantSchedulePatch(request.body);
      const mapData = parseMapData(env);
      const zone = mapData.zones.find(z => z.id === zoneId);
      if (zone === undefined) {
        throw new ApiError(
          404,
          'UNKNOWN_ZONE',
          `Environment "${id}" has no zone "${zoneId}" — known zones: ` +
            `${mapData.zones.map(z => z.id).slice(0, 10).join(', ')}${mapData.zones.length > 10 ? ', …' : ''}`,
        );
      }
      const before = {
        occupantSchedule: zone.occupantSchedule ?? null,
        occupantScheduleOverlay: zone.occupantScheduleOverlay ?? null,
      };
      if (patch.schedule !== undefined) {
        if (patch.schedule === null) delete zone.occupantSchedule;
        else zone.occupantSchedule = patch.schedule;
      }
      if (patch.overlay !== undefined) {
        if (patch.overlay === null) delete zone.occupantScheduleOverlay;
        else zone.occupantScheduleOverlay = patch.overlay;
      }

      const updated = ctx.envStore.updateEnvironment(env.id, { mapData });
      // Fix-1: owner direct edits are audited (env-direct-edit) with the
      // patched field's before/after values (same discipline as PATCH env).
      ctx.pipeline.log({
        envId: env.id,
        actorId: user.id,
        kind: 'env-direct-edit',
        payload: {
          objectType: 'zone',
          action: 'occupant-schedule',
          objectId: zoneId,
          before,
          after: {
            occupantSchedule: zone.occupantSchedule ?? null,
            occupantScheduleOverlay: zone.occupantScheduleOverlay ?? null,
          },
        },
      });
      ctx.pipeline.publish(updated.id, 'updated', 'environment', {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        mapType: updated.map_type,
        visibility: updated.visibility,
        zones: zonesOf(updated),
        updatedAt: updated.updated_at,
      }, user.id);

      // Phase-1 lane (schedule key only) keeps its exact legacy seam call;
      // an overlay touch pushes the zone's RESULTING timetable state.
      const appliedRuntimes = ctx.occupantScheduleSync === undefined
        ? 0
        : patch.overlay === undefined
          ? ctx.occupantScheduleSync.applyZoneSchedule(env.id, zoneId, patch.schedule ?? null)
          : ctx.occupantScheduleSync.applyZoneSchedule(
              env.id,
              zoneId,
              zone.occupantSchedule ?? null,
              zone.occupantScheduleOverlay ?? null,
            );
      return {
        envId: env.id,
        zoneId,
        occupantSchedule: zone.occupantSchedule ?? null,
        occupantScheduleOverlay: zone.occupantScheduleOverlay ?? null,
        cleared: patch.schedule === null,
        overlayCleared: patch.overlay === null,
        appliedRuntimes,
      };
    },
  );
}

/**
 * The body parser: `{schedule?: <shape> | null, overlay?: {schedule: <shape>,
 * startsAtSimSec, endsAtSimSec} | null}` — at least one key; null clears the
 * respective timetable. Constraints mirror the scenario schema's
 * occupantSchedule/occupantScheduleOverlay blocks; every violation is a 400
 * with the legal shape and ranges spelled out (teaching validation, R102
 * output discipline) — except a degenerate overlay window
 * (endsAtSimSec <= startsAtSimSec), which is a 422 with the same teaching
 * style (the shape is legal, the semantics are not).
 */
export function parseOccupantSchedulePatch(raw: unknown): OccupantSchedulePatch {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body must be an object: {schedule?: {count, startSimTimeSec, endSimTimeSec, repeatDaily?} | null, overlay?: {schedule, startsAtSimSec, endsAtSimSec} | null}');
  }
  const body = raw as { schedule?: unknown; overlay?: unknown };
  if (body.schedule === undefined && body.overlay === undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body must include "schedule" and/or "overlay" — the occupant timetable ' +
        '{count, startSimTimeSec, endSimTimeSec, repeatDaily?} (null clears it), and/or the temporary ' +
        'calendar overlay {schedule, startsAtSimSec, endsAtSimSec} (null clears it)',
    );
  }
  const patch: OccupantSchedulePatch = {};
  if (body.schedule !== undefined) {
    patch.schedule = body.schedule === null ? null : parseScheduleShape(body.schedule, 'schedule');
  }
  if (body.overlay !== undefined) {
    patch.overlay = body.overlay === null ? null : parseOverlayShape(body.overlay);
  }
  return patch;
}

/** The shared timetable shape validator (base schedule and overlay schedule). */
function parseScheduleShape(raw: unknown, field: string): OccupantSchedule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "${field}" must be an object {count, startSimTimeSec, endSimTimeSec, repeatDaily?} — or null to clear the zone's timetable`,
    );
  }
  const value = raw as Record<string, unknown>;
  const KNOWN = ['count', 'startSimTimeSec', 'endSimTimeSec', 'repeatDaily'] as const;
  const unknown = Object.keys(value).filter(key => !(KNOWN as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "${field}" has unknown field(s): ${unknown.map(f => `"${f}"`).join(', ')} — ` +
        'occupantSchedule accepts only: count, startSimTimeSec, endSimTimeSec, repeatDaily',
    );
  }
  const count = value.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "${field}.count" must be an integer >= 0 (headcount during the active window)`,
    );
  }
  for (const bound of ['startSimTimeSec', 'endSimTimeSec'] as const) {
    const boundValue = value[bound];
    if (typeof boundValue !== 'number' || !Number.isFinite(boundValue) || boundValue < 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "${field}.${bound}" must be a number >= 0 (sim-time second of the day, e.g. 28800 = 08:00, 64800 = 18:00)`,
      );
    }
  }
  const repeatDaily = value.repeatDaily;
  if (repeatDaily !== undefined && typeof repeatDaily !== 'boolean') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "${field}.repeatDaily" must be a boolean (default true; false = one-shot window)`,
    );
  }
  return {
    count,
    startSimTimeSec: value.startSimTimeSec as number,
    endSimTimeSec: value.endSimTimeSec as number,
    ...(repeatDaily !== undefined ? { repeatDaily } : {}),
  };
}

/** FEAT-07 phase-2: the calendar-overlay shape + window validator. */
function parseOverlayShape(raw: unknown): OccupantScheduleOverlay {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "overlay" must be an object {schedule: {count, startSimTimeSec, endSimTimeSec, repeatDaily?}, startsAtSimSec, endsAtSimSec} — or null to clear the zone\'s calendar overlay',
    );
  }
  const value = raw as Record<string, unknown>;
  const KNOWN = ['schedule', 'startsAtSimSec', 'endsAtSimSec'] as const;
  const unknown = Object.keys(value).filter(key => !(KNOWN as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "overlay" has unknown field(s): ${unknown.map(f => `"${f}"`).join(', ')} — ` +
        'occupantScheduleOverlay accepts only: schedule, startsAtSimSec, endsAtSimSec',
    );
  }
  const schedule = parseScheduleShape(value.schedule, 'overlay.schedule');
  for (const field of ['startsAtSimSec', 'endsAtSimSec'] as const) {
    const bound = value[field];
    if (typeof bound !== 'number' || !Number.isFinite(bound) || bound < 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "overlay.${field}" must be a number >= 0 (ABSOLUTE sim-time second — day N 08:00 = N*86400 + 28800)`,
      );
    }
  }
  const startsAtSimSec = value.startsAtSimSec as number;
  const endsAtSimSec = value.endsAtSimSec as number;
  if (!(endsAtSimSec > startsAtSimSec)) {
    throw new ApiError(
      422,
      'OCCUPANT_OVERLAY_WINDOW_INVALID',
      `Body field "overlay" has a degenerate window: endsAtSimSec (${endsAtSimSec}) must exceed ` +
        `startsAtSimSec (${startsAtSimSec}) — the overlay governs [startsAtSimSec, endsAtSimSec) in ` +
        'absolute sim seconds (exam-week example: one week starting day 1 = ' +
        '{startsAtSimSec: 86400, endsAtSimSec: 7*86400})',
    );
  }
  return { schedule, startsAtSimSec, endsAtSimSec };
}
