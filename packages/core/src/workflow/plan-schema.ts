/**
 * Workflow Plan Schema v1 (P4-3) — collaboration workflow synthesis.
 *
 * Design rule: the model AUTHORS a plan, the framework VALIDATES it
 * statically (like a compiler), a deterministic EXECUTOR runs it.
 *
 * This file defines the authored artifact:
 *   - WorkflowPlan / PlanNode types
 *   - PLAN_JSON_SCHEMA (used BOTH for ajv shape validation and for
 *     constrained decoding via ChatParams.format)
 *   - validatePlanShape(): ajv-backed shape validation
 *   - the condition mini-language (parse + evaluate) documented below
 *
 * Condition mini-language (v1 — deliberately small):
 *
 *   <condition> := <path> <op> <literal>
 *   <path>      := segment ('.' segment)*   e.g. "zone.temperature", "temperature"
 *   <segment>   := [A-Za-z_][\w-]*          (hyphens allowed: zone ids like 'living-room')
 *   <op>        := == | != | > | < | >= | <=
 *   <literal>   := number | true | false | 'string' | "string"
 *
 * Resolution against an environment snapshot (a plain object):
 *   1. exact flat key match on the full path ("zone.temperature")
 *   2. dotted walk from the root (snapshot.zone.temperature)
 * Logical combinators (&&/||), arithmetic and functions are NOT v1 —
 * they fail parsing and are reported as validation errors. Richness here
 * is v2 work.
 */

import Ajv, { type ValidateFunction } from 'ajv';

// ============================================================================
// Types
// ============================================================================

/** Failure policy for a plan node. */
export interface PlanFailurePolicy {
  policy: 'abort' | 'retry' | 'compensate';
  /** Number of RETRY attempts after the first (retry policy; default 2). */
  retries?: number;
  /** Node to execute once when this node fails (compensate policy). */
  compensateNodeId?: string;
}

// ============================================================================
// Delegate node spec (Mechanism A — mixed-initiative flows; TYPES ONLY)
// ============================================================================

/**
 * Execution budget for an actuating delegate node (Mechanism A). Every
 * actuation the delegate proposes is checked against this budget BEFORE it
 * runs: at most `maxCommands` commands, only on the pinned `deviceIds`, only
 * with the `allowedCommands` names. Out-of-budget proposals are rejected
 * INDIVIDUALLY with a recorded reason — never silently truncated, never a
 * whole-node failure.
 *
 * Ratified trade-off #1 (owner, design-mixed-initiative-flows §4.3): for
 * zone-scoped triggers (event/condition) every budget device must sit INSIDE
 * the trigger zone — "a zone-X flow never touches zone-Y devices" must cover
 * judgment-driven actuations too. Cross-zone needs per-zone delegation or
 * the agreement path.
 */
export interface PlanDelegateBudget {
  /** Maximum number of device commands the delegate may execute (≥ 1). */
  maxCommands: number;
  /** The ONLY devices the delegate may actuate (pinned, T-201 semantics). */
  deviceIds: string[];
  /** The ONLY command names the delegate may use on those devices. */
  allowedCommands: string[];
}

/**
 * Deterministic fallback when a delegate node cannot produce a judgment
 * (timeout, LLM provider down / degraded, disabled assignee):
 *   - 'none': record an honest no-op (node result carries fallbackUsed + reason)
 *   - 'node': run the referenced action node once, out-of-band — the same
 *     at-most-once semantics compensate nodes have.
 */
export type PlanDelegateFallback =
  | { policy: 'none' }
  | { policy: 'node'; nodeId: string };

/**
 * The `delegate` body of a plan node. A node carrying `delegate` is a
 * DELEGATE node: the flow asks one bounded question of the assignee agent's
 * LLM judgment, optionally letting it act inside a strict budget. The flow
 * remains the process owner — topology, guards and failure policies are all
 * still decided by the (deterministic) flow.
 *
 * `advice` mode: the judgment is only RECORDED (and its whitelisted
 * `outputs` promoted into the guard snapshot under
 * `delegate.<nodeId>.<key>`); the agent actuates nothing.
 * `actuating` mode: the agent may additionally execute device commands
 * strictly inside `budget` (required in this mode), through the same
 * own-devices command path action nodes use.
 *
 * This is a FLOW-ONLY node variant: PLAN_JSON_SCHEMA deliberately does not
 * accept it (LLM-synthesized plans may not embed free judgment steps —
 * design §8.5.1); only FLOW_JSON_SCHEMA does.
 */
