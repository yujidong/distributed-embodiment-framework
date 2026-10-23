/**
 * Flow routes — user-orchestrated business flows (core flows module)
 *
 * - `GET    /api/environments/:id/flows`   list the env's flows (read access).
 * - `POST   /api/environments/:id/flows`   create a flow (builder/owner).
 *     The candidate is statically validated by the core `validateFlow`
 *     compiler pass — JSON shape, trigger semantics, plan shape/semantics,
 *     and assignment satisfiability against the env's bridged
 *     ScenarioDefinition. Error-level issues → 422 FLOW_INVALID with the
 *     full issue list; warnings pass.
 * - `GET    /api/flows/:id`                   one flow (read access).
 * - `PATCH  /api/flows/:id`                   edit name/description/enabled/
 *     trigger/plan (creator or env owner); trigger/plan changes re-run the
 *     same validation. Enable/disable takes effect in running simulations on
 *     the next trigger evaluation (the flowsProvider re-reads the store).
 * - `DELETE /api/flows/:id`                   creator or env owner.
 * - `GET    /api/flows/:id/runs`              the flow's execution ledger
 *     (most recent N, `?limit=`; the store keeps at most 50 per flow).
 * - `POST   /api/simulations/:id/flows/:flowId/run`
 *     operator-triggered run inside a RUNNING env-backed simulation: the
 *     runtime's FlowEngine executes the flow immediately (its own trigger is
 *     bypassed, triggerKind 'manual'); the run lands in the ledger via the
 *     registry's onFlowRun wiring. Disabled flows → 409 FLOW_NOT_RUNNABLE.
 *
 * Flows are user state, not governed world structure (unlike devices/agents
 * there is no proposal path): builders create/edit their own flows directly,
 * the env owner may edit any flow. Every mutation publishes a world-change
 * message (objectType 'flow') so other online users see edits live.
 */

import type { FastifyInstance } from 'fastify';

import { acceptedParameterNames, isCapabilityExecutable } from '@active-collaboration/simulation';

import {
  computeCapabilityDrift,
  resolveFlowAssignments,
  resolveFlowRunParams,
  undeclaredEventTypeWarning,
  validateFlow,
  type FlowDefinition,
  type FlowInputSpec,
  type FlowPolicyEnvelope,
  type FlowTrigger,
  type PlanIssue,
  type ScenarioDefinition,
} from '@active-collaboration/core';

import type { ChangePipeline } from '../change-pipeline.js';
import { MAX_FLOWS_PER_ENV, flowRowToDefinition, type FlowRow, FlowStore } from '../db/flow-store.js';
import { flowServiceInterface, type ServiceStore } from '../db/service-store.js';
import { parseJsonArray, parseMapData, type EnvironmentRow, type EnvironmentStore } from '../db/environment-store.js';
import type { AgreementStore } from '../db/agreement-store.js';
import { actuationPairsOf } from '../agreements/contentions.js';
import { environmentToScenario } from '../environment-bridge.js';
import {
  getEnvironmentOrThrow,
  requireBuilderOrOwner,
  requireObjectMutationAccess,
  requireReadAccess,
} from '../env-access.js';
import { flowRunToJson, flowToJson } from '../env-serializers.js';
import { ApiError } from '../errors.js';
import type { SimulationRegistry } from '../simulation-registry.js';

export interface FlowRoutesContext {
  envStore: EnvironmentStore;
  flowStore: FlowStore;
  registry: SimulationRegistry;
  /** World-change broadcasts carry the acting user (Fix-1 convention). */
  pipeline: ChangePipeline;
  /**
   * Mechanism D: flow edits refresh the generated interface of origin='flow'
   * services backed by the flow. Optional so degenerate harnesses can omit
   * it — the refresh silently no-ops without it (publish validation lives
   * on the services route, which owns the hard requirement). UX-16: the
   * getService slice also feeds the authoring contention warnings.
   */
  serviceStore?: Pick<ServiceStore, 'servicesOfFlow' | 'updateService' | 'getService'>;
  /**
   * UX-16 (pm-dev-backlog): active agreements' trigger automation joins the
   * authoring contention warnings (「同设备多流/合约写」). Optional — the
   * agreement half of the warning is skipped honestly when unwired.
   */
  agreementStore?: AgreementStore;
}

interface FlowEnvParams {
  id: string;
}

interface FlowParams {
  id: string;
}

