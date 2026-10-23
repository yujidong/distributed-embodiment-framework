/**
 * @vitest-environment node
 *
 * T-036 (DevLoop R17; HF-F03, R11) — scope-of-practice enforcement.
 *
 * The enforcement seam itself shipped with Workstream A3 + T-021 (persisted
 * cannotDeliverClasses end to end); this suite PINS it at the selection
 * seam (PartnerSelectionNegotiator) and closes the honesty gap: when all
 * capability-matching candidates were excluded by scope-of-practice, the
 * selection failure must SAY so (the old "discoverAgents returned 0 agents
 * with capabilities" sent operators hunting for a capability-registration
 * bug that did not exist).
 *
 * Contract: an agent whose metadata.cannotDeliverClasses intersects the
 * event's requiredCapabilities is NEVER selected for that class; unblocked
 * classes are unaffected; exclusions surface on the result.
 */

import { describe, it, expect } from 'vitest';

import { PartnerSelectionNegotiator } from '../PartnerSelectionNegotiator.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';

function mockCenter(agents: Array<Record<string, unknown>>): EnvironmentCenter {
  return {
    discoverAgents: (criteria: { excludeIds?: string[] }) =>
      agents.filter(a => !criteria.excludeIds?.includes(a.id as string)) as never,
    listAgents: () => agents as never,
  } as unknown as EnvironmentCenter;
}

function agent(id: string, capabilities: string[], cannotDeliverClasses?: string[]) {
  return {
    id,
    name: id,
    capabilities,
    ...(cannotDeliverClasses !== undefined ? { metadata: { cannotDeliverClasses } } : {}),
    currentCollaborations: 0,
    resourceManager: { getAllResources: () => [] },
  };
}

function assessment(requiredCapabilities: string[]) {
  return {
    clusterSummary: {
      clusterId: 'c1',
      region: { id: 'zone-a', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      timeWindow: 'test',
      significance: 'high',
      summary: 'test event',
      findings: [{ eventType: 'medical.emergency', count: 1, trend: 'flat', anomaly: true }],
      recommendation: 'immediate_action',
    },
    agentContext: {
      agentId: 'initiator',
      agentName: 'Initiator',
      capabilities: ['triage'],
      currentWorkload: 'idle',
      recentCollaborations: [],
      currentCollaborations: 0,
    },
    llmAssessment: {
      needsCollaboration: true,
      reasoning: 'need a specialist',
      urgency: 'high',
      suggestedPartnerTypes: [],
      requiredCapabilities,
      confidence: 0.9,
      estimatedDuration: 60000,
      potentialRisks: [],
    },
    decision: 'initiate_ac',
    timestamp: new Date(),
  } as Parameters<PartnerSelectionNegotiator['findPartners']>[0];
}

describe('T-036: scope-of-practice (cannotDeliverClasses) enforcement', () => {
  it('a blocklisted agent is NEVER selected for that class', async () => {
    // pharmacy can talk about meds but is blocklisted from controlled
    // substance dispensing (the medical scope-of-practice example).
    const negotiator = new PartnerSelectionNegotiator({}, mockCenter([
      agent('pharmacy', ['medication-dispense', 'controlled-substance-dispense'], ['controlled-substance-dispense']),
    ]));

    const result = await negotiator.findPartners(assessment(['controlled-substance-dispense']));

    expect(result.selectedPartners.map(p => p.agentId)).not.toContain('pharmacy');
    expect(result.isFallback).toBe(true);
    // Honest exclusion: the failure names the scope filter, not a phantom
    // capability gap.
    expect(result.failureReasons?.[0]?.reason).toContain('scope-of-practice');
    expect(result.failureReasons?.[0]?.details).toContain('pharmacy');
    expect(result.failureReasons?.[0]?.details).toContain('controlled-substance-dispense');
    expect(result.scopeExclusions).toEqual([
      { agentId: 'pharmacy', blockedBy: ['controlled-substance-dispense'] },
    ]);
  });

  it('unblocked classes are unaffected — the same agent IS selected', async () => {
    const negotiator = new PartnerSelectionNegotiator({}, mockCenter([
      agent('pharmacy', ['medication-dispense', 'controlled-substance-dispense'], ['controlled-substance-dispense']),
    ]));

    const result = await negotiator.findPartners(assessment(['medication-dispense']));

    expect(result.selectedPartners.map(p => p.agentId)).toContain('pharmacy');
    expect(result.scopeExclusions).toBeUndefined();
  });

  it('a mixed field excludes only the blocked candidate — the unblocked one is selected', async () => {
    // The pharmacy DECLARES the controlled-substance capability (it stocks
    // related meds) — only the blocklist stands between it and selection.
    const negotiator = new PartnerSelectionNegotiator({}, mockCenter([
      agent('pharmacy', ['medication-dispense', 'controlled-substance-dispense'], ['controlled-substance-dispense']),
      agent('hospital', ['controlled-substance-dispense', 'medication-dispense']),
    ]));

    const result = await negotiator.findPartners(assessment(['controlled-substance-dispense']));

    expect(result.selectedPartners.map(p => p.agentId)).toEqual(['hospital']);
    // Even on SUCCESS the blocked candidate is reported honestly.
    expect(result.scopeExclusions).toEqual([
      { agentId: 'pharmacy', blockedBy: ['controlled-substance-dispense'] },
    ]);
  });

  it('agents without a blocklist are never reported as excluded', async () => {
    const negotiator = new PartnerSelectionNegotiator({}, mockCenter([
      agent('hospital', ['controlled-substance-dispense']),
      agent('triage-team', ['triage']),
    ]));

    const result = await negotiator.findPartners(assessment(['controlled-substance-dispense']));
    expect(result.selectedPartners.map(p => p.agentId)).toEqual(['hospital']);
    expect(result.scopeExclusions).toBeUndefined();
    expect(result.failureReasons).toBeUndefined();
  });

  it('top-level cannotDeliverClasses (test doubles) is honored too', async () => {
    const negotiator = new PartnerSelectionNegotiator({}, mockCenter([
      { ...agent('pharmacy', ['controlled-substance-dispense']), cannotDeliverClasses: ['controlled-substance-dispense'] },
      agent('hospital', ['controlled-substance-dispense']),
    ]));

    const result = await negotiator.findPartners(assessment(['controlled-substance-dispense']));
    expect(result.selectedPartners.map(p => p.agentId)).toEqual(['hospital']);
    expect(result.scopeExclusions?.map(e => e.agentId)).toEqual(['pharmacy']);
  });
});
