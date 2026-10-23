/**
 * 决策缝接线（FEAT-10 装配）—— pure shaping (L2)，与 wireNLInteractionTrace
 * 同因落 shaping（EngineRuntime 的尺寸门禁）。纯接线：无引擎状态、无 IO。
 */

import type { InitiatorCoordinator } from '../../decision/InitiatorCoordinator.js';

/** DualTriggerACManager 的结构面（避免反向 import L3）。 */
export interface DecisionSeamManagerLike {
  setInitiatorCoordinator(coordinator: InitiatorCoordinator): void;
  hasSelfHandledEvent(eventId: string): boolean;
}

/** CognitiveAgent 的结构面。 */
export interface DecisionSeamAgentLike {
  getDualTriggerACManager(): DecisionSeamManagerLike | undefined;
  proposalHandler?: {
    setSelfHandledEventCheck(check: (eventId: string) => boolean): void;
  };
}

/**
 * Wire the runtime-wide InitiatorCoordinator into the agent's AC manager,
 * and the manager's self-handling knowledge into the responder lane
 * (FEAT-10, dorm-life D11): a proposal whose trigger event this agent
 * already self-handled — real device commands dispatched — is rejected, so
 * the same devices are never double-actuated.
 */
export function wireDecisionSeams(agent: DecisionSeamAgentLike, coordinator: InitiatorCoordinator): void {
  agent.getDualTriggerACManager()?.setInitiatorCoordinator(coordinator);
  agent.proposalHandler?.setSelfHandledEventCheck(
    eventId => agent.getDualTriggerACManager()?.hasSelfHandledEvent(eventId) ?? false,
  );
}
