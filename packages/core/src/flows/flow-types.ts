/**
 * Flow types + validation (user-orchestrated business flows).
 *
 * A Flow is a USER-AUTHORED automation: "when <trigger> fires, run this
 * plan". Unlike the P4-3 workflow-synthesis path (model authors, framework
 * validates), the plan inside a flow is written by a human/operator — the
 * framework still statically validates it (same validatePlanShape /
 * validatePlanSemantics compiler pass) and deterministically executes it
 * through the same PlanExecutor.
 *
 * This file defines:
 *   - FlowDefinition / FlowTrigger / FlowCondition types
 *   - FLOW_JSON_SCHEMA (draft-07; used by server/CLI tooling for shape
 *     validation, mirroring PLAN_JSON_SCHEMA's role for plans)
 *   - validateFlow(): shape + trigger + condition + plan validation,
 *     returning PlanIssue records — never throws
 *   - evaluateFlowCondition(): condition evaluation reusing the plan
 *     condition mini-language's comparison semantics
 *
 * Condition semantics deliberately mirror the plan condition mini-language
 * (plan-schema.ts): same path segment rule, same operators, same comparison
 * behavior (== falls back to string coercion, ordering ops require numbers).
 * FlowCondition is structurally identical to ParsedPlanCondition, so
 * evaluatePlanCondition is reused directly.
 */

import Ajv, { type ValidateFunction } from 'ajv';

import {
  evaluatePlanCondition,
  parsePlanCondition,
  validatePlanSemantics,
  validatePlanShape,
  type PlanDelegateSpec,
  type PlanIssue,
  type PlanNode,
  type WorkflowPlan,
} from '../workflow/plan-schema.js';
import { detectPromptInjection } from '../security/prompt-sanitizer.js';
// T-606 (R26): the condition-path lint needs the standard snapshot
// parameter names (pure constant, no cycle — world.ts has no flows imports).
import { SNAPSHOT_PARAMETERS } from '../runtime/shaping/world.js';
import type { ScenarioDefinition } from '../scenario/scenario-types.js';
// Runtime import; flow-invoker only imports TYPES from this module, so
// there is no runtime import cycle.
import { ownerEligibleForFlowAuthor, resolveFlowAssignments, type FlowAssignmentOptions } from './flow-invoker.js';

// ============================================================================
// Types
// ============================================================================

/** One trigger condition (structurally the plan condition mini-language). */
export interface FlowCondition {
  /** Dotted path, e.g. 'zone-a.temperature' or 'temperature'. */
  path: string;
  op: '==' | '!=' | '>' | '<' | '>=' | '<=';
  value: number | boolean | string;
}

/**
 * What starts a flow:
 *   - event:     an injected scenario/manual event (matched by
 *                eventType/zoneId/parameter when declared + conditions)
 *   - condition: edge-triggered environment predicate (false → true), with
 *                an optional sim-time cooldown between firings and an
 *                optional time-of-day active window (FEAT-01)
 *   - schedule:  sim-time schedule — one-shot (`atSimTimeSec`) and/or
 *                periodic (`everySimSec`, bounded by start/end), plus the
 *                FEAT-01 daily anchors: a time-of-day (`atTimeOfDaySec`)
 *                and/or an occupancy-relative anchor (`relativeToOccupancy`)
 */
export type FlowTrigger =
  | {
      kind: 'event';
      eventType?: string;
      zoneId?: string;
      parameter?: string;
      conditions?: FlowCondition[];
      /** Fix-44f: optional sim-time debounce (external feeds are chatty). */
      cooldownSimSec?: number;
    }
  | {
      kind: 'condition';
      zoneId: string;
      conditions: FlowCondition[];
      cooldownSimSec?: number;
      /**
       * T-107 (F10): false-side re-arm window in SIM seconds. A condition
       * that flickers around its threshold (atrium 26.01 °C vs an Overheat
       * Guard at 26) produces a rising edge after every brief false dip —
       * measured 4 retriggers/day. With hysteresisSimC set, a false period
       * shorter than the window does NOT re-arm the edge: the next true is
       * treated as a continuation, not a new trigger. Distinct from
       * cooldownSimSec (which suppresses fires AFTER a fire regardless of
       * what the predicate did in between).
       */
      hysteresisSimC?: number;
      /**
       * FEAT-01: time-of-day active window [startSec, endSec) in sim
       * seconds-of-day (0..86400). start > end crosses midnight
       * (22:00–06:00 = [79200, 21600]). The window FOLDS INTO the edge
       * predicate — outside the window the trigger reads false, so a
       * predicate already true when the window opens produces the rising
       * edge at window open, and physics noise outside the window (dorm-life
       * 凌晨 power wobble) can never fire the flow. start === end is a
       * validation error (an empty window would silently never fire).
       */
      activeWindowSimSec?: [number, number];
    }
  | {
      kind: 'schedule';
      atSimTimeSec?: number;
      everySimSec?: number;
      startAtSimTimeSec?: number;
      endAtSimTimeSec?: number;
      /**
       * FEAT-01: daily time-of-day anchor in sim seconds-of-day
       * (0 ≤ v < 86400; 84600 = 23:30). Fires once per sim day when the
       * (prev, cur] tick window crosses day*86400 + atTimeOfDaySec — the
       * "每天 23:30 就寝" shape that used to require hand-computing absolute
       * sim seconds per day.
       */
      atTimeOfDaySec?: number;
      /**
       * FEAT-01: occupancy-relative daily anchor — fires `offsetSec` BEFORE
       * the named occupantSchedule boundary ('arrive' = startSimTimeSec,
       * 'depart' = endSimTimeSec) each sim day, e.g. "到馆前 30 分钟预冷" =
       * { before: 'arrive', offsetSec: 1800 }. `zoneId` pins the source
       * zone; omitted = every zone with an occupantSchedule (one firing per
       * zone per boundary per day). The engine resolves the boundaries from
       * the scenario's occupantSchedules (the same prediction table
       * due-moments enumerates).
       */
      relativeToOccupancy?: {
        zoneId?: string;
        before: 'arrive' | 'depart';
        offsetSec: number;
      };
    };

/**
 * Mechanism D (design-mixed-initiative-flows.md §5.2): one declared input of
 * a flow's parameter surface. Flows had triggers but no function signature —
 * `inputs` IS that signature: a closed list of named, typed parameters with
 * optional default / enum / min / max, consumable by manual runs, scenario
 * JSON defaults, and flow-services (the service interface is generated FROM
 * it).
 */
export interface FlowInputSpec {
  /** Parameter name (^[A-Za-z_][\w-]*$, same segment rule as guard keys). */
  name: string;
  type: 'number' | 'string' | 'boolean';
  /** Caller must supply a value (a declared default satisfies it). */
  required?: boolean;
  /** Value used when the caller omits the parameter. */
  default?: number | string | boolean;
  /** number-only inclusive lower bound. */
  min?: number;
  /** number-only inclusive upper bound. */
  max?: number;
  /** Allowed values (string/number types; meaningless for boolean). */
  enum?: Array<number | string>;
}

/**
 * Mechanism C (design-mixed-initiative-flows.md §7): the flow-level policy
 * envelope — bounds ALL agent activity inside this one flow, whatever entry
 * point fired it (trigger, manual, service, agent). The envelope slots into
 * the decisionPolicy precedence chain at the FLOW tier: sim-level option >
 * FLOW ENVELOPE > per-agent decisionPolicy > platform default — and like
 * every tier above default it can only RESTRICT (an envelope never grants
 * actuation the operator or agent policy forbade).
 */
export interface FlowPolicyEnvelope {
  /**
   * Delegate-node execution cap per RUN. Delegate nodes beyond the cap refuse
   * before consulting the LLM (zero model cost) and take their deterministic
   * fallback, exactly like the other honest degradation paths.
   */
  maxDelegationsPerRun?: number;
  /**
   * Confidence gate for ACTUATING delegates (0–1). An answer whose confidence
   * is below the threshold — or that carries no usable confidence at all —
   * refuses every actuation (each with a recorded reason); the judgment and
   * its confidence are still recorded honestly and the flow continues on the
   * advice semantics, like autoActuateIndependent=false.
   */
  minConfidenceToActuate?: number;
  /**
   * What exhaustion of maxDelegationsPerRun does beyond the per-node
   * fallback: 'fallback' (default) is silent — the run record already
   * carries each refusal; 'escalate' ADDITIONALLY signals the owner through
   * the existing notification face (escalation only signals, it never
   * modifies the flow body).
   */
  onBudgetExhausted?: 'fallback' | 'escalate';
  /**
   * Escalation delivery (v1: notification to the environment owner). Only
   * read when onBudgetExhausted === 'escalate'.
   */
  escalate?: { channel: 'notification'; toRole: 'owner' };
}

/** A complete user-authored flow definition. */
export interface FlowDefinition {
  id: string;
  name: string;
  description?: string;
  /** Disabled flows are validated but never fire. */
  enabled: boolean;
  /**
   * Owning tenant of the flow (T-201). SERVER-STAMPED (from the
   * authenticated caller / `flows.created_by`), never client-suppliable.
   * When set, assignment resolution considers ONLY agents owned by this
   * user (`ScenarioAgent.ownerUserId`); the env owner's flows omit the
   * stamp and keep unrestricted (governance-principal) semantics, as do
   * file-scenario flows.
   */
  authorUserId?: string;
  trigger: FlowTrigger;
  /**
   * Mechanism D: the flow's parameter surface. OMITTED = the flow declares
   * no surface (pre-D behavior — runs take no params, and the flow cannot
   * be published as a service). An EMPTY array is a valid zero-arg
   * signature.
   */
  inputs?: FlowInputSpec[];
  /**
   * Mechanism C: the per-flow policy envelope (see FlowPolicyEnvelope).
   * OMITTED = no envelope (pre-C behavior — nothing in the flow is bounded
   * beyond the standing gates).
   */
  policy?: FlowPolicyEnvelope;
  /**
   * Mechanism B: agents in the flow author's T-201 scope may name this flow
   * in a handle_independently decision and have it executed as a governed
   * action (triggerKind 'agent'). DEFAULT OFF — flows are opt-in tools.
   */
  agentInvocable?: boolean;
  /** The plan to run; node ids/capabilities follow plan-schema rules. */
  plan: {
    goal: string;
    nodes: PlanNode[];
  };
}

