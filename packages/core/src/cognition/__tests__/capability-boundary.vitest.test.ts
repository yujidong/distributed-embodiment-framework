/**
 * L5 Meta-cognition — Capability Boundary + escalation function tests
 * (§7.2 capability awareness, §7.5 boundary recognition).
 */

import { describe, expect, it } from 'vitest';
import {
  ESCALATION_PRESSURE_THRESHOLDS,
  EVENT_SEVERITY_RISK_BANDS,
  deriveCapabilityBoundary,
  evaluateDecisionEscalation,
  isSafetyCriticalCapability,
  renderCapabilityBoundary,
  shouldEscalate,
  type DecisionEscalationInput,
} from '../capability-boundary.js';

const hvacAgent = {
  capabilities: ['temperature-control', 'hvac-control', 'temperature-monitoring', 'security', 'fire-suppression'],
  devices: [
    { deviceId: 'hvac-101', capabilities: ['hvac-control', 'cooling'], online: true },
    { deviceId: 'temp-s-101', capabilities: ['temperature-monitoring'], online: true },
  ],
};

describe('deriveCapabilityBoundary', () => {
  it('splits declared capabilities into strong (device-backed) and weak (no backing)', () => {
    const boundary = deriveCapabilityBoundary(hvacAgent);
    expect(boundary.strongAreas).toEqual(['temperature-control', 'hvac-control', 'temperature-monitoring']);
    // security + fire-suppression have no device backing AND are safety-critical.
    expect(boundary.weakAreas).toEqual([]);
    expect(boundary.mustEscalate).toEqual(['security', 'fire-suppression']);
  });

  it('synonym-aware backing: cooling device backs temperature-control', () => {
    const boundary = deriveCapabilityBoundary({
      capabilities: ['temperature-control'],
      devices: [{ deviceId: 'ac-1', capabilities: ['cooling'], online: true }],
    });
    expect(boundary.strongAreas).toEqual(['temperature-control']);
  });

  it('offline devices degrade their areas to weak/must-escalate (runtime dynamic face, §7.2)', () => {
    const boundary = deriveCapabilityBoundary({
      capabilities: ['temperature-control', 'security'],
      devices: [{ deviceId: 'ac-1', capabilities: ['temperature-control'], online: false }],
    });
    expect(boundary.strongAreas).toEqual([]);
    expect(boundary.weakAreas).toEqual(['temperature-control']);
    // No backing at all + safety marker → escalate.
    expect(boundary.mustEscalate).toEqual(['security']);
  });

  it('a deliverable, in-scope safety capability stays STRONG (agent should act, not escalate)', () => {
    const boundary = deriveCapabilityBoundary({
      capabilities: ['fire-suppression'],
      devices: [{ deviceId: 'sprinkler-1', capabilities: ['fire-suppression'], online: true }],
    });
    expect(boundary.strongAreas).toEqual(['fire-suppression']);
    expect(boundary.mustEscalate).toEqual([]);
  });

  it('scope-of-practice exclusions are must-escalate even when devices exist (T-036)', () => {
    const boundary = deriveCapabilityBoundary({
      capabilities: ['temperature-control', 'controlled-substance-dispense'],
      devices: [
        { deviceId: 'd1', capabilities: ['temperature-control'], online: true },
        { deviceId: 'd2', capabilities: ['controlled-substance-dispense'], online: true },
      ],
      scopeOfPractice: ['controlled-substance-dispense'],
    });
    expect(boundary.strongAreas).toEqual(['temperature-control']);
    expect(boundary.mustEscalate).toContain('controlled-substance-dispense');
    expect(boundary.strongAreas).not.toContain('controlled-substance-dispense');
  });

  it('non-safety capabilities without backing land in weakAreas (collaborate hint)', () => {
    const boundary = deriveCapabilityBoundary({
      capabilities: ['temperature-control', 'energy-optimization'],
      devices: [{ deviceId: 'd1', capabilities: ['temperature-control'], online: true }],
    });
    expect(boundary.weakAreas).toEqual(['energy-optimization']);
  });

  it('empty devices → everything declared is weak or must-escalate', () => {
    const boundary = deriveCapabilityBoundary({ capabilities: ['monitoring'], devices: [] });
    expect(boundary.strongAreas).toEqual([]);
    expect(boundary.weakAreas).toEqual(['monitoring']);
  });

  it('isSafetyCriticalCapability matches the documented markers only', () => {
    expect(isSafetyCriticalCapability('Fire-Suppression')).toBe(true);
    expect(isSafetyCriticalCapability('smoke-detection')).toBe(true);
    expect(isSafetyCriticalCapability('access-control')).toBe(true);
    expect(isSafetyCriticalCapability('temperature-control')).toBe(false);
    expect(isSafetyCriticalCapability('lighting-control')).toBe(false);
  });

  it('renderCapabilityBoundary emits bounded deterministic hint lines', () => {
    const boundary = deriveCapabilityBoundary(hvacAgent);
    const lines = renderCapabilityBoundary(boundary);
    expect(lines[0]).toBe(
      'CAPABILITY_BOUNDARY: strong=[temperature-control,hvac-control,temperature-monitoring] weak=[] ' +
      'must-escalate=[security,fire-suppression]',
    );
    expect(lines[1]).toBe('You MUST ESCALATE security, fire-suppression (safety-critical or outside your scope of practice)');
    // Same inputs → same bytes.
    expect(renderCapabilityBoundary(deriveCapabilityBoundary(hvacAgent))).toEqual(lines);
  });
});

