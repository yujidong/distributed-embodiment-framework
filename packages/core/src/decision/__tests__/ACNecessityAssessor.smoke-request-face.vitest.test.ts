/**
 * @vitest-environment node
 *
 * R100-ac-request-face-mismatch (chen-11): a scheduled smoke event's
 * deterministic initiate_ac (Type E precheck) went out with an EMPTY gap
 * face — the inference table had no smoke/air-quality entries (a 'smoke'
 * event rides a generic ENVIRONMENT_PARAM_CHANGED envelope and is only
 * visible through its parameter). "No requirements → every agent eligible"
 * then broadcast the AC to semantically random partners; proposals named
 * irrelevant services (lighting/lighting-dim, the initiator's own lab-101
 * services) and all 7 responders justifiably rejected — zero smoke dispatch.
 *
 * Pins: smoke/air-quality events infer dispatch-relevant needs; the
 * precheck (Type E) and LLM lanes produce the SAME request face for the
 * same event + agent (AGENTS.md「AC 提案请求面」口径); self-covered needs
 * stay out of the face; unknown types stay honestly empty.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';
import { inferCapabilitiesFromCluster } from '../inference-tables.js';

/** The chen-11 smoke cluster: generic envelope, smoke visible via parameter. */
function smokeCluster(): SpatialClusterSummary {
  return {
    clusterId: 'cluster-smoke',
    region: { id: 'lab-102', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
    timeWindow: '2026-09-15T22:00:00Z - 2026-09-15T22:05:00Z',
    significance: 'medium',
    summary: 'smoke parameter changed in lab-102',
    findings: [{
      eventType: 'smoke',
      count: 1,
      trend: 'stable',
      anomaly: false,
      details: { parameter: 'smoke', eventType: 'smoke', newValue: true },
    }],
    recommendation: 'evaluate_with_llm',
  };
}

/** The real initiator's surface (lab-101 环境管家 f5fcc698 in the trajectory). */
const INITIATOR_CAPS = [
  'temperature-monitoring', 'co2-monitoring', 'ventilation', 'cooling',
  'monitor-air-quality', 'detect-pollution', 'environment', 'air-quality',
  'temperature-control', 'climate-control', 'hvac',
];

function agentCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    agentId: 'agent-env-steward',
    agentName: 'EnvSteward',
    capabilities: [...INITIATOR_CAPS],
    availableResources: [],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['lab-101'],
    ...overrides,
  };
}

function cognitiveInitiateAC(partnerCapabilities?: string[]): string {
  return JSON.stringify({
    situation: { type: 'emergency', severity: 4, confidence: 0.9 },
    actionPlan: {
      primary: {
        action: 'initiate_ac',
        reasoning: 'need a capable partner',
        ...(partnerCapabilities !== undefined
          ? { collaboration: { partnerCapabilities } }
          : {}),
      },
    },
    uncertainty: { overall: 0.3 },
  });
}

describe('R100: smoke-event deterministic request face (chen-11)', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  it('inference: a smoke event (parameter-only visibility) yields dispatch capabilities, not an empty face', () => {
    const inferred = inferCapabilitiesFromCluster(smokeCluster());
    expect(inferred).toContain('ventilation');
    expect(inferred).toContain('emergency-broadcast');
    expect(inferred).toContain('smoke-monitoring');
    // No lighting, no generic filler.
    expect(inferred).not.toContain('lighting-control');
    expect(inferred).not.toContain('monitoring');
  });

  it('inference: a co2/air-quality event yields ventilation/purification needs', () => {
    const inferred = inferCapabilitiesFromCluster({
      ...smokeCluster(),
      findings: [{
        eventType: 'air-quality', count: 1, trend: 'stable', anomaly: false,
        details: { parameter: 'co2', eventType: 'air-quality', newValue: 1500 },
      }],
    });
    expect(inferred).toContain('ventilation');
    expect(inferred).toContain('air-purification');
    expect(inferred).not.toContain('emergency-broadcast');
  });

  it('inference: an unknown event type stays honestly EMPTY (no random face)', () => {
    const inferred = inferCapabilitiesFromCluster({
      ...smokeCluster(),
      significance: 'medium',
      findings: [{ eventType: 'mystery-event', count: 1, trend: 'stable', anomaly: false, details: {} }],
    });
    expect(inferred).toEqual([]);
  });

  it('a no-coverage agent with a real gap now DEFERS honestly (Type D) — the record names the smoke gap, never a garbage face', async () => {
    // With smoke needs inferred, the lab-101 stewards are Type D (no zone
    // coverage AND a capability gap), not accidental Type E — they defer to
    // agents with coverage instead of broadcasting a face responders must
    // reject. The collaboration attempt comes from propagation/direct
    // coverage agents on the LLM lane (next test).
    const result = await assessor.assess(smokeCluster(), agentCtx());

    expect(result.decision).toBe('defer');
    expect(result.decisionSource).toBe('precheck');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.no_coverage_defer');
    // The decision record carries the smoke-relevant requirements — the
    // steward's decision is auditable (acceptance: 决策行为有记录可查).
    const required = result.llmAssessment.reasoningParams?.['required'] as string;
    expect(required).toContain('emergency-broadcast');
    expect(required).toContain('smoke-monitoring');
    expect(required).not.toContain('lighting');
  });

  it('Type E (full smoke coverage, no zone reach) keeps an EMPTY face — the honest bridge skip, no broadcast', async () => {
    const fullCoverage = [
      'smoke-monitoring', 'ventilation', 'air-purification',
      'emergency-broadcast', 'emergency-response',
    ];
    const result = await assessor.assess(smokeCluster(), agentCtx({ capabilities: fullCoverage }));
    expect(result.decision).toBe('initiate_ac');
    expect(result.decisionSource).toBe('precheck');
    expect(result.llmAssessment.requiredCapabilities).toEqual([]);
  });

  it('LLM lane (propagation coverage): a model-omitted initiate_ac carries the SAME deterministic smoke gap needs', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveInitiateAC());
    // Direct coverage of lab-102 → no Type D/E short-circuit → LLM lane;
    // the model initiates without naming partners → deterministic face.
    const result = await assessor.assess(smokeCluster(), agentCtx({ actuatorZoneIds: ['lab-102'] }));

    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('initiate_ac');
    const face = result.llmAssessment.requiredCapabilities;
    expect(face).toContain('emergency-broadcast');
    expect(face).toContain('smoke-monitoring');
    expect(face).not.toContain('ventilation'); // self-covered
    expect(face).not.toContain('lighting');
    // The LLM-lane face IS the initiatorRequestFace computation — the same
    // one the precheck lane uses (AGENTS.md「AC 提案请求面」口径).
    expect(face).toContain('air-purification');
  });
});
