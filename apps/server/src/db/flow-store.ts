/**
 * Flow store — user-orchestrated business flows (core flows module)
 *
 * A flow is a user-authored "when <trigger> → run <plan>" automation scoped
 * to one environment. The trigger and plan columns hold the core wire shapes
 * verbatim (`FlowTrigger` / `{goal, nodes}` — FLOW_JSON_SCHEMA is the
 * contract), so the running simulation's `flowsProvider` can hand core
 * `FlowDefinition`s straight back (`listEnabled`); enable/disable and edits
 * take effect on the next trigger evaluation without rebuilding the runtime.
 *
 * `flow_runs` is the execution ledger fed by the runtime's `onFlowRun`
 * listener (SimulationRegistry wires it for environment-backed sims);
 * `recordRun` prunes each flow to its most recent MAX_RUNS_PER_FLOW entries.
 * Both tables cascade with their environment / flow (migration v21).
 */

import { randomUUID } from 'node:crypto';

import type {
  FlowDefinition,
  FlowInputSpec,
  FlowPolicyEnvelope,
  FlowRunRecord,
  FlowTrigger,
} from '@active-collaboration/core';

import { ApiError } from '../errors.js';
import type { EafDatabase } from './database.js';

/** Run ledger retention: each flow keeps only its most recent N runs. */
export const MAX_RUNS_PER_FLOW = 50;

/**
 * Fix-44f: per-environment flow-count cap. Every enabled flow is evaluated
 * on every injected event and every tick and publishes two bus events per
 * run — an unbounded count is a shared-server DoS surface, not just clutter.
 */
export const MAX_FLOWS_PER_ENV = 50;

export interface FlowRow {
  id: string;
  environment_id: string;
  name: string;
  description: string;
  /** 1 = enabled (fires on its trigger), 0 = validated but never fires. */
  enabled: number;
  trigger_json: string;
  plan_json: string;
  /**
   * Mechanism D: the flow's input-parameter surface (core FlowInputSpec
   * array). NULL = no declared surface (pre-D flow; runs take no params and
   * the flow cannot be published as a service).
   */
  inputs_json: string | null;
  /**
   * Mechanism C: the per-flow policy envelope (core FlowPolicyEnvelope).
   * NULL = no envelope (pre-C flow — nothing in the flow is bounded beyond
   * the standing gates).
   */
  policy_json: string | null;
  /**
   * Mechanism B: the agent-invocation opt-in (1 = agents in the author's
   * T-201 scope may name this flow in decisions; 0 = default OFF).
   */
  agent_invocable: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  simulation_id: string | null;
  trigger_kind: string;
  status: string;
  summary: string;
  node_results_json: string;
  /** T-061: serialized FlowTriggerEvaluation; NULL on pre-v30 rows. */
  trigger_evaluation_json: string | null;
  /** Mechanism D: the run's EFFECTIVE params (caller values after defaults). */
  inputs_json: string | null;
  /** Mechanism C: exhaustion escalations ('escalate' mode only); NULL otherwise. */
  policy_escalations_json: string | null;
  /** Mechanism B: the deciding agent of a triggerKind 'agent' run. */
  invoked_by_agent_id: string | null;
  /** Mechanism B: the in-flight event the decision answered (ledger ↔ decision linkage). */
  invoked_by_event_id: string | null;
  /**
   * T1 (R2, u3-F1, migration v62): serialized FlowCapabilityDrift array —
   * nodes that executed on a capability the assignee no longer DECLARES.
   * NULL = the run ran within declared authority (or predates the column).
   */
  capability_drift_json: string | null;
  started_at: string;
  finished_at: string;
}

export interface CreateFlowInput {
  environmentId: string;
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: FlowTrigger;
  plan: FlowDefinition['plan'];
  /** Mechanism D: the declared input surface (undefined = none). */
  inputs?: FlowInputSpec[];
  /** Mechanism C: the per-flow policy envelope (undefined = none). */
  policy?: FlowPolicyEnvelope;
  /** Mechanism B: agent-invocation opt-in (undefined = off). */
  agentInvocable?: boolean;
  createdBy?: string | null;
}