interface ManualRunParams {
  id: string;
  flowId: string;
}

export function registerFlowRoutes(app: FastifyInstance, ctx: FlowRoutesContext): void {
  app.get('/api/environments/:id/flows', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as FlowEnvParams;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
    requireReadAccess(env, role);
    return { flows: ctx.flowStore.listByEnvironment(id).map(row => flowJsonWithDrift(ctx, env, row)) };
  });

  app.post(
    '/api/environments/:id/flows',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as FlowEnvParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireBuilderOrOwner(ctx.envStore, id, user);

      const body = (request.body ?? {}) as Record<string, unknown>;
      rejectClientAuthorStamp(body);
      const name = requireNonEmptyString(body.name, 'name');
      const description = body.description !== undefined ? requireString(body.description, 'description') : '';
      const enabled = body.enabled !== undefined ? requireBoolean(body.enabled, 'enabled') : true;
      // trigger/plan are checked by the core compiler pass (never throws) —
      // shape errors surface as 422 FLOW_INVALID issues, not 400s.
      const trigger = requireObject(body.trigger, 'trigger') as unknown as FlowTrigger;
      const plan = requireObject(body.plan, 'plan') as unknown as FlowDefinition['plan'];
      // Mechanism D: the optional input-parameter surface (closed array of
      // FlowInputSpec; undefined = no surface. null — surface REMOVAL — is a
      // PATCH-only shape).
      const inputs = parseInputsBody(body.inputs);
      if (inputs === null) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body field "inputs" must be an array on create — null (remove the surface) is a PATCH-only shape',
        );
      }
      // Mechanism C: the optional per-flow policy envelope (semantic checks
      // live in the core compiler pass; null removal is PATCH-only).
      const policy = parsePolicyBody(body.policy);
      if (policy === null) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body field "policy" must be an object on create — null (remove the envelope) is a PATCH-only shape',
        );
      }
      // Mechanism B: the agent-invocation opt-in (default off).
      const agentInvocable = body.agentInvocable !== undefined
        ? requireBoolean(body.agentInvocable, 'agentInvocable')
        : undefined;

      // T-201: authorship is SERVER-STAMPED from the authenticated caller.
      // The env owner is the governance principal — its flows stay
      // unrestricted (no stamp), everyone else's are scoped to their own
      // agents/devices at assignment resolution.
      const authorUserId = user.id !== env.owner_id ? user.id : undefined;
      const candidate: FlowDefinition = {
        id: '(new)',
        name,
        ...(description !== '' ? { description } : {}),
        enabled,
        ...(authorUserId !== undefined ? { authorUserId } : {}),
        trigger,
        ...(inputs !== undefined ? { inputs } : {}),
        ...(policy !== undefined ? { policy } : {}),
        ...(agentInvocable !== undefined ? { agentInvocable } : {}),
        plan,
      };
      // T-606 (R26): warnings ride the create response (non-blocking).
      // UX-16: + the「同设备多流/合约写」contention warnings (last-writer-wins
      // is by design — detect + warn, never block).
      const warnings = [
        ...assertFlowValid(ctx, env, candidate),
        ...flowContentionWarnings(ctx, env, candidate),
      ];

      // Fix-44f: per-environment cap — every enabled flow costs evaluation
      // time on every event/tick plus two bus events per run.
      if (ctx.flowStore.listByEnvironment(env.id).length >= MAX_FLOWS_PER_ENV) {
        throw new ApiError(
          422,
          'FLOW_QUOTA_EXCEEDED',
          `Environment "${env.id}" already has the maximum of ${MAX_FLOWS_PER_ENV} flows — delete or disable unused ones before creating more`,
        );
      }

      const row = ctx.flowStore.create({
        environmentId: env.id,
        name,
        description,
        enabled,
        trigger,
        plan,
        ...(inputs !== undefined ? { inputs } : {}),
        ...(policy !== undefined ? { policy } : {}),
        ...(agentInvocable !== undefined ? { agentInvocable } : {}),
        createdBy: user.id,
      });
      const json = flowToJson(row);
      ctx.pipeline.publish(env.id, 'created', 'flow', json, user.id);
      // T74 (R8, u3-F3): flow lifecycle lands in the activity audit — flows
      // are the fire/security automation topology, so "who changed the
      // linkage rules, when" must be answerable from the feed.
      logFlowAudit(ctx, env.id, user.id, 'created', {
        flowId: row.id,
        name: row.name,
        enabled: row.enabled === 1,
      });
      return reply.code(201).send(
        warnings.length > 0 ? { ...json, validationWarnings: warnings } : json,
      );
    },
  );

  app.get('/api/flows/:id', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as FlowParams;
    const row = getFlowOrThrow(ctx.flowStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, row.environment_id);
    const role = request.user ? ctx.envStore.roleOf(env.id, request.user.id) : undefined;
    requireReadAccess(env, role);
    return flowJsonWithDrift(ctx, env, row);
  });

  app.patch('/api/flows/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as FlowParams;
    const user = request.user!;
    const existing = getFlowOrThrow(ctx.flowStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.environment_id);
    requireObjectMutationAccess(ctx.envStore, env, existing.created_by ?? '', user, 'flow');

    const body = (request.body ?? {}) as Record<string, unknown>;
    rejectClientAuthorStamp(body);
    const patch: Parameters<FlowStore['update']>[1] = {};
    if (body.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
    if (body.description !== undefined) patch.description = requireString(body.description, 'description');
    if (body.enabled !== undefined) patch.enabled = requireBoolean(body.enabled, 'enabled');
    if (body.trigger !== undefined) {
      patch.trigger = requireObject(body.trigger, 'trigger') as unknown as FlowTrigger;
    }
    if (body.plan !== undefined) {
      patch.plan = requireObject(body.plan, 'plan') as unknown as FlowDefinition['plan'];
    }
    // Mechanism D: a new inputs surface (array) or null to REMOVE it.
    if (body.inputs !== undefined) patch.inputs = parseInputsBody(body.inputs);
    // Mechanism C: a new policy envelope (object) or null to REMOVE it.
    if (body.policy !== undefined) patch.policy = parsePolicyBody(body.policy);
    // Mechanism B: toggle the agent-invocation opt-in.
    if (body.agentInvocable !== undefined) patch.agentInvocable = requireBoolean(body.agentInvocable, 'agentInvocable');
    if (Object.keys(patch).length === 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body must contain at least one of: name, description, enabled, trigger, plan, inputs, policy, agentInvocable',
      );
    }

    // Trigger/plan edits re-run the compiler pass on the MERGED definition.
    // Fix-44f: re-ENABLING also re-validates — the world may have changed
    // since the flow was authored (device deleted, agent unbound), and a
    // stale-UNSAT flow that is re-armed becomes per-event failed-run noise.
    let patchWarnings: string[] = [];
    if (patch.trigger !== undefined || patch.plan !== undefined || patch.inputs !== undefined || patch.policy !== undefined || patch.enabled === true) {
      // T-201: the merged candidate keeps the row's server-stamped authorship
      // (created_by, omitted when the author is the env owner).
      const authorUserId =
        existing.created_by !== null && existing.created_by !== env.owner_id
          ? existing.created_by
          : undefined;
      const mergedInputs =
        patch.inputs !== undefined
          ? patch.inputs === null
            ? undefined
            : patch.inputs
          : existing.inputs_json !== null
            ? (JSON.parse(existing.inputs_json) as FlowInputSpec[])
            : undefined;
      const mergedPolicy =
        patch.policy !== undefined
          ? patch.policy === null
            ? undefined
            : patch.policy
          : existing.policy_json !== null
            ? (JSON.parse(existing.policy_json) as FlowPolicyEnvelope)
            : undefined;
      const merged: FlowDefinition = {
        id: existing.id,
        name: patch.name ?? existing.name,
        ...(patch.description ?? existing.description
          ? { description: patch.description ?? existing.description }
          : {}),
        enabled: patch.enabled ?? existing.enabled === 1,
        ...(authorUserId !== undefined ? { authorUserId } : {}),
        trigger: patch.trigger ?? (JSON.parse(existing.trigger_json) as FlowTrigger),
        ...(mergedInputs !== undefined ? { inputs: mergedInputs } : {}),
        ...(mergedPolicy !== undefined ? { policy: mergedPolicy } : {}),
        ...((patch.agentInvocable ?? existing.agent_invocable === 1) ? { agentInvocable: true } : {}),
        plan: patch.plan ?? (JSON.parse(existing.plan_json) as FlowDefinition['plan']),
      };
      patchWarnings = [
        ...assertFlowValid(ctx, env, merged),
        // UX-16: same authoring contention warnings on edit (self excluded).
        ...flowContentionWarnings(ctx, env, merged, existing.id),
      ];
    }

    const row = ctx.flowStore.update(id, patch);
    // Mechanism D: flow edits refresh the generated interface of every
    // origin='flow' service backed by this flow — the inputs surface IS the
    // service contract, so it must never drift (flow deletion cascades the
    // services via FK instead).
    refreshFlowServiceInterfaces(ctx, row);
    const json = flowToJson(row);
    ctx.pipeline.publish(env.id, 'updated', 'flow', json, user.id);
    // T74 (R8, u3-F3): the update audit names WHAT changed (patch keys) and
    // the resulting enabled state (enable/disable is the operation the
    // audit question "is this linkage armed?" is really about).
    logFlowAudit(ctx, env.id, user.id, 'updated', {
      flowId: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      changed: Object.keys(patch),
    });
    return patchWarnings.length > 0 ? { ...json, validationWarnings: patchWarnings } : json;
  });

  app.delete('/api/flows/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as FlowParams;
    const user = request.user!;
    const existing = getFlowOrThrow(ctx.flowStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.environment_id);
    requireObjectMutationAccess(ctx.envStore, env, existing.created_by ?? '', user, 'flow');

    ctx.flowStore.delete(id);
    ctx.pipeline.publish(env.id, 'deleted', 'flow', { id }, user.id);
    // T74 (R8, u3-F3): the delete row carries a payload SNAPSHOT (name +
    // enabled state + author) — the flow row is physically gone, so the
    // audit line must stay readable without any join (T33 inject precedent).
    logFlowAudit(ctx, env.id, user.id, 'deleted', {
      flowId: existing.id,
      name: existing.name,
      enabled: existing.enabled === 1,
      createdBy: existing.created_by ?? undefined,
    });
    return reply.code(204).send();
  });

  app.get('/api/flows/:id/runs', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as FlowParams;
    const row = getFlowOrThrow(ctx.flowStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, row.environment_id);
    const role = request.user ? ctx.envStore.roleOf(env.id, request.user.id) : undefined;
    requireReadAccess(env, role);

    const query = request.query as Record<string, unknown>;
    const limit = optionalLimit(query.limit);
    return { runs: ctx.flowStore.listRuns(id, limit).map(flowRunToJson) };
  });

  /**
   * Operator-triggered run: execute one flow NOW inside an env-backed
   * simulation, through the runtime's FlowEngine (serialized with automatic
   * triggers; the run lands in the ledger via onFlowRun). Auth mirrors the
   * device-command route (Fix-1): a manual run actuates the shared world, so
   * it requires builder/owner membership of the sim's environment.
   */
  app.post(
    '/api/simulations/:id/flows/:flowId/run',
    { preHandler: app.authenticate },
    async request => {
      const { id: simId, flowId } = request.params as ManualRunParams;
      const user = request.user!;
      const record = ctx.registry.getOrThrow(simId);
      if (record.environmentId === undefined) {
        throw new ApiError(
          400,
          'FLOW_RUN_REQUIRES_ENVIRONMENT',
          `Simulation "${simId}" is not environment-backed — flows belong to environments`,
        );
      }
      const env = getEnvironmentOrThrow(ctx.envStore, record.environmentId);
      requireBuilderOrOwner(ctx.envStore, env.id, user);

      const flow = ctx.flowStore.getById(flowId);
      if (!flow || flow.environment_id !== record.environmentId) {
        throw new ApiError(
          404,
          'FLOW_NOT_FOUND',
          `Flow "${flowId}" does not exist in environment "${record.environmentId}"`,
        );
      }
      if (record.runtime.getState() === 'stopped') {
        throw new ApiError(409, 'SIMULATION_STOPPED', `Simulation "${simId}" is stopped`);
      }
      const flowEngine = record.runtime.getFlowEngine();
      if (!flowEngine) {
        throw new ApiError(
          409,
          'FLOW_ENGINE_UNAVAILABLE',
          `Simulation "${simId}" has no flow engine (no flowsProvider wired)`,
        );
      }

      // Mechanism D: manual runs accept params, validated against the flow's
      // declared inputs surface by the SAME oracle the engine and the
      // flow-service invocation core use — a surfaceless flow with params or
      // an out-of-bounds value is a teaching 422, never a silent no-op.
      const flowDef = flowDefinitionFromRow(flow, env.owner_id);
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (body.params !== undefined &&
          (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "params" must be an object when provided');
      }
      const { params: effectiveParams, issues: paramIssues } =
        resolveFlowRunParams(flowDef.inputs, body.params as Record<string, unknown> | undefined);
      const paramErrors = paramIssues.filter(issue => issue.level === 'error');
      if (paramErrors.length > 0) {
        throw new ApiError(
          422,
          'FLOW_PARAMS_INVALID',
          `Flow "${flow.name}" rejected the run parameters: ${paramErrors[0].message}`,
          paramErrors.map(issue => issue.message),
          { issues: paramIssues },
        );
      }

      // T-003 (DevLoop R2): stale-simulation diagnostic. An env-backed sim
      // runs a FROZEN snapshot of the environment — when the world changed
      // after the sim was created (device added, agent bound/deleted), a
      // flow authored against the CURRENT world UNSATs against the frozen
      // one and the manual run fails with a bare "refused" record, with no
      // hint that the sim itself is the problem. Resolve the flow's
      // assignments against BOTH worlds (the runtime resolves WITH the
      // executability oracle since T-051, so mirror that exactly): fails
      // frozen + passes current → the sim is stale, 409 with the recreate
      // guidance instead of running a doomed flow. When the flow fails
      // against BOTH (or the current world cannot even be bridged), the
      // flow itself is the problem — let the run proceed and report its
      // own failure.
      const frozenIssues = flow.enabled === 1
        ? resolveFlowAssignments(
            flowDefinitionFromRow(flow, env.owner_id),
            record.runtime.scenario,
            { isExecutableCapability: isCapabilityExecutable },
          ).issues.filter(issue => issue.level === 'error')
        : [];
      if (frozenIssues.length > 0) {
        const currentScenario = scenarioForValidation(ctx.envStore, env);
        const passesCurrent = currentScenario !== undefined &&
          resolveFlowAssignments(
            flowDefinitionFromRow(flow, env.owner_id),
            currentScenario,
            { isExecutableCapability: isCapabilityExecutable },
          ).issues.every(issue => issue.level !== 'error');
        if (passesCurrent) {
          throw new ApiError(
            409,
            'FLOW_STALE_SIMULATION',
            `Flow "${flow.name}" does not resolve against simulation "${simId}": ` +
              'the environment changed after this simulation was created — ' +
              'recreate the simulation to run this flow',
            frozenIssues.map(issue => issue.message),
          );
        }
      }

      const runRecord = await flowEngine.runDirect(
        flowId,
        'manual',
        Object.keys(effectiveParams).length > 0 ? effectiveParams : undefined,
      );
      if (runRecord === null) {
        throw new ApiError(
          409,
          'FLOW_NOT_RUNNABLE',
          `Flow "${flowId}" is disabled — enable it before triggering a manual run`,
        );
      }
      // FEAT-06: a run parked on a wait node persists NOTHING yet (the ledger
      // row lands when the run finishes) — answer with the honest
      // intermediate record instead of silently reading back the PREVIOUS
      // persisted run.
      if (runRecord.status === 'waiting') {
        return {
          flowId,
          run: {
            id: runRecord.runId,
            flowId: runRecord.flowId,
            simulationId: simId,
            triggerKind: runRecord.triggerKind,
            triggerSimTimeSec: runRecord.triggerEvaluation?.simTimeSec ?? null,
            status: runRecord.status,
            summary: runRecord.summary,
            nodeResults: runRecord.nodeResults,
            ...(runRecord.waiting !== undefined ? { waiting: runRecord.waiting } : {}),
            startedAt: runRecord.startedAt,
            finishedAt: runRecord.finishedAt,
          },
        };
      }
      // runDirect awaited the serialized execution; the registry's
      // onFlowRun wiring has already persisted this run.
      const run = ctx.flowStore.listRuns(flowId, 1)[0];
      return { flowId, run: run !== undefined ? flowRunToJson(run) : null };
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * T74 (R8, u3-F3): one flow-lifecycle audit row per mutation — kind 'flow',
 * actor = the operating account, payload snapshot names the flow (id + name
 * + enabled + author). The delete path runs AFTER the physical row removal,
 * so the payload is self-contained (no FK join). Failures must not break the
 * mutation (same discipline as the engine seams' audit lanes).
 */
function logFlowAudit(
  ctx: FlowRoutesContext,
  envId: string,
  actorId: string,
  action: 'created' | 'updated' | 'deleted',
  snapshot: { flowId: string; name: string; enabled: boolean; createdBy?: string; changed?: string[] },
): void {
  try {
    ctx.pipeline.log({
      envId,
      actorId,
      kind: 'flow',
      payload: {
        action,
        objectType: 'flow',
        objectId: snapshot.flowId,
        ...snapshot,
      },
    });
  } catch {
    // Audit failures must never break a flow mutation.
  }
}

function getFlowOrThrow(store: FlowStore, id: string): FlowRow {
  const row = store.getById(id);
  if (!row) throw new ApiError(404, 'FLOW_NOT_FOUND', `Flow "${id}" not found`);
  return row;
}

/**
 * T1 (R2, u3-F1): the flow JSON annotated with CURRENT capability drift for
 * 存量 flows — the same computeCapabilityDrift oracle the runtime annotates
 * runs with, evaluated against the env's LIVE bridged scenario (declarations
 * may have been revoked since the flow was authored; the authoring gate only
 * re-runs on edits). Absent = no drift (or the world cannot bridge, in which
 * case there is nothing honest to claim). Best-effort by design: an
 * annotation failure must never fail a read.
 */
function flowJsonWithDrift(ctx: FlowRoutesContext, env: EnvironmentRow, row: FlowRow) {
  const json = flowToJson(row);
  try {
    const scenario = scenarioForValidation(ctx.envStore, env);
    if (scenario === undefined) return json;
    const def = flowRowToDefinition(row, env.owner_id);
    const { assignments } = resolveFlowAssignments(def, scenario, {
      isExecutableCapability: isCapabilityExecutable,
    });
    const drift = computeCapabilityDrift(
      def,
      assignments,
      agentId => scenario.agents.find(a => a.id === agentId)?.capabilities ?? [],
    );
    // T78 (R8, u4-P1-3): the ghost-event-type warning stays VISIBLE on the
    // read faces — a flow that reads as silently healthy while it can never
    // fire is exactly the u4-P1-3 complaint. The same core oracle the
    // create/patch responses speak, best-effort on reads.
    const ghost = undeclaredEventTypeWarning(def.trigger, scenario);
    const annotated: Record<string, unknown> = { ...json };
    if (drift.length > 0) annotated.capabilityDrift = drift;
    if (ghost !== undefined) {
      const raw = (json as unknown as { validationWarnings?: unknown }).validationWarnings;
      const existing = Array.isArray(raw) ? (raw as string[]) : [];
      annotated.validationWarnings = [...existing, ghost];
    }
    return annotated as typeof json;
  } catch {
    return json;
  }
}

/**
 * Mechanism D: after a flow edit, regenerate the interface of every
 * origin='flow' service backed by the flow — the inputs surface (and the
 * delegate-node count) are the service contract; a stale copy would
 * advertise parameters the invoke path no longer accepts. Best-effort by
 * design: an interface refresh failure must not fail the flow edit (the
 * next edit retries); publish-time generation is the authoritative source.
 */
function refreshFlowServiceInterfaces(ctx: FlowRoutesContext, row: FlowRow): void {
  if (ctx.serviceStore === undefined) return;
  const iface = flowServiceInterface(flowRowToDefinition(row));
  for (const service of ctx.serviceStore.servicesOfFlow(row.id)) {
    ctx.serviceStore.updateService(service.id, { interface: iface });
  }
}

/**
 * Rehydrate a stored flow row into the core FlowDefinition shape. T-201:
 * authorship rides along (created_by, omitted for env-owner rows) so the
 * stale-sim resolution check sees the same author scoping as the runtime.
 */
function flowDefinitionFromRow(row: FlowRow, envOwnerId?: string): FlowDefinition {
  return flowRowToDefinition(row, envOwnerId);
}

/**
 * T-201: authorUserId is server-stamped from the authenticated caller and
 * must never be client-suppliable — reject it loudly instead of silently
 * dropping the field (the standing silent-field-dropping trap).
 */
function rejectClientAuthorStamp(body: Record<string, unknown>): void {
  if (body.authorUserId !== undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "authorUserId" cannot be supplied — flow authorship is stamped ' +
        'server-side from the authenticated caller',
    );
  }
}

/**
 * Mechanism D: parse the optional `inputs` body field — an ARRAY (the closed
 * FlowInputSpec surface; semantic checks live in the core compiler pass) or
 * null (PATCH only: remove the surface). Anything else is a 400.
 */
function parseInputsBody(value: unknown): FlowInputSpec[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "inputs" must be an array of input declarations [{name, type, ...}] (or null on PATCH to remove the surface)',
    );
  }
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "inputs" must contain objects ({name, type: number|string|boolean, required?, default?, min?, max?, enum?})',
      );
    }
  }
  return value as FlowInputSpec[];
}

