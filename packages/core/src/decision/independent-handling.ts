/**
 * Independent-handling execution lanes — extracted from DualTriggerACManager
 * (R21 file-budget ratchet; FEAT-10 reshaped the lane returns to report the
 * DISPATCHED command count, which made the segment self-contained enough to
 * stand alone). The three lanes run in precedence order:
 *
 *   1. Mechanism B (flow invocation): a named invocable flow IS the governed
 *      handling — an honored invocation REPLACES device improvisation.
 *   2. Phase-1 cognitive deviceActions: the model's STRUCTURED commands,
 *      bridge-validated (budget / own devices / command surface / safe
 *      ranges).
 *   3. Deterministic rule planning (T-204/T-041): the fallback when neither
 *      lane settles.
 *
 * Every function reports `dispatched` — how many commands were actually
 * handed to the executor (a governing flow run counts as one) — so the
 * caller (DualTriggerACManager) can register the FEAT-10 event claim only
 * for REAL self-handling. Pure over the injected seam: no manager state.
 */

import { createLogger } from '@active-collaboration/shared';
import type { AgentFlowInvocationOutcome } from '../flows/index.js';
import { bridgeCognitiveDeviceActions } from '../flows/delegate-recommendation-bridge.js';
import { planIndependentDeviceActions, type PlannerDeviceInfo } from './rule-actuation-planner.js';
import type { SemanticOfferRule } from './independent-actuation-honesty.js';
import type { ACNecessityAssessment } from './ACNecessityAssessor.js';

const logger = createLogger('DualTriggerACManager');

/**
 * Phase 1: execution cap for the cognitive deviceActions lane — matches the
 * CognitiveDecisionSchema's deviceActions maxItems bound, so the schema and
 * the executor enforce the same ceiling (budget discipline: the bridge
 * validates, the executor's loop enforces).
 */
const COGNITIVE_DEVICE_ACTIONS_MAX = 8;

/** Everything the lanes need from the owning manager (verbatim extraction). */
export interface IndependentHandlingSeam {
  agentId: string;
  agentDevices: readonly PlannerDeviceInfo[];
  commandExecutor?: (
    deviceId: string,
    commandName: string,
    params?: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string } | unknown>;
  flowInvoker?: (
    flowId: string,
    params?: Record<string, unknown>,
  ) => Promise<AgentFlowInvocationOutcome>;
  semanticOfferRules?: readonly SemanticOfferRule[];
  /** T-302: the actuation gate with its self-naming reason (undefined = may actuate). */
  actuationBlockReason(): string | undefined;
}

/** Lane outcome: whether the decision's action lane settled here, and how many commands were dispatched. */
export interface HandlingLaneOutcome {
  settled: boolean;
  dispatched: number;
}

/**
 * Run the lanes in precedence order (Mechanism-B flow → Phase-1 cognitive
 * deviceActions → deterministic rule planning) and report how many commands
 * were actually DISPATCHED (a governing flow run counts as one). FEAT-10
 * (dorm-life D11): the caller claims the event when the count is > 0, so a
 * real self-handling registers "this event is handled" — a decision that
 * produced NO commands claims nothing.
 */
export async function runIndependentHandling(
  seam: IndependentHandlingSeam,
  assessment: ACNecessityAssessment,
): Promise<number> {
  const flow = await runFlowInvocation(seam, assessment);
  if (flow.settled) return flow.dispatched;
  const cognitive = await runCognitiveDeviceActions(seam, assessment);
  if (cognitive.settled) return cognitive.dispatched;
  // Rule-only: deterministic actuation (no LLM to plan execution). T-204:
  // deterministic actuation of the agent's OWN devices (any mode — LLM
  // decisions act too, not just rule-only ones).
  return runRuleActions(seam, assessment);
}

/**
 * Mechanism B: execute a decision's named flow as the agent's GOVERNED
 * independent handling. `settled` is true when the decision's action lane
 * is settled here — an honored invocation REPLACES the deterministic device
 * commands (the flow IS the standardized procedure; improvising on top of
 * it would double-actuate), while a refusal falls back to them with the
 * teaching reason appended to the recorded reasoning (honest degradation to
 * pre-B behavior). `dispatched` is 1 only when a flow run actually started
 * (the governed handling produces its commands inside the flow engine).
 * Never throws.
 */
