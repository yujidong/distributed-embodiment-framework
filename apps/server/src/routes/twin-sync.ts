/**
 * Twin-sync routes — sync bindings + observations (P-D,
 * multi-user-simulation-design.md §6, §10)
 *
 * - `PUT  /api/environments/:id/sync-bindings`  owner replaces the whole
 *     binding set (`{bindings: [{deviceInstanceId, attributeKey, source,
 *     minIntervalSec?}]}`; source is 'manual' or 'hass:<entity_id>').
 * - `GET  /api/environments/:id/sync-bindings`  read access (members;
 *     anonymous too when the environment is public).
 * - `POST /api/environments/:id/observations`   owner/builder pushes one
 *     observation for a 'manual' binding (`{deviceInstanceId, key, value,
 *     simTime?}`); the row always lands in the time series, the device-row
 *     update + broadcast obeys the binding's throttle.
 * - `GET  /api/environments/:id/observations`   read access; `?entityId=`,
 *     `?from=`, `?to=` (ISO wall-time window), `?limit=`.
 */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import {
  getEnvironmentOrThrow,
  requireBuilderOrOwner,
  requireEnvRole,
  requireReadAccess,
} from '../env-access.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import type { ObservationRow, ObservationStore, SyncBindingRow } from '../db/sync-store.js';
import { deviceDetailTier, type DeviceViewer } from '../device-privacy.js';
import { deviceOracleFor } from '../device-viewer.js';
import {
  parseBindingInput,
  type ObservationValue,
  type TwinSyncService,
} from '../twin-sync.js';

export interface TwinSyncRoutesContext {
  envStore: EnvironmentStore;
  observationStore: ObservationStore;
  twinSync: TwinSyncService;
}

interface IdParams {
  id: string;
}

const OBSERVATIONS_DEFAULT_LIMIT = 1000;
const OBSERVATIONS_MAX_LIMIT = 5000;

export function registerTwinSyncRoutes(app: FastifyInstance, ctx: TwinSyncRoutesContext): void {
  app.put(
    '/api/environments/:id/sync-bindings',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!Array.isArray(body.bindings)) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "bindings" must be an array');
      }
      const inputs = body.bindings.map((raw, index) => parseBindingInput(raw, index));

      const rows = await ctx.twinSync.replaceBindings(id, user.id, inputs);
      return { bindings: rows.map(row => bindingToJson(row)) };
    },
  );

  app.get(
    '/api/environments/:id/sync-bindings',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireReadAccess(env, ctx.envStore.roleOf(id, user.id));
      return { bindings: ctx.twinSync.listBindings(id).map(row => bindingToJson(row)) };
    },
  );

  app.post(
    '/api/environments/:id/observations',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      getEnvironmentOrThrow(ctx.envStore, id);
      requireBuilderOrOwner(ctx.envStore, id, user);

      const body = (request.body ?? {}) as Record<string, unknown>;
      const deviceInstanceId = requireNonEmptyString(body.deviceInstanceId, 'deviceInstanceId');
      const key = requireNonEmptyString(body.key, 'key');
      if (
        typeof body.value !== 'number' &&
        typeof body.value !== 'boolean' &&
        typeof body.value !== 'string'
      ) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body field "value" must be a number, boolean or string',
        );
      }
      let simTime: number | undefined;
      if (body.simTime !== undefined) {
        if (typeof body.simTime !== 'number' || !Number.isFinite(body.simTime)) {
          throw new ApiError(400, 'BAD_REQUEST', 'Body field "simTime" must be a finite number');
        }
        simTime = body.simTime;
      }

      const result = ctx.twinSync.ingestManual(
        id,
        deviceInstanceId,
        key,
        body.value as ObservationValue,
        simTime ?? null,
      );
      return reply.code(201).send({
        observation: observationToJson(result.observation),
        applied: result.applied,
      });
    },
  );

  app.get(
    '/api/environments/:id/observations',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireReadAccess(env, ctx.envStore.roleOf(id, user.id));

      const query = request.query as Record<string, unknown>;
      const entityId = typeof query.entityId === 'string' ? query.entityId : undefined;
      const from = parseIsoQuery(query.from, 'from');
      const to = parseIsoQuery(query.to, 'to');
      let limit = OBSERVATIONS_DEFAULT_LIMIT;
      if (query.limit !== undefined) {
        const parsed = Number(query.limit);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new ApiError(400, 'BAD_REQUEST', 'Query "limit" must be a positive integer');
        }
        limit = Math.min(parsed, OBSERVATIONS_MAX_LIMIT);
      }

      const rows = ctx.observationStore.query(id, {
        ...(entityId !== undefined ? { entityId } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        limit,
      });
      // S2 (device privacy): observations ARE sensor readings — the most
      // private data class. A non-owner viewer sees rows of devices it can
      // read in FULL tier only (own devices; the env owner/admin see all).
      // Omitted rows are counted, not listed (existence is visible; values
      // are not). Detail delivery for foreign devices goes through the
      // service layer (agreements / access grants), never this lane.
      // R21-W4 (audit §3.4): the ONE oracle-assembly helper.
      const ownershipOf = deviceOracleFor(ctx.envStore);
      // Observations address devices by entity id: the device instance id
      // (twin-sync's write form) or a binding source key ('hass:<entity>'
      // per attribute) — resolve both, mirroring replay-service.
      const deviceBySourceKey = new Map<string, string>();
      for (const binding of ctx.twinSync.listBindings(id)) {
        deviceBySourceKey.set(`${binding.source} ${binding.attribute_key}`, binding.device_instance_id);
      }
      const resolveDeviceId = (entityId: string, key: string): string | undefined => {
        const direct = ctx.envStore.getDevice(entityId);
        if (direct !== undefined && direct.env_id === env.id) return entityId;
        const viaBinding = deviceBySourceKey.get(`${entityId} ${key}`);
        return viaBinding;
      };
      const viewer: DeviceViewer = { userId: user.id };
      const viewerIsEnvOwner = user.id === env.owner_id;
      const visible: ObservationRow[] = [];
      let redacted = 0;
      for (const row of rows) {
        const deviceId = resolveDeviceId(row.entity_id, row.key);
        const tier = deviceDetailTier(
          viewerIsEnvOwner ? { ...viewer, isAdmin: true } : viewer,
          deviceId !== undefined ? ownershipOf(deviceId) : undefined,
        );
        if (tier === 'full') {
          visible.push(row);
        } else {
          redacted++;
        }
      }
      return {
        observations: visible.map(row => observationToJson(row)),
        ...(redacted > 0
          ? {
              redacted,
              redactedNote:
                `${redacted} observation row(s) belong to devices you do not own — device ` +
                'telemetry is only readable through the service layer (agreements or provider ' +
                'access grants), not this lane',
            }
          : {}),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Serializers + helpers
// ---------------------------------------------------------------------------

function bindingToJson(row: SyncBindingRow) {
  return {
    id: row.id,
    envId: row.env_id,
    deviceInstanceId: row.device_instance_id,
    attributeKey: row.attribute_key,
    source: row.source,
    minIntervalSec: row.min_interval_sec,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function observationToJson(row: ObservationRow) {
  return {
    id: row.id,
    envId: row.env_id,
    entityId: row.entity_id,
    key: row.key,
    value: JSON.parse(row.value_json) as ObservationValue,
    simTime: row.sim_time,
    wallTime: row.wall_time,
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function parseIsoQuery(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, 'BAD_REQUEST', `Query "${field}" must be an ISO timestamp`);
  }
  return value;
}