export interface FlowPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger?: FlowTrigger;
  plan?: FlowDefinition['plan'];
  /** Mechanism D: a new surface; null REMOVES it (back to pre-D semantics). */
  inputs?: FlowInputSpec[] | null;
  /** Mechanism C: a new envelope; null REMOVES it (back to pre-C semantics). */
  policy?: FlowPolicyEnvelope | null;
  /** Mechanism B: toggle the agent-invocation opt-in. */
  agentInvocable?: boolean;
}

/**
 * Rebuild the core FlowDefinition a flow row encodes (flowsProvider shape).
 *
 * T-201: `authorUserId` is attached from `created_by` so runtime assignment
 * resolution scopes flow nodes to the author's own agents/devices — EXCEPT
 * when the author IS the env owner (the governance principal keeps
 * unrestricted semantics via an omitted stamp) or the row has no author
 * (legacy/imported rows). The env owner id must be supplied by the caller;
 * without it the stamp is omitted ( unrestricted, pre-T-201 behavior).
 */
export function flowRowToDefinition(row: FlowRow, envOwnerId?: string): FlowDefinition {
  const authorUserId =
    row.created_by !== null && row.created_by !== envOwnerId ? row.created_by : undefined;
  return {
    id: row.id,
    name: row.name,
    ...(row.description !== '' ? { description: row.description } : {}),
    enabled: row.enabled === 1,
    ...(authorUserId !== undefined ? { authorUserId } : {}),
    trigger: JSON.parse(row.trigger_json) as FlowTrigger,
    ...(row.inputs_json !== null ? { inputs: JSON.parse(row.inputs_json) as FlowInputSpec[] } : {}),
    ...(row.policy_json !== null ? { policy: JSON.parse(row.policy_json) as FlowPolicyEnvelope } : {}),
    ...(row.agent_invocable === 1 ? { agentInvocable: true } : {}),
    plan: JSON.parse(row.plan_json) as FlowDefinition['plan'],
  };
}

export class FlowStore {
  constructor(private readonly db: EafDatabase) {}

  // -------------------------------------------------------------------------
  // Flow CRUD
  // -------------------------------------------------------------------------