/**
 * Mechanism B: ONE flow offered to an agent's decision surface — the honest
 * tool listing (only flows the agent may actually invoke reach the LLM
 * prompt; anything else the model names is refused at the gate with
 * teaching). `inputs` rides along so the listing documents the invocation
 * contract (names/types/bounds) instead of advertising a bare id.
 */
export interface InvocableFlowOffering {
  flowId: string;
  name: string;
  description?: string;
  /** The flow's declared input surface (omitted = zero-arg invocation). */
  inputs?: FlowInputSpec[];
}

// ============================================================================
// JSON schema (ajv shape validation; also the wire contract for server/CLI)
// ============================================================================

const nonEmptyString = { type: 'string', minLength: 1 } as const;

/** Same segment rule as the plan condition mini-language (plan-schema.ts). */
const CONDITION_PATH_PATTERN = '^[A-Za-z_][\\w-]*(?:\\.[A-Za-z_][\\w-]*)*$';

const flowConditionSchema = {
  type: 'object',
  required: ['path', 'op', 'value'],
  additionalProperties: false,
  properties: {
    path: { type: 'string', pattern: CONDITION_PATH_PATTERN },
    op: { type: 'string', enum: ['==', '!=', '>', '<', '>=', '<='] },
    value: { type: ['number', 'boolean', 'string'] },
  },
} as const;

/** Shared onFail subschema (identical semantics on action and delegate nodes). */
const planNodeOnFailSchema = {
  type: 'object',
  required: ['policy'],
  additionalProperties: false,
  properties: {
    policy: { type: 'string', enum: ['abort', 'retry', 'compensate'] },
    retries: { type: 'integer', minimum: 0, maximum: 10 },
    compensateNodeId: nonEmptyString,
  },
} as const;

/**
 * R6-B-F03: the strict sub-schema for a SERVICE node's target block. Closed
 * like the delegate block; ref-shape semantics (exactly one of serviceId /
 * semanticType) live in validateServiceNodes for a teaching message instead
 * of an ajv anyOf riddle.
 */
const planNodeServiceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    serviceId: nonEmptyString,
    semanticType: nonEmptyString,
    action: nonEmptyString,
  },
} as const;

/**
 * FEAT-05: the strict sub-schema for a NOTIFY node's target block. Closed
 * like the delegate block; the per-`to` target rules (agent id / env role /
 * none) live in validateNotifyNodes for a teaching message instead of an
 * ajv riddle.
 */
const planNodeNotifySchema = {
  type: 'object',
  required: ['to', 'message'],
  additionalProperties: false,
  properties: {
    to: { type: 'string', enum: ['agent', 'role', 'owner'] },
    target: nonEmptyString,
    message: nonEmptyString,
  },
} as const;

/** FEAT-06: the strict sub-schema for a WAIT node (sim-clock delay). */
const planNodeWaitSchema = {
  type: 'object',
  required: ['simSec'],
  additionalProperties: false,
  properties: {
    simSec: { type: 'number', exclusiveMinimum: 0 },
  },
} as const;

/**
 * Mechanism A (mixed-initiative flows): plan-node shape — the union of the
 * ACTION shape (capability + params + optional deviceId), the DELEGATE
 * shape (a `delegate` block), — R6-B-F03 — the SERVICE shape (a `service`
 * block: an agreement-mediated call to another tenant's published
 * service), — FEAT-05 — the NOTIFY shape (a `notify` block: a message to a
 * user's inbox through the host notification pipeline) and — FEAT-06 — the
 * WAIT shape (a `wait` block: a deterministic sim-clock delay). The
 * variants' mutual exclusion is enforced by validateFlow's teaching
 * pre-check (one precise message beats ajv's cryptic "must match exactly
 * one schema in oneOf"); the sub-objects are strictly closed
 * (additionalProperties: false) so typos inside them fail loudly with an
 * exact path. All four non-action variants are FLOW-ONLY —
 * PLAN_JSON_SCHEMA never accepts them (design §8.5.1: no free agent
 * judgment, no contract-mediated calls, no host-pipeline side effects and
 * no sim-clock waits embedded in LLM-synthesized plans).
 */
const planNodeSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    capability: nonEmptyString,
    assigneeAgentId: nonEmptyString,
    /** T-201: pin the node to ONE device (see PlanNode.deviceId). */
    deviceId: nonEmptyString,
    /**
     * R1 (B1-8 / P-17): explicit cross-zone actuation — the node declares
     * it intentionally reaches outside the trigger zone; both the authoring
     * zone check and the runtime invoker honor it. See PlanNode.crossZone.
     */
    crossZone: { type: 'boolean' },
    params: { type: 'object' },
    dependsOn: { type: 'array', items: nonEmptyString },
    condition: nonEmptyString,
    onFail: planNodeOnFailSchema,
    delegate: {
      type: 'object',
      required: ['question', 'mode'],
      additionalProperties: false,
      properties: {
        question: nonEmptyString,
        mode: { type: 'string', enum: ['advice', 'actuating'] },
        budget: {
          type: 'object',
          required: ['maxCommands', 'deviceIds', 'allowedCommands'],
          additionalProperties: false,
          properties: {
            maxCommands: { type: 'integer', minimum: 1 },
            deviceIds: { type: 'array', minItems: 1, items: nonEmptyString },
            allowedCommands: { type: 'array', minItems: 1, items: nonEmptyString },
          },
        },
        outputs: {
          type: 'array',
          items: { type: 'string', pattern: '^[A-Za-z_][\\w-]*$' },
        },
        timeoutMs: { type: 'number', exclusiveMinimum: 0 },
        fallback: {
          oneOf: [
            {
              type: 'object',
              required: ['policy'],
              additionalProperties: false,
              properties: { policy: { const: 'none' } },
            },
            {
              type: 'object',
              required: ['policy', 'nodeId'],
              additionalProperties: false,
              properties: { policy: { const: 'node' }, nodeId: nonEmptyString },
            },
          ],
        },
      },
    },
    /** R6-B-F03: agreement-mediated service target (see PlanServiceSpec). */
    service: planNodeServiceSchema,
    /** FEAT-05: notification-lane target (see PlanNotifySpec). */
    notify: planNodeNotifySchema,
    /** FEAT-06: sim-clock wait (see PlanWaitSpec). */
    wait: planNodeWaitSchema,
  },
} as const;

/**
 * Mechanism D: the strict sub-schema for one declared input. Closed like the
 * rest of FLOW_JSON_SCHEMA — a typo'd key (e.g. `requried`) fails loudly with
 * an exact path instead of being silently dropped.
 */
const flowInputSchema = {
  type: 'object',
  required: ['name', 'type'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', pattern: '^[A-Za-z_][\\w-]*$' },
    type: { type: 'string', enum: ['number', 'string', 'boolean'] },
    required: { type: 'boolean' },
    default: { type: ['number', 'string', 'boolean'] },
    min: { type: 'number' },
    max: { type: 'number' },
    // Booleans are accepted here so the SEMANTIC pass can teach ("a boolean
    // is already closed") instead of a bare schema path error.
    enum: { type: 'array', minItems: 1, items: { type: ['number', 'string', 'boolean'] } },
  },
} as const;

/**
 * Mechanism C: the strict sub-schema for the per-flow policy envelope. Closed
 * like the rest of FLOW_JSON_SCHEMA — a typo'd key (e.g. `onBudgetExausted`)
 * fails loudly with an exact path instead of being silently dropped.
 */
const flowPolicySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxDelegationsPerRun: { type: 'integer', minimum: 1 },
    minConfidenceToActuate: { type: 'number', minimum: 0, maximum: 1 },
    onBudgetExhausted: { type: 'string', enum: ['fallback', 'escalate'] },
    escalate: {
      type: 'object',
      required: ['channel', 'toRole'],
      additionalProperties: false,
      properties: {
        channel: { type: 'string', enum: ['notification'] },
        toRole: { type: 'string', enum: ['owner'] },
      },
    },
  },
} as const;

/**
 * Draft-07 JSON schema for FlowDefinition. Strict (additionalProperties:
 * false) like PLAN_JSON_SCHEMA: flows are machine-checked user artifacts,
 * not LLM output, so silent field typos should fail loudly.
 */
export const FLOW_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['id', 'name', 'enabled', 'trigger', 'plan'],
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    name: nonEmptyString,
    description: { type: 'string' },
    enabled: { type: 'boolean' },
    /**
     * T-201: server-stamped flow authorship (omitted = unrestricted). The
     * schema ACCEPTS it so stored/rehydrated definitions round-trip, but
     * server routes never take it from a request body.
     */
    authorUserId: nonEmptyString,
    /** Mechanism D: the parameter surface (see FlowInputSpec). */
    inputs: { type: 'array', items: flowInputSchema },
    /** Mechanism C: the per-flow policy envelope (see FlowPolicyEnvelope). */
    policy: flowPolicySchema,
    /** Mechanism B: agent-invocation opt-in (default off). */
    agentInvocable: { type: 'boolean' },
    trigger: {
      oneOf: [
        {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { const: 'event' },
            eventType: nonEmptyString,
            zoneId: nonEmptyString,
            parameter: nonEmptyString,
            conditions: { type: 'array', items: flowConditionSchema },
            cooldownSimSec: { type: 'number', minimum: 0 },
          },
        },
        {
          type: 'object',
          required: ['kind', 'zoneId', 'conditions'],
          additionalProperties: false,
          properties: {
            kind: { const: 'condition' },
            zoneId: nonEmptyString,
            conditions: { type: 'array', minItems: 1, items: flowConditionSchema },
            cooldownSimSec: { type: 'number', minimum: 0 },
            hysteresisSimC: { type: 'number', minimum: 0 },
            /** FEAT-01: time-of-day active window [start, end) (see FlowTrigger). */
            activeWindowSimSec: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: { type: 'number', minimum: 0, maximum: 86400 },
            },
          },
        },
        {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { const: 'schedule' },
            atSimTimeSec: { type: 'number', minimum: 0 },
            everySimSec: { type: 'number', exclusiveMinimum: 0 },
            startAtSimTimeSec: { type: 'number', minimum: 0 },
            endAtSimTimeSec: { type: 'number', minimum: 0 },
            /** FEAT-01: daily time-of-day anchor (sim seconds-of-day). */
            atTimeOfDaySec: { type: 'number', minimum: 0, exclusiveMaximum: 86400 },
            /** FEAT-01: occupancy-relative daily anchor (see FlowTrigger). */
            relativeToOccupancy: {
              type: 'object',
              required: ['before', 'offsetSec'],
              additionalProperties: false,
              properties: {
                zoneId: nonEmptyString,
                before: { type: 'string', enum: ['arrive', 'depart'] },
                offsetSec: { type: 'number', minimum: 0 },
              },
            },
          },
        },
      ],
    },
    plan: {
      type: 'object',
      required: ['goal', 'nodes'],
      additionalProperties: false,
      properties: {
        goal: nonEmptyString,
        nodes: { type: 'array', minItems: 1, items: planNodeSchema },
      },
    },
  },
};

