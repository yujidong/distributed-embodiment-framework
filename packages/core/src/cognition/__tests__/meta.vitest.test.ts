/**
 * L5 Meta-cognition — orchestrator tests (§7): observation → quality →
 * policy → context rendering; collaboration outcome resolution + partner
 * trust updates; checkpoint round-trip; determinism of the prompt sections.
 */

import { describe, expect, it } from 'vitest';
import {
  MetaCognition,
  buildMetaCognitionSummary,
  deriveIndependentOutcome,
  renderMetaCognitionPromptSections,
  type DecisionObservation,
} from '../meta.js';

const boundaryInput = {
  capabilities: ['temperature-control', 'security'],
  devices: [{ deviceId: 'hvac-1', capabilities: ['temperature-control'], online: true }],
};

function observation(overrides: Partial<DecisionObservation> = {}): DecisionObservation {
  return {
    action: 'handle_independently',
    confidence: 0.8,
    decisionSource: 'llm',
    atSimTimeSec: 100,
    hasCognitiveDeviceActions: false,
    hasInvokeFlow: false,
    plannedCommandCount: 0,
    ...overrides,
  };
}

describe('deriveIndependentOutcome (v1 semantics)', () => {
  it('initiate_ac is pending (unknown) until the collaboration completes', () => {
    expect(deriveIndependentOutcome(observation({ action: 'initiate_ac' }))).toBe('unknown');
  });

  it('defer/ignore have no outcome lane', () => {
    expect(deriveIndependentOutcome(observation({ action: 'defer' }))).toBe('unknown');
    expect(deriveIndependentOutcome(observation({ action: 'ignore' }))).toBe('unknown');
  });

  it('policy-blocked independent actuation is unknown, NOT a failure', () => {
    expect(deriveIndependentOutcome(observation({ actuationBlockedReason: 'acMode=shadow' }))).toBe('unknown');
  });

  it('an actuation lane (model commands / named flow / planned commands) → success', () => {
    expect(deriveIndependentOutcome(observation({ hasCognitiveDeviceActions: true }))).toBe('success');
    expect(deriveIndependentOutcome(observation({ hasInvokeFlow: true }))).toBe('success');
    expect(deriveIndependentOutcome(observation({ plannedCommandCount: 2 }))).toBe('success');
  });

  it('decided to handle but nothing would actuate → failure', () => {
    expect(deriveIndependentOutcome(observation())).toBe('failure');
  });
});