  create(input: CreateFlowInput): FlowRow {
    const now = new Date().toISOString();
    const row: FlowRow = {
      id: randomUUID(),
      environment_id: input.environmentId,
      name: input.name,
      description: input.description ?? '',
      enabled: input.enabled === false ? 0 : 1,
      trigger_json: JSON.stringify(input.trigger),
      plan_json: JSON.stringify(input.plan),
      inputs_json: input.inputs !== undefined ? JSON.stringify(input.inputs) : null,
      policy_json: input.policy !== undefined ? JSON.stringify(input.policy) : null,
      agent_invocable: input.agentInvocable === true ? 1 : 0,
      created_by: input.createdBy ?? null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO flows
         (id, environment_id, name, description, enabled, trigger_json, plan_json,
          inputs_json, policy_json, agent_invocable, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.environment_id, row.name, row.description, row.enabled,
        row.trigger_json, row.plan_json, row.inputs_json, row.policy_json,
        row.agent_invocable, row.created_by, row.created_at, row.updated_at,
      );
    return row;
  }

  getById(id: string): FlowRow | undefined {
    return this.db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as FlowRow | undefined;
  }

  listByEnvironment(envId: string, opts: { enabledOnly?: boolean } = {}): FlowRow[] {
    const sql =
      'SELECT * FROM flows WHERE environment_id = ?' +
      (opts.enabledOnly ? ' AND enabled = 1' : '') +
      ' ORDER BY created_at ASC, id ASC';
    return this.db.prepare(sql).all(envId) as FlowRow[];
  }

  update(id: string, patch: FlowPatch): FlowRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new ApiError(404, 'FLOW_NOT_FOUND', `Flow "${id}" not found`);
    }
    const next: FlowRow = {
      ...existing,
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
      trigger_json: patch.trigger !== undefined ? JSON.stringify(patch.trigger) : existing.trigger_json,
      plan_json: patch.plan !== undefined ? JSON.stringify(patch.plan) : existing.plan_json,
      inputs_json: patch.inputs !== undefined
        ? patch.inputs === null
          ? null
          : JSON.stringify(patch.inputs)
        : existing.inputs_json,
      policy_json: patch.policy !== undefined
        ? patch.policy === null
          ? null
          : JSON.stringify(patch.policy)
        : existing.policy_json,
      agent_invocable: patch.agentInvocable !== undefined
        ? patch.agentInvocable ? 1 : 0
        : existing.agent_invocable,
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE flows
         SET name = ?, description = ?, enabled = ?, trigger_json = ?, plan_json = ?,
             inputs_json = ?, policy_json = ?, agent_invocable = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name, next.description, next.enabled, next.trigger_json, next.plan_json,
        next.inputs_json, next.policy_json, next.agent_invocable, next.updated_at, id,
      );
    return next;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM flows WHERE id = ?').run(id);
  }

  /**
   * Enabled flows of one environment as core FlowDefinitions — the runtime's
   * `flowsProvider` re-reads this at every trigger evaluation, so API-side
   * edits and enable/disable toggles take effect immediately.
   *
   * T-201: pass the env owner id so `flowRowToDefinition` can omit the
   * authorUserId stamp for owner-authored flows (owner = governance
   * principal, keeps unrestricted semantics).
   */
  listEnabled(envId: string, envOwnerId?: string): FlowDefinition[] {
    return this.listByEnvironment(envId, { enabledOnly: true })
      .map(row => flowRowToDefinition(row, envOwnerId));
  }

  // -------------------------------------------------------------------------
  // Run ledger
  // -------------------------------------------------------------------------

  /**
   * Record one execution (runtime `onFlowRun` listener input), then prune the
   * flow's ledger to its most recent MAX_RUNS_PER_FLOW rows. Called from the
   * engine's listener path — a persistence failure must never break the
   * runtime, so callers wrap this in try/catch (SimulationRegistry does).
   */
  recordRun(record: FlowRunRecord & { simulationId?: string }): FlowRunRow {
    const row: FlowRunRow = {
      id: record.runId,
      flow_id: record.flowId,
      simulation_id: record.simulationId ?? null,
      trigger_kind: record.triggerKind,
      status: record.status,
      summary: record.summary,
      node_results_json: JSON.stringify(record.nodeResults),
      trigger_evaluation_json: record.triggerEvaluation !== undefined
        ? JSON.stringify(record.triggerEvaluation)
        : null,
      inputs_json: record.inputs !== undefined ? JSON.stringify(record.inputs) : null,
      policy_escalations_json: record.policyEscalations !== undefined
        ? JSON.stringify(record.policyEscalations)
        : null,
      invoked_by_agent_id: record.invokedBy?.agentId ?? null,
      invoked_by_event_id: record.invokedBy?.eventId ?? null,
      capability_drift_json: record.capabilityDrift !== undefined
        ? JSON.stringify(record.capabilityDrift)
        : null,
      started_at: record.startedAt,
      finished_at: record.finishedAt,
    };
    this.db
      .prepare(
        `INSERT INTO flow_runs
         (id, flow_id, simulation_id, trigger_kind, status, summary,
          node_results_json, trigger_evaluation_json, inputs_json,
          policy_escalations_json, invoked_by_agent_id, invoked_by_event_id,
          capability_drift_json, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.flow_id, row.simulation_id, row.trigger_kind, row.status,
        row.summary, row.node_results_json, row.trigger_evaluation_json, row.inputs_json,
        row.policy_escalations_json, row.invoked_by_agent_id, row.invoked_by_event_id,
        row.capability_drift_json, row.started_at, row.finished_at,
      );
    this.db
      .prepare(
        `DELETE FROM flow_runs
         WHERE flow_id = ? AND id NOT IN (
           SELECT id FROM flow_runs
           WHERE flow_id = ?
           ORDER BY started_at DESC, id DESC
           LIMIT ?
         )`,
      )
      .run(row.flow_id, row.flow_id, MAX_RUNS_PER_FLOW);
    return row;
  }

  /** A flow's most recent runs (newest first). */
  listRuns(flowId: string, limit = MAX_RUNS_PER_FLOW): FlowRunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM flow_runs
         WHERE flow_id = ?
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(flowId, limit) as FlowRunRow[];
  }
}
