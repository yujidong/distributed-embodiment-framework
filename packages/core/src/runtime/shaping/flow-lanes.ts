/**
 * Agent flow-lane wiring — pure shaping (L2), see docs/architecture-runtime.md
 *
 * Mechanism B (agent-invocable flows, design-mixed-initiative-flows.md §6):
 * wire each agent's governed invocation lane to the FlowEngine
 * (runAsAgent's gates: scenario member → enabled → agentInvocable flag →
 * T-201 author scope, then the inputs oracle) and offer ONLY the flows
 * that agent may invoke (agentInvocableFlowOfferings — the same oracle the
 * engine gate uses, so the listing is honest; S1-sanitized downstream).
 *
 * R6-E-F09: the NL command lane reads the SAME listing + lane
 * (agent.setNLFlowLane) — its prompt renders exactly what the decision
 * lane offers and its invoke_flow executes through exactly the decision
 * lane's gates, so a hallucinated flowId is refused, never faked.
 */

import {
  agentInvocableFlowOfferings,
  type AgentFlowInvocationOutcome,
  type FlowDefinition,
  type InvocableFlowOffering,
} from '../../flows/index.js';
import type { ScenarioDefinition } from '../../scenario/index.js';

/** The agent face this wiring needs (avoids importing L3 CognitiveAgent). */
export interface AgentFlowLaneAgentLike {
  getDualTriggerACManager(): {
    setInvocableFlowsProvider(provider: () => InvocableFlowOffering[]): void;
    setAgentFlowInvoker(
      invoke: (flowId: string, params?: Record<string, unknown>) => Promise<AgentFlowInvocationOutcome>,
    ): void;
  } | undefined;
  setNLFlowLane(
    provider: () => readonly InvocableFlowOffering[],
    invoker: (flowId: string, params?: Record<string, unknown>) => Promise<AgentFlowInvocationOutcome>,
  ): void;
}

/**
 * Wire every agent's flow lanes (decision + NL) to the FlowEngine. The two
 * lambdas are created ONCE per agent so all three consumers (the manager's
 * prompt listing, the manager's invoke lane, the NL seam) share one source.
 */
export function wireAgentFlowLanes(seams: {
  agents: ReadonlyMap<string, AgentFlowLaneAgentLike>;
  flowsProvider: () => FlowDefinition[];
  scenario: ScenarioDefinition;
  /** FlowEngine.runAsAgent, eventId threaded from the inflight injection. */
  invokeAsAgent: (
    flowId: string,
    agentId: string,
    params: Record<string, unknown> | undefined,
    eventId: string | undefined,
  ) => Promise<AgentFlowInvocationOutcome>;
  inflightEventId: () => string | undefined;
}): void {
  for (const [agentId, agent] of seams.agents) {
    const manager = agent.getDualTriggerACManager();
    const offerings = () => agentInvocableFlowOfferings(seams.flowsProvider(), agentId, seams.scenario);
    const invoke = (flowId: string, params?: Record<string, unknown>) =>
      seams.invokeAsAgent(flowId, agentId, params, seams.inflightEventId());
    manager?.setInvocableFlowsProvider(offerings);
    manager?.setAgentFlowInvoker(invoke);
    agent.setNLFlowLane(offerings, invoke);
  }
}
