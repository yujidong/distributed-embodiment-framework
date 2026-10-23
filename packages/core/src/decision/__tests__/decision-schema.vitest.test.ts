/**
 * @vitest-environment node
 *
 * F0-2 (docs/plan-r84-verification-framework.md Wave F0-2): the versioned
 * six-block decision schema (schemas/decision-v1.json) — validator behavior,
 * the wire-copy drift guard, the checked parser, and the ROLLBACK
 * VERIFICATION that the new strict path rejects what the old tolerant path
 * silently accepted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';

import {
  COGNITIVE_DECISION_SCHEMA,
  parseCognitiveDecision,
  parseCognitiveDecisionV1Checked,
} from '../cognitive-decision.js';
import {
  DECISION_SCHEMA_VERSION,
  DECISION_V1_WIRE_SCHEMA,
  validateDecisionV1,
} from '../decision-schema.js';
import decisionV1Document from '../schemas/decision-v1.json';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import type { AgentContext, SpatialClusterSummary } from '../ACNecessityAssessor.js';

/** A full six-block decision payload (all optional segments present). */
function fullPayload(): Record<string, unknown> {
  return {
    situation: {
      type: 'anomaly',
      severity: 3,
      affectedZones: ['region-1'],
      rootCauseHypothesis: 'afternoon sun load',
      confidence: 0.8,
    },
    goals: [{ goal: 'maintain_comfort', priority: 1 }],
    actionPlan: {
      primary: {
        action: 'handle_independently',
        reasoning: 'own devices cover this',
        deviceActions: [{ deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } }],
      },
      fallback: { action: 'wait', reasoning: 'if hvac fails' },
      escalationCondition: 'temperature exceeds 35C',
    },
    explanation: {
      summary: 'Own HVAC covers the zone.',
      factors: [{ name: 'comfort', weight: 0.8 }],
      tradeoffs: 'energy vs comfort',
      alternativesConsidered: ['initiate_ac'],
    },
    collaboration: { needed: false },
    uncertainty: { overall: 0.2, dataQuality: 0.9, riskFactors: ['sensor drift'] },
  };
}

/** Minimal payload — only the three required root blocks. */
function minimalPayload(): Record<string, unknown> {
  return {
    situation: { type: 'normal', severity: 1, confidence: 0.9 },
    actionPlan: { primary: { action: 'wait', reasoning: 'nothing to do' } },
    uncertainty: { overall: 0.1 },
  };
}

describe('validateDecisionV1 (decision-v1.json)', () => {
  it('accepts a full six-block payload', () => {
    const result = validateDecisionV1(fullPayload());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts the minimal required-block payload', () => {
    expect(validateDecisionV1(minimalPayload()).valid).toBe(true);
  });

  it('rejects a missing required block (situation) and names it', () => {
    const payload = minimalPayload() as { situation?: unknown };
    delete payload.situation;
    const result = validateDecisionV1(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain("'situation'");
  });

  it.each(['situation', 'actionPlan', 'uncertainty'])('rejects when required block %s is absent', block => {
    const payload = minimalPayload() as Record<string, unknown>;
    delete payload[block];
    expect(validateDecisionV1(payload).valid).toBe(false);
  });

  it('rejects an unexpected extra block (additionalProperties: false)', () => {
    const result = validateDecisionV1({ ...minimalPayload(), telemetry: { note: 'not in the contract' } });
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('telemetry');
  });

  it('rejects type errors: string severity, out-of-range confidence, unknown action word', () => {
    const badSeverity = validateDecisionV1({
      ...minimalPayload(),
      situation: { type: 'normal', severity: 'high', confidence: 0.9 },
    });
    expect(badSeverity.valid).toBe(false);

    const badConfidence = validateDecisionV1({
      ...minimalPayload(),
      uncertainty: { overall: 1.5 },
    });
    expect(badConfidence.valid).toBe(false);

    const badAction = validateDecisionV1({
      ...minimalPayload(),
      actionPlan: { primary: { action: 'nuke_the_zone', reasoning: 'r' } },
    });
    expect(badAction.valid).toBe(false);
    expect(badAction.errors.join('; ')).toContain('/actionPlan/primary/action');
  });

  it('rejects non-objects and arrays at the root', () => {
    expect(validateDecisionV1('nope').valid).toBe(false);
    expect(validateDecisionV1([minimalPayload()]).valid).toBe(false);
    expect(validateDecisionV1(null).valid).toBe(false);
  });
});

describe('decision-v1 document versioning + wire copy (single source of truth)', () => {
  it('the document carries the v1 markers and the export names the version', () => {
    expect(DECISION_SCHEMA_VERSION).toBe('v1');
    expect(decisionV1Document.$id).toContain('decision-v1');
    expect(decisionV1Document.version).toBe('v1');
  });

  it('the wire schema is the document minus meta keywords (drift guard)', () => {
    for (const meta of ['$schema', '$id', 'title', 'version', 'description']) {
      expect(DECISION_V1_WIRE_SCHEMA[meta]).toBeUndefined();
    }
    const { $schema, $id, title, version, description, ...pure } = decisionV1Document;
    expect(DECISION_V1_WIRE_SCHEMA).toEqual(pure);
    // COGNITIVE_DECISION_SCHEMA is exactly this wire copy — no second schema
    // literal can drift away from the versioned file.
    expect(COGNITIVE_DECISION_SCHEMA).toBe(DECISION_V1_WIRE_SCHEMA);
  });
});

describe('parseCognitiveDecisionV1Checked (guided-decoding backstop)', () => {
  it('parses a schema-valid answer identically to the tolerant parser', () => {
    const text = JSON.stringify(fullPayload());
    const onReject = vi.fn();
    const checked = parseCognitiveDecisionV1Checked(text, onReject);
    expect(onReject).not.toHaveBeenCalled();
    expect(checked).toEqual(parseCognitiveDecision(text));
    expect(checked!.actionPlan.primary.action).toBe('handle_independently');
  });

  it('rejects a schema-violating answer with the violations reported (null, never repaired)', () => {
    const payload = minimalPayload() as { situation?: unknown };
    delete payload.situation;
    const errors: string[][] = [];
    const result = parseCognitiveDecisionV1Checked(JSON.stringify(payload), e => errors.push(e));
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.join('; ')).toContain("'situation'");
  });

  it('non-JSON prose returns null WITHOUT a schema report (not a format violation)', () => {
    const onReject = vi.fn();
    expect(parseCognitiveDecisionV1Checked('DECISION: independent\nMy devices cover it.', onReject)).toBeNull();
    expect(onReject).not.toHaveBeenCalled();
  });
});

