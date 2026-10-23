/**
 * Deterministic Plan Executor (P4-3).
 *
 * Runs a statically-validated WorkflowPlan. The executor contains NO model
 * calls and NO planning logic: the model authored the plan, the validator
 * compiled it, this machine just runs it. Every call is mediated through the
 * injected PlanNodeInvoker (in production: the ACExecutor three-phase
 * device-capability path), and every node produces a trace record.
 *
 * Execution semantics (v1):
 *   - Nodes run in topological waves (Kahn levels). Within a wave nodes run
 *     SEQUENTIALLY — concurrency across independent nodes is v2 work.
 *   - A node referenced as another node's compensateNodeId is
 *     COMPENSATION-ONLY: it is excluded from normal scheduling and runs at
 *     most once, at failure time, out-of-band (its own dependsOn ignored).
 *   - Dependency propagation: a node whose dependency 'failed'/'blocked' is
 *     'blocked'; a node whose dependency was condition-'skipped' is 'skipped'
 *     (the whole subtree is skipped).
 *   - Conditions are evaluated per node against the injected env-state
 *     reader; false ⇒ 'skipped'. An unresolvable condition path is treated
 *     as false (conservative) and recorded in the node's note.
 *   - Failure policies:
 *       abort (default): node 'failed' → dependents 'blocked'.
 *       retry: up to 1 + retries invoke attempts (default retries = 2) with
 *              linear backoff; exhausted ⇒ same as abort.
 *       compensate: single attempt; on failure execute the compensation node
 *              once, then node 'failed' → dependents 'blocked'.
 *   - This executor NEVER throws: any internal fault yields a 'failed'
 *     PlanExecutionResult with the error in the summary.
 */

import {
  evaluatePlanCondition,
  parsePlanCondition,
  type PlanNode,
  type WorkflowPlan,
} from './plan-schema.js';

// ============================================================================
// Types
// ============================================================================

export type PlanNodeStatus = 'succeeded' | 'failed' | 'skipped' | 'blocked';

export interface PlanNodeResult {
  nodeId: string;
  status: PlanNodeStatus;
  /** Number of invoke attempts made (0 for skipped/blocked nodes). */
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
  /** Human-readable note (condition outcomes, compensation detail). */
  note?: string;
  /** Set on a compensation node's result: the failed node it compensates. */
  compensationFor?: string;
  /**
   * The device this node actuated (T-201): copied from the invocation when
   * the invoker resolved one, so run traces (flow ledger) show WHICH device
   * every node touched.
   */
  deviceId?: string;
}

export interface PlanExecutionResult {
  planId: string;
  status: 'success' | 'partial' | 'failed';
  nodeResults: Record<string, PlanNodeResult>;
  summary: string;
  startedAt: string;
  finishedAt: string;
}

/** Outcome of one mediated node invocation. Implementations must not throw. */
export interface PlanNodeInvocation {
  success: boolean;
  result?: unknown;
  error?: string;
  /**
   * The device the invoker actuated (or resolved before failing), when it
   * knows one (T-201) — the executor copies it into the node result.
   */
  deviceId?: string;
}

/**
 * Optional per-run invocation context. `zoneId` is the zone the run was
 * triggered for (flow trigger zone) — zone-scoped invokers use it to prefer
 * devices IN that zone instead of any device the assignee happens to own.
 */
export interface PlanNodeInvokeContext {
  zoneId?: string;
  /**
   * T-608 (R26, SC26-F03): display label of the acting principal, threaded
   * to the device audit trail (accessLog `by` / lastActionBy). Flow-lane
   * actuations carry `flow:<flowId>`; the direct lane carries the user
   * displayName. Deliberately NOT merged into node params (R17 purity).
   */
  actor?: string;
  /**
   * R6-B-F03: the id of the flow whose run is invoking the node (flow lane
   * only). Service-node invokers (the server's agreement-mediated lane) key
   * the CONSUMER identity off the flow's authorship — the flow author's
   * active agreement is what authorizes the call.
   */
  flowId?: string;
}

/**
 * The mediation seam: executes one plan node as the assigned agent. In
 * production this routes through the same own-resources → external-services
 * device-capability path the ACExecutor uses. The third parameter is
 * optional: callers without zone context (and invokers that ignore it) keep
 * the original two-argument shape.
 */
export type PlanNodeInvoker = (
  node: PlanNode,
  agentId: string,
  context?: PlanNodeInvokeContext,
) => Promise<PlanNodeInvocation>;

