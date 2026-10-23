/**
 * Independent-actuation honesty helpers — PURE logic extracted from
 * DualTriggerACManager (R21 file-budget ratchet). Two twins:
 *
 *  1. annotateIndependentActuationNote (campus-pilot P0): when a
 *     handle_independently decision cannot or does not actuate (no command
 *     executor, decision-only evaluation, planner produced 0 commands),
 *     append the reason to the recorded reasoning (read by
 *     EngineRuntime.recordDecision and TrajectoryRecorder) so the absence
 *     of commands is auditable instead of a silent null. T-204: actuation
 *     is no longer rule-only — the note reflects whichever gate actually
 *     blocked the commands.
 *  2. applyPrecheckHonestyGate (BUG-01): a precheck Type-A short-circuit
 *     (reasoningCode 'precheck.independent') whose planner produces ZERO
 *     device commands AND whose agent has NO device backing for THIS event
 *     (no in-zone climate device for a temperature event; no in-zone
 *     device backing any actuation-class requirement — directly or through
 *     the semantic-offer table) is a FALSE positive: the coverage premise
 *     came from a misclassified read-only device or a declared-but-
 *     unbacked capability. Recording it as handle_independently both
 *     performs nothing and suppresses the collaboration that could
 *     actually act. Convert it to a Type-E initiate_ac (delegate to an
 *     agent that can act) BEFORE the decision is recorded and counted —
 *     zero-command "independent" decisions no longer enter the
 *     handledIndependently success tally. Legitimate zero-command cases
 *     (deadband, missing value, observation-only requirements) keep their
 *     handle_independently + [actuation: none] note. LLM/triage decisions
 *     are untouched (their own lanes carry the honesty notes), as are runs
 *     where actuation is config-suppressed (eval harnesses — the note
 *     explains instead).
 */

import {
  hasIndependentActuationBacking,
  planIndependentDeviceActions,
  type PlannerDeviceInfo,
} from './rule-actuation-planner.js';
import type { SemanticOfferRule } from '../service/semantic-offers.js';
import type { ACNecessityAssessment } from './ACNecessityAssessor.js';

export type { SemanticOfferRule };

/** Inputs both helpers share (the manager resolves the config reads). */
export interface IndependentActuationHonestyArgs {
  assessment: ACNecessityAssessment;
  agentDevices: readonly PlannerDeviceInfo[];
  offerRules?: readonly SemanticOfferRule[];
  /** this.canActuateIndependently() — config-suppressed runs take the note lane. */
  canActuate: boolean;
}

/** Append a note to the assessment's recorded reasoning (shared shape). */
function appendReasoningNote(assessment: ACNecessityAssessment, note: string): void {
  const current = assessment.llmAssessment?.reasoning;
  assessment.llmAssessment.reasoning = current !== undefined && current.length > 0
    ? `${current} ${note}`
    : note;
}

/** Whether the decision carries its own actuation lane (flow / cognitive commands). */
function hasOwnActuationLane(assessment: ACNecessityAssessment): boolean {
  // Mechanism B: a decision carrying a named flow reports through the
  // invocation outcome note instead (the zero-device-command note would
  // mislead — the flow IS the actuation lane here). Phase 1: the same
  // applies to a decision carrying structured cognitive deviceActions —
  // the model's commands are the actuation lane; their bridge refusals
  // annotate themselves inside executeCognitiveDeviceActions.
  return assessment.invokeFlow !== undefined ||
    (assessment.cognitiveDecision?.actionPlan.primary.deviceActions?.length ?? 0) > 0;
}

/** Twin 1: annotate no-actuation handle_independently decisions (verbatim extraction). */
export function annotateIndependentActuationNote(
  args: IndependentActuationHonestyArgs & { blockReason?: string },
): void {
  const { assessment, agentDevices, offerRules, canActuate, blockReason } = args;
  if (assessment.decision !== 'handle_independently' || hasOwnActuationLane(assessment)) return;

  let note: string | undefined;
  if (canActuate) {
    const { actions, skipReason } = planIndependentDeviceActions(assessment, agentDevices, offerRules);
    if (actions.length === 0) {
      note = `[actuation: none — deterministic planner produced 0 device commands (${skipReason ?? 'no actionable device'})]`;
    }
  } else {
    // T-302: name the operative gate (not a disjunction) — each suppressing
    // policy reports itself via independentActuationBlockReason().
    note = `[actuation: none — ${blockReason ?? 'unknown gate'}; this decision issues no device command]`;
  }
  if (note === undefined) return; // commands will be issued — nothing to explain
  appendReasoningNote(assessment, note);
}

/**
 * Twin 2 (BUG-01): convert a false precheck Type-A to Type-E initiate_ac.
 * Returns the event zone when a conversion happened, undefined otherwise
 * (the manager logs the conversion).
 */
export function applyPrecheckHonestyGate(
  args: IndependentActuationHonestyArgs,
): string | undefined {
  const { assessment, agentDevices, offerRules, canActuate } = args;
  if (assessment.decision !== 'handle_independently') return undefined;
  if (assessment.llmAssessment?.reasoningCode !== 'precheck.independent') return undefined;
  if (hasOwnActuationLane(assessment)) return undefined;
  if (!canActuate) return undefined;
  if (planIndependentDeviceActions(assessment, agentDevices, offerRules).actions.length > 0) return undefined;
  if (hasIndependentActuationBacking(assessment, agentDevices, offerRules)) return undefined;

  const eventZone = assessment.clusterSummary.region.id;
  assessment.decision = 'initiate_ac';
  appendReasoningNote(
    assessment,
    `[honesty-gate: precheck claimed independent coverage of ${eventZone} but no own device can act on this event — delegating via AC instead of recording a no-op]`,
  );
  assessment.llmAssessment.reasoningCode = 'precheck.no_actuation_delegate';
  assessment.llmAssessment.reasoningParams = { zone: eventZone };
  return eventZone;
}