export async function runFlowInvocation(
  seam: IndependentHandlingSeam,
  assessment: ACNecessityAssessment,
): Promise<HandlingLaneOutcome> {
  const named = assessment.invokeFlow;
  if (named === undefined) return { settled: false, dispatched: 0 };
  const appendNote = (note: string): void => {
    const current = assessment.llmAssessment?.reasoning;
    assessment.llmAssessment.reasoning = current !== undefined && current.length > 0
      ? `${current} ${note}`
      : note;
  };
  if (assessment.decision !== 'handle_independently') {
    appendNote(`[flow invocation '${named.flowId}' ignored: only handle_independently decisions may invoke a flow]`);
    return { settled: true, dispatched: 0 }; // the AC/defer path owns this decision — nothing else acts here
  }
  const blockReason = seam.actuationBlockReason();
  if (blockReason !== undefined) {
    // The same standing gates that suppress device actuation suppress
    // flow invocation — and name themselves (T-302 discipline).
    appendNote(`[flow invocation '${named.flowId}' refused: ${blockReason}; no flow ran]`);
    return { settled: true, dispatched: 0 };
  }
  const invoke = seam.flowInvoker;
  if (invoke === undefined) {
    appendNote(`[flow invocation '${named.flowId}' refused: no flow-invocation lane is wired to this runtime — falling back to direct device commands]`);
    return { settled: false, dispatched: 0 };
  }
  try {
    const outcome = await invoke(named.flowId, named.params);
    if (outcome.status === 'invoked') {
      appendNote(`[flow invoked: '${named.flowId}' run=${outcome.run.runId} status=${outcome.run.status}]`);
      return { settled: true, dispatched: 1 };
    }
    appendNote(`[flow invocation '${named.flowId}' refused: ${outcome.reason} — falling back to direct device commands]`);
    return { settled: false, dispatched: 0 };
  } catch (error) {
    appendNote(`[flow invocation '${named.flowId}' failed in the lane: ${error instanceof Error ? error.message : String(error)} — falling back to direct device commands]`);
    return { settled: false, dispatched: 0 };
  }
}

/**
 * Phase 1 (cognitive architecture §14.1): execute the model's STRUCTURED
 * device commands (CognitiveDecision.actionPlan.primary.deviceActions)
 * through the recommendation bridge — budget validation (own devices only),
 * command-surface membership and the R33 device-safe param ranges, the same
 * machinery the flow-delegate text lane uses. `settled` is true when the
 * decision's action lane is settled here (≥1 validated command — the
 * cognitive lane REPLACES the deterministic rule planning, exactly like an
 * honored Mechanism-B flow invocation); false when the model named no
 * deviceActions or the bridge refused them all — the honest refusal notes
 * ride the recorded reasoning and the deterministic fallback runs.
 * `dispatched` counts the commands handed to the executor. Never throws.
 */