export interface PlanDelegateSpec {
  /** The bounded, closed question asked of the assignee's judgment. */
  question: string;
  mode: 'advice' | 'actuating';
  /** Required (and only allowed) in 'actuating' mode. */
  budget?: PlanDelegateBudget;
  /** Advice-only: output keys promoted to guard paths `delegate.<nodeId>.<key>`. */
  outputs?: string[];
  /**
   * Wall-clock bound on the judgment (default 30000). The FlowEngine's run
   * queue is serial, so an unbounded LLM wait would hang every later flow —
   * the timeout guarantees the queue drains (bounded by the same
   * "(1 + retries) provider timeouts" argument as T-022 llmFailure).
   */
  timeoutMs?: number;
  fallback?: PlanDelegateFallback;
}

/**
 * R6-B-F03 (cross-owner orchestration carrier): when set, this node is a
 * SERVICE node — it invokes ANOTHER tenant's published service in the same
 * environment THROUGH an active agreement (the metered invoke lane: quota /
 * terms.action / audit / metering all apply), never the flow author's own
 * devices. Orchestration declares the DEPENDENCY; the agreement grants the
 * permission (provider approval semantics unchanged). `capability`,
 * `deviceId`, `assigneeAgentId` and `delegate` must be absent (enforced by
 * FLOW_JSON_SCHEMA's closed node shape + validateFlow's teaching pre-check).
 * FLOW-ONLY: PLAN_JSON_SCHEMA never accepts it (LLM-synthesized plans may
 * not embed contract-mediated calls).
 */
export interface PlanServiceSpec {
  /** Exact service id in the node's environment (preferred — unambiguous). */
  serviceId?: string;
  /**
   * Semantic-type reference, resolved against the env catalog at run time
   * (the active agreement the flow's author holds on a service of this
   * type wins; zero → honest failure teaching the signing move).
   */
  semanticType?: string;
  /**
   * The action to invoke (a command name; 'run' for flow-backed services).
   * Omitted = the agreement's negotiated terms.action.command.
   */
  action?: string;
}

/**
 * FEAT-05 (deterministic notify lane): when set, this node is a NOTIFY node —
 * it delivers a message to a user's inbox through the host's notification
 * pipeline (the same family as policy-envelope escalations and handshake
 * answers), never a device. `to` picks the recipient resolution: 'agent'
 * (target = agent id, resolved to its owner user), 'role' (target = an env
 * role: owner/builder/viewer — every member with that role), or 'owner'
 * (the environment owner; no target). `capability`, `params`, `deviceId`
 * and `assigneeAgentId` must be absent (enforced by FLOW_JSON_SCHEMA's
 * closed node shape + validateFlow's teaching pre-check). FLOW-ONLY:
 * PLAN_JSON_SCHEMA never accepts it.
 */
export interface PlanNotifySpec {
  to: 'agent' | 'role' | 'owner';
  /** agent id (to='agent') or env role (to='role'); absent for to='owner'. */
  target?: string;
  message: string;
}

/**
 * FEAT-06 (deterministic staggering): when set, this node is a WAIT node —
 * it completes only after `simSec` SIMULATED seconds have passed since its
 * dependencies completed, suspending the run (deterministically scheduled
 * on the engine's sim clock, checkpointed; a paused world does not count
 * down). Everything depending on it resumes at the due tick. `capability`,
 * `params`, `deviceId` and `assigneeAgentId` must be absent (same teaching
 * pre-check). FLOW-ONLY: PLAN_JSON_SCHEMA never accepts it.
 */
export interface PlanWaitSpec {
  /** Sim seconds to wait (exclusive minimum 0). */
  simSec: number;
}