/**
 * Mechanism C: parse the optional `policy` body field — an OBJECT (the
 * FlowPolicyEnvelope; closed shape + semantic checks live in the core
 * compiler pass) or null (PATCH only: remove the envelope). Anything else
 * is a 400.
 */
function parsePolicyBody(value: unknown): FlowPolicyEnvelope | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "policy" must be an object {maxDelegationsPerRun?, minConfidenceToActuate?, onBudgetExhausted?, escalate?} (or null on PATCH to remove the envelope)',
    );
  }
  return value as FlowPolicyEnvelope;
}

/**
 * The env's bridged ScenarioDefinition for assignment-satisfiability checks.
 * An environment whose stored world fails scenario validation (e.g. an agent
 * bound to a deleted device) cannot block flow CRUD — validation then runs
 * WITHOUT the scenario (shape/trigger/plan checks still apply).
 */
function scenarioForValidation(envStore: EnvironmentStore, env: EnvironmentRow): ScenarioDefinition | undefined {
  try {
    return environmentToScenario(env, envStore.devicesOf(env.id), envStore.agentsOf(env.id));
  } catch {
    return undefined;
  }
}

/** Run the core compiler pass; error-level issues → 422 FLOW_INVALID.
 *
 * T-002 (DevLoop R2): the executability oracle (simulation's live
 * capability→command contract) rides along, so assignment satisfiability
 * requires a bound device that not only DECLARES the node capability but
 * can actually EXECUTE it. Pre-fix, a flow with capability 'switch' passed
 * validation (agent + device declare it) and failed mid-run with
 * "no handler / no effect for command switch"; now it is a 422 naming the
 * executable alternatives at authoring time.
 *
 * T-305 (DevLoop R12): when the env's world does NOT bridge to a scenario
 * (empty worlds make environmentToScenario throw), the Fix-44k trigger-zone
 * check falls back to the env's mapData zone list so it stays unconditional
 * — an empty env used to make the gate vacuous and bogus-zone flows 201'd.
 * Assignment satisfiability stays scenario-gated (nothing to check against
 * in an empty world).
 */
