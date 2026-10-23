/**
 * @vitest-environment node
 *
 * BUG-01 — deterministic actuation planner: the semantic-offer lane and the
 * actuation-backing predicates.
 *
 * Before BUG-01 the planner matched event requirements ONLY against device
 * DECLARED capability names, so an event requiring an aggregate service
 * type (load-management) planned 0 commands even when the agent bound a
 * device holding the rule's actuation backing (a charging pile's turn-off).
 * The merged semantic-offer table (built-in ∪ scenario rules — the same
 * table the signing/invoke gates consult) now resolves such requirements,
 * and hasActuationBacking gives the honesty gate / ground truth the
 * planner-twin structural check.
 */

import { describe, it, expect } from 'vitest';
import {
  planIndependentDeviceActions,
  hasActuationBacking,
  hasIndependentActuationBacking,
  type PlannerDeviceInfo,
} from '../rule-actuation-planner.js';
import { SEMANTIC_OFFER_RULES, type SemanticOfferRule } from '../../service/semantic-offers.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';

/** Minimal assessment fixture — the planner reads clusterSummary + decisionSource only. */
function makeAssessment(args: {
  zoneId?: string;
  details?: Record<string, unknown>;
  decisionSource?: ACNecessityAssessment['decisionSource'];
}): ACNecessityAssessment {
  return {
    clusterSummary: {
      clusterId: 'test-cluster',
      region: { id: args.zoneId ?? 'zone-a', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      timeWindow: new Date().toISOString(),
      significance: 'medium',
      summary: 'Test cluster summary',
      findings: [
        {
          eventType: String(args.details?.eventType ?? 'custom'),
          count: 1,
          trend: 'stable',
          anomaly: true,
          details: args.details ?? {},
        },
      ],
      recommendation: 'evaluate_with_llm',
    },
    agentContext: {
      agentId: 'agent-1',
      agentName: 'Agent 1',
      capabilities: [],
      availableResources: [],
      currentWorkload: 'idle',
      recentCollaborations: [],
      currentCollaborations: 0,
    },
    llmAssessment: {
      needsCollaboration: false,
      reasoning: 'test',
      urgency: 'medium',
      suggestedPartnerTypes: [],
      requiredCapabilities: [],
      confidence: 0.5,
      estimatedDuration: 1000,
      potentialRisks: [],
    },
    decision: 'handle_independently',
    decisionSource: args.decisionSource ?? 'precheck',
    timestamp: new Date(),
  } as ACNecessityAssessment;
}

const chargingPile: PlannerDeviceInfo = {
  deviceId: 'pile-1',
  type: 'charging-pile',
  // Load-shedding binding: the pile can be switched OFF (no turn-on) —
  // the dorm-life shape BUG-01 acceptance pins.
  capabilities: ['turn-off', 'read-power'],
  zoneId: 'zone-a',
};

describe('planIndependentDeviceActions — semantic-offer lane (BUG-01)', () => {
  it('load-management event + bound turn-off charging pile → ≥1 turn-off command (built-in rules)', () => {
    const assessment = makeAssessment({
      zoneId: 'zone-a',
      details: { eventType: 'grid-peak', requiredCapabilities: ['load-management'] },
    });
    const { actions, skipReason } = planIndependentDeviceActions(assessment, [chargingPile]);
    expect(skipReason).toBeUndefined();
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.some(a => a.deviceId === 'pile-1' && a.commandName === 'turn-off')).toBe(true);
  });

  it('scenario-authored rule (merged table) resolves its own semantic type', () => {
    const customRule: SemanticOfferRule = {
      semanticType: 'exam-week-quiet',
      label: '考试周静音保障',
      description: 'custom scenario rule',
      requires: ['noise-monitoring'],
      actuates: ['set-volume'],
    };
    const speaker: PlannerDeviceInfo = {
      deviceId: 'speaker-1',
      type: 'speaker',
      capabilities: ['set-volume'],
      zoneId: 'zone-a',
    };
    const assessment = makeAssessment({
      zoneId: 'zone-a',
      details: { eventType: 'quiet-hours', requiredCapabilities: ['exam-week-quiet'] },
    });
    // Built-ins alone cannot resolve the scenario's own semantic type…
    expect(planIndependentDeviceActions(assessment, [speaker]).actions).toHaveLength(0);
    // …the merged table can.
    const { actions } = planIndependentDeviceActions(
      assessment,
      [speaker],
      [customRule, ...SEMANTIC_OFFER_RULES],
    );
    expect(actions).toEqual([
      { deviceId: 'speaker-1', commandName: 'set-volume', params: {} },
    ]);
  });

  it('a backing device outside the event zone is not commanded (out-of-zone stays honest)', () => {
    const farPile: PlannerDeviceInfo = { ...chargingPile, deviceId: 'pile-far', zoneId: 'zone-b' };
    const assessment = makeAssessment({
      zoneId: 'zone-a',
      details: { eventType: 'grid-peak', requiredCapabilities: ['load-management'] },
    });
    const { actions, skipReason } = planIndependentDeviceActions(assessment, [farPile]);
    expect(actions).toHaveLength(0);
    expect(skipReason).toContain('outside event zone');
  });
});