/** Reads the current environment snapshot for condition evaluation. */
export type EnvStateReader = () => Record<string, unknown>;

export interface PlanExecutorOptions {
  /** Base backoff between retry attempts (ms); linear: backoffMs × attempt. */
  backoffMs?: number;
  /** Sleep function (injectable for deterministic tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Default retry count when onFail.policy === 'retry' and retries unset. */
  defaultRetries?: number;
}

const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_RETRIES = 2;

// ============================================================================
// PlanExecutor
// ============================================================================

export class PlanExecutor {
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultRetries: number;

  constructor(options: PlanExecutorOptions = {}) {
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    this.defaultRetries = options.defaultRetries ?? DEFAULT_RETRIES;
  }

  /**
   * Execute a validated plan. `assignments` maps nodeId → agentId as chosen
   * by the static validator (a node without an assignment fails immediately
   * with an UNSAT-style error — run validatePlan first).
   */
  async execute(
    plan: WorkflowPlan,
    assignments: ReadonlyMap<string, string>,
    invoker: PlanNodeInvoker,
    envStateReader: EnvStateReader,
  ): Promise<PlanExecutionResult> {
    const startedAt = new Date().toISOString();
    const nodeResults: Record<string, PlanNodeResult> = {};

    try {
      const compensationOnly = this.collectCompensationOnlyNodes(plan);
      const waves = this.computeWaves(plan, compensationOnly);

      if (waves === null) {
        // Defensive: validator should have caught cycles. Never throw.
        return this.finalize(plan, nodeResults, startedAt,
          `plan '${plan.id}' has a dependency cycle — refused by executor (run validatePlan first)`);
      }

      for (const wave of waves) {
        for (const node of wave) {
          nodeResults[node.id] = await this.executeNode(
            plan, node, nodeResults, assignments, invoker, envStateReader, compensationOnly,
          );
        }
      }

      // Compensation-only nodes that never triggered get an explicit record.
      for (const nodeId of compensationOnly) {
        if (!nodeResults[nodeId]) {
          nodeResults[nodeId] = {
            nodeId, status: 'skipped', attempts: 0, note: 'compensation not required',
          };
        }
      }

      return this.finalize(plan, nodeResults, startedAt);
    } catch (error) {
      // NEVER throw across the boundary.
      return this.finalize(plan, nodeResults, startedAt,
        `executor internal fault: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  /** Node ids referenced as compensateNodeId (compensation-only). */
  private collectCompensationOnlyNodes(plan: WorkflowPlan): Set<string> {
    const set = new Set<string>();
    for (const node of plan.nodes) {
      if (node.onFail?.policy === 'compensate' && node.onFail.compensateNodeId) {
        set.add(node.onFail.compensateNodeId);
      }
    }
    return set;
  }

  /**
   * Kahn-level topological waves over normally-scheduled nodes. Returns null
   * on cycle (defensive — the validator already rejects cyclic plans).
   * Compensation-only nodes are excluded; dependencies ON compensation-only
   * nodes are dropped from the schedule (they never complete normally).
   */
  private computeWaves(plan: WorkflowPlan, compensationOnly: Set<string>): PlanNode[][] | null {
    const scheduled = plan.nodes.filter(n => !compensationOnly.has(n.id));
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    const byId = new Map(scheduled.map(n => [n.id, n]));

    for (const node of scheduled) indegree.set(node.id, 0);
    for (const node of scheduled) {
      for (const dep of node.dependsOn ?? []) {
        if (!byId.has(dep)) continue; // unknown or compensation-only dep
        indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
        const list = dependents.get(dep) ?? [];
        list.push(node.id);
        dependents.set(dep, list);
      }
    }

    const waves: PlanNode[][] = [];
    let current = scheduled.filter(n => (indegree.get(n.id) ?? 0) === 0).map(n => n.id);
    let visited = 0;
    while (current.length > 0) {
      waves.push(current.map(id => byId.get(id) as PlanNode));
      visited += current.length;
      const next: string[] = [];
      for (const id of current) {
        for (const dep of dependents.get(id) ?? []) {
          const d = (indegree.get(dep) ?? 0) - 1;
          indegree.set(dep, d);
          if (d === 0) next.push(dep);
        }
      }
      current = next;
    }

    return visited === scheduled.length ? waves : null;
  }

  /** Execute one node with dependency propagation, condition and onFail policy. */
  private async executeNode(
    plan: WorkflowPlan,
    node: PlanNode,
    nodeResults: Record<string, PlanNodeResult>,
    assignments: ReadonlyMap<string, string>,
    invoker: PlanNodeInvoker,
    envStateReader: EnvStateReader,
    compensationOnly: Set<string>,
  ): Promise<PlanNodeResult> {
    // 1. Dependency propagation.
    for (const depId of node.dependsOn ?? []) {
      const dep = nodeResults[depId];
      if (!dep) continue; // dep outside normal schedule (compensation-only)
      if (dep.status === 'failed' || dep.status === 'blocked') {
        return {
          nodeId: node.id, status: 'blocked', attempts: 0,
          error: `dependency '${depId}' ${dep.status}`,
        };
      }
      if (dep.status === 'skipped') {
        return {
          nodeId: node.id, status: 'skipped', attempts: 0,
          note: `dependency '${depId}' was skipped`,
        };
      }
    }

    // 2. Condition guard.
    if (node.condition !== undefined) {
      const parsed = parsePlanCondition(node.condition);
      if (!parsed) {
        // Validator guarantees parseability; be conservative anyway.
        return {
          nodeId: node.id, status: 'skipped', attempts: 0,
          note: `condition '${node.condition}' unparseable at execution time — skipped conservatively`,
        };
      }
      let snapshot: Record<string, unknown> = {};
      try {
        snapshot = envStateReader() ?? {};
      } catch (error) {
        return {
          nodeId: node.id, status: 'skipped', attempts: 0,
          note: `environment snapshot read failed (${error instanceof Error ? error.message : String(error)}) — skipped conservatively`,
        };
      }
      const evaluation = evaluatePlanCondition(parsed, snapshot);
      if (evaluation.result !== true) {
        return {
          nodeId: node.id, status: 'skipped', attempts: 0,
          note: evaluation.unresolvedReason
            ? `condition '${node.condition}' unresolved: ${evaluation.unresolvedReason} — treated as false`
            : `condition '${node.condition}' evaluated false`,
        };
      }
    }

    // 3. Assignee.
    const agentId = assignments.get(node.id);
    if (agentId === undefined) {
      return {
        nodeId: node.id, status: 'failed', attempts: 0,
        error: `no assignee for node '${node.id}' (capability '${node.capability}' UNSAT?) — run validatePlan first`,
      };
    }

    // 4. Invoke with failure policy.
    const policy = node.onFail?.policy ?? 'abort';
    const maxAttempts = policy === 'retry' ? 1 + (node.onFail?.retries ?? this.defaultRetries) : 1;

    let attempts = 0;
    let lastError: string | undefined;
    let lastDeviceId: string | undefined;
    const nodeStartedAt = new Date().toISOString();

    while (attempts < maxAttempts) {
      attempts++;
      if (attempts > 1) {
        await this.sleep(this.backoffMs * (attempts - 1));
      }
      try {
        const invocation = await invoker(node, agentId);
        if (invocation.deviceId !== undefined) lastDeviceId = invocation.deviceId;
        if (invocation.success) {
          return {
            nodeId: node.id, status: 'succeeded', attempts,
            startedAt: nodeStartedAt, finishedAt: new Date().toISOString(),
            result: invocation.result,
            ...(invocation.deviceId !== undefined ? { deviceId: invocation.deviceId } : {}),
          };
        }
        lastError = invocation.error ?? 'invocation reported failure';
      } catch (error) {
        // Invokers must not throw; defend anyway.
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    // 5. Failure path.
    const failedResult: PlanNodeResult = {
      nodeId: node.id, status: 'failed', attempts,
      startedAt: nodeStartedAt, finishedAt: new Date().toISOString(),
      error: lastError ?? 'unknown failure',
      ...(lastDeviceId !== undefined ? { deviceId: lastDeviceId } : {}),
    };

    if (policy === 'compensate' && node.onFail?.compensateNodeId) {
      const compensationNote = await this.runCompensation(
        plan, node, node.onFail.compensateNodeId, nodeResults, assignments, invoker, compensationOnly,
      );
      failedResult.note = compensationNote;
    }

    return failedResult;
  }

  /**
   * Run a compensation node once, out-of-band. Records its result under its
   * own nodeId (tagged compensationFor) so it is not re-run later.
   */
  private async runCompensation(
    plan: WorkflowPlan,
    failedNode: PlanNode,
    compensationNodeId: string,
    nodeResults: Record<string, PlanNodeResult>,
    assignments: ReadonlyMap<string, string>,
    invoker: PlanNodeInvoker,
    compensationOnly: Set<string>,
  ): Promise<string> {
    const compensationNode = plan.nodes.find(n => n.id === compensationNodeId);
    if (!compensationNode) {
      return `compensation node '${compensationNodeId}' not found in plan`;
    }
    const existing = nodeResults[compensationNodeId];
    if (existing && existing.status === 'succeeded') {
      return `compensation node '${compensationNodeId}' already succeeded — not re-run`;
    }

    const agentId = assignments.get(compensationNodeId);
    if (agentId === undefined) {
      nodeResults[compensationNodeId] = {
        nodeId: compensationNodeId, status: 'failed', attempts: 0,
        error: 'no assignee for compensation node', compensationFor: failedNode.id,
      };
      return `compensation node '${compensationNodeId}' has no assignee`;
    }

    const startedAt = new Date().toISOString();
    try {
      const invocation = await invoker(compensationNode, agentId);
      nodeResults[compensationNodeId] = {
        nodeId: compensationNodeId,
        status: invocation.success ? 'succeeded' : 'failed',
        attempts: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        result: invocation.result,
        error: invocation.error,
        compensationFor: failedNode.id,
        ...(invocation.deviceId !== undefined ? { deviceId: invocation.deviceId } : {}),
      };
      return invocation.success
        ? `compensation node '${compensationNodeId}' executed successfully`
        : `compensation node '${compensationNodeId}' FAILED: ${invocation.error ?? 'unknown'}`;
    } catch (error) {
      nodeResults[compensationNodeId] = {
        nodeId: compensationNodeId, status: 'failed', attempts: 1,
        startedAt, finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        compensationFor: failedNode.id,
      };
      return `compensation node '${compensationNodeId}' threw: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      // Ensure the compensation node is treated as compensation-only from here on.
      compensationOnly.add(compensationNodeId);
    }
  }

  /** Compute overall status + summary. */
  private finalize(
    plan: WorkflowPlan,
    nodeResults: Record<string, PlanNodeResult>,
    startedAt: string,
    forcedError?: string,
  ): PlanExecutionResult {
    const results = Object.values(nodeResults);
    const succeeded = results.filter(r => r.status === 'succeeded').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const blocked = results.filter(r => r.status === 'blocked').length;
    const skipped = results.filter(r => r.status === 'skipped').length;

    // T-109 (DevLoop R32, F15): a failed node whose DECLARED fallback lane
    // (onFail compensate / a delegate's authored fallback, which the flow
    // engine maps onto the same machine) SUCCEEDED delivered the plan's
    // authored behavior — the run must not meter as a failure downstream
    // (agreement invocations counted exactly this shape outcome:'failure',
    // provider-hostile for an honest degradation). The failed node itself
    // stays 'failed' in nodeResults — per-node honesty is unchanged; only
    // the RUN-level classification distinguishes delivered degradations.
    const compensatedBy = new Set(
      results
        .filter(r => r.compensationFor !== undefined && r.status === 'succeeded')
        .map(r => r.compensationFor as string),
    );
    const degradedDelivered = results
      .filter(r => r.status === 'failed' && compensatedBy.has(r.nodeId)).length;
    const uncompensatedFailures = failed - degradedDelivered;

    let status: PlanExecutionResult['status'];
    if (forcedError !== undefined) {
      status = 'failed';
    } else if (uncompensatedFailures === 0 && blocked === 0) {
      // Covers the all-succeeded case AND the fallback-delivered case.
      status = 'success';
    } else if (succeeded === 0) {
      status = 'failed';
    } else {
      status = 'partial';
    }

    const degradedNote = degradedDelivered > 0
      ? `, ${degradedDelivered} degraded but fallback-delivered`
      : '';
    const summary = forcedError !== undefined
      ? `plan '${plan.id}' failed: ${forcedError}`
      : `plan '${plan.id}' ${status}: ${succeeded} succeeded, ${skipped} skipped, ` +
        `${uncompensatedFailures} failed, ${blocked} blocked${degradedNote} (${plan.nodes.length} nodes)`;

    return {
      planId: plan.id,
      status,
      nodeResults,
      summary,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}
