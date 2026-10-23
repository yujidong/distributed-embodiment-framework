/**
 * Agent→device binding edges — which temporary edges the map draws when an
 * agent is selected ("这个脑有哪些身体", product_design.md §11.5).
 *
 * Only the selected agent's bindings are drawn (selecting is what turns the
 * edges on), and bindings pointing at devices that no longer exist are
 * dropped — the world is last-write-wins, so a bound device may have been
 * deleted by its owner while the agent row still references it.
 */

import type { WorldModelAgent } from './worldModel';

export interface AgentEdgePair {
  agentId: string;
  deviceId: string;
}

export function deriveAgentEdgePairs(
  agents: readonly WorldModelAgent[],
  selectedAgentId: string | null,
  existingDeviceIds?: ReadonlySet<string>,
): AgentEdgePair[] {
  if (!selectedAgentId) return [];
  const agent = agents.find(a => a.id === selectedAgentId);
  if (!agent) return [];
  return agent.boundDeviceIds
    .filter(deviceId => !existingDeviceIds || existingDeviceIds.has(deviceId))
    .map(deviceId => ({ agentId: agent.id, deviceId }));
}
