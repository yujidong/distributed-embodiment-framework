/**
 * Simulation-route parse/format helpers (R21-W1 size-ceiling split): the
 * pure body parsers and error/echo formatters that `routes/simulations.ts`
 * and `routes/external-invoke.ts` share. No route wiring lives here.
 */

import { type FaultProfile, type InjectEventInput } from '@active-collaboration/core';

import { ApiError } from '../errors.js';
import type { SimulationRecord } from '../simulation-registry.js';

export function parseInjectEventInput(raw: unknown): InjectEventInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body must be an object (the injectEvent input)');
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.type !== 'string' || body.type.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "type" must be a non-empty string');
  }
  if (typeof body.zoneId !== 'string' || body.zoneId.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "zoneId" must be a non-empty string');
  }
  if (
    body.severity !== undefined &&
    !['low', 'medium', 'high', 'critical'].includes(body.severity as string)
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "severity" must be one of "low" | "medium" | "high" | "critical", got ${JSON.stringify(body.severity)}`,
    );
  }
  // T-103 (F-PH21): duration (sim seconds) of a zone-scoped physical effect —
  // consumed by power-outage-family events; positive and finite when given.
  if (
    body.durationSec !== undefined &&
    (typeof body.durationSec !== 'number' || !Number.isFinite(body.durationSec) || body.durationSec <= 0)
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "durationSec" must be a positive number (sim seconds), got ${JSON.stringify(body.durationSec)}`,
    );
  }
  return body as unknown as InjectEventInput;
}

/**
 * Parse a FaultProfile body (P3d): an object with any subset of the four
 * fault fields; each present field must be well-typed and in range.
 */
export function parseFaultProfile(raw: unknown): FaultProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body must be an object (the FaultProfile)');
  }
  const body = raw as Record<string, unknown>;
  const profile: FaultProfile = {};

  if (body.offline !== undefined) {
    if (typeof body.offline !== 'boolean') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "offline" must be a boolean');
    }
    profile.offline = body.offline;
  }
  if (body.failureRate !== undefined) {
    if (
      typeof body.failureRate !== 'number' || !Number.isFinite(body.failureRate) ||
      body.failureRate < 0 || body.failureRate > 1
    ) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "failureRate" must be a number in [0, 1], got ${JSON.stringify(body.failureRate)}`,
      );
    }
    profile.failureRate = body.failureRate;
  }
  if (body.latencyMs !== undefined) {
    if (
      typeof body.latencyMs !== 'number' || !Number.isFinite(body.latencyMs) || body.latencyMs < 0
    ) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "latencyMs" must be a number >= 0, got ${JSON.stringify(body.latencyMs)}`,
      );
    }
    profile.latencyMs = body.latencyMs;
  }
  if (body.staleState !== undefined) {
    if (typeof body.staleState !== 'boolean') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "staleState" must be a boolean');
    }
    profile.staleState = body.staleState;
  }

  // DevLoop AI Explorer finding: a body of only unknown fields (e.g.
  // {"type":"stuck-at"}) silently produced an empty fault — the caller
  // believed a fault was injected when nothing was. Reject unknowns and
  // empty profiles outright.
  const knownFields = new Set(['offline', 'failureRate', 'latencyMs', 'staleState']);
  const unknownFields = Object.keys(body).filter(key => !knownFields.has(key));
  if (unknownFields.length > 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Unknown fault field${unknownFields.length > 1 ? 's' : ''}: ${unknownFields.map(f => `"${f}"`).join(', ')}. ` +
        `Accepted fields: ${[...knownFields].map(f => `"${f}"`).join(', ')}`,
    );
  }
  if (Object.keys(profile).length === 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Fault profile is empty — set at least one of: offline, failureRate, latencyMs, staleState',
    );
  }
  return profile;
}

/**
 * DevLoop (error clarity): JSON.stringify(NaN/Infinity) prints `null`, so
 * `{"speed": 1e999}` (JSON.parse → Infinity) used to answer "got null" —
 * describe non-finite numbers by name instead.
 */
export function describeNumber(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : JSON.stringify(value);
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * DOC-02 (speed semantics): echo the pace in force so a start/resume
 * response says what `speed` MEANS — `speed` sim-s per tick, plus the
 * nominal wall rate for the classic tick loop (`speed × 1000/tickMs`
 * sim-s per wall-second; the nominal base the snapshot's
 * effectiveSpeedPerSec divides down from under load). Lazy sims have no
 * tick timer (the due-moment driver owns advancement), so the
 * per-wall-second echo stays honestly absent there.
 */
export function speedEcho(record: SimulationRecord): { speed: number; nominalSpeedPerSec?: number } {
  const snapshot = record.runtime.getSnapshot();
  return {
    speed: snapshot.speed,
    ...(record.scheduling === 'lazy'
      ? {}
      : { nominalSpeedPerSec: (snapshot.speed * 1000) / (snapshot.tickMs ?? 10) }),
  };
}

/** Map engine-layer throws onto the API error vocabulary. */
export function mapEngineError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('runtime is stopped')) {
    return new ApiError(409, 'SIMULATION_STOPPED', message);
  }
  if (message.includes('unknown device')) {
    return new ApiError(404, 'DEVICE_NOT_FOUND', message);
  }
  if (message.includes('unknown zone')) {
    return new ApiError(400, 'UNKNOWN_ZONE', message);
  }
  // hass:// race: the entity vanished between pre-validation and build.
  if (message.includes('not found in Home Assistant')) {
    return new ApiError(400, 'HASS_UNKNOWN_ENTITY', message);
  }
  if (message.includes('speed must be') || message.includes('n must be')) {
    return new ApiError(400, 'BAD_REQUEST', message);
  }
  // T-063(a): a string event value is a CALLER mistake with a teaching
  // message — it surfaced as 500 ENGINE_ERROR (R12 retry NEW-R1).
  if (message.includes('is not numeric; physical parameters accept')) {
    return new ApiError(400, 'INVALID_EVENT_VALUE', message);
  }
  return new ApiError(500, 'ENGINE_ERROR', message);
}
