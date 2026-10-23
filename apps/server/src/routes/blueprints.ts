/**
 * Blueprint routes (Fix-38) — student "one-click" application templates.
 *
 * - `GET    /api/blueprints`                   list (built-in + custom)
 * - `GET    /api/blueprints/:id`               one blueprint (read access)
 * - `POST   /api/blueprints`                   create custom (builder+)
 * - `DELETE /api/blueprints/:id`               delete custom (creator/owner)
 * - `POST   /api/environments/:id/blueprints/:bpId/install`
 *     Install into a target zone — resolves template variables, creates
 *     devices + agents + flows atomically. Builder/owner.
 * - `DELETE /api/environments/:id/blueprints/:bpId/instances`
 *     Uninstall all objects created from this blueprint in this env.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import { ApiError } from '../errors.js';
import { checkCapabilityBacking } from '../proposal-rules.js';
import {
  getEnvironmentOrThrow,
  requireBuilderOrOwner,
} from '../env-access.js';
import { parseMapData, type EnvironmentStore } from '../db/environment-store.js';
import type { BlueprintStore, BlueprintDefinition } from '../db/blueprint-store.js';
import type { EafDatabase } from '../db/database.js';

export interface BlueprintRoutesContext {
  blueprintStore: BlueprintStore;
  envStore: EnvironmentStore;
  db: EafDatabase;
  /**
   * R100 (agreement-row-integrity): the retire lanes for the uninstall's
   * agent/device deletions — agreements retire + unlink (v60/R100
   * discipline) instead of being physically cascade-swallowed. Optional so
   * minimal contexts keep the legacy cascade.
   */
  agreementStore?: {
    retireProviderAgreements(agentId: string): unknown;
  };
  /** R100: device deletion first drops its derived rows through the
   *  agreement-retiring deleteService choke point. */
  serviceStore?: {
    deleteDerivedForDevice(deviceId: string): unknown;
  };
}

interface IdParams { id: string }
interface EnvIdParams { id: string; bpId: string }

