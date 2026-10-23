/**
 * Device-catalog routes — the real-hardware catalog (product_design.md §11.3)
 *
 * - `GET  /api/catalog`             public list of ACTIVE models (summary
 *     fields only; filters: device_type, vendor, tier, q substring on
 *     name/model).
 * - `GET  /api/catalog/:id`         full model detail (any status).
 * - `POST /api/catalog`             auth; community submission, lands as
 *     status='pending' (approval flow is a later slice — the schema already
 *     carries the status column for it).
 * - `POST /api/environments/:id/devices:instantiate`
 *     owner: creates a device_instance pre-filled from a catalog model
 *     (type/brand=vendor/capabilities copied; name defaults to the model's
 *     display name), audited as `env-direct-edit`. builder (Fix-1): the call
 *     is converted into an `install-devices` proposal (the modelId rides
 *     the payload, so the rule check re-resolves the same model) and the
 *     PROPOSAL is returned.
 */

import type { FastifyInstance } from 'fastify';

import type { ChangePipeline } from '../change-pipeline.js';
import { ApiError } from '../errors.js';
import { getEnvironmentOrThrow, requireBuilderOrOwner } from '../env-access.js';
import { validateDevicePositionForEnv } from '../geo.js';
import { deviceToJson, ownerRef, zonesOf } from '../env-serializers.js';
import type { DeviceModelRow, CatalogStore, CatalogTier } from '../db/catalog-store.js';
import { modelToDetailJson, modelToSummaryJson } from '../db/catalog-store.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import { parseJsonObject } from '../db/environment-store.js';
import { catalogPhysicsInitialState } from '../proposal-rules.js';
import type { CommandLogStore } from '../db/proposal-store.js';
import type { ProposalService } from '../proposal-service.js';
import { assertQuota, type QuotaConfig } from '../quotas.js';
import { ENV_DIRECT_EDIT_KIND } from './env-objects.js';
import { proposalToJson } from './proposals.js';

export interface CatalogRoutesContext {
  catalogStore: CatalogStore;
  envStore: EnvironmentStore;
  userStore: UserStore;
  /** Fix-10: proposal serialization reads back created ids from the apply entry. */
  commandLogStore: CommandLogStore;
  /** Fix-1: unified change recording (command_log + actor-carrying broadcast). */
  pipeline: ChangePipeline;
  /** Fix-1: builder instantiations are converted into proposals. */
  proposalService: ProposalService;
  /** P4-4 quotas (devices_per_env enforced on instantiate). */
  quotas: QuotaConfig;
}

interface IdParams {
  id: string;
}