let compiledFlowShapeValidator: ValidateFunction | null = null;

function getFlowShapeValidator(): ValidateFunction {
  if (!compiledFlowShapeValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    compiledFlowShapeValidator = ajv.compile(FLOW_JSON_SCHEMA);
  }
  return compiledFlowShapeValidator;
}

// ============================================================================
// Condition evaluation
// ============================================================================

/**
 * Evaluate one FlowCondition against an environment snapshot (the same
 * `{ zoneId: { param: value } }` shape the plan executor reads). Never
 * throws; an unresolvable path is treated as false (conservative, matching
 * the executor's guard semantics).
 */
export function evaluateFlowCondition(
  condition: FlowCondition,
  snapshot: Record<string, unknown>,
): boolean {
  return evaluatePlanCondition(condition, snapshot).result === true;
}

/** AND-combine a condition list; an empty/undefined list is vacuously true. */
export function evaluateFlowConditions(
  conditions: FlowCondition[] | undefined,
  snapshot: Record<string, unknown>,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(c => evaluateFlowCondition(c, snapshot));
}

/**
 * T-061: per-condition evaluation detail — path, operator, threshold AND the
 * value the path resolved to (undefined when unresolvable). Threshold
 * authoring stops being guesswork when the run trace shows what the
 * condition actually saw (e.g. a custom baseline quantity's current value)
 * next to the threshold it was compared against.
 */
export interface FlowConditionEvaluation {
  path: string;
  op: FlowCondition['op'];
  /** The declared threshold literal. */
  threshold: number | boolean | string;
  /** Value the path resolved to at evaluation time; absent when unresolvable. */
  evaluatedValue?: unknown;
  /** Comparison verdict (false when unresolvable — same conservative rule). */
  met: boolean;
  /** Why the path could not be resolved, when it could not. */
  unresolvedReason?: string;
}