describe('shouldEscalate (§7.5 escalate = f(uncertainty × risk × authority))', () => {
  it('confident + moderate risk + full authority → no escalation', () => {
    const result = shouldEscalate(0.9, 0.6, 'full');
    expect(result.escalate).toBe(false);
    expect(result.reason).toContain('pressure=0.06<0.4');
  });

  it('low confidence × high risk escalates (the severity≥4 rule fires first)', () => {
    const result = shouldEscalate(0.3, 1, 'full');
    expect(result.escalate).toBe(true);
    expect(result.reason).toContain('severity≥4'); // ordered rules: trigger 1 before pressure
  });

  it('§7.5 trigger 1: severity≥4 (risk≥0.8) with confidence<0.5 escalates even mid-pressure', () => {
    // pressure = 0.2 × 0.8 = 0.16 < 0.4, but the emergency rule fires first.
    const result = shouldEscalate(0.4, 0.8, 'full');
    expect(result.escalate).toBe(true);
    expect(result.reason).toContain('severity≥4');
  });

  it('severity≥4 with confident read does NOT auto-escalate (full authority)', () => {
    expect(shouldEscalate(0.9, 0.8, 'full').escalate).toBe(false);
  });

  it('viewer authority escalates at high risk regardless of confidence (cannot actuate)', () => {
    const result = shouldEscalate(0.95, 0.6, 'viewer');
    expect(result.escalate).toBe(true);
    expect(result.reason).toContain('viewer');
    // Low-risk viewer observation stays with the agent.
    expect(shouldEscalate(0.9, 0.1, 'viewer').escalate).toBe(false);
  });

  it('less authority lowers the pressure threshold (builder between full and viewer)', () => {
    // pressure = 0.25 × 1 = 0.25: below full's 0.4, above builder's 0.3? No —
    // pick a pressure inside (builder 0.3, full 0.4): 0.35.
    expect(shouldEscalate(0.65, 1, 'full').escalate).toBe(false);   // 0.35 < 0.4
    expect(shouldEscalate(0.65, 1, 'builder').escalate).toBe(true); // 0.35 ≥ 0.3
    expect(ESCALATION_PRESSURE_THRESHOLDS.viewer).toBeLessThan(ESCALATION_PRESSURE_THRESHOLDS.builder);
  });

  it('clamps out-of-range inputs instead of throwing', () => {
    expect(shouldEscalate(Number.NaN, Number.NaN, 'full').escalate).toBe(false); // 0.5 conf × 0 risk
    expect(shouldEscalate(-1, 2, 'full').escalate).toBe(true); // clamps to 0 conf × 1 risk → pressure 1
  });
});

// ---------------------------------------------------------------------------
// R45-P0: evaluateDecisionEscalation uses the EVENT's real severity as the
// authoritative risk source; the model's self-reported severity only picks a
// point inside the event's band (tie-breaker).
// ---------------------------------------------------------------------------

/** Minimal assessment face (v5-like: self-reported severity, low confidence). */
function cognitiveAssessment(overrides: {
  severity?: number;
  confidence?: number;
  action?: string;
}): DecisionEscalationInput & { escalated?: boolean; escalationCondition?: string } {
  return {
    cognitiveDecision: {
      situation: { severity: overrides.severity ?? 5 },
      uncertainty: { overall: overrides.confidence ?? 0.15 },
      actionPlan: { primary: { action: overrides.action ?? 'handle_independently' } },
    },
    llmAssessment: { reasoning: '' },
  };
}