function assertFlowValid(ctx: FlowRoutesContext, env: EnvironmentRow, flow: FlowDefinition): string[] {
  const scenario = scenarioForValidation(ctx.envStore, env);
  const issues: PlanIssue[] = validateFlow(flow, scenario, {
    isExecutableCapability: isCapabilityExecutable,
    // R13 (CB-F01): param-shape oracle — a node whose params keys match none
    // of the command's accepted spellings is a guaranteed no-effect node at
    // run time (params are dropped silently); teach it at authoring time.
    acceptedParameterNames,
    ...(scenario === undefined
      ? { knownZoneIds: parseMapData(env).zones.map(zone => zone.id) }
      : {}),
  });
  const errors = issues.filter(issue => issue.level === 'error');
  if (errors.length > 0) {
    throw new ApiError(
      422,
      'FLOW_INVALID',
      `Flow "${flow.name}" failed validation: ${errors[0].message}`,
      undefined,
      { issues },
    );
  }
  // T-606 (R26): non-blocking warnings ride the response (e.g. the
  // condition-path lint for runtime-injected parameters) — visible, never
  // a 422.
  return issues.filter(issue => issue.level === 'warning').map(issue => issue.message);
}

/**
 * UX-16 (pm-dev-backlog, energy-carbon D7 + library-comfort #3): the
 * authoring-time「同设备多流/合约写」warning. Multi-channel automation
 * writing one device is last-writer-wins BY DESIGN (deterministic,
 * auditable) — the platform detects and warns, never blocks. The flow's
 * actuation face is resolved heuristically at authoring time: a pinned
 * node device, else every bound device of the candidate agents (explicit
 * assignee, else all env agents) DECLARING the node capability — the
 * runtime's exact pick needs a live world, so this is the honest
 * approximation for a warning (never a gate). Two contention families:
 * other ENABLED flows of the env, and ACTIVE agreements whose trigger
 * automation actuation pairs (the D1 oracle — contentions.ts) hit the same
 * devices. Empty when the device sets don't intersect; also empty when the
 * flow targets nothing resolvable (the UNSAT errors already speak).
 */