/** Evaluate every condition WITH its detail (T-061). Never throws. */
export function describeFlowConditions(
  conditions: FlowCondition[] | undefined,
  snapshot: Record<string, unknown>,
): FlowConditionEvaluation[] {
  if (!conditions || conditions.length === 0) return [];
  return conditions.map(condition => {
    const evaluation = evaluatePlanCondition(condition, snapshot);
    return {
      path: condition.path,
      op: condition.op,
      threshold: condition.value,
      ...(evaluation.resolvedValue !== undefined || evaluation.result !== undefined
        ? { evaluatedValue: evaluation.resolvedValue }
        : {}),
      met: evaluation.result === true,
      ...(evaluation.unresolvedReason ? { unresolvedReason: evaluation.unresolvedReason } : {}),
    };
  });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * T-078 (DevLoop R23): one prompt-injection flag on a flow's TEXT surface.
 *
 * Policy ruling this encodes: flows stay DIRECT-AUTHORED by builders — the
 * T-201 author scoping IS the safety model (a flow can only drive its
 * author's own agents/devices; breadth is bounded by ownership; zone
 * containment + delegate budgets + the Mechanism C envelope bound the rest).
 * A proposal lane would duplicate governance without adding safety. The ONE
 * real S1 gap was that flow text never passed the injection detector even
 * though it can reach OTHER viewers' LLM prompts (agent-invocable offerings,
 * flow-service interfaces, adopt-config payloads into the reviewer prompt,
 * delegate questions into the assignee's prompt). This scan closes that
 * dimension: a trip does NOT reject (flows are legitimate expressions and
 * the pattern table false-positives on operational language), it FLAGS the
 * flow so every governance surface it reaches can force human review.
 */
export interface FlowSecurityFlag {
  /** Where the flagged text lives ('name' | 'description' | 'plan.goal' | node-scoped delegate-question label). */
  field: string;
  /** Canonical detector marker id (e.g. 'instruction-override'). */
  marker: string;
  /** First matched span (already capped by the detector) — for audits. */
  evidence: string;
}

/** Bounded flag list: a hostile flow cannot flood audits with markers. */
const FLOW_SECURITY_FLAG_CAP = 12;

/**
 * Run the canonical prompt-injection detector over the flow's text surface —
 * exactly the fields that can end up inside ANOTHER viewer's LLM prompt:
 * name/description (offerings + service interfaces), plan.goal, and every
 * delegate node's question (the author-owned prompt the assignee's LLM is
 * asked). Pure, never throws; non-string fields carry no flags. Returns []
 * for clean text.
 *
 * Deliberately DERIVED (not persisted): the flag is a pure function of the
 * flow text and the ONE shared pattern table, so extending the detector
 * re-flags existing flows automatically and the verdict can never drift
 * from the sanitizer that guards the same text downstream.
 */
export function securityFlagsForFlow(flow: unknown): FlowSecurityFlag[] {
  const flags: FlowSecurityFlag[] = [];
  const record = (field: string, text: unknown): void => {
    if (flags.length >= FLOW_SECURITY_FLAG_CAP) return;
    for (const marker of detectPromptInjection(text)) {
      flags.push({ field, marker: marker.id, evidence: marker.evidence });
      if (flags.length >= FLOW_SECURITY_FLAG_CAP) return;
    }
  };
  const def = flow as {
    name?: unknown;
    description?: unknown;
    plan?: { goal?: unknown; nodes?: Array<{ id?: unknown; delegate?: { question?: unknown } }> };
  } | null | undefined;
  if (def === null || typeof def !== 'object') return flags;
  record('name', def.name);
  record('description', def.description);
  record('plan.goal', def.plan?.goal);
  for (const node of def.plan?.nodes ?? []) {
    if (node === null || typeof node !== 'object') continue;
    const nodeId = typeof node.id === 'string' && node.id.length > 0 ? node.id : '(unnamed node)';
    record(`delegate question (node '${nodeId}')`, node.delegate?.question);
  }
  return flags;
}

/**
 * The flagging pass expressed as a validateFlow WARNING (T-078): warnings
 * pass the 422 gate — the flow is a legitimate expression — but the flag
 * rides the issue list and the API response's derived `securityFlags`
 * field, and every governance surface that consumes flagged flows (the
 * adopt-config rule check's force-escalate hook) keys off the same scan.
 */
function validateFlowSecurityText(flow: FlowDefinition): PlanIssue[] {
  const flags = securityFlagsForFlow(flow);
  if (flags.length === 0) return [];
  const shown = flags
    .slice(0, 4)
    .map(flag => `${flag.field}: [${flag.marker}]`)
    .join('; ');
  const more = flags.length > 4 ? ` (+${flags.length - 4} more)` : '';
  return [
    {
      level: 'warning',
      message:
        `securityFlags: flow text carries prompt-injection markers (${shown}${more}) — the flow is ` +
        'NOT rejected (flows are legitimate expressions and the detector can false-positive on ' +
        'operational language), but it is flagged: wherever this flow surfaces into governance ' +
        '(adopt-config promotion, service surfaces) human review is forced, and the flagged text ' +
        'is neutralized inside every LLM prompt that embeds it',
    },
  ];
}

/**
 * T78 (R8, u4-P1-3 / u3-P2-F5): the ONE ghost-event-type warning — an event
 * trigger naming a type this world's scenario never declares. The inject
 * lane (routes/simulations.ts) warns on the same condition; authoring and
 * read faces consume THIS helper so every face speaks one oracle and one
 * wording. `undefined` = nothing to warn about (non-event trigger, shape-only
 * validation without a declaration table, or a declared type).
 */
export function undeclaredEventTypeWarning(
  trigger: FlowTrigger,
  scenario: ScenarioDefinition | undefined,
): string | undefined {
  if (scenario === undefined || trigger.kind !== 'event') return undefined;
  // An event trigger with NO eventType matches every type — nothing to warn.
  if (typeof trigger.eventType !== 'string' || trigger.eventType.length === 0) return undefined;
  const declared = new Set(scenario.events.map(event => event.type));
  if (declared.has(trigger.eventType)) return undefined;
  return (
    `unrecognized event type "${trigger.eventType}": this world's scenario never declares it — ` +
    'the flow may never fire unless that type is injected at runtime (POST /api/simulations/:id/events); ' +
    `this world declares: ${[...declared].slice(0, 8).join(', ') || '(no events declared)'}`
  );
}

/**
 * Validate a flow definition: JSON shape (ajv), trigger semantics the
 * schema cannot express, condition parseability (same mini-language as
 * plan conditions), and plan shape + semantics (the same compiler pass a
 * synthesized plan goes through). When `scenario` is given, plan-node
 * assignments are additionally checked for satisfiability against the
 * scenario's agents/devices (see flow-invoker.resolveFlowAssignments).
 *
 * T-002: pass `options.isExecutableCapability` (the host app injects the
 * simulation package's `isCapabilityExecutable`) and assignment
 * satisfiability additionally requires an EXECUTABLE device path — a bound
 * device that lands the capability on a registered command handler.
 * Without the oracle, a declared capability is assumed executable (legacy
 * behavior for core-only consumers).
 *
 * Returns issues only — never throws. Errors block execution; warnings
 * (e.g. ambiguous auto-assignment) do not.
 */
export function validateFlow(
  flow: unknown,
  scenario?: ScenarioDefinition,
  options?: FlowAssignmentOptions,
): PlanIssue[] {
  const issues: PlanIssue[] = [];

  // Mechanism A + R6-B-F03 + FEAT-05/06: action/delegate/service/notify/wait
  // mutual exclusion, checked BEFORE ajv so the author gets a teaching
  // message instead of "must match exactly one schema in oneOf" (the
  // standing silent-field-dropping trap, inverted: loud AND explained).
  const rawNodes = (flow as { plan?: { nodes?: unknown[] } } | null)?.plan?.nodes;
  if (Array.isArray(rawNodes)) {
    for (const node of rawNodes) {
      if (node === null || typeof node !== 'object') continue;
      const { id, capability, delegate, service, notify, wait, params, deviceId, assigneeAgentId } = node as {
        id?: unknown; capability?: unknown; delegate?: unknown; service?: unknown;
        notify?: unknown; wait?: unknown;
        params?: unknown; deviceId?: unknown; assigneeAgentId?: unknown;
      };
      const nodeId = typeof id === 'string' && id.length > 0 ? id : '(unnamed node)';
      const kinds = [
        capability !== undefined ? 'capability (action node)' : undefined,
        delegate !== undefined ? 'delegate (delegate node)' : undefined,
        service !== undefined ? 'service (service node)' : undefined,
        notify !== undefined ? 'notify (notify node)' : undefined,
        wait !== undefined ? 'wait (wait node)' : undefined,
      ].filter((kind): kind is string => kind !== undefined);
      if (kinds.length > 1) {
        issues.push({
          level: 'error',
          nodeId,
          message:
            `node '${nodeId}' carries ${kinds.join(' + ')} — a node is EXACTLY ONE of: an action node ` +
            '(capability + params + optional deviceId, actuating the author\'s own devices), a delegate node ' +
            '(delegate question/budget), a service node (service {serviceId|semanticType, action?}, an ' +
            'agreement-mediated call to another tenant\'s published service), a notify node ' +
            '(notify {to, target?, message}, a message to a user inbox), or a wait node ' +
            '(wait {simSec}, a deterministic sim-clock delay); split the concerns into separate nodes',
        });
      } else if (delegate !== undefined) {
        // Delegate nodes must not carry action-only fields (they would be
        // silently meaningless — the delegate's actuations are budget-driven,
        // not node params).
        const stray: string[] = [];
        if (params !== undefined) stray.push('params');
        if (deviceId !== undefined) stray.push('deviceId');
        if (stray.length > 0) {
          issues.push({
            level: 'error',
            nodeId,
            message:
              `delegate node '${nodeId}' carries action-only field(s) ${stray.map(f => `'${f}'`).join(', ')} — ` +
              "a delegate node's device scope lives in delegate.budget.deviceIds; remove the stray field(s)",
          });
        }
      } else if (service !== undefined) {
        // R6-B-F03: service nodes carry params (the invocation params) but no
        // routing fields — the AGREEMENT resolves the provider's backing
        // device/flow; pinning an assignee or device would be silently
        // meaningless (the standing trap, refused loudly).
        const stray: string[] = [];
        if (deviceId !== undefined) stray.push('deviceId');
        if (assigneeAgentId !== undefined) stray.push('assigneeAgentId');
        if (stray.length > 0) {
          issues.push({
            level: 'error',
            nodeId,
            message:
              `service node '${nodeId}' carries field(s) ${stray.map(f => `'${f}'`).join(', ')} — ` +
              'a service node never addresses the provider\'s internals: the active agreement\'s terms ' +
              '(action/backing) decide what executes; remove the stray field(s) and keep service + params only',
          });
        }
      } else if (notify !== undefined) {
        // FEAT-05: notify nodes address USERS through the notification
        // pipeline — capability params / device pins / assignees would be
        // silently meaningless (the standing trap, refused loudly).
        const stray: string[] = [];
        if (params !== undefined) stray.push('params');
        if (deviceId !== undefined) stray.push('deviceId');
        if (assigneeAgentId !== undefined) stray.push('assigneeAgentId');
        if (stray.length > 0) {
          issues.push({
            level: 'error',
            nodeId,
            message:
              `notify node '${nodeId}' carries field(s) ${stray.map(f => `'${f}'`).join(', ')} — ` +
              'a notify node only delivers a message to user inboxes (notify {to, target?, message}); ' +
              'remove the stray field(s) — device actuation is a separate action node',
          });
        }
      } else if (wait !== undefined) {
        // FEAT-06: wait nodes are pure sim-clock delays — no capability,
        // device or assignee is ever consulted.
        const stray: string[] = [];
        if (params !== undefined) stray.push('params');
        if (deviceId !== undefined) stray.push('deviceId');
        if (assigneeAgentId !== undefined) stray.push('assigneeAgentId');
        if (stray.length > 0) {
          issues.push({
            level: 'error',
            nodeId,
            message:
              `wait node '${nodeId}' carries field(s) ${stray.map(f => `'${f}'`).join(', ')} — ` +
              'a wait node is a deterministic sim-clock delay (wait {simSec}) and never addresses ' +
              'devices or agents; remove the stray field(s)',
          });
        }
      } else if (capability === undefined) {
        issues.push({
          level: 'error',
          nodeId,
          message:
            `node '${nodeId}' carries none of 'capability', 'delegate', 'service', 'notify' or 'wait' — ` +
            'action nodes need a capability (e.g. "cooling"); judgment steps need a delegate block ' +
            '{question, mode}; calling another tenant\'s published service needs a service block ' +
            '{serviceId|semanticType, action?}; messaging a user needs a notify block {to, target?, message}; ' +
            'a deterministic delay needs a wait block {simSec}',
        });
      }
    }
    if (issues.some(i => i.level === 'error')) return issues;
  }

  const validator = getFlowShapeValidator();
  const shapeValid = validator(flow);
  if (!shapeValid) {
    for (const err of validator.errors ?? []) {
      // instancePath like "/plan/nodes/2/capability" → node index 2
      let nodeId: string | undefined;
      const nodeMatch = err.instancePath.match(/^\/plan\/nodes\/(\d+)(\/|$)/);
      const nodes = (flow as { plan?: { nodes?: unknown[] } } | null)?.plan?.nodes;
      if (nodeMatch && Array.isArray(nodes)) {
        const node = (nodes as Array<{ id?: unknown }>)[Number(nodeMatch[1])];
        nodeId = typeof node?.id === 'string' ? node.id : `plan.nodes[${nodeMatch[1]}]`;
      }
      const path = err.instancePath || '/';
      issues.push({
        level: 'error',
        ...(nodeId ? { nodeId } : {}),
        message: `schema: ${path} ${err.message ?? 'invalid'}`,
      });
    }
    return issues; // shape failure: semantic checks would be meaningless
  }

  const def = flow as FlowDefinition;

  // --- T-078: prompt-injection flag pass over the flow's text surface ---
  // (A warning, never an error — see securityFlagsForFlow.)
  issues.push(...validateFlowSecurityText(def));

  // --- T-090 (R28): delegate-question open-endedness lint ---
  issues.push(...validateDelegateQuestions(def));
  // --- T-108 (R32, F16): advice-guard degradation teaching ---
  issues.push(...validateAdviceGuardDegradation(def));

  // --- Trigger semantics beyond JSON shape ---
  if (def.trigger.kind === 'schedule') {
    const t = def.trigger;
    if (
      t.atSimTimeSec === undefined && t.everySimSec === undefined &&
      t.atTimeOfDaySec === undefined && t.relativeToOccupancy === undefined
    ) {
      issues.push({
        level: 'error',
        message:
          "schedule trigger requires at least one of 'atSimTimeSec', 'everySimSec', " +
          "'atTimeOfDaySec' or 'relativeToOccupancy'",
      });
    }
    if (
      t.startAtSimTimeSec !== undefined && t.endAtSimTimeSec !== undefined &&
      t.endAtSimTimeSec < t.startAtSimTimeSec
    ) {
      issues.push({
        level: 'error',
        message: `schedule trigger: endAtSimTimeSec (${t.endAtSimTimeSec}) < startAtSimTimeSec (${t.startAtSimTimeSec})`,
      });
    }
    // FEAT-01: the occupancy-relative anchor only fires when an occupantSchedule
    // exists to anchor to — a pinned zone must exist and carry one; an
    // unanchored world is a warning (the flow silently never fires otherwise).
    const rel = t.relativeToOccupancy;
    if (rel !== undefined && scenario !== undefined) {
      if (rel.zoneId !== undefined) {
        const zone = scenario.zones.find(z => z.id === rel.zoneId);
        if (zone === undefined) {
          issues.push({
            level: 'error',
            message:
              `relativeToOccupancy zoneId '${rel.zoneId}' does not exist in scenario '${scenario.meta.id}' ` +
              `(known zones: ${scenario.zones.slice(0, 5).map(z => z.id).join(', ')}${scenario.zones.length > 5 ? ', …' : ''})`,
          });
        } else if (zone.occupantSchedule === undefined) {
          issues.push({
            level: 'error',
            message:
              `relativeToOccupancy zoneId '${rel.zoneId}' has no occupantSchedule — the anchor has no ` +
              'boundary to fire relative to; declare occupantSchedule on the zone or pick another zone',
          });
        }
      } else if (!scenario.zones.some(z => z.occupantSchedule !== undefined)) {
        issues.push({
          level: 'warning',
          message:
            'relativeToOccupancy names no zoneId and no zone in this scenario declares an occupantSchedule — ' +
            'the flow will never fire; add occupantSchedule to a zone or pin zoneId',
        });
      }
    }
  }
  if (def.trigger.kind === 'condition' && def.trigger.activeWindowSimSec !== undefined) {
    const [start, end] = def.trigger.activeWindowSimSec;
    if (start === end) {
      issues.push({
        level: 'error',
        message:
          `condition trigger: activeWindowSimSec start === end (${start}) is an empty window that never ` +
          'opens — use distinct bounds (start > end crosses midnight, e.g. [79200, 21600] = 22:00–06:00)',
      });
    }
  }

  // --- Condition parseability (same mini-language as plan conditions) ---
  const conditions: FlowCondition[] =
    def.trigger.kind === 'event'
      ? def.trigger.conditions ?? []
      : def.trigger.kind === 'condition'
        ? def.trigger.conditions
        : [];
  for (const condition of conditions) {
    // FlowCondition is already structured; verify it round-trips through the
    // plan condition mini-language so engine and validator share semantics.
    const literal =
      typeof condition.value === 'string' ? JSON.stringify(condition.value) : String(condition.value);
    const parsed = parsePlanCondition(`${condition.path} ${condition.op} ${literal}`);
    if (!parsed) {
      issues.push({
        level: 'error',
        message: `condition '${condition.path} ${condition.op} ${literal}' is not parseable in the condition mini-language`,
      });
    }
  }

  // --- T-606 (R26, SC26-F02): non-blocking condition-path lint ---
  // A path whose final segment is neither a standard snapshot parameter nor
  // any zone's DECLARED baseline key only exists if something INJECTS it at
  // runtime (POST /api/simulations/:id/events parameter field; the runtime
  // unions injection-written names into the condition snapshot). Runtime
  // injection is a legal authoring pattern — this round proved it — so it
  // is a WARNING, never a 422; declaring the key in a zone baseline makes
  // it structural. Scenario-gated (an empty world has no baseline truth).
  if (scenario !== undefined) {
    const known = new Set<string>(SNAPSHOT_PARAMETERS);
    known.add('occupancy');
    for (const zone of scenario.zones) {
      for (const key of Object.keys(zone.baseline ?? {})) known.add(key);
    }
    const linted = new Set<string>();
    for (const condition of conditions) {
      const name = condition.path.split('.').pop() ?? condition.path;
      if (known.has(name) || linted.has(name)) continue;
      linted.add(name);
      issues.push({
        level: 'warning',
        message:
          `condition path '${condition.path}' names neither a standard snapshot parameter nor a zone-baseline-declared key ` +
          '(temperature, humidity, light, motion, smoke, co2, pm2_5, occupancy, or any zone baseline key) — ' +
          'this parameter only exists if something injects it at runtime (POST /api/simulations/:id/events parameter field); ' +
          'declare it in a zone baseline to make it structural',
      });
    }
  }

  // --- T78 (R8, u4-P1-3 / u3-P2-F5): the ghost-event-type oracle ---
  // A trigger on an event type this world's scenario never declares is a
  // flow that looks armed and can never fire ("幽灵事件类型": the inject
  // lane warns on the same condition, the authoring lane said nothing). The
  // SAME oracle the inject lane speaks (the scenario's declared event
  // types); a WARNING, never a 422 — authoring for a type that will be
  // injected later is a legal pattern, the reader just deserves to know.
  // Scenario-gated (a shape-only validation has no declaration table).
  const ghostWarning = undeclaredEventTypeWarning(def.trigger, scenario);
  if (ghostWarning !== undefined) {
    issues.push({ level: 'warning', message: ghostWarning });
  }

  // --- Mechanism D: input-surface semantics + interpolation references ---
  issues.push(...validateFlowInputs(def));
  issues.push(...validateInputReferences(def));
  // Mechanism D follow-up (implemented with C): the self-trigger footgun —
  // a required-no-default input means every AUTO-triggered run honestly
  // fails the engine's param gate (never a silent substitution).
  issues.push(...validateSelfTriggerInputs(def));

  // --- Mechanism C: policy-envelope semantics ---
  issues.push(...validateFlowPolicy(def));

  // --- Mechanism B: agent-invocation flag semantics (scenario-gated) ---
  issues.push(...validateAgentInvocable(def, scenario));

  // --- Trigger zone existence (Fix-44k) ---
  // A dead zoneId in a condition/event trigger would only fail at runtime —
  // reject it at authoring time. T-305 (DevLoop R12): with a scenario in
  // hand the check names the scenario's zones (legacy behavior); WITHOUT
  // one, a caller-supplied knownZoneIds fallback (the REST authoring path
  // passes the env's mapData zones) keeps the check UNCONDITIONAL — an
  // empty world used to make the gate vacuous and bogus-zone flows 201'd.
  const triggerZoneId =
    def.trigger.kind === 'condition'
      ? def.trigger.zoneId
      : def.trigger.kind === 'event'
        ? def.trigger.zoneId
        : undefined;
  if (triggerZoneId !== undefined) {
    if (scenario !== undefined) {
      if (!scenario.zones.some(z => z.id === triggerZoneId)) {
        issues.push({
          level: 'error',
          message:
            `trigger zoneId '${triggerZoneId}' does not exist in scenario '${scenario.meta.id}' ` +
            `(known zones: ${scenario.zones.slice(0, 5).map(z => z.id).join(', ')}${scenario.zones.length > 5 ? ', …' : ''})`,
        });
      }
    } else if (options?.knownZoneIds !== undefined) {
      if (options.knownZoneIds.length === 0) {
        issues.push({
          level: 'error',
          message:
            `trigger zoneId '${triggerZoneId}' cannot be validated: this environment has no zones yet — ` +
            'create or import zones before authoring zone-triggered flows',
        });
      } else if (!options.knownZoneIds.includes(triggerZoneId)) {
        issues.push({
          level: 'error',
          message:
            `trigger zoneId '${triggerZoneId}' does not exist in this environment ` +
            `(known zones: ${options.knownZoneIds.slice(0, 5).join(', ')}${options.knownZoneIds.length > 5 ? ', …' : ''})`,
        });
      }
    }
  }

  // --- Plan shape + semantics (the standard compiler pass) ---
  // Mechanism A: delegate nodes are FLOW-ONLY and unknown to PLAN_JSON_SCHEMA
  // (LLM-synthesized plans may not embed judgment steps), so the SHAPE pass
  // runs over the action nodes only — delegate shapes were already checked
  // by FLOW_JSON_SCHEMA's strict variant above. R6-B-F03: service nodes are
  // FLOW-ONLY for the same reason (no contract-mediated calls in synthesized
  // plans) and join the same exclusion — FEAT-05/06: notify and wait nodes
  // too (no capability of their own; host-pipeline side effects and
  // sim-clock waits are never synthesized). SEMANTICS (duplicate ids, dependsOn
  // references, DAG acyclicity, guard parseability) run over the FULL node
  // list: all node variants participate in the DAG like any other node, and
  // an action node may legitimately dependOn any of them.
  //
  // Mechanism D: guard conditions must parse in their RUN form — a
  // '${input:x}' reference inside a condition string is substituted with a
  // type-appropriate SAMPLE (the default when declared) before the semantics
  // pass, so parseability is judged on exactly what the executor will see.
  const planDef = def.inputs !== undefined ? interpolateFlowInputs(def, sampleParamsFor(def.inputs)) : def;
  const delegateNodes = planDef.plan.nodes.filter(n => n.delegate !== undefined);
  const actionNodes = planDef.plan.nodes.filter(
    n =>
      n.delegate === undefined &&
      n.service === undefined &&
      n.notify === undefined &&
      n.wait === undefined,
  );
  // (FLOW_JSON_SCHEMA itself requires plan.nodes minItems 1, so an all-
  // delegate/all-service plan is legal — an EMPTY action partition must not
  // trip PLAN_JSON_SCHEMA's own minItems.)
  if (actionNodes.length > 0) {
    const actionPlan: WorkflowPlan = {
      id: def.id,
      goal: planDef.plan.goal,
      nodes: actionNodes,
      metadata: { author: 'manual', createdAt: 'validation' },
    };
    issues.push(...validatePlanShape(actionPlan));
  }
  const fullPlan: WorkflowPlan = {
    id: def.id,
    goal: planDef.plan.goal,
    nodes: planDef.plan.nodes,
    metadata: { author: 'manual', createdAt: 'validation' },
  };
  issues.push(...validatePlanSemantics(fullPlan));
  issues.push(...validateDelegateNodes(planDef, delegateNodes));
  issues.push(...validateServiceNodes(planDef));
  issues.push(...validateNotifyNodes(planDef, scenario));
  issues.push(...validateWaitNodes(planDef));

  // --- Assignment satisfiability against the scenario (optional) ---
  if (scenario !== undefined) {
    issues.push(...resolveFlowAssignments(def, scenario, options).issues);
  }

  // --- R1 (B1-8 / P-17): authoring/runtime zone parity for EVENT triggers
  // without a declared zoneId. The declared-zone cross-zone refusal above
  // already runs at authoring; what authoring could NOT see is the zone an
  // event will carry — the run scopes to (trigger.zoneId ?? event.zoneId),
  // so a pinned node outside the firing zone refuses mid-run. A WARNING at
  // authoring names that exact future failure (and the `crossZone: true`
  // declaration that makes the cross-zone intent explicit) instead of
  // leaving the config green until the fire drill.
  if (def.trigger.kind === 'event' && def.trigger.zoneId === undefined && scenario !== undefined) {
    for (const node of def.plan.nodes) {
      if (node.deviceId === undefined || node.crossZone === true) continue;
      const pinned = scenario.devices.find(d => d.id === node.deviceId);
      if (pinned === undefined || pinned.zoneId === undefined) continue;
      issues.push({
        level: 'warning',
        nodeId: node.id,
        message:
          `pinned device '${pinned.name ?? pinned.id}' sits in zone '${pinned.zoneId}' — this flow's ` +
          'trigger names no zone, so the run is scoped to whichever zone the event fires in; when the ' +
          "event fires in another zone the run refuses to actuate this device ('a zone-triggered flow " +
          "refuses to actuate another zone's device'). If cross-zone actuation is the INTENT (e.g. " +
          'fire-evacuation broadcast), declare `crossZone: true` on the node',
      });
    }
  }

  return issues;
}

// ============================================================================
// Mechanism D: the input-parameter surface (§5.2)
// ============================================================================

/**
 * The ONLY interpolation the flow plan supports: `"${input:name}"` inside a
 * node param string value or a node condition string. One pattern, global
 * (lastIndex-safe callers reset it); segment rule matches input names.
 */
export const FLOW_INPUT_REF_PATTERN = /\$\{input:([A-Za-z_][\w-]*)\}/g;

/** Every input name referenced by `${input:x}` occurrences in one string. */
export function referencedInputNames(text: string): string[] {
  const names: string[] = [];
  FLOW_INPUT_REF_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FLOW_INPUT_REF_PATTERN)) {
    names.push(match[1]);
  }
  return names;
}