/** One step of a workflow plan. */
export interface PlanNode {
  id: string;
  /** Required capability semantic type (e.g. 'cooling', 'temperature-reading'). */
  capability: string;
  /** Optional preferred agent; the validator may reassign when unsatisfiable. */
  assigneeAgentId?: string;
  /**
   * Pin the node to ONE device (T-201): the flow invoker actuates exactly
   * this device of the assignee's bound set. Required when several bound
   * devices provide the capability (ambiguity is a validation error, not a
   * warning); the resolved device lands in the run's node results.
   */
  deviceId?: string;
  /**
   * R1 (B1-8 / P-17): EXPLICIT cross-zone actuation. A zone-scoped run
   * refuses to actuate another zone's device ("authoring green, fire-day
   * red" was the most dangerous failure mode); `crossZone: true` declares
   * the pin intentionally reaches outside the trigger zone (fire-evacuation
   * broadcast is the canonical case) and both the authoring zone check and
   * the runtime invoker honor it.
   */
  crossZone?: boolean;
  /** Capability parameters, e.g. { targetTemperature: 25 }. */
  params?: Record<string, unknown>;
  /** Node ids that must complete first (DAG edges). */
  dependsOn?: string[];
  /** Guard condition in the mini-language above; false ⇒ node subtree skipped. */
  condition?: string;
  onFail?: PlanFailurePolicy;
  /**
   * Mechanism A (mixed-initiative flows): when set, this node is a DELEGATE
   * node — `capability`/`params`/`deviceId` must be absent (enforced by
   * FLOW_JSON_SCHEMA's strict node variants). FLOW-ONLY: PLAN_JSON_SCHEMA
   * does not know this field, so LLM-synthesized plans reject it loudly.
   */
  delegate?: PlanDelegateSpec;
  /**
   * R6-B-F03: when set, this node is a SERVICE node (see PlanServiceSpec) —
   * `capability`/`params`-on-devices/`deviceId`/`assigneeAgentId` do not
   * apply; node.params are the invocation params passed to the agreement
   * lane (terms.action.params merge-override still binds). FLOW-ONLY:
   * PLAN_JSON_SCHEMA does not know this field, so LLM-synthesized plans
   * reject it loudly.
   */
  service?: PlanServiceSpec;
  /**
   * FEAT-05: when set, this node is a NOTIFY node (see PlanNotifySpec) —
   * `capability`/`params`/`deviceId`/`assigneeAgentId` do not apply (the
   * recipients are users, resolved by the host's notification lane).
   * FLOW-ONLY: PLAN_JSON_SCHEMA does not know this field.
   */
  notify?: PlanNotifySpec;
  /**
   * FEAT-06: when set, this node is a WAIT node (see PlanWaitSpec) —
   * `capability`/`params`/`deviceId`/`assigneeAgentId` do not apply (the
   * engine's sim clock is the only actor). FLOW-ONLY: PLAN_JSON_SCHEMA does
   * not know this field.
   */
  wait?: PlanWaitSpec;
}

/** A complete authored workflow plan. */
export interface WorkflowPlan {
  id: string;
  /** Natural-language goal the plan achieves. */
  goal: string;
  nodes: PlanNode[];
  metadata: {
    author: 'llm' | 'manual';
    model?: string;
    createdAt: string;
  };
}

/** Machine-readable validation issue, shared by schema/static validation. */
export interface PlanIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

// ============================================================================
// JSON schema (ajv shape validation + LLM constrained decoding)
// ============================================================================

/**
 * Draft-07 JSON schema for WorkflowPlan v1. Kept permissive where the LLM
 * benefits (additionalProperties tolerated at the top level) but strict on
 * the invariants the executor relies on (non-empty ids/capabilities, enum
 * failure policies).
 */