export async function runCognitiveDeviceActions(
  seam: IndependentHandlingSeam,
  assessment: ACNecessityAssessment,
): Promise<HandlingLaneOutcome> {
  const deviceActions = assessment.cognitiveDecision?.actionPlan.primary.deviceActions;
  if (deviceActions === undefined || deviceActions.length === 0) return { settled: false, dispatched: 0 };

  const appendNote = (note: string): void => {
    if (assessment.llmAssessment === undefined) return;
    const current = assessment.llmAssessment.reasoning;
    assessment.llmAssessment.reasoning = current !== undefined && current.length > 0
      ? `${current} ${note}`
      : note;
  };

  const blockReason = seam.actuationBlockReason();
  if (blockReason !== undefined) {
    appendNote(
      `[cognitive deviceActions: ${deviceActions.length} model command(s) NOT executed — ` +
      `${blockReason}]`,
    );
    return { settled: false, dispatched: 0 };
  }
  const executor = seam.commandExecutor;
  if (executor === undefined) {
    appendNote('[cognitive deviceActions: model command(s) not executed — no command executor is wired to this agent]');
    return { settled: false, dispatched: 0 };
  }

  const budget = {
    // Bridge contract: budget enforcement happens in the executor's loop.
    maxCommands: COGNITIVE_DEVICE_ACTIONS_MAX,
    deviceIds: seam.agentDevices.map(device => device.deviceId),
    // The device's own declared command vocabulary — the same surface the
    // deterministic planner and the resource layer treat as the command
    // name space (T-204/T-041).
    allowedCommands: [...new Set(
      seam.agentDevices.flatMap(device => device.capabilities.map(cap => cap.toLowerCase())),
    )],
  };
  const bridged = bridgeCognitiveDeviceActions({
    deviceActions,
    budget,
  });

  if (bridged.proposals.length === 0) {
    // Every named command was refused — teaching reasons on the record,
    // then honest degradation to deterministic planning (pre-Phase-1
    // behavior).
    appendNote(
      `[cognitive deviceActions: all ${bridged.rejected.length} command(s) refused by the recommendation bridge — ` +
      `${bridged.rejected.map(r => r.reason).join('; ')}]`,
    );
    return { settled: false, dispatched: 0 };
  }

  let executed = 0;
  const dispatchedProposals = bridged.proposals.slice(0, COGNITIVE_DEVICE_ACTIONS_MAX);
  for (const proposal of dispatchedProposals) {
    try {
      const result = await executor(proposal.deviceId, proposal.command, proposal.params);
      const failed = typeof result === 'object' && result !== null &&
        (result as { success?: boolean }).success === false;
      if (failed) {
        logger.warn(
          `[DualTriggerACManager:${seam.agentId}] Cognitive action ${proposal.command} on ${proposal.deviceId} failed:`,
          (result as { error?: string }).error,
        );
      } else {
        executed++;
        logger.info(
          `[DualTriggerACManager:${seam.agentId}] Cognitive action: ${proposal.command} on ${proposal.deviceId}`,
          proposal.params,
        );
      }
    } catch (error) {
      logger.error(`[DualTriggerACManager:${seam.agentId}] Cognitive action ${proposal.command} on ${proposal.deviceId} threw:`, error);
    }
  }
  if (bridged.clamped.length > 0) {
    appendNote(`[cognitive deviceActions clamped to device-safe ranges: ${bridged.clamped.join('; ')}]`);
  }
  if (bridged.proposals.length > COGNITIVE_DEVICE_ACTIONS_MAX) {
    appendNote(`[cognitive deviceActions: truncated to ${COGNITIVE_DEVICE_ACTIONS_MAX} of ${bridged.proposals.length} commands]`);
  }
  if (bridged.rejected.length > 0) {
    appendNote(`[cognitive deviceActions: ${bridged.rejected.length} command(s) refused — ${bridged.rejected.map(r => r.reason).join('; ')}]`);
  }
  logger.info(
    `[DualTriggerACManager:${seam.agentId}] Cognitive deviceActions: ${executed} executed, ` +
    `${bridged.rejected.length} refused, ${bridged.clamped.length} clamped`,
  );
  return { settled: true, dispatched: dispatchedProposals.length };
}

/**
 * Execute the planned rule actions via the configured command executor.
 * Returns the number of commands dispatched (0 when the lane is gated).
 */
export async function runRuleActions(
  seam: IndependentHandlingSeam,
  assessment: ACNecessityAssessment,
): Promise<number> {
  // T-204: relaxed from rule-only to ANY mode — an agent that DECIDES to
  // handle an event independently now actually drives its own devices
  // (previously LLM-mode decisions were advisory and nothing actuated).
  const executor = seam.commandExecutor;
  if (executor === undefined || seam.actuationBlockReason() !== undefined) return 0;
  const actions = planIndependentDeviceActions(assessment, seam.agentDevices, seam.semanticOfferRules).actions;
  for (const action of actions) {
    try {
      const result = await executor(action.deviceId, action.commandName, action.params);
      const failed = typeof result === 'object' && result !== null &&
        (result as { success?: boolean }).success === false;
      if (failed) {
        logger.warn(
          `[DualTriggerACManager:${seam.agentId}] Rule action ${action.commandName} on ${action.deviceId} failed:`,
          (result as { error?: string }).error,
        );
      } else {
        logger.info(
          `[DualTriggerACManager:${seam.agentId}] Rule action: ${action.commandName} on ${action.deviceId}`,
          action.params,
        );
      }
    } catch (error) {
      logger.error(`[DualTriggerACManager:${seam.agentId}] Rule action ${action.commandName} on ${action.deviceId} threw:`, error);
    }
  }
  return actions.length;
}