describe('hasActuationBacking (BUG-01 structural twin of the planner)', () => {
  it('sensor-only devices do not back an actuation-class requirement', () => {
    const sensor: PlannerDeviceInfo = {
      deviceId: 'cam-1',
      type: 'camera',
      capabilities: ['read-occupancy', 'detect-smoke'],
      zoneId: 'zone-a',
    };
    expect(hasActuationBacking({
      requiredCapabilities: ['security-patrol'],
      eventZoneId: 'zone-a',
      devices: [sensor],
    })).toBe(false);
  });

  it('an observation-only event (read-style requirements) needs no backing', () => {
    expect(hasActuationBacking({
      requiredCapabilities: ['read-occupancy'],
      eventZoneId: 'zone-a',
      devices: [],
    })).toBe(true);
  });

  it('offer-rule backing counts (load-management ← turn-off pile in zone)', () => {
    expect(hasActuationBacking({
      requiredCapabilities: ['load-management'],
      eventZoneId: 'zone-a',
      devices: [chargingPile],
    })).toBe(true);
  });

  it('temperature event: an in-zone climate device backs it, a sensor does not', () => {
    const hvac: PlannerDeviceInfo = {
      deviceId: 'hvac-1',
      type: 'hvac',
      capabilities: ['temperature-control'],
      zoneId: 'zone-a',
    };
    const sensor: PlannerDeviceInfo = {
      deviceId: 'temp-sensor',
      type: 'temperature-sensor',
      capabilities: ['read-temperature'],
      zoneId: 'zone-a',
    };
    const query = { parameter: 'temperature', eventZoneId: 'zone-a' };
    expect(hasActuationBacking({ ...query, requiredCapabilities: [], devices: [hvac] })).toBe(true);
    expect(hasActuationBacking({ ...query, requiredCapabilities: [], devices: [sensor] })).toBe(false);
  });

  it('assessment-shaped wrapper derives the same verdict from the cluster summary', () => {
    const noBacking = makeAssessment({
      zoneId: 'zone-a',
      details: { eventType: 'security-patrol', requiredCapabilities: ['security-patrol'] },
    });
    const sensor: PlannerDeviceInfo = {
      deviceId: 'cam-1',
      type: 'camera',
      capabilities: ['read-occupancy'],
      zoneId: 'zone-a',
    };
    expect(hasIndependentActuationBacking(noBacking, [sensor])).toBe(false);
    expect(hasIndependentActuationBacking(noBacking, [chargingPile])).toBe(false);
    const backed = makeAssessment({
      zoneId: 'zone-a',
      details: { eventType: 'grid-peak', requiredCapabilities: ['load-management'] },
    });
    expect(hasIndependentActuationBacking(backed, [chargingPile])).toBe(true);
  });
});