export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['id', 'goal', 'nodes', 'metadata'],
  properties: {
    id: { type: 'string', minLength: 1 },
    goal: { type: 'string', minLength: 1 },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'capability'],
        properties: {
          id: { type: 'string', minLength: 1 },
          capability: { type: 'string', minLength: 1 },
          assigneeAgentId: { type: 'string', minLength: 1 },
          deviceId: { type: 'string', minLength: 1 },
          // R1 (B1-8 / P-17): explicit cross-zone actuation (see
          // PlanNode.crossZone) — a structural declaration like deviceId,
          // legal in both flow-authored and plan-shaped nodes.
          crossZone: { type: 'boolean' },
          params: { type: 'object' },
          dependsOn: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
          condition: { type: 'string', minLength: 1 },
          onFail: {
            type: 'object',
            required: ['policy'],
            properties: {
              policy: { type: 'string', enum: ['abort', 'retry', 'compensate'] },
              retries: { type: 'integer', minimum: 0, maximum: 10 },
              compensateNodeId: { type: 'string', minLength: 1 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    metadata: {
      type: 'object',
      required: ['author', 'createdAt'],
      properties: {
        author: { type: 'string', enum: ['llm', 'manual'] },
        model: { type: 'string' },
        createdAt: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

let compiledShapeValidator: ValidateFunction | null = null;

function getShapeValidator(): ValidateFunction {
  if (!compiledShapeValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    compiledShapeValidator = ajv.compile(PLAN_JSON_SCHEMA);
  }
  return compiledShapeValidator;
}

/**
 * Validate the JSON shape of an unknown value against PLAN_JSON_SCHEMA.
 * Returns issues only — never throws. Node-scoped errors carry nodeId when
 * the ajv path allows it.
 */
export function validatePlanShape(plan: unknown): PlanIssue[] {
  const validator = getShapeValidator();
  const valid = validator(plan);
  if (valid) return [];

  return (validator.errors ?? []).map(err => {
    // instancePath like "/nodes/2/capability" → node index 2; resolve to id when possible
    let nodeId: string | undefined;
    const nodeMatch = err.instancePath.match(/^\/nodes\/(\d+)(\/|$)/);
    if (nodeMatch && Array.isArray((plan as { nodes?: unknown[] })?.nodes)) {
      const node = (plan as { nodes: Array<{ id?: unknown }> }).nodes[Number(nodeMatch[1])];
      nodeId = typeof node?.id === 'string' ? node.id : `nodes[${nodeMatch[1]}]`;
    }
    const path = err.instancePath || '/';
    return {
      level: 'error' as const,
      ...(nodeId ? { nodeId } : {}),
      message: `schema: ${path} ${err.message ?? 'invalid'}`,
    };
  });
}

// ============================================================================
// Semantic (DAG) validation — shape-independent, like a compiler's IR checks
// ============================================================================

/**
 * Validate plan semantics beyond JSON shape: duplicate node ids, dependsOn
 * references, compensateNodeId references, DAG acyclicity, and condition
 * parseability. Assumes shape already validated (tolerates minor shape
 * drift defensively).
 */
export function validatePlanSemantics(plan: WorkflowPlan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];

  // Duplicate ids
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      issues.push({ level: 'error', nodeId: node.id, message: `duplicate node id '${node.id}'` });
    }
    seen.add(node.id);
  }

  // dependsOn references + compensateNodeId references + condition parsing
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!seen.has(dep)) {
        issues.push({ level: 'error', nodeId: node.id, message: `dependsOn references unknown node '${dep}'` });
      }
      if (dep === node.id) {
        issues.push({ level: 'error', nodeId: node.id, message: `node '${node.id}' depends on itself` });
      }
    }
    if (node.onFail?.policy === 'compensate') {
      const target = node.onFail.compensateNodeId;
      if (!target) {
        issues.push({ level: 'error', nodeId: node.id, message: `compensate policy requires compensateNodeId` });
      } else if (!seen.has(target)) {
        issues.push({ level: 'error', nodeId: node.id, message: `compensateNodeId references unknown node '${target}'` });
      } else if (target === node.id) {
        issues.push({ level: 'error', nodeId: node.id, message: `node '${node.id}' cannot compensate itself` });
      }
    }
    if (node.condition !== undefined) {
      const parsed = parsePlanCondition(node.condition);
      if (!parsed) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `condition '${node.condition}' is not parseable (expected "<path> <op> <literal>", e.g. "zone.temperature > 30")`,
        });
      }
    }
  }

  // DAG acyclicity (Kahn's algorithm)
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!seen.has(dep) || dep === node.id) continue; // already reported
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }
  const queue = nodes.filter(n => (indegree.get(n.id) ?? 0) === 0).map(n => n.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited++;
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited < nodes.length) {
    const inCycle = nodes.filter(n => (indegree.get(n.id) ?? 0) > 0).map(n => n.id);
    issues.push({
      level: 'error',
      nodeId: inCycle[0],
      message: `dependency cycle detected involving node(s): ${inCycle.join(', ')}`,
    });
  }

  return issues;
}