export function registerCatalogRoutes(app: FastifyInstance, ctx: CatalogRoutesContext): void {
  app.get('/api/catalog', async request => {
    const query = request.query as Record<string, unknown>;
    const filters = {
      ...(typeof query.device_type === 'string' && query.device_type.length > 0
        ? { deviceType: query.device_type }
        : {}),
      ...(typeof query.vendor === 'string' && query.vendor.length > 0
        ? { vendor: query.vendor }
        : {}),
      ...(isCatalogTier(query.tier) ? { tier: query.tier } : {}),
      ...(typeof query.q === 'string' && query.q.length > 0 ? { q: query.q } : {}),
    };
    return ctx.catalogStore.listActive(filters).map(modelToSummaryJson);
  });

  app.get('/api/catalog/:id', async request => {
    const { id } = request.params as IdParams;
    return modelToDetailJson(getModelOrThrow(ctx.catalogStore, id));
  });

  app.post('/api/catalog', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const vendor = requireNonEmptyString(body.vendor, 'vendor');
    const model = requireNonEmptyString(body.model, 'model');
    const name = requireNonEmptyString(body.name, 'name');
    const deviceType = requireNonEmptyString(body.deviceType, 'deviceType');
    const capabilities = requireNonEmptyStringArray(body.capabilities, 'capabilities');
    const physics = optionalObject(body.physics, 'physics');
    const specs = optionalObject(body.specs, 'specs');
    const purchaseUrl = optionalString(body.purchaseUrl, 'purchaseUrl');
    const priceCny = optionalNonNegativeNumber(body.priceCny, 'priceCny');

    const row = ctx.catalogStore.create({
      vendor,
      model,
      name,
      deviceType,
      capabilities,
      ...(physics !== undefined ? { physics } : {}),
      ...(specs !== undefined ? { specs } : {}),
      ...(purchaseUrl !== undefined ? { purchaseUrl } : {}),
      ...(priceCny !== undefined ? { priceCny } : {}),
      source: 'community',
      status: 'pending',
      createdBy: user.id,
    });
    return reply.code(201).send(modelToDetailJson(row));
  });

  app.post(
    '/api/environments/:id/devices:instantiate',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = requireBuilderOrOwner(ctx.envStore, id, user);
      // P4-4 quota: instantiate is a device create — same per-env limit.
      assertQuota('devices_per_env', ctx.quotas.maxDevicesPerEnv, ctx.envStore.countDevicesIn(id));

      const body = (request.body ?? {}) as Record<string, unknown>;
      const modelId = requireNonEmptyString(body.modelId, 'modelId');
      const catalogModel = ctx.catalogStore.get(modelId);
      // Only 'active' (approved) models may be instantiated; pending/rejected
      // submissions are not yet part of the usable catalog.
      if (!catalogModel || catalogModel.status !== 'active') {
        throw new ApiError(404, 'MODEL_NOT_FOUND', `Catalog model "${modelId}" not found`);
      }

      const name = body.name === undefined
        ? catalogModel.name
        : requireNonEmptyString(body.name, 'name');
      const zoneId = requireNonEmptyString(body.zoneId, 'zoneId');
      if (!zonesOf(env).some(zone => zone.id === zoneId)) {
        throw new ApiError(
          400,
          'UNKNOWN_ZONE',
          `Zone "${zoneId}" does not exist in environment "${env.id}"`,
        );
      }
      const position = optionalObject(body.position, 'position');
      validateDevicePositionForEnv(env.map_type, position);

      // Fix-1: a builder's instantiate is a structural change to the SHARED
      // world — converted into an install-devices proposal; the rule check
      // resolves the same catalog model from the payload's modelId.
      if (role !== 'owner') {
        const proposal = await ctx.proposalService.submit(env, user, 'install-devices', {
          devices: [
            {
              modelId,
              name,
              zoneId,
              ...(position !== undefined ? { position } : {}),
            },
          ],
        }, request.locale);
        return reply.code(201).send(proposalToJson(ctx, proposal));
      }

      const row = ctx.envStore.createDevice({
        envId: id,
        ownerId: user.id,
        name,
        type: catalogModel.device_type,
        brand: catalogModel.vendor,
        capabilities: capabilitiesOf(catalogModel),
        zoneId,
        ...(position !== undefined ? { position } : {}),
        // T-702 (DevLoop R29): the owner-direct path gets the SAME catalog
        // physics bridge as the proposal install path (cooling/heating/
        // rated watts into initialState), with author overrides honored.
        initialState: catalogPhysicsInitialState(
          {
            physics: parseJsonObject(catalogModel.physics_json) ?? {},
            specs: parseJsonObject(catalogModel.specs_json) ?? {},
          },
          optionalObject(body.initialState, 'initialState'),
        ),
      });
      const owner = ctx.userStore.findById(user.id);
      const json = deviceToJson(row, ownerRef(owner ? toPublicUser(owner) : undefined, user.id));
      ctx.pipeline.log({
        envId: id,
        actorId: user.id,
        kind: ENV_DIRECT_EDIT_KIND,
        payload: { objectType: 'device', action: 'created', objectId: row.id, before: null, after: json },
      });
      ctx.pipeline.publish(id, 'created', 'device', json, user.id);
      return reply.code(201).send(json);
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModelOrThrow(store: CatalogStore, id: string): DeviceModelRow {
  const row = store.get(id);
  if (!row) throw new ApiError(404, 'MODEL_NOT_FOUND', `Catalog model "${id}" not found`);
  return row;
}

function capabilitiesOf(row: DeviceModelRow): string[] {
  const parsed = JSON.parse(row.capabilities_json) as unknown;
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

/** Unknown tier values are ignored (no filter) rather than rejected. */
function isCatalogTier(value: unknown): value is CatalogTier {
  return value === 'consumer' || value === 'industrial' || value === 'municipal';
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function requireNonEmptyStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(item => typeof item !== 'string')
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "${field}" must be a non-empty array of strings`,
    );
  }
  return value as string[];
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a string`);
  }
  return value;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-negative number`);
  }
  return value;
}
