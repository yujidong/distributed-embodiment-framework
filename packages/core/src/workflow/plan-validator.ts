/**
 * Static Plan Validator (P4-3) — the "compiler" pass over an authored plan.
 *
 * Beyond JSON shape and DAG semantics (plan-schema.ts), this pass checks the
 * plan against the world as it is NOW:
 *
 *   (a) Satisfiability — every node's capability must be providable by some
 *       agent in the supplied capability index (ServiceRegistry / ResourceManager
 *       snapshot). Each satisfiable node gets a concrete assignee; an
 *       unsatisfiable node is an UNSAT error and the plan is invalid.
 *   (b) Condition strings must parse (reported by validatePlanSemantics).
 *   (c) Side-effect report — nodes classified as actuation vs monitoring, so
 *       the UI/log can show what the plan will physically do before it runs.
 *
 * Capability matching reuses the shared capabilityMatches() util (exact /
 * bidirectional substring / synonym table) — the same semantics the AC
 * necessity assessor and ground-truth calculator use.
 */

import { capabilityMatches } from '../utils/capabilityMatching.js';
import {
  validatePlanSemantics,
  validatePlanShape,
  type PlanIssue,
  type WorkflowPlan,
} from './plan-schema.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Capability index: agentId → capability names available on that agent
 * (from its ServiceRegistry services and ResourceManager resources).
 */
export type CapabilityIndex = ReadonlyMap<string, readonly string[]>;

/** Side-effect classification of one node's capability. */
export type SideEffectKind = 'actuation' | 'monitoring' | 'unknown';

export interface SideEffectReport {
  /** Node ids whose capability actuates (physically changes the world). */
  actuation: string[];
  /** Node ids whose capability only senses/monitors. */
  monitoring: string[];
  /** Node ids whose capability cannot be classified by the v1 heuristic. */
  unknown: string[];
}

export interface PlanValidationResult {
  valid: boolean;
  issues: PlanIssue[];
  /** nodeId → agentId chosen by the validator (only for satisfiable nodes). */
  assignments: Map<string, string>;
  sideEffects: SideEffectReport;
}

// ============================================================================
// Side-effect classification (documented v1 heuristic)
// ============================================================================

const ACTUATION_KEYWORDS = [
  'control', 'cooling', 'heating', 'actuat', 'switch', 'set-',
  'open', 'close', 'lock', 'unlock', 'suppression', 'purification',
  'shutoff', 'dimming', 'regulat',
];

const MONITORING_KEYWORDS = [
  'sensing', 'monitoring', 'reading', 'detect', 'measure', 'observ', 'report',
];

/**
 * Classify a capability's side effects by keyword heuristic. Actuation wins
 * when both families match (a 'temperature-control' node may also report).
 */
export function classifySideEffect(capability: string): SideEffectKind {
  const cap = capability.toLowerCase();
  if (ACTUATION_KEYWORDS.some(k => cap.includes(k))) return 'actuation';
  if (MONITORING_KEYWORDS.some(k => cap.includes(k))) return 'monitoring';
  return 'unknown';
}

// ============================================================================
// Satisfiability
// ============================================================================

/**
 * Choose an assignee for a node:
 *   1. The preferred assigneeAgentId when that agent exists in the index AND
 *      matches the capability.
 *   2. Otherwise the first index agent (insertion order) that matches.
 *   3. Otherwise UNSAT.
 * A preferred agent that cannot satisfy the capability yields a warning and
 * reassignment; a preferred agent absent from the index yields a warning too.
 */
function assignNode(
  nodeId: string,
  capability: string,
  preferredAgentId: string | undefined,
  index: CapabilityIndex,
  issues: PlanIssue[],
): string | undefined {
  if (preferredAgentId !== undefined) {
    const preferredCaps = index.get(preferredAgentId);
    if (preferredCaps === undefined) {
      issues.push({
        level: 'warning',
        nodeId,
        message: `preferred assignee '${preferredAgentId}' is not in the capability index; reassigning`,
      });
    } else if (preferredCaps.some(cap => capabilityMatches(cap, capability))) {
      return preferredAgentId;
    } else {
      issues.push({
        level: 'warning',
        nodeId,
        message: `preferred assignee '${preferredAgentId}' cannot satisfy capability '${capability}'; reassigning`,
      });
    }
  }

  for (const [agentId, capabilities] of index) {
    if (agentId === preferredAgentId) continue; // already known not to match
    if (capabilities.some(cap => capabilityMatches(cap, capability))) {
      return agentId;
    }
  }

  issues.push({
    level: 'error',
    nodeId,
    message: `UNSAT: no agent in the capability index can satisfy capability '${capability}'`,
  });
  return undefined;
}

// ============================================================================
// validatePlan
// ============================================================================

/**
 * Statically validate a plan: JSON shape → DAG semantics → satisfiability →
 * side-effect report. `valid` is true only when there are no error-level
 * issues. Assignments are still returned for satisfiable nodes of an invalid
 * plan (useful for repair feedback).
 */
export function validatePlan(plan: unknown, capabilityIndex: CapabilityIndex): PlanValidationResult {
  const issues: PlanIssue[] = [];
  const assignments = new Map<string, string>();
  const sideEffects: SideEffectReport = { actuation: [], monitoring: [], unknown: [] };

  // 1. Shape (ajv). When the shape is broken, semantic/satisfiability checks
  //    would deref garbage — stop after collecting shape issues.
  const shapeIssues = validatePlanShape(plan);
  issues.push(...shapeIssues);
  if (shapeIssues.length > 0) {
    return { valid: false, issues, assignments, sideEffects };
  }

  const typedPlan = plan as WorkflowPlan;

  // 2. Semantics: refs, DAG, condition parsing.
  issues.push(...validatePlanSemantics(typedPlan));

  // 3. Satisfiability + side effects (independent of semantic errors — a
  //    repair loop wants the full picture in one pass).
  for (const node of typedPlan.nodes) {
    const assignee = assignNode(node.id, node.capability, node.assigneeAgentId, capabilityIndex, issues);
    if (assignee !== undefined) {
      assignments.set(node.id, assignee);
    }
    sideEffects[classifySideEffect(node.capability)].push(node.id);
  }

  const valid = !issues.some(issue => issue.level === 'error');
  return { valid, issues, assignments, sideEffects };
}
