/**
 * @vitest-environment node
 *
 * R17 final smalls — shaping-level pins for the two record seams:
 *
 * - T-024-part3: buildDecisionRecord threads the LLM parse-quality marker
 *   (decisionSubSource 'llm-json' | 'llm-fsm') onto decisionSource 'llm'
 *   records only — the recentDecisions ring/snapshot consumers (console,
 *   eval dashboards) can measure structured-output compliance.
 * - T-036-depth: buildCollaborationRows copies session scopeExclusions onto
 *   RuntimeCollaborationRecord so the collaborations view shows WHO was
 *   blocked by scope-of-practice beside the collaboration that DID form
 *   (the exclusions previously died at the PartnerSelectionResult seam).
 */

import { describe, expect, it } from 'vitest';

import { buildCollaborationRows, buildDecisionRecord } from './collaboration.js';
import type { RuntimeCollaborationRecord } from '../contract.js';
import type { SystemEvent } from '../../events/index.js';
import { parseCognitiveDecision } from '../../decision/cognitive-decision.js';

function makeEvent(): SystemEvent {
  return {
    id: 'evt-1',
    type: 'ENVIRONMENT_PARAM_CHANGED' as SystemEvent['type'],
    source: 'test',
    timestamp: new Date(),
    payload: { eventId: 'evt-1', zoneId: 'zone-a' },
    metadata: { eventId: 'evt-1', eventType: 'temperature-spike', zoneId: 'zone-a' },
  } as SystemEvent;
}

describe('buildDecisionRecord decisionSubSource (T-024-part3)', () => {
  it('carries the parse-quality marker on llm decisions', () => {
    const record = buildDecisionRecord(
      'agent-1',
      {
        decision: 'initiate_ac',
        decisionSource: 'llm',
        llmAssessment: { reasoning: 'need help', decisionSubSource: 'llm-json' },
      },
      makeEvent(),
    );
    expect(record.decisionSubSource).toBe('llm-json');
  });

  it('never carries the marker on non-llm decisions (even if the field leaks in)', () => {
    const record = buildDecisionRecord(
      'agent-1',
      {
        decision: 'defer',
        decisionSource: 'rule',
        llmAssessment: { reasoning: 'lacks capabilities', decisionSubSource: 'llm-fsm' },
      },
      makeEvent(),
    );
    expect(record.decisionSubSource).toBeUndefined();
    expect('decisionSubSource' in record).toBe(false);
  });

  it('llm decisions without a marker (legacy assessments) stay valid', () => {
    const record = buildDecisionRecord(
      'agent-1',
      { decision: 'handle_independently', decisionSource: 'llm', llmAssessment: { reasoning: 'mine' } },
      makeEvent(),
    );
    expect(record.decisionSource).toBe('llm');
    expect(record.decisionSubSource).toBeUndefined();
  });
});

describe('buildDecisionRecord cognitive segments (Phase 1, §14.1)', () => {
  const cognitive = parseCognitiveDecision(JSON.stringify({
    situation: { type: 'emergency', severity: 4, affectedZones: ['zone-a'], rootCauseHypothesis: 'fire', confidence: 0.9 },
    goals: [{ goal: 'ensure_safety', priority: 1 }],
    actionPlan: {
      primary: { action: 'initiate_ac', reasoning: 'need ventilation partner', collaboration: { partnerCapabilities: ['ventilation'] } },
      fallback: { action: 'defer', reasoning: 'wait' },
      escalationCondition: 'temp>35C for 10min',
    },
    explanation: { summary: 'Ventilation gap.', factors: [{ name: 'safety', weight: 0.9 }] },
    uncertainty: { overall: 0.4, dataQuality: 0.8, riskFactors: ['smoke'] },
  }))!;

  it('spreads the four auditable segments additively onto the record', () => {
    const record = buildDecisionRecord(
      'agent-1',
      {
        decision: 'initiate_ac',
        decisionSource: 'llm',
        llmAssessment: { reasoning: 'Ventilation gap.', decisionSubSource: 'llm-json' },
        cognitiveDecision: cognitive,
      },
      makeEvent(),
    );
    expect(record.situation).toEqual(cognitive.situation);
    expect(record.actionPlan).toEqual(cognitive.actionPlan);
    expect(record.explanation).toEqual(cognitive.explanation);
    expect(record.uncertainty).toEqual(cognitive.uncertainty);
    // Legacy fields keep their meaning (derived view).
    expect(record.decision).toBe('initiate_ac');
    expect(record.reasoning).toBe('Ventilation gap.');
  });

  it('records without a cognitiveDecision keep the legacy shape (no new keys)', () => {
    const record = buildDecisionRecord(
      'agent-1',
      { decision: 'defer', decisionSource: 'precheck', llmAssessment: { reasoning: 'rule' } },
      makeEvent(),
    );
    expect(record.situation).toBeUndefined();
    expect(record.actionPlan).toBeUndefined();
    expect(record.explanation).toBeUndefined();
    expect(record.uncertainty).toBeUndefined();
    expect('situation' in record).toBe(false);
  });
});

describe('buildCollaborationRows scopeExclusions (T-036-depth)', () => {
  it('copies session scopeExclusions onto the runtime record', () => {
    const rows: RuntimeCollaborationRecord[] = buildCollaborationRows([
      {
        id: 'initiator-agent',
        getCollaborationSessions: () => ({
          active: [{
            id: 'ac-1',
            initiator: 'initiator-agent',
            status: 'pending',
            type: 'service-composition',
            participants: ['initiator-agent', 'hospital-agent'],
            description: 'controlled-substance response',
            createdAt: new Date('2026-08-23T00:00:00Z'),
            updatedAt: new Date('2026-08-23T00:00:00Z'),
            scopeExclusions: [
              { agentId: 'pharmacy-agent', blockedBy: ['controlled-substance-dispense'] },
            ],
          }],
          completed: [],
        }),
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeExclusions).toEqual([
      { agentId: 'pharmacy-agent', blockedBy: ['controlled-substance-dispense'] },
    ]);
    expect(rows[0]!.agentId).toBe('initiator-agent');
    expect(rows[0]!.role).toBe('initiator');
  });

  it('sessions without exclusions carry no field (schema stays lean)', () => {
    const rows: RuntimeCollaborationRecord[] = buildCollaborationRows([
      {
        id: 'initiator-agent',
        getCollaborationSessions: () => ({
          active: [{
            id: 'ac-2',
            initiator: 'initiator-agent',
            status: 'pending',
            type: 'service-composition',
            participants: ['initiator-agent', 'partner-agent'],
            description: 'routine',
            createdAt: new Date('2026-08-23T00:00:00Z'),
            updatedAt: new Date('2026-08-23T00:00:00Z'),
          }],
          completed: [],
        }),
      },
    ]);

    expect(rows[0]!.scopeExclusions).toBeUndefined();
    expect('scopeExclusions' in rows[0]!).toBe(false);
  });
});
