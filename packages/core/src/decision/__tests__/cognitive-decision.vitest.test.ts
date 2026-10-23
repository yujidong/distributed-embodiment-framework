/**
 * CognitiveDecisionSchema unit tests (Phase 1, cognitive architecture §11/§14.1).
 *
 * Pins the single-oracle contract:
 * - parseCognitiveDecision: full valid object, design-doc snake_case aliases,
 *   action normalization, segment-wise degradation (bad fields never throw
 *   away a valid action), hard null on a missing/unknown action, T-106 caps
 *   and bounded arrays;
 * - deriveLegacyDecision: the backward-compatibility derivation every
 *   existing consumer (manager / runtime record / trajectory) reads;
 * - collaboration.needed is DERIVED (action === 'initiate_ac') — a model
 *   contradiction is overridden, never trusted.
 */

import { describe, it, expect } from 'vitest';
import {
  COGNITIVE_DECISION_SCHEMA,
  canonicalizeCognitiveAction,
  deriveLegacyDecision,
  parseCognitiveDecision,
  type CognitiveDecision,
} from '../cognitive-decision.js';

const fullAnswer = JSON.stringify({
  situation: {
    type: 'anomaly',
    severity: 3,
    affectedZones: ['floor-1', 'floor-2'],
    rootCauseHypothesis: 'HVAC compressor degradation plus outdoor heat wave',
    confidence: 0.85,
  },
  goals: [
    { goal: 'stabilize_floor_1', priority: 1, deadline: 'sim+600s' },
    { goal: 'maintain_comfort', priority: 2 },
  ],
  actionPlan: {
    primary: {
      action: 'initiate_ac',
      reasoning: 'I lack ventilation; partner required.',
      collaboration: { partnerCapabilities: ['ventilation'], proposedTerms: { sla: 'high' } },
    },
    fallback: { action: 'defer', reasoning: 'wait for partner' },
    escalationCondition: 'temp>35C for 10min',
  },
  explanation: {
    summary: 'Ventilation gap requires collaboration.',
    factors: [
      { name: 'safety', weight: 0.9 },
      { name: 'comfort', weight: 0.6 },
    ],
    tradeoffs: 'Initiating AC over waiting because severity rising',
    alternativesConsidered: ['defer until morning'],
  },
  collaboration: { needed: true, partnerType: 'ventilation-agent', reasoning: 'gap' },
  uncertainty: { overall: 0.3, dataQuality: 0.9, riskFactors: ['sensor_calibration'] },
});

