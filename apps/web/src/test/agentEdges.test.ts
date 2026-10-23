/**
 * Agent→device binding edge derivation tests (P2c agent layer).
 */

import { describe, expect, it } from 'vitest';

import { deriveAgentEdgePairs } from '../lib/agentEdges';
import type { WorldModelAgent } from '../lib/worldModel';

function makeAgent(id: string, boundDeviceIds: string[]): WorldModelAgent {
  return {
    id,
    name: `Agent${id}`,
    capabilities: [],
    boundDeviceIds,
    managedZoneIds: [],
    llm: null,
    ownerId: null,
    ownerName: null,
  };
}

describe('deriveAgentEdgePairs', () => {
  const agents = [makeAgent('a1', ['d1', 'd2']), makeAgent('a2', ['d3'])];

  it('returns no edges when nothing is selected', () => {
    expect(deriveAgentEdgePairs(agents, null)).toEqual([]);
  });

  it('returns one edge per bound device of the selected agent', () => {
    expect(deriveAgentEdgePairs(agents, 'a1')).toEqual([
      { agentId: 'a1', deviceId: 'd1' },
      { agentId: 'a1', deviceId: 'd2' },
    ]);
    expect(deriveAgentEdgePairs(agents, 'a2')).toEqual([{ agentId: 'a2', deviceId: 'd3' }]);
  });

  it('returns no edges for an unknown selection', () => {
    expect(deriveAgentEdgePairs(agents, 'ghost')).toEqual([]);
  });

  it('drops bindings pointing at deleted devices', () => {
    const existing = new Set(['d2']);
    expect(deriveAgentEdgePairs(agents, 'a1', existing)).toEqual([
      { agentId: 'a1', deviceId: 'd2' },
    ]);
  });
});