describe('evaluateDecisionEscalation — event severity is authoritative (R45-P0)', () => {
  it('low event + model self-report severity 5 → NO escalation (risk capped at 0.2)', () => {
    // The R45 regression: 6/6 low recovery notifications escalated because
    // v5 always self-reports 4-5 with low confidence.
    const assessment = cognitiveAssessment({ severity: 5, confidence: 0.15 });
    const verdict = evaluateDecisionEscalation(assessment, 'low');
    expect(verdict.escalated).toBe(false);
    expect(assessment.escalated).toBeUndefined();
  });

  it('critical event + model self-report severity 2 → escalates (risk floored at 0.6)', () => {
    // The model downplaying a critical disaster must not mask the event.
    const assessment = cognitiveAssessment({ severity: 2, confidence: 0.3 });
    const verdict = evaluateDecisionEscalation(assessment, 'critical');
    expect(verdict.escalated).toBe(true);
    expect(assessment.escalated).toBe(true);
    expect(assessment.llmAssessment?.reasoning).toContain('[escalated to owner');
  });

  it('medium event + v5 self-report severity 5 → NO escalation (band max 0.4)', () => {
    const assessment = cognitiveAssessment({ severity: 5, confidence: 0.15 });
    expect(evaluateDecisionEscalation(assessment, 'medium').escalated).toBe(false);
  });

  it('high/urgent events keep escalating under v5-like answers (should-escalate band)', () => {
    const high = cognitiveAssessment({ severity: 5, confidence: 0.15 });
    expect(evaluateDecisionEscalation(high, 'high').escalated).toBe(true);
    const urgent = cognitiveAssessment({ severity: 5, confidence: 0.15 });
    expect(evaluateDecisionEscalation(urgent, 'urgent').escalated).toBe(true);
  });

  it('the model self-report stays the tie-breaker INSIDE the band', () => {
    // Same event severity (high band [0.3, 0.7]), different self-reports:
    // understated → risk 0.3, overstated → risk 0.7. With low confidence the
    // tie-breaker decides (pressure 0.7×0.3=0.21 vs 0.7×0.7=0.49 vs the 0.4
    // full-authority threshold); with high confidence neither escalates.
    const understated = cognitiveAssessment({ severity: 1, confidence: 0.95 });
    expect(evaluateDecisionEscalation(understated, 'high').escalated).toBe(false);
    const overstated = cognitiveAssessment({ severity: 5, confidence: 0.95 });
    expect(evaluateDecisionEscalation(overstated, 'high').escalated).toBe(false);
    const overstatedUnsure = cognitiveAssessment({ severity: 5, confidence: 0.3 });
    expect(evaluateDecisionEscalation(overstatedUnsure, 'high').escalated).toBe(true);
    const understatedUnsure = cognitiveAssessment({ severity: 1, confidence: 0.3 });
    expect(evaluateDecisionEscalation(understatedUnsure, 'high').escalated).toBe(false);
  });

  it('no event severity provided → falls back to the model self-report (pre-R45 behavior)', () => {
    const assessment = cognitiveAssessment({ severity: 5, confidence: 0.15 });
    expect(evaluateDecisionEscalation(assessment).escalated).toBe(true);
    const undefinedSeverity = cognitiveAssessment({ severity: 5, confidence: 0.15 });
    expect(evaluateDecisionEscalation(undefinedSeverity, undefined).escalated).toBe(true);
  });

  it("model explicitly asking 'escalate' is still honored on a low event", () => {
    // The threshold channel needs event-side evidence; an explicit owner
    // hand-off request from the model remains a direct trigger.
    const assessment = cognitiveAssessment({ severity: 5, confidence: 0.9, action: 'escalate' });
    expect(evaluateDecisionEscalation(assessment, 'low').escalated).toBe(true);
  });

  it('EVENT_SEVERITY_RISK_BANDS pins the documented bands', () => {
    expect(EVENT_SEVERITY_RISK_BANDS.low).toEqual({ min: 0, max: 0.2 });
    expect(EVENT_SEVERITY_RISK_BANDS.critical).toEqual({ min: 0.6, max: 1.0 });
  });
});