describe('parseCognitiveDecision', () => {
  it('parses a full valid answer with every segment intact', () => {
    const cd = parseCognitiveDecision(fullAnswer)!;
    expect(cd).not.toBeNull();
    expect(cd.situation).toEqual({
      type: 'anomaly',
      severity: 3,
      affectedZones: ['floor-1', 'floor-2'],
      rootCauseHypothesis: 'HVAC compressor degradation plus outdoor heat wave',
      confidence: 0.85,
    });
    expect(cd.goals).toEqual([
      { goal: 'stabilize_floor_1', priority: 1, deadline: 'sim+600s' },
      { goal: 'maintain_comfort', priority: 2 },
    ]);
    expect(cd.actionPlan.primary.action).toBe('initiate_ac');
    expect(cd.actionPlan.primary.collaboration).toEqual({
      partnerCapabilities: ['ventilation'],
      proposedTerms: { sla: 'high' },
    });
    expect(cd.actionPlan.fallback).toEqual({ action: 'defer', reasoning: 'wait for partner' });
    expect(cd.actionPlan.escalationCondition).toBe('temp>35C for 10min');
    expect(cd.explanation.factors).toEqual([
      { name: 'safety', weight: 0.9 },
      { name: 'comfort', weight: 0.6 },
    ]);
    expect(cd.uncertainty).toEqual({ overall: 0.3, dataQuality: 0.9, riskFactors: ['sensor_calibration'] });
  });

  it('adopts a root-level legacy invokeFlow when the primary lane has none (R40-A4)', () => {
    // A provider ignoring the constrained format followed the pre-Phase-1
    // INVOCABLE_FLOWS wording: action=handle_independently + a ROOT-level
    // "invokeFlow" object. The parser must recover the named flow instead
    // of silently dropping it.
    const cd = parseCognitiveDecision(JSON.stringify({
      situation: { type: 'normal', severity: 2, affectedZones: ['living-room'], confidence: 0.8 },
      actionPlan: { primary: { action: 'handle_independently', reasoning: 'run owner procedure' } },
      explanation: { summary: 'standard evening routine' },
      collaboration: { needed: false },
      uncertainty: { overall: 0.2, dataQuality: 0.9, riskFactors: [] },
      invokeFlow: { flowId: 'evening-precool', params: { targetTemperature: 26 } },
    }))!;
    expect(cd).not.toBeNull();
    expect(cd.actionPlan.primary.action).toBe('handle_independently');
    expect(cd.actionPlan.primary.flowId).toBe('evening-precool');
    expect(cd.actionPlan.primary.flowParams).toEqual({ targetTemperature: 26 });
  });

  it('root-level invokeFlow never overrides a primary-lane flowId (R40-A4)', () => {
    const cd = parseCognitiveDecision(JSON.stringify({
      situation: { type: 'normal', severity: 2, affectedZones: [], confidence: 0.8 },
      actionPlan: { primary: { action: 'invoke_flow', flowId: 'primary-flow', reasoning: '' } },
      explanation: { summary: '' },
      collaboration: { needed: false },
      uncertainty: { overall: 0.2, dataQuality: 0.9, riskFactors: [] },
      invokeFlow: { flowId: 'stale-root-flow' },
    }))!;
    expect(cd.actionPlan.primary.flowId).toBe('primary-flow');
  });

  it('accepts the design-doc snake_case wire spellings (§11.1)', () => {
    const cd = parseCognitiveDecision(JSON.stringify({
      situation_assessment: {
        type: 'emergency',
        severity: 5,
        affected_zones: ['zone-x'],
        root_cause_hypothesis: 'fire',
        confidence: 0.9,
      },
      goal_stack: [{ goal: 'ensure_safety', priority: 1 }],
      action_plan: { primary: { action: 'escalate', reasoning: 'beyond scope' } },
      collaboration_judgment: { needed: false },
      uncertainty: { overall: 0.6, data_quality: 0.7, risk_factors: ['unverified_hypothesis'] },
    }))!;
    expect(cd).not.toBeNull();
    expect(cd.situation.type).toBe('emergency');
    expect(cd.situation.affectedZones).toEqual(['zone-x']);
    expect(cd.situation.rootCauseHypothesis).toBe('fire');
    expect(cd.goals[0].goal).toBe('ensure_safety');
    expect(cd.actionPlan.primary.action).toBe('escalate');
    expect(cd.uncertainty.dataQuality).toBe(0.7);
    expect(cd.uncertainty.riskFactors).toEqual(['unverified_hypothesis']);
  });

  it('normalizes action spellings (hyphens, legacy aliases)', () => {
    expect(canonicalizeCognitiveAction('handle-independently')).toBe('handle_independently');
    expect(canonicalizeCognitiveAction('Handle It Myself')).toBe('handle_independently');
    expect(canonicalizeCognitiveAction('initiate-ac')).toBe('initiate_ac');
    expect(canonicalizeCognitiveAction('COLLABORATE')).toBe('initiate_ac');
    expect(canonicalizeCognitiveAction('independent')).toBe('handle_independently');
    expect(canonicalizeCognitiveAction('monitor')).toBe('wait');
    expect(canonicalizeCognitiveAction('launch_missiles')).toBeNull();
    expect(canonicalizeCognitiveAction(42)).toBeNull();
  });

  it('extracts JSON from markdown fences and surrounding prose', () => {
    const fenced = '```json\n' + fullAnswer + '\n```';
    expect(parseCognitiveDecision(fenced)).not.toBeNull();
    const prosemixed = `Analysis follows.\n${fullAnswer}\nDone.`;
    expect(parseCognitiveDecision(prosemixed)).not.toBeNull();
  });

  it('returns null when the decision-critical segment is missing', () => {
    expect(parseCognitiveDecision('no json here')).toBeNull();
    expect(parseCognitiveDecision('{"situation": {"type": "normal"}}')).toBeNull();
    // The legacy binary answer has no actionPlan — the assessor's legacy
    // parser owns it (degradation ladder, never guessed here).
    expect(parseCognitiveDecision('{"decision": "collaborate", "reasoning": "x"}')).toBeNull();
    expect(parseCognitiveDecision(JSON.stringify({
      actionPlan: { primary: { action: 'detonate', reasoning: 'nope' } },
    }))).toBeNull();
    expect(parseCognitiveDecision('')).toBeNull();
  });

  it('degrades field-by-field instead of failing the whole answer', () => {
    const cd = parseCognitiveDecision(JSON.stringify({
      situation: { type: 'weird', severity: 42, confidence: 7 },
      actionPlan: { primary: { action: 'defer', reasoning: 'hold', deviceActions: [
        { deviceId: 'd1', command: 'set-temperature', params: { targetTemperature: 24 } },
        { deviceId: '', command: 'x' },               // invalid → dropped
        { command: 'no-device' },                      // invalid → dropped
        'garbage',                                     // invalid → dropped
      ] } },
      goals: [{ goal: 'g', priority: 99 }, { nope: 1 }, 'junk'],
      explanation: { factors: [{ name: 'safety', weight: 12 }, { weight: 1 }, 'junk'] },
      uncertainty: { overall: 'high' },
    }))!;
    expect(cd).not.toBeNull();
    // unknown situation type → anomaly; severity clamped to 5; confidence to 1
    expect(cd.situation.type).toBe('anomaly');
    expect(cd.situation.severity).toBe(5);
    expect(cd.situation.confidence).toBe(1);
    // deviceActions filtered to the one valid entry
    expect(cd.actionPlan.primary.deviceActions).toEqual([
      { deviceId: 'd1', command: 'set-temperature', params: { targetTemperature: 24 } },
    ]);
    // invalid goal entries dropped, priority clamped
    expect(cd.goals).toEqual([{ goal: 'g', priority: 99 }]);
    // factor weight clamped; junk factors dropped
    expect(cd.explanation.factors).toEqual([{ name: 'safety', weight: 1 }]);
    // non-numeric uncertainty falls back to the 0.5 default
    expect(cd.uncertainty.overall).toBe(0.5);
    // missing explanation.summary falls back to the primary reasoning
    expect(cd.explanation.summary).toBe('hold');
  });

  it('derives collaboration.needed from the action — model contradictions overridden', () => {
    const contradicting = parseCognitiveDecision(JSON.stringify({
      actionPlan: { primary: { action: 'initiate_ac', reasoning: 'gap' } },
      collaboration: { needed: false }, // WRONG on purpose
    }))!;
    expect(contradicting.collaboration.needed).toBe(true);

    const honest = parseCognitiveDecision(JSON.stringify({
      actionPlan: { primary: { action: 'handle_independently', reasoning: 'mine' } },
      collaboration: { needed: true }, // also a contradiction → overridden
    }))!;
    expect(honest.collaboration.needed).toBe(false);
  });

  it('caps oversized model text at write time (T-106) and bounds arrays', () => {
    const huge = 'x'.repeat(64 * 1024);
    const cd = parseCognitiveDecision(JSON.stringify({
      situation: { type: 'anomaly', severity: 3, confidence: 0.5, rootCauseHypothesis: huge },
      actionPlan: { primary: {
        action: 'handle_independently',
        reasoning: huge,
        deviceActions: Array.from({ length: 20 }, (_, i) => ({ deviceId: `d${i}`, command: 'turn-on' })),
      } },
      goals: Array.from({ length: 12 }, (_, i) => ({ goal: `g${i}`, priority: 1 })),
      uncertainty: { overall: 0.5, riskFactors: Array.from({ length: 40 }, (_, i) => `r${i}`) },
    }))!;
    expect(cd.situation.rootCauseHypothesis.length).toBeLessThanOrEqual(16 * 1024 + 100);
    expect(cd.situation.rootCauseHypothesis).toMatch(/\[truncated \d+ of \d+ chars\]$/);
    expect(cd.actionPlan.primary.reasoning).toMatch(/\[truncated/);
    expect(cd.actionPlan.primary.deviceActions!.length).toBe(8); // schema maxItems
    expect(cd.goals.length).toBe(5); // schema maxItems
    expect(cd.uncertainty.riskFactors!.length).toBeLessThanOrEqual(16);
  });

  it('rides invoke_flow fields through the actionPlan', () => {
    const cd = parseCognitiveDecision(JSON.stringify({
      actionPlan: { primary: {
        action: 'invoke_flow',
        reasoning: 'standard procedure fits',
        flowId: 'flow-cool-down',
        flowParams: { targetTemp: 22 },
      } },
    }))!;
    expect(cd.actionPlan.primary.flowId).toBe('flow-cool-down');
    expect(cd.actionPlan.primary.flowParams).toEqual({ targetTemp: 22 });
  });
});

describe('deriveLegacyDecision (backward compatibility)', () => {
  const withAction = (action: CognitiveDecision['actionPlan']['primary']['action']): CognitiveDecision =>
    parseCognitiveDecision(JSON.stringify({
      actionPlan: { primary: { action, reasoning: `because ${action}` } },
      explanation: { summary: `Summary for ${action}` },
    }))!;

  it('maps every cognitive action onto the legacy vocabulary', () => {
    expect(deriveLegacyDecision(withAction('initiate_ac')).decision).toBe('initiate_ac');
    expect(deriveLegacyDecision(withAction('defer')).decision).toBe('defer');
    // escalate maps to defer for now (Phase 1; no legacy escalate word yet)
    expect(deriveLegacyDecision(withAction('escalate')).decision).toBe('defer');
    expect(deriveLegacyDecision(withAction('handle_independently')).decision).toBe('handle_independently');
    expect(deriveLegacyDecision(withAction('wait')).decision).toBe('handle_independently');
    expect(deriveLegacyDecision(withAction('invoke_flow')).decision).toBe('handle_independently');
  });

  it('prefers the explanation summary as the legacy reasoning', () => {
    const { decision, reasoning } = deriveLegacyDecision(withAction('initiate_ac'));
    expect(decision).toBe('initiate_ac');
    expect(reasoning).toBe('Summary for initiate_ac');
  });

  it('falls back to the primary reasoning when the summary is empty', () => {
    const cd = parseCognitiveDecision(JSON.stringify({
      actionPlan: { primary: { action: 'defer', reasoning: 'fallback text' } },
    }))!;
    const { reasoning } = deriveLegacyDecision(cd);
    expect(reasoning).toBe('fallback text');
  });
});

describe('COGNITIVE_DECISION_SCHEMA (constrained decoding)', () => {
  it('declares the six-word action vocabulary and the required segments', () => {
    const json = JSON.stringify(COGNITIVE_DECISION_SCHEMA);
    for (const action of ['handle_independently', 'initiate_ac', 'defer', 'escalate', 'wait', 'invoke_flow']) {
      expect(json).toContain(`"${action}"`);
    }
    const schema = COGNITIVE_DECISION_SCHEMA as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['situation', 'actionPlan', 'uncertainty']);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['situation', 'goals', 'actionPlan', 'explanation', 'collaboration', 'uncertainty']),
    );
  });
});