function flowContentionWarnings(
  ctx: FlowRoutesContext,
  env: EnvironmentRow,
  flow: FlowDefinition,
  selfFlowId?: string,
): string[] {
  const ownDevices = flowActuationDeviceIds(ctx, env, flow);
  if (ownDevices.size === 0) return [];
  const warnings: string[] = [];
  const deviceName = (id: string): string => ctx.envStore.getDevice(id)?.name ?? id;
  const names = (ids: string[]): string => ids.slice(0, 3).map(deviceName).join('、') + (ids.length > 3 ? ' 等' : '');
  const LAST_WRITER_WINS =
    'concurrent automations on one device are last-writer-wins (the later run/invoke wins — deterministic, auditable); ' +
    'stagger the trigger windows or split the target devices if the race is not intended';

  // Family 1: other ENABLED flows of the same env.
  for (const row of ctx.flowStore.listByEnvironment(env.id)) {
    if (row.id === selfFlowId || row.enabled !== 1) continue;
    const other = flowActuationDeviceIds(ctx, env, flowDefinitionFromRow(row, env.owner_id));
    const shared = [...ownDevices].filter(id => other.has(id));
    if (shared.length === 0) continue;
    warnings.push(
      `flow "${row.name}" also actuates device(s) ${names(shared)} — ${LAST_WRITER_WINS}`,
    );
    if (warnings.length >= 3) break;
  }

  // Family 2: ACTIVE agreements whose trigger automation writes the same
  // devices (the D1 actuation-pair oracle; unwired contexts skip honestly).
  if (ctx.agreementStore !== undefined && ctx.serviceStore !== undefined) {
    const contentionCtx = {
      envStore: ctx.envStore,
      serviceStore: ctx.serviceStore,
      agreementStore: ctx.agreementStore,
    };
    let emitted = 0;
    for (const agreement of ctx.agreementStore.agreementsOfEnv(env.id)) {
      if (agreement.status !== 'active') continue;
      if (agreement.provider_agent_id === null || agreement.service_id === null) continue;
      const shared = [...new Set(
        actuationPairsOf(contentionCtx, agreement)
          .map(pair => pair.deviceId)
          .filter(id => ownDevices.has(id)),
      )];
      if (shared.length === 0) continue;
      const serviceName = ctx.serviceStore.getService(agreement.service_id)?.name ?? agreement.service_id;
      warnings.push(
        `agreement "${agreement.id}" (service "${serviceName}")'s trigger automation also writes device(s) ` +
        `${names(shared)} — ${LAST_WRITER_WINS}`,
      );
      emitted++;
      if (emitted >= 3) break;
    }
  }
  return warnings;
}