export function registerBlueprintRoutes(app: FastifyInstance, ctx: BlueprintRoutesContext): void {
  app.get('/api/blueprints', { preHandler: app.authenticate }, async request => {
    const query = request.query as Record<string, unknown>;
    const includeCustom = query.builtinOnly !== 'true';
    return { blueprints: ctx.blueprintStore.list(includeCustom).map(bpToJson) };
  });

  app.get('/api/blueprints/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const bp = ctx.blueprintStore.getById(id);
    if (!bp) throw new ApiError(404, 'BLUEPRINT_NOT_FOUND', `Blueprint "${id}" not found`);
    return bpToJson(bp);
  });

  app.post('/api/blueprints', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = requireNonEmpty(body.name, 'name');
    const definition = body.definition as BlueprintDefinition | undefined;
    if (!definition || !Array.isArray(definition.devices) || definition.devices.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "definition.devices" must be a non-empty array');
    }
    // R6-D-S3: partnerSuggestion is optional pair metadata {blueprintId, note?}.
    const suggestion = definition.partnerSuggestion as unknown;
    if (suggestion !== undefined) {
      const s = suggestion as Record<string, unknown> | null;
      if (
        typeof s !== 'object' || s === null || Array.isArray(s) ||
        typeof s.blueprintId !== 'string' || s.blueprintId.length === 0 ||
        (s.note !== undefined && typeof s.note !== 'string')
      ) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body field "definition.partnerSuggestion" must be an object {blueprintId: non-empty string, note?: string}',
        );
      }
    }
    const bp = ctx.blueprintStore.create({
      name,
      description: typeof body.description === 'string' ? body.description : '',
      definition,
      createdBy: user.id,
    });
    return reply.code(201).send(bpToJson(bp));
  });

  app.delete('/api/blueprints/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const bp = ctx.blueprintStore.getById(id);
    if (!bp) throw new ApiError(404, 'BLUEPRINT_NOT_FOUND', `Blueprint "${id}" not found`);
    if (bp.created_by && bp.created_by !== user.id) {
      throw new ApiError(403, 'FORBIDDEN', `Only the blueprint creator can delete it`);
    }
    if (!ctx.blueprintStore.delete(id)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Built-in blueprints cannot be deleted');
    }
    return reply.code(204).send();
  });

  /**
   * Install a blueprint into a target zone. Resolves template variables
   * (${zoneId}, device index references), then creates devices, agents,
   * and flows — all tagged with `installed_from` for whole-blueprint uninstall.
   */
  app.post(
    '/api/environments/:id/blueprints/:bpId/install',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id: envId, bpId } = request.params as EnvIdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, envId);
      requireBuilderOrOwner(ctx.envStore, env.id, user);

      const bp = ctx.blueprintStore.getById(bpId);
      if (!bp) throw new ApiError(404, 'BLUEPRINT_NOT_FOUND', `Blueprint "${bpId}" not found`);
      const definition = JSON.parse(bp.definition_json) as BlueprintDefinition;

      const body = (request.body ?? {}) as { zoneId?: unknown };
      const zoneId = typeof body.zoneId === 'string' ? body.zoneId : '';
      if (zoneId.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "zoneId" is required (the target zone to install into)');
      }
      // Validate zone exists (zones live in map_data_json, not a separate table).
      const envRow = ctx.envStore.getEnvironment(env.id);
      if (!envRow) throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${env.id}" not found`);
      const mapData = parseMapData(envRow);
      if (!mapData.zones.some(z => z.id === zoneId)) {
        throw new ApiError(400, 'UNKNOWN_ZONE', `Zone "${zoneId}" does not exist in environment "${env.id}"`);
      }

      // Resolve template variables and create objects.
      const createdIds: { devices: string[]; agents: string[]; flows: string[] } = { devices: [], agents: [], flows: [] };
      const tag = (table: string, id: string) => {
        try { ctx.db.prepare(`UPDATE ${table} SET installed_from = ? WHERE id = ?`).run(bp.id, id); } catch { /* non-fatal */ }
      };

      // DevLoop (install 500s): user-authored definitions crash the install
      // when optional fields are omitted — `dev.zoneId.replace` on undefined
      // surfaced as INTERNAL_ERROR "Cannot read properties of undefined".
      // Treat an omitted zoneId as the '${zoneId}' template (the install
      // target decides placement — the natural authoring shape) and default
      // the agent arrays; only genuinely malformed entries 400 with the
      // offending index instead of a stack trace.
      const resolveTemplate = (value: string | undefined, fallback: string): string =>
        (value ?? fallback).replace(/\$\{zoneId\}/g, zoneId);
      const requireString = (value: unknown, what: string): string => {
        if (typeof value !== 'string' || value.length === 0) {
          throw new ApiError(400, 'BLUEPRINT_INVALID', `Blueprint "${bp.id}" ${what} must be a non-empty string`);
        }
        return value;
      };

      // R1 (B1-8 / P-18): blueprint agents pass the SAME capability-backing
      // gate as owner-direct agent creation — an unbacked declaration is a
      // guaranteed runtime UNSAT for any flow driving it (the
      // sz-emergency-lighting lesson: install succeeded, the fire flow
      // died on the day with UNSAT). Runs BEFORE any object is created so a
      // rejected install leaves nothing behind (the Fix-6 discipline).
      // Blueprint devices carry no hass:// bindings, so no exemption applies.
      for (const agentDef of definition.agents ?? []) {
        const backingIssues: string[] = [];
        // The gate reads capabilities_json + type (the BUG-08③ type
        // expansion) + the hass:// exemption; blueprint definition devices
        // have no bindings, so row-shaped stubs over the DEFINITION are the
        // pre-creation truth.
        const stubRows = (agentDef.boundDeviceIndexes ?? [])
          .map(idx => definition.devices[idx])
          .filter(dev => dev !== undefined)
          .map(dev => ({
            type: dev.type ?? '',
            capabilities_json: JSON.stringify(dev.capabilities ?? []),
          })) as Parameters<typeof checkCapabilityBacking>[1];
        checkCapabilityBacking(
          Array.isArray(agentDef.capabilities) ? agentDef.capabilities : [],
          stubRows,
          'capabilities',
          backingIssues,
        );
        if (backingIssues.length > 0) {
          throw new ApiError(422, 'AGENT_CAPABILITIES_UNBACKED', backingIssues[0], backingIssues);
        }
      }

      // 1. Create devices.
      const deviceIdMap = new Map<number, string>();
      for (let i = 0; i < definition.devices.length; i++) {
        const dev = definition.devices[i] as Partial<BlueprintDefinition['devices'][number]> | undefined;
        if (dev === undefined || typeof dev !== 'object') {
          throw new ApiError(400, 'BLUEPRINT_INVALID', `Blueprint "${bp.id}" definition.devices[${i}] must be an object`);
        }
        const resolvedZoneId = resolveTemplate(dev.zoneId, '${zoneId}');
        const row = ctx.envStore.createDevice({
          envId: env.id,
          ownerId: user.id,
          name: requireString(dev.name, `definition.devices[${i}].name`),
          type: requireString(dev.type, `definition.devices[${i}].type`),
          capabilities: Array.isArray(dev.capabilities) ? dev.capabilities : [],
          zoneId: resolvedZoneId,
          ...(dev.initialState !== undefined ? { initialState: dev.initialState } : {}),
        });
        tag('device_instances', row.id);
        deviceIdMap.set(i, row.id);
        createdIds.devices.push(row.id);
      }

      // 2. Create agents (bind to created devices by index).
      for (const agentDef of definition.agents ?? []) {
        const resolvedZones = (agentDef.managesZoneIds ?? []).map(z => resolveTemplate(z, '${zoneId}'));
        const boundDeviceIds = (agentDef.boundDeviceIndexes ?? [])
          .map(idx => deviceIdMap.get(idx))
          .filter((id): id is string => id !== undefined);
        const row = ctx.envStore.createAgent({
          envId: env.id,
          ownerId: user.id,
          name: requireString(agentDef.name, 'definition.agents[].name'),
          capabilities: Array.isArray(agentDef.capabilities) ? agentDef.capabilities : [],
          managedZoneIds: resolvedZones,
          boundDeviceIds,
        });
        tag('agent_instances', row.id);
        createdIds.agents.push(row.id);
      }

      // 3. Create flows (direct SQL — FlowStore.create doesn't have installedFrom yet).
      for (const flowDef of definition.flows ?? []) {
        // DevLoop: a flow def without trigger/plan crashed with the same
        // undefined-replace 500 (JSON.stringify(undefined) → undefined).
        // Validate up front — a flow without a trigger can never fire.
        if (flowDef.trigger === undefined || typeof flowDef.trigger !== 'object') {
          throw new ApiError(400, 'BLUEPRINT_INVALID', `Blueprint "${bp.id}" definition.flows[].trigger must be an object`);
        }
        const resolvedTrigger = JSON.parse(
          JSON.stringify(flowDef.trigger).replace(/\$\{zoneId\}/g, zoneId),
        ) as Record<string, unknown>;
        const flowId = `flow-${randomUUID()}`;
        const now = new Date().toISOString();
        ctx.db.prepare(`
          INSERT INTO flows (id, environment_id, name, description, enabled, trigger_json, plan_json, created_by, created_at, updated_at, installed_from)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(flowId, env.id, requireString(flowDef.name, 'definition.flows[].name'), '', flowDef.enabled ? 1 : 0,
          JSON.stringify(resolvedTrigger), JSON.stringify(flowDef.plan ?? []), user.id, now, now, bp.id);
        createdIds.flows.push(flowId);
      }

      return reply.code(201).send({
        blueprintId: bp.id,
        blueprintName: bp.name,
        envId: env.id,
        zoneId,
        createdIds,
        summary: {
          devices: createdIds.devices.length,
          agents: createdIds.agents.length,
          flows: createdIds.flows.length,
        },
      });
    },
  );

  /**
   * Uninstall every object created from this blueprint in this env (the
   * header-comment contract since Fix-38). Matches rows by the
   * `installed_from` lineage tag, so it also cleans up instances of a custom
   * blueprint that has since been deleted — no blueprint-existence gate.
   * Delete order flows → agents → devices: derived services FK-cascade with
   * their agent/device rows (same semantics as the object delete routes).
   * Idempotent: uninstalling twice (or with nothing installed) returns zeros.
   */
  app.delete(
    '/api/environments/:id/blueprints/:bpId/instances',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id: envId, bpId } = request.params as EnvIdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, envId);
      requireBuilderOrOwner(ctx.envStore, env.id, user);

      const removedIds = ctx.db.transaction(() => {
        const flowIds = (ctx.db.prepare(
          'SELECT id FROM flows WHERE environment_id = ? AND installed_from = ?',
        ).all(envId, bpId) as Array<{ id: string }>).map(r => r.id);
        const agentIds = (ctx.db.prepare(
          'SELECT id FROM agent_instances WHERE env_id = ? AND installed_from = ?',
        ).all(envId, bpId) as Array<{ id: string }>).map(r => r.id);
        const deviceIds = (ctx.db.prepare(
          'SELECT id FROM device_instances WHERE env_id = ? AND installed_from = ?',
        ).all(envId, bpId) as Array<{ id: string }>).map(r => r.id);

        const deleteFlow = ctx.db.prepare('DELETE FROM flows WHERE id = ?');
        for (const id of flowIds) deleteFlow.run(id);
        for (const id of agentIds) {
          // R100: retire + unlink the agent's agreements BEFORE the row goes
          // (v60 discipline — the FK cascades then have nothing to match).
          ctx.agreementStore?.retireProviderAgreements(id);
          ctx.envStore.deleteAgent(id);
        }
        for (const id of deviceIds) {
          // R100: derived rows leave through the agreement-retiring
          // deleteService choke point before the device row cascades.
          ctx.serviceStore?.deleteDerivedForDevice(id);
          ctx.envStore.deleteDevice(id);
        }
        return { devices: deviceIds, agents: agentIds, flows: flowIds };
      })();

      return reply.code(200).send({
        blueprintId: bpId,
        envId: env.id,
        removedIds,
        summary: {
          devices: removedIds.devices.length,
          agents: removedIds.agents.length,
          flows: removedIds.flows.length,
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bpToJson(row: { id: string; name: string; description: string; definition_json: string; is_builtin: number; created_by: string | null }) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: JSON.parse(row.definition_json),
    isBuiltin: row.is_builtin === 1,
    createdBy: row.created_by,
  };
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}