// ============================================================================
// Condition mini-language
// ============================================================================

export interface ParsedPlanCondition {
  /** Dotted path, e.g. 'zone.temperature'. */
  path: string;
  op: '==' | '!=' | '>' | '<' | '>=' | '<=';
  value: number | boolean | string;
}

const CONDITION_PATTERN = /^([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

/**
 * Parse a condition string in the v1 mini-language. Returns null when the
 * string is not parseable (validator reports it as an error).
 */
export function parsePlanCondition(condition: string): ParsedPlanCondition | null {
  if (typeof condition !== 'string') return null;
  const match = condition.trim().match(CONDITION_PATTERN);
  if (!match) return null;

  const [, path, op, rawLiteral] = match;
  const literal = rawLiteral.trim();

  let value: number | boolean | string;
  if (/^-?\d+(?:\.\d+)?$/.test(literal)) {
    value = Number(literal);
  } else if (literal === 'true') {
    value = true;
  } else if (literal === 'false') {
    value = false;
  } else if (
    (literal.startsWith("'") && literal.endsWith("'") && literal.length >= 2) ||
    (literal.startsWith('"') && literal.endsWith('"') && literal.length >= 2)
  ) {
    value = literal.slice(1, -1);
  } else {
    // Bare words are not valid literals in v1 (strings must be quoted) —
    // this catches typos like "zone.temp > hot" at validation time.
    return null;
  }

  return { path, op: op as ParsedPlanCondition['op'], value };
}

export interface PlanConditionEvaluation {
  /** Comparison result; undefined when the path cannot be resolved. */
  result?: boolean;
  /** Why evaluation could not resolve a value. */
  unresolvedReason?: string;
  /**
   * T-061: the value the path resolved to, when found — surfaced so
   * consumers (flow run traces) can show evaluated-value vs threshold
   * instead of a bare boolean.
   */
  resolvedValue?: unknown;
}

/**
 * Resolve a dotted path against an environment snapshot:
 *   1. exact flat key ("zone.temperature" as a single key)
 *   2. dotted walk (snapshot.zone.temperature)
 */
function resolvePath(snapshot: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
  if (Object.prototype.hasOwnProperty.call(snapshot, path)) {
    return { found: true, value: snapshot[path] };
  }
  const segments = path.split('.');
  let current: unknown = snapshot;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/**
 * Evaluate a parsed condition against an environment snapshot. Never throws.
 * An unresolvable path yields `result: undefined` — the executor treats the
 * condition as false (conservative skip) and records the reason.
 */
export function evaluatePlanCondition(
  condition: ParsedPlanCondition,
  snapshot: Record<string, unknown>,
): PlanConditionEvaluation {
  const resolved = resolvePath(snapshot, condition.path);
  if (!resolved.found) {
    return { unresolvedReason: `path '${condition.path}' not present in environment snapshot` };
  }

  const actual = resolved.value;
  const expected = condition.value;

  switch (condition.op) {
    case '==':
      return { result: actual === expected || String(actual) === String(expected), resolvedValue: actual };
    case '!=':
      return { result: !(actual === expected || String(actual) === String(expected)), resolvedValue: actual };
    case '>':
    case '<':
    case '>=':
    case '<=': {
      const a = Number(actual);
      const e = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(e)) {
        return {
          unresolvedReason: `path '${condition.path}' value ${JSON.stringify(actual)} is not numeric (op '${condition.op}')`,
        };
      }
      if (condition.op === '>') return { result: a > e, resolvedValue: actual };
      if (condition.op === '<') return { result: a < e, resolvedValue: actual };
      if (condition.op === '>=') return { result: a >= e, resolvedValue: actual };
      return { result: a <= e, resolvedValue: actual };
    }
  }
}