/**
 * One type-appropriate sample value per declared input (the default when
 * declared) — what validateFlow substitutes before the plan semantics pass
 * so guard parseability is judged on the RUN form of condition strings.
 */
function sampleParamsFor(inputs: readonly FlowInputSpec[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const input of inputs) {
    params[input.name] = input.default !== undefined
      ? input.default
      : input.type === 'number' ? 0 : input.type === 'boolean' ? false : 'input';
  }
  return params;
}

/**
 * Authoring-time semantic checks for the declared surface (validateFlow
 * path): unique/well-formed names, default/enum/min/max consistent with the
 * declared type, and referenced inputs resolvable + guaranteed present at
 * run time (required or defaulted — a reference to an optional, defaultless
 * input would be ambiguous when the caller omits it).
 */
function validateFlowInputs(flow: FlowDefinition): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const inputs = flow.inputs ?? [];
  const declared = new Map<string, FlowInputSpec>();
  for (const input of inputs) {
    if (declared.has(input.name)) {
      issues.push({
        level: 'error',
        message: `inputs: duplicate input name '${input.name}' — parameter names must be unique`,
      });
      continue;
    }
    declared.set(input.name, input);
    const typeOf = (value: unknown): string =>
      typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    if (input.default !== undefined && typeOf(input.default) !== input.type) {
      issues.push({
        level: 'error',
        message:
          `inputs: input '${input.name}' declares type '${input.type}' but its default ` +
          `${JSON.stringify(input.default)} is a ${typeOf(input.default)} — the default must satisfy the declared type`,
      });
    }
    if (input.type === 'boolean' && input.enum !== undefined) {
      issues.push({
        level: 'error',
        message:
          `inputs: input '${input.name}' is a boolean with an enum — a boolean input is already closed (true|false); drop the enum`,
      });
    }
    if (input.enum !== undefined) {
      const badType = input.enum.filter(value => typeOf(value) !== input.type);
      if (badType.length > 0) {
        issues.push({
          level: 'error',
          message:
            `inputs: input '${input.name}' declares type '${input.type}' but its enum carries ` +
            `${badType.map(v => JSON.stringify(v)).join(', ')} — every enum value must satisfy the declared type`,
        });
      }
    }
    if ((input.min !== undefined || input.max !== undefined) && input.type !== 'number') {
      issues.push({
        level: 'error',
        message:
          `inputs: input '${input.name}' declares min/max but its type is '${input.type}' — bounds apply to number inputs only`,
      });
    }
    if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
      issues.push({
        level: 'error',
        message: `inputs: input '${input.name}' has min (${input.min}) > max (${input.max})`,
      });
    }
    if (
      input.default !== undefined && input.type === 'number' &&
      (input.min !== undefined || input.max !== undefined)
    ) {
      const value = input.default as number;
      if ((input.min !== undefined && value < input.min) || (input.max !== undefined && value > input.max)) {
        issues.push({
          level: 'error',
          message:
            `inputs: input '${input.name}' default ${value} is outside its own bounds ` +
            `[${input.min ?? '-∞'}, ${input.max ?? '∞'}] — the default must be a valid value`,
        });
      }
    }
  }
  return issues;
}