/**
 * F0-2 ROLLBACK VERIFICATION: a model answer missing the required
 * `situation` block (the historical silent-repair class). Old path
 * (parseCognitiveDecision, LLM_GUIDED_JSON=0 behavior): silently passes with
 * defaults filled. New path (parseCognitiveDecisionV1Checked + the assessor
 * lane under guided JSON): rejected onto the degradation ladder.
 */
describe('rollback verification — missing-block model response', () => {
  const missingSituationAnswer = JSON.stringify({
    actionPlan: { primary: { action: 'handle_independently', reasoning: 'own devices cover this' } },
    uncertainty: { overall: 0.5 },
  });

  it('OLD path (tolerant parser): silently passes with situation defaults filled', () => {
    const parsed = parseCognitiveDecision(missingSituationAnswer);
    expect(parsed).not.toBeNull(); // the silent pass this wave removes from the guided lane
    expect(parsed!.situation.type).toBe('anomaly'); // default, not model output
    expect(parsed!.situation.severity).toBe(3); // default
  });

  it('NEW path (checked parser): the same answer is rejected with violations named', () => {
    const errors: string[] = [];
    const parsed = parseCognitiveDecisionV1Checked(missingSituationAnswer, e => errors.push(...e));
    expect(parsed).toBeNull();
    expect(errors.join('; ')).toContain("'situation'");
  });

  // --- lane level: the assessor under guided JSON rejects; the env escape
  // hatch (LLM_GUIDED_JSON=0) restores the old tolerant behavior. -----------
  const cluster = {
    clusterId: 'cluster-rb',
    region: { id: 'region-1', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
    timeWindow: '2024-03-15T10:00:00Z - 2024-03-15T10:05:00Z',
    significance: 'medium',
    summary: 'Generic event requiring LLM evaluation for decision making',
    findings: [{
      eventType: 'odd-event',
      count: 1,
      trend: 'stable',
      anomaly: false,
      details: { requiredCapabilities: ['cooling'] },
    }],
    recommendation: 'evaluate_with_llm',
  } as unknown as SpatialClusterSummary;

  const ctx = {
    agentId: 'agent-1',
    agentName: 'AgentOne',
    capabilities: ['cooling', 'monitoring'],
    availableResources: [],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: [],
  } as unknown as AgentContext;

  function assessorWith(answer: string): { assessor: ACNecessityAssessor } {
    const client = { quickChat: vi.fn().mockResolvedValue(answer) } as unknown as LLMClient;
    return { assessor: new ACNecessityAssessor({}, client) };
  }

  afterEach(() => {
    delete process.env.LLM_GUIDED_JSON;
  });

  it('lane under guided JSON (default): schema violation → cognitive answer rejected, decision degraded', async () => {
    delete process.env.LLM_GUIDED_JSON; // default ON
    const { assessor } = assessorWith(missingSituationAnswer);
    const result = await assessor.assess(cluster, ctx);
    // The cognitive parse was REJECTED (no CognitiveDecision rides the
    // assessment); the ladder below still recovers the action word from the
    // raw text via the FSM — degraded, visible, never silently repaired.
    expect(result.cognitiveDecision).toBeUndefined();
    expect(result.llmAssessment.decisionSubSource).toBe('llm-fsm');
  });

  it('escape hatch LLM_GUIDED_JSON=0: the old silent pass is restored (control arm)', async () => {
    process.env.LLM_GUIDED_JSON = '0';
    const { assessor } = assessorWith(missingSituationAnswer);
    const result = await assessor.assess(cluster, ctx);
    expect(result.cognitiveDecision).toBeDefined(); // tolerant repair, as before F0-2
    expect(result.llmAssessment.decisionSubSource).toBe('llm-json');
  });
});