describe('MetaCognition', () => {
  it('closes the loop: observe → resolve → metrics + policy adjust → context renders', () => {
    const meta = new MetaCognition({ agentId: 'thermal-ops-1' });

    // Three independent decisions that would actuate + one that would not.
    for (let i = 0; i < 3; i++) {
      meta.noteAssessment(observation({ confidence: 0.8, plannedCommandCount: 1 }));
    }
    meta.noteAssessment(observation({ confidence: 0.8 }));
    let metrics = meta.quality.getMetrics();
    expect(metrics.totalDecisions).toBe(4);
    expect(metrics.correctDecisions).toBe(3);
    expect(metrics.incorrectDecisions).toBe(1);

    const context = meta.buildContext(boundaryInput);
    expect(context.boundary.strongAreas).toEqual(['temperature-control']);
    expect(context.boundary.mustEscalate).toEqual(['security']);
    expect(context.quality.totalDecisions).toBe(4);
    expect(context.policy.strategy).toBe('balanced'); // 0.75 success, calibrated enough

    // A failure streak flips the gear and de-prioritizes the action.
    for (let i = 0; i < 4; i++) {
      meta.noteAssessment(observation({ confidence: 0.85 }));
    }
    metrics = meta.quality.getMetrics();
    expect(metrics.evaluatedDecisions).toBe(8);
    // R40-C2: getPolicy() folded into buildContext — read context.policy.
    const policy = meta.buildContext(boundaryInput).policy;
    expect(policy.deprioritizedActions).toEqual(['handle_independently']);
    expect(policy.strategy).toBe('conservative');
  });

  it('recordCollaborationOutcome resolves the pending initiate_ac and updates partner trust', () => {
    const meta = new MetaCognition({ agentId: 'agent-1' });
    meta.noteAssessment(observation({ action: 'initiate_ac', confidence: 0.9 }));
    meta.noteAssessment(observation({ action: 'initiate_ac', confidence: 0.6 }));

    // First collaboration (with agent-1 itself among participants) fails; second succeeds.
    meta.recordCollaborationOutcome('failure', ['agent-1', 'partner-x']);
    meta.recordCollaborationOutcome('success', ['partner-x', 'partner-y']);

    const metrics = meta.quality.getMetrics();
    expect(metrics.evaluatedDecisions).toBe(2);
    // FIFO: first pending (0.9) failed, second (0.6) succeeded.
    expect(metrics.incorrectDecisions).toBe(1);
    expect(metrics.correctDecisions).toBe(1);

    // Trust: partner-x 1 success + 1 failure; partner-y 1 success; agent-1 not its own partner.
    const partners = meta.trust.listPartners().map(p => [p.partnerId, p.successfulCollaborations, p.failedCollaborations]);
    expect(partners).toContainEqual(['partner-x', 1, 1]);
    expect(partners).toContainEqual(['partner-y', 1, 0]);
    expect(partners.some(([id]) => id === 'agent-1')).toBe(false);
  });

  it('platform reputation rides into the context; prompt renders partner ranking', () => {
    const meta = new MetaCognition({ agentId: 'agent-1' });
    meta.setPlatformReputation('partner-a', 0.82);
    meta.noteAssessment(observation({ action: 'initiate_ac', confidence: 0.7 }));
    meta.recordCollaborationOutcome('success', ['partner-b']); // partner-b earns private trust

    const rendered = renderMetaCognitionPromptSections(meta.buildContext(boundaryInput));
    expect(rendered).toContain('META_COGNITION (your own tracked self-knowledge');
    expect(rendered).toContain('CAPABILITY_BOUNDARY: strong=[temperature-control] weak=[] must-escalate=[security]');
    expect(rendered).toContain('You MUST ESCALATE security');
    expect(rendered).toContain('PARTNER_TRUST (2):');
    expect(rendered).toContain('partner-a=0.82');
    expect(rendered).toContain('CALIBRATION: 1 decision(s), 1 with outcomes');
    // Deterministic: same state → same bytes.
    expect(renderMetaCognitionPromptSections(meta.buildContext(boundaryInput))).toBe(rendered);
  });

  it('prompt renders honest zero-state (no partners, no outcomes, no adaptive rules)', () => {
    const meta = new MetaCognition({ agentId: 'agent-1' });
    const rendered = renderMetaCognitionPromptSections(meta.buildContext(boundaryInput));
    expect(rendered).toContain('PARTNER_TRUST: none known yet');
    expect(rendered).toContain('CALIBRATION: 0 decision(s), 0 with outcomes, calibration=0.5, success=0.5');
    expect(rendered).not.toContain('ADAPTIVE:');
  });

  it('checkpoint round-trips through JSON (hibernate/resume parity)', () => {
    const meta = new MetaCognition({ agentId: 'agent-1' });
    meta.setPlatformReputation('partner-a', 0.7);
    meta.noteAssessment(observation({ action: 'initiate_ac', confidence: 0.8 }));
    meta.recordCollaborationOutcome('success', ['partner-a']);
    meta.noteAssessment(observation({ confidence: 0.6, plannedCommandCount: 1 }));
    const snapshot = JSON.parse(JSON.stringify(meta.checkpoint()));

    const revived = new MetaCognition({ agentId: 'agent-1' });
    revived.restore(snapshot);
    expect(revived.quality.getMetrics()).toEqual(meta.quality.getMetrics());
    expect(revived.trust.listPartners()).toEqual(meta.trust.listPartners());
    expect(revived.buildContext(boundaryInput)).toEqual(meta.buildContext(boundaryInput));
    // restore(null) is a no-op; a fresh restore clears.
    revived.restore(null);
    expect(revived.quality.getMetrics().totalDecisions).toBe(2); // unchanged
  });

  it('clear() resets quality and trust', () => {
    const meta = new MetaCognition({ agentId: 'agent-1' });
    meta.noteAssessment(observation({ action: 'initiate_ac', confidence: 0.8 }));
    meta.recordCollaborationOutcome('success', ['p']);
    meta.clear();
    expect(meta.quality.getMetrics().totalDecisions).toBe(0);
    expect(meta.trust.listPartners()).toEqual([]);
  });
});