/**
 * Authoring-time check that every `${input:x}` reference in node params /
 * node conditions resolves to a DECLARED input, and that each referenced
 * input is guaranteed present at run time (required or defaulted). Unknown
 * references 422 loudly — the standing silent-field-dropping trap, inverted.
 */
function validateInputReferences(flow: FlowDefinition): PlanIssue[] {
  if (flow.inputs === undefined) {
    // No declared surface: ANY reference is unresolvable by construction.
    const stray: PlanIssue[] = [];
    for (const node of flow.plan.nodes) {
      for (const name of nodeInputReferences(node)) {
        stray.push({
          level: 'error',
          nodeId: node.id,
          message:
            `node '${node.id}' references '\${input:${name}}' but the flow declares no inputs surface — ` +
            "declare inputs: [{name: '" + name + "', ...}] at the flow level",
        });
      }
    }
    return stray;
  }
  const declared = new Map((flow.inputs).map(input => [input.name, input]));
  const issues: PlanIssue[] = [];
  for (const node of flow.plan.nodes) {
    for (const name of nodeInputReferences(node)) {
      const spec = declared.get(name);
      if (spec === undefined) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `node '${node.id}' references '\${input:${name}}' which is not a declared input ` +
            `(declared: ${declared.size > 0 ? [...declared.keys()].join(', ') : '(none)'}) — ` +
            'add it to the flow-level inputs array',
        });
      } else if (spec.required !== true && spec.default === undefined) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `node '${node.id}' references '\${input:${name}}' but that input is neither required nor ` +
            "defaulted — a run may legitimately omit it, leaving the reference unresolvable; " +
            "declare required: true or add a default",
        });
      }
    }
  }
  return issues;
}

/** Input names referenced by one node (params values, deep; + condition). */
function nodeInputReferences(node: PlanNode): string[] {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const name of referencedInputNames(value)) names.add(name);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(node.params);
  if (node.condition !== undefined) {
    for (const name of referencedInputNames(node.condition)) names.add(name);
  }
  return [...names];
}

/**
 * Mechanism D follow-up (implemented with Mechanism C, per the Wave-D notes):
 * a flow with an automatic trigger (event/condition/schedule — every flow has
 * one) AND a required input without a default is a footgun. Its own trigger
 * supplies no params, so every auto-triggered run lands an HONEST FAILED
 * record at the engine's param gate (documented, never a silent
 * substitution). The behavior is legal — manual runs and flow-service
 * invocations DO supply params — so this is a WARNING that teaches, not an
 * error that blocks.
 */
function validateSelfTriggerInputs(flow: FlowDefinition): PlanIssue[] {
  if (flow.inputs === undefined) return [];
  const footguns = flow.inputs.filter(
    input => input.required === true && input.default === undefined,
  );
  if (footguns.length === 0) return [];
  return [
    {
      level: 'warning',
      message:
        `inputs: this flow has an automatic trigger (kind '${flow.trigger.kind}') but declares ` +
        `required input(s) without defaults (${footguns.map(i => `'${i.name}'`).join(', ')}) — ` +
        'auto-triggered runs cannot supply params and will land honest FAILED run records ' +
        '(the engine never substitutes values); give the inputs defaults, or drive the flow ' +
        'through manual runs / a flow-service invocation' +
        (flow.agentInvocable === true ? ' / an agent invocation (this flow is agent-invocable)' : '') +
        ' where callers pass params',
    },
  ];
}

/**
 * Mechanism C: authoring-time semantics for the policy envelope
 * (validateFlow path; the closed JSON schema already guards shape).
 *   - escalate declared while onBudgetExhausted !== 'escalate' is dead
 *     config — an error (the standing loud-config principle: fields that do
 *     nothing fail loudly instead of silently misleading).
 *   - an envelope on a flow with NO delegate nodes is inert today — a
 *     warning (future mechanisms may give it meaning; today it bounds
 *     nothing).
 */
function validateFlowPolicy(flow: FlowDefinition): PlanIssue[] {
  const policy = flow.policy;
  if (policy === undefined) return [];
  const issues: PlanIssue[] = [];
  if (policy.escalate !== undefined && policy.onBudgetExhausted !== 'escalate') {
    issues.push({
      level: 'error',
      message:
        `policy: 'escalate' is declared but onBudgetExhausted is ` +
        `'${policy.onBudgetExhausted ?? 'fallback'}' (the default) — the escalate block is ` +
        "only read when onBudgetExhausted === 'escalate'; set it or drop the block",
    });
  }
  const delegateCount = flow.plan.nodes.filter(node => node.delegate !== undefined).length;
  if (delegateCount === 0) {
    issues.push({
      level: 'warning',
      message:
        'policy: this flow declares a policy envelope but its plan has no delegate nodes — ' +
        'the envelope bounds agent activity inside the flow (delegate judgments today), so it ' +
        'currently bounds nothing here',
    });
  }
  return issues;
}

/**
 * Mechanism D run-time oracle — validate CALLER params against the flow's
 * declared surface and apply defaults. THE single validation function for
 * both ends (design §5.2: "类型校验在两端……各做一次，同一校验函数"):
 * the manual-run route, the flow-service invocation core, and the engine's
 * defensive run gate all call this. Never throws; issues teach.
 *
 * Rules (closed surface, deterministic contract):
 *   - unknown caller keys are ERRORS (the surface is the contract — no
 *     silent dropping);
 *   - types are checked strictly (no coercion: '20' is not 20);
 *   - number bounds (min/max inclusive) and enum membership are enforced;
 *   - required inputs must be present AFTER defaults apply;
 *   - effective params = defaults merged under the caller's values.
 */
