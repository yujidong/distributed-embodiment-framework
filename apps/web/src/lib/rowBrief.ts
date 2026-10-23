/**
 * Track F 信息分级: field assembly for the sidebar rows' inline brief
 * (简介) — the middle level of the 名字 → 行内简介 → 完整详情 disclosure.
 * Pure functions so the brief content stays unit-testable and the row
 * components stay thin.
 */

import type { WorldAgent, WorldDevice, WorldService } from '../api/types';
import { perCapabilityReputation, type ReputationView } from './reputation';

/** Device brief: type · zone · capability count. */
export interface DeviceBrief {
  type: string;
  zoneName: string;
  capabilityCount: number;
}

export function deviceBrief(device: WorldDevice, zoneName: string): DeviceBrief {
  return {
    type: device.type,
    zoneName,
    capabilityCount: device.capabilities.length,
  };
}

export interface AgentBrief {
  deviceCount: number;
  zoneCount: number;
  /** 'provider/model', or null for rule-only agents. */
  llm: string | null;
  /**
   * Track record aggregated across the agent's visible offers
   * (attempts-weighted average of the per-capability scores); null when the
   * agent has no visible services.
   */
  reputation: ReputationView | null;
}

export function agentBrief(agent: WorldAgent, services: readonly WorldService[]): AgentBrief {
  const track = perCapabilityReputation([...services], agent.id);
  const attempts = track.reduce((sum, rep) => sum + rep.attempts, 0);
  const reputation: ReputationView | null =
    track.length === 0
      ? null
      : {
          score:
            attempts > 0
              ? track.reduce((sum, rep) => sum + rep.score * rep.attempts, 0) / attempts
              : track.reduce((sum, rep) => sum + rep.score, 0) / track.length,
          attempts,
          successes: track.reduce((sum, rep) => sum + rep.successes, 0),
        };
  return {
    deviceCount: agent.boundDeviceIds.length,
    zoneCount: agent.managedZoneIds.length,
    llm: agent.llm ? `${agent.llm.provider}/${agent.llm.model}` : null,
    reputation,
  };
}

export interface ServiceBrief {
  /** 'agentName（ownerName）' — the provider attribution line. */
  providerLabel: string;
  /** Long description, or null when the offer has none. */
  description: string | null;
}

export function serviceBrief(service: WorldService): ServiceBrief {
  return {
    providerLabel: `${service.provider.name}（${service.provider.owner.displayName}）`,
    description: service.description.trim() === '' ? null : service.description,
  };
}