describe('buildMetaCognitionSummary (R40-B2 eval-report face)', () => {
  it('projects metrics/trust/boundary from the existing aggregator faces', () => {
    const meta = new MetaCognition({ agentId: 'agent-1' });
    // Two evaluated decisions (one overconfident failure) + partner trust.
    meta.noteAssessment(observation({ confidence: 0.9, plannedCommandCount: 1 }));
    meta.noteAssessment(observation({ confidence: 0.9 }));
    meta.setPlatformReputation('partner-a', 0.8);
    meta.noteAssessment(observation({ action: 'initiate_ac', confidence: 0.7 }));
    meta.recordCollaborationOutcome('success', ['partner-a']);

    const summary = buildMetaCognitionSummary({ agentId: 'agent-1', meta, boundary: boundaryInput });
    expect(summary.agentId).toBe('agent-1');
    expect(summary.decisionCount).toBe(3);
    expect(summary.evaluatedDecisions).toBe(3);
    // Same numbers the metrics face carries (no formula re-implemented).
    expect(summary.calibrationScore).toBe(meta.quality.getMetrics().calibrationScore);
    expect(summary.successRate).toBe(meta.quality.getMetrics().successRate);
    expect(summary.note).toBeUndefined();
    // Boundary from the same derivation the prompt face uses.
    expect(summary.capabilityBoundary).toEqual(meta.buildContext(boundaryInput).boundary);
    // Trust partners carry the blended score + private interactions.
    expect(summary.trustPartners).toEqual([
      { partnerId: 'partner-a', trust: meta.trust.getTrust('partner-a').trustScore, interactions: 1 },
    ]);
    // The uncalibrated action ranks first (0.9 confidence, 0.5 success → gap 0.4).
    expect(summary.topUncalibratedActions[0]).toMatchObject({
      action: 'handle_independently',
      gap: 0.4,
    });
  });

  it('honest empty states: absent meta / no decisions / nothing evaluated → null + note', () => {
    const absent = buildMetaCognitionSummary({ agentId: 'a', boundary: boundaryInput });
    expect(absent.calibrationScore).toBeNull();
    expect(absent.successRate).toBeNull();
    expect(absent.decisionCount).toBe(0);
    expect(absent.topUncalibratedActions).toEqual([]);
    expect(absent.trustPartners).toEqual([]);
    expect(absent.note).toContain('absent');
    // The boundary still derives (it is live device state, not recorded data).
    expect(absent.capabilityBoundary.strongAreas).toEqual(['temperature-control']);

    const noDecisions = buildMetaCognitionSummary({
      agentId: 'a',
      meta: new MetaCognition({ agentId: 'a' }),
      boundary: boundaryInput,
    });
    expect(noDecisions.calibrationScore).toBeNull();
    expect(noDecisions.note).toContain('no cognitive decisions');

    const pendingOnly = new MetaCognition({ agentId: 'a' });
    pendingOnly.noteAssessment(observation({ action: 'defer', confidence: 0.7 }));
    const pending = buildMetaCognitionSummary({ agentId: 'a', meta: pendingOnly, boundary: boundaryInput });
    expect(pending.decisionCount).toBe(1);
    expect(pending.evaluatedDecisions).toBe(0);
    expect(pending.calibrationScore).toBeNull();
    expect(pending.note).toContain('reconciled');
  });
});