export function resolveFlowRunParams(
  inputs: FlowInputSpec[] | undefined,
  callerParams: Record<string, unknown> | undefined,
): { params: Record<string, unknown>; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  const specs = new Map((inputs ?? []).map(input => [input.name, input]));

  if (inputs === undefined || inputs.length === 0) {
    // No declared surface: a run takes no params. Params on a surfaceless
    // flow would be silently meaningless — refuse them loudly.
    if (callerParams !== undefined && Object.keys(callerParams).length > 0) {
      issues.push({
        level: 'error',
        message:
          `this flow declares no inputs surface, but the run carried params ` +
          `({${Object.keys(callerParams).join(', ')}}) — declare inputs at the flow level or drop the params`,
      });
    }
    return { params: {}, issues };
  }

  const params: Record<string, unknown> = {};
  for (const input of inputs) {
    if (input.default !== undefined) params[input.name] = input.default;
  }
  for (const [key, value] of Object.entries(callerParams ?? {})) {
    const spec = specs.get(key);
    if (spec === undefined) {
      issues.push({
        level: 'error',
        message:
          `param '${key}' is not a declared input (declared: ${inputs.map(i => i.name).join(', ')}) — ` +
          'the inputs surface is closed; remove the param or declare it on the flow',
      });
      continue;
    }
    params[key] = value;
  }

  for (const input of inputs) {
    const value = params[input.name];
    if (value === undefined) {
      if (input.required === true) {
        issues.push({
          level: 'error',
          message: `required input '${input.name}' (type ${input.type}) is missing`,
        });
      }
      continue;
    }
    const typeOk =
      (input.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (input.type === 'string' && typeof value === 'string') ||
      (input.type === 'boolean' && typeof value === 'boolean');
    if (!typeOk) {
      issues.push({
        level: 'error',
        message:
          `input '${input.name}' must be a ${input.type} — got ${JSON.stringify(value)} ` +
          `(${Array.isArray(value) ? 'array' : typeof value}); no coercion is applied`,
      });
      continue;
    }
    if (input.type === 'number') {
      const num = value as number;
      if (input.min !== undefined && num < input.min) {
        issues.push({ level: 'error', message: `input '${input.name}' = ${num} is below its minimum ${input.min}` });
      }
      if (input.max !== undefined && num > input.max) {
        issues.push({ level: 'error', message: `input '${input.name}' = ${num} is above its maximum ${input.max}` });
      }
    }
    if (input.enum !== undefined && !input.enum.some(option => option === value)) {
      issues.push({
        level: 'error',
        message:
          `input '${input.name}' = ${JSON.stringify(value)} is outside its enum ` +
          `(${input.enum.map(v => JSON.stringify(v)).join(', ')})`,
      });
    }
  }
  return { params, issues };
}

/**
 * Resolve `${input:x}` references against the EFFECTIVE run params and
 * return a flow copy with substituted node params/conditions (the definition
 * itself is never mutated — the provider re-reads it on every run).
 *
 * Substitution rules (documented contract):
 *   - a param whose ENTIRE string value is one reference takes the input's
 *     TYPED value (a number input stays a number);
 *   - references embedded in longer strings interpolate as text (numbers
 *     render via String());
 *   - an unresolvable reference keeps its literal text — reachable only via
 *     direct engine misuse (authoring + resolveFlowRunParams close both gaps
 *     in the hosted paths), and a visible `${input:...}` artifact in the
 *     trace beats a silent omission.
 */
export function interpolateFlowInputs(
  flow: FlowDefinition,
  params: Record<string, unknown>,
): FlowDefinition {
  const resolveString = (text: string): unknown => {
    const whole = text.match(/^\$\{input:([A-Za-z_][\w-]*)\}$/);
    if (whole !== null) {
      const value = params[whole[1]];
      return value !== undefined ? value : text;
    }
    return text.replace(FLOW_INPUT_REF_PATTERN, (match, name: string) => {
      const value = params[name];
      return value === undefined ? match : String(value);
    });
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return resolveString(value);
    if (Array.isArray(value)) {
      const next = value.map(walk);
      return next.some((item, i) => item !== value[i]) ? next : value;
    }
    if (typeof value === 'object' && value !== null) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        next[key] = walk(item);
        if (next[key] !== item) changed = true;
      }
      return changed ? next : value;
    }
    return value;
  };
  const nodes = flow.plan.nodes.map(node => {
    const params = node.params === undefined ? undefined : walk(node.params);
    const condition =
      typeof node.condition === 'string' && referencedInputNames(node.condition).length > 0
        ? String(resolveString(node.condition))
        : node.condition;
    // T-110 (F20): a delegate node's question is an authorable string like
    // any other — `${input:x}` references in questions used to reach the
    // model VERBATIM (it literally saw "${input:zone}"). Same substitution
    // rule, string-typed result.
    const question =
      typeof node.delegate?.question === 'string' &&
      referencedInputNames(node.delegate.question).length > 0
        ? String(resolveString(node.delegate.question))
        : node.delegate?.question;
    const questionChanged =
      node.delegate !== undefined && question !== node.delegate.question;
    if (params === node.params && condition === node.condition && !questionChanged) return node;
    return {
      ...node,
      ...(params !== node.params ? { params: params as PlanNode['params'] } : {}),
      ...(condition !== node.condition ? { condition: condition as string } : {}),
      ...(questionChanged ? { delegate: { ...node.delegate!, question: question as string } } : {}),
    };
  });
  return { ...flow, plan: { ...flow.plan, nodes } };
}

/**
 * Mechanism B: authoring-time semantics for the agent-invocation flag. The
 * closed JSON schema already guards shape (boolean). A member-authored flow
 * whose author scope contains NO agent is inert — the flag lets nobody
 * invoke. A WARNING that teaches (the world may gain the author's agents
 * later), not an error that blocks. Env-owner flows (no stamp) are
 * unrestricted — every agent is in scope — so they never warn.
 */
function validateAgentInvocable(
  flow: FlowDefinition,
  scenario: ScenarioDefinition | undefined,
): PlanIssue[] {
  if (flow.agentInvocable !== true || scenario === undefined) return [];
  if (flow.authorUserId === undefined) return [];
  const eligible = scenario.agents.some(agent =>
    ownerEligibleForFlowAuthor(agent.ownerUserId, flow.authorUserId),
  );
  if (eligible) return [];
  return [
    {
      level: 'warning',
      message:
        `agentInvocable: this flow is authored by '${flow.authorUserId}' but the world has no ` +
        'agent in that author scope — the flag currently lets no agent invoke it; ' +
        'add an agent owned by the author (or drop the flag)',
    },
  ];
}

/**
 * Mechanism B run-time gate + honest listing — ONE oracle for both sides:
 *   - the OFFERING (what an agent's decision surface may be told it can
 *     invoke) and
 *   - the GATE (FlowEngine.runAsAgent refuses anything this would not offer)
 * share this predicate, so the listing can never advertise a flow the gate
 * would refuse (and vice versa — the standing duplicated-verdicts-drift
 * lesson). Scope: SAME-TENANT ONLY (the T-201 rule keyed by owner ids);
 * cross-tenant reuse runs through a flow-service agreement (Mechanism D).
 */
export function isFlowInvocableByAgent(
  flow: FlowDefinition,
  agentId: string,
  scenario: ScenarioDefinition,
): boolean {
  if (flow.agentInvocable !== true || flow.enabled !== true) return false;
  const agent = scenario.agents.find(a => a.id === agentId);
  if (agent === undefined) return false;
  return ownerEligibleForFlowAuthor(agent.ownerUserId, flow.authorUserId);
}

/**
 * Mechanism B: the offering for one agent — every enabled, agent-invocable
 * flow in the agent's T-201 scope, with the flow's declared inputs surface
 * (the invocation contract) attached. This is EXACTLY what the agent's LLM
 * prompt lists and EXACTLY what runAsAgent accepts — one truth.
 */
export function agentInvocableFlowOfferings(
  flows: readonly FlowDefinition[] | undefined,
  agentId: string,
  scenario: ScenarioDefinition,
): InvocableFlowOffering[] {
  const offerings: InvocableFlowOffering[] = [];
  for (const flow of flows ?? []) {
    if (!isFlowInvocableByAgent(flow, agentId, scenario)) continue;
    offerings.push({
      flowId: flow.id,
      name: flow.name,
      ...(flow.description !== undefined ? { description: flow.description } : {}),
      ...(flow.inputs !== undefined ? { inputs: flow.inputs } : {}),
    });
  }
  return offerings;
}

/**
 * T-090 (DevLoop R28, RT26-F01 code half): authoring-time lint on delegate
 * `question` fields. Open-ended phrasings ("what should we do?", "is it okay
 * to …", "how should we handle …") push small models into unanswerable
 * breadth — the T-609 delegate guidance teaches the closed-threshold form
 * ("is zone-a.temperature above 30?"), which small models answer reliably
 * AND which feeds the advice-outputs + guard machinery directly. Deliberately
 * a WARNING, never a 422 (same lane as the T-606 condition-path lint): open
 * questions are legitimate authoring and stronger models handle them; the
 * lint teaches the form that degrades gracefully. Pure text heuristic — no
 * scenario needed, fires on every channel that validates flows.
 */
const OPEN_ENDED_QUESTION_PATTERNS: readonly RegExp[] = [
  /\bwhat should\b/i,
  /\bhow should\b/i,
  /\bis it okay\b/i,
  /\bwhat do you (?:think|recommend|advise|suggest)\b/i,
  /\bshould (?:we|i)\b/i,
  /\bwhat(?:'s| is) the best\b/i,
];

/**
 * T-108 (DevLoop R32, F16): advice-guard degradation teaching, expressed as
 * a validateFlow WARNING. When a delegate degrades (LLM down, or a
 * rule-only agent whose deterministic fallback produces NO advice outputs),
 * every `delegate.<id>.<key>` guard path is unresolvable — an advice guard
 * reads false, and BOTH branches of a dichotomous guard (`== "lab-b"` /
 * `!= "lab-b"`) skip: the run dead-ends. R29 measured exactly this on the
 * CleanroomGuard flow. The warning fires when a node's guard references the
 * outputs of a delegate that has NO fallback declaration (an explicit
 * `fallback {policy:'node'}` covers the degradation; `policy:'none'` is the
 * author's informed opt-out).
 */
function validateAdviceGuardDegradation(flow: FlowDefinition): PlanIssue[] {
  const delegates = new Map<string, 'covered' | 'none' | 'absent'>();
  for (const node of flow.plan.nodes) {
    if (node.delegate === undefined) continue;
    const fallback = node.delegate.fallback;
    delegates.set(
      node.id,
      fallback === undefined ? 'absent' : fallback.policy === 'node' ? 'covered' : 'none',
    );
  }
  // One warning per DEGRADE-EXPOSED delegate, naming every guarded node —
  // a dichotomous guard pair reads as one teaching moment, not two.
  const exposed = new Map<string, string[]>();
  for (const node of flow.plan.nodes) {
    if (node.condition === undefined) continue;
    const refs = node.condition.match(/delegate\.[A-Za-z_][\w-]*\./g) ?? [];
    for (const ref of refs) {
      const delegateId = ref.slice('delegate.'.length).split('.')[0]!;
      if (delegates.get(delegateId) !== 'absent') continue;
      const guardedNodes = exposed.get(delegateId) ?? [];
      if (!guardedNodes.includes(node.id)) guardedNodes.push(node.id);
      exposed.set(delegateId, guardedNodes);
    }
  }
  return [...exposed.entries()].map(([delegateId, nodeIds]) => ({
    level: 'warning' as const,
    nodeId: nodeIds[0],
    message:
      `node(s) ${nodeIds.map(id => `'${id}'`).join(', ')} guard on delegate '${delegateId}' outputs while the ` +
      'delegate declares no fallback — when the delegate degrades (LLM down, or a rule-only agent whose fallback ' +
      'yields no advice outputs) the guard path is unresolvable and BOTH branches of a dichotomous guard skip ' +
      `(F16: '==' false, '!=' not taken — the run dead-ends). Declare delegate.fallback {policy:"node", nodeId} ` +
      'for the degraded lane, or author a bare-condition guard (env-state conditions keep evaluating when advice ' +
      'is absent)',
  }));
}

function validateDelegateQuestions(flow: FlowDefinition): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const node of flow.plan.nodes) {
    if (node.delegate === undefined) continue;
    const question = node.delegate.question;
    if (!OPEN_ENDED_QUESTION_PATTERNS.some(p => p.test(question))) continue;
    const shown = question.length > 80 ? `${question.slice(0, 80)}…` : question;
    issues.push({
      level: 'warning',
      nodeId: node.id,
      message:
        `delegate question on node '${node.id}' reads open-ended ("${shown}") — closed-threshold questions ` +
        'degrade gracefully on small models and feed the guard machinery directly (e.g. "is the zone ' +
        'temperature above 30?" or "which budget device has the highest load, and what targetTemperature ' +
        '(18-26) should it get?"); see the delegate-question guidance in docs/flow-authoring.md (T-609)',
    });
  }
  return issues;
}