/**
 * The devices a flow's action nodes may actuate (authoring-time heuristic —
 * see flowContentionWarnings). Pinned nodes contribute their pin; unpinned
 * nodes contribute every bound device of the candidate agents declaring the
 * node capability. Service/delegate/notify/wait nodes actuate nothing
 * directly (service nodes ride the AGREEMENT lane — that agreement's own
 * contention faces cover them).
 */
function flowActuationDeviceIds(ctx: FlowRoutesContext, env: EnvironmentRow, flow: FlowDefinition): Set<string> {
  const ids = new Set<string>();
  const agents = ctx.envStore.agentsOf(env.id);
  for (const node of flow.plan.nodes) {
    if (node.service !== undefined || node.delegate !== undefined || node.notify !== undefined || node.wait !== undefined) continue;
    if (!('capability' in node) || typeof node.capability !== 'string' || node.capability === '') continue;
    if (typeof node.deviceId === 'string' && node.deviceId !== '') {
      ids.add(node.deviceId);
      continue;
    }
    const candidates = node.assigneeAgentId !== undefined
      ? agents.filter(agent => agent.id === node.assigneeAgentId)
      : agents;
    for (const agent of candidates) {
      for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
        const device = ctx.envStore.getDevice(deviceId);
        if (device !== undefined && parseJsonArray<string>(device.capabilities_json).includes(node.capability)) {
          ids.add(deviceId);
        }
      }
    }
  }
  return ids;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new ApiError(400, 'BAD_REQUEST', 'Query "limit" must be an integer between 1 and 200');
  }
  return parsed;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a string`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a boolean`);
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}