/**
 * Plan-local checks for delegate nodes (Mechanism A): mode/budget/outputs
 * cross rules and fallback references. The SCENARIO-gated governance
 * (assignee existence + author scoping + enabled, budget device binding +
 * executability + zone containment) lives in resolveFlowAssignments so
 * authoring validation and the runtime refusal share ONE oracle (T-051).
 */
function validateDelegateNodes(
  flow: FlowDefinition,
  delegateNodes: PlanNode[],
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const nodeIds = new Set(flow.plan.nodes.map(n => n.id));

  for (const node of delegateNodes) {
    const spec = node.delegate as PlanDelegateSpec;
    if (spec.mode === 'advice' && spec.budget !== undefined) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `delegate node '${node.id}' is mode 'advice' but carries a budget — advice delegates never actuate ` +
          "devices; remove the budget or switch mode to 'actuating'",
      });
    }
    if (spec.mode === 'actuating' && spec.budget === undefined) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `delegate node '${node.id}' is mode 'actuating' but carries no budget — an actuating delegate must ` +
          "declare budget {maxCommands, deviceIds, allowedCommands} (the judgment may ONLY act inside it)",
      });
    }
    if (spec.mode === 'actuating' && spec.outputs !== undefined) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `delegate node '${node.id}' is mode 'actuating' but declares outputs — outputs are advice-only ` +
          "(an actuating delegate's effects are its budgeted actuations, recorded per-command in the run trace)",
      });
    }
    if (spec.fallback?.policy === 'node') {
      const target = spec.fallback.nodeId;
      if (!nodeIds.has(target)) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `delegate node '${node.id}' fallback references unknown node '${target}' ` +
            `(known nodes: ${[...nodeIds].slice(0, 5).join(', ')}${nodeIds.size > 5 ? ', …' : ''})`,
        });
      } else if (target === node.id) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `delegate node '${node.id}' cannot use itself as its fallback node`,
        });
      } else {
        const targetNode = flow.plan.nodes.find(n => n.id === target);
        if (targetNode?.delegate !== undefined) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message:
              `delegate node '${node.id}' fallback references node '${target}', which is itself a delegate node — ` +
              'a fallback must be deterministic (an action node); delegates cannot chain',
          });
        } else if (targetNode?.condition !== undefined) {
          // R33 (DevLoop, Smart F4): a fallback target is compensation-only —
          // the executor EXCLUDES it from normal scheduling ("compensation
          // not required" skip). Pointing it at a guarded BRANCH node
          // silently disables that branch (a lockdown run engaged only one
          // of two locks this way). Teach instead of 422 — dedicated
          // fallback nodes are legal, the trap is reusing a branch.
          issues.push({
            level: 'warning',
            nodeId: node.id,
            message:
              `delegate node '${node.id}' fallback references node '${target}', which carries a condition — ` +
              `a fallback node is compensation-only and is EXCLUDED from normal scheduling (it only runs when the ` +
              `delegate degrades, and reads "compensation not required" otherwise), so that guarded branch will ` +
              `never fire on its own. Point the fallback at a DEDICATED action node and keep '${target}' as a ` +
              'normal branch, or drop the fallback',
          });
        }
      }
      // R33 (Smart F4): the engine maps delegate.fallback onto the node's
      // onFail (compensate semantics) — an authored onFail on the SAME node
      // is silently superseded. Teach the precedence instead of guessing.
      if (node.onFail !== undefined) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message:
            `delegate node '${node.id}' declares BOTH onFail and delegate.fallback — the fallback SUPersedes ` +
            `onFail at runtime (degradation is delegated-specific policy; the engine rewrites the node's ` +
            `failure handling to compensate into the fallback node). Remove the onFail block, or move the ` +
            `desired failure policy into the fallback declaration`,
        });
      }
    }
  }
  return issues;
}


/**
 * R6-B-F03 (cross-owner orchestration carrier): plan-local checks for
 * SERVICE nodes. The closed JSON schema already guards the block's shape;
 * what remains is ref-shape semantics the schema cannot teach:
 *   - exactly ONE of serviceId / semanticType (both = ambiguous; neither =
 *     untargeted) — an error naming the fix;
 *   - an action on a semanticType ref is legal (it constrains whichever
 *     agreement resolves).
 * What core deliberately does NOT check: whether the service EXISTS in the
 * environment or whether the author holds an active agreement for it. Core
 * has no catalog/contract state — and the dependency may legitimately be
 * signed LATER (authoring = declaring the dependency, not holding the
 * permission). The SERVER's authoring pass (routes/flows.ts) adds the
 * non-blocking dependency hint against the live catalog; the runtime gate
 * (the service-invocation lane) is the hard boundary.
 */
function validateServiceNodes(flow: FlowDefinition): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const node of flow.plan.nodes) {
    const spec = node.service;
    if (spec === undefined) continue;
    const hasId = spec.serviceId !== undefined;
    const hasType = spec.semanticType !== undefined;
    if (hasId === hasType) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: hasId
          ? `service node '${node.id}' declares BOTH serviceId '${spec.serviceId}' and semanticType ` +
            `'${spec.semanticType}' — pick exactly one (a pinned id is unambiguous; a semantic type ` +
            'resolves against the env catalog at run time)'
          : `service node '${node.id}' declares no target — give exactly one of serviceId (a pinned ` +
            'service in this environment) or semanticType (resolved against the catalog at run time)',
      });
    }
  }
  return issues;
}

/** The env roles a notify node's to='role' target may name (mirrors the server's EnvRole). */
const NOTIFY_ROLE_TARGETS = ['owner', 'builder', 'viewer'] as const;

/**
 * FEAT-05 (deterministic notify lane): plan-local checks for NOTIFY nodes.
 * The closed JSON schema guards the block's shape; what remains is target
 * semantics the schema cannot teach:
 *   - to='agent'  → target REQUIRED (the agent id; resolved to its owner
 *     user at run time). When the scenario is known, a dangling agent id is
 *     a dead reference — an error like a dangling trigger zoneId.
 *   - to='role'   → target REQUIRED and must be an env role
 *     (owner/builder/viewer) — a typo'd role would silently notify nobody.
 *   - to='owner'  → target FORBIDDEN (the environment owner is unambiguous;
 *     a stray target would be silently meaningless).
 */
function validateNotifyNodes(flow: FlowDefinition, scenario?: ScenarioDefinition): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const node of flow.plan.nodes) {
    const spec = node.notify;
    if (spec === undefined) continue;
    if (spec.to === 'owner') {
      if (spec.target !== undefined) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `notify node '${node.id}' targets 'owner' but also declares target '${spec.target}' — ` +
            "the environment owner is unambiguous; drop the target field (a target only applies to 'agent'/'role')",
        });
      }
      continue;
    }
    if (spec.target === undefined) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `notify node '${node.id}' targets '${spec.to}' but declares no target — ` +
          (spec.to === 'agent'
            ? "give target: '<agentId>' (the notification lands in that agent's owner inbox)"
            : "give target: 'owner' | 'builder' | 'viewer' (every env member with that role is notified)"),
      });
      continue;
    }
    if (spec.to === 'role' && !(NOTIFY_ROLE_TARGETS as readonly string[]).includes(spec.target)) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `notify node '${node.id}' targets role '${spec.target}' — env roles are ` +
          `${NOTIFY_ROLE_TARGETS.join('/')}; a typo'd role would silently notify nobody`,
      });
    }
    if (spec.to === 'agent' && scenario !== undefined) {
      const agent = scenario.agents.find(a => a.id === spec.target);
      if (agent === undefined) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `notify node '${node.id}' targets agent '${spec.target}', which does not exist in this ` +
            'environment (known agents: ' +
            `${scenario.agents.slice(0, 5).map(a => a.id).join(', ')}${scenario.agents.length > 5 ? ', …' : ''})`,
        });
      }
    }
  }
  return issues;
}

/**
 * FEAT-06 (deterministic staggering): plan-local checks for WAIT nodes. The
 * closed schema already guarantees simSec > 0; what remains is the DAG
 * honesty check — a wait node NOTHING depends on delays no work (its whole
 * point is staggering downstream nodes), so authoring says so as a warning
 * instead of letting a no-op delay sit green.
 */
function validateWaitNodes(flow: FlowDefinition): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const dependedOn = new Set<string>();
  for (const node of flow.plan.nodes) {
    for (const dep of node.dependsOn ?? []) dependedOn.add(dep);
  }
  for (const node of flow.plan.nodes) {
    if (node.wait === undefined) continue;
    if (!dependedOn.has(node.id)) {
      issues.push({
        level: 'warning',
        nodeId: node.id,
        message:
          `wait node '${node.id}' has no dependents — it delays nothing (a wait node only staggers the ` +
          'nodes that dependOn it); give it a dependent or drop it',
      });
    }
  }
  return issues;
}
