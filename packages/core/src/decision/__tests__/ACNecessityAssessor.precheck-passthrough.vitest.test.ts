/**
 * R43-B/lever-b: precheck Type-A pass-through (training loop v5 §9.5).
 *
 * Type-A events (direct actuator coverage × no capability gap → GT
 * handle_independently) normally short-circuit BEFORE the LLM
 * ('precheck.independent'). The agent-level policy
 * AgentContext.precheckPassThrough {'off'|'sample'|'all'} lets a controlled
 * fraction of them fall through to the LLM decision lane to produce real
 * GT-A×LLM handle samples. Default (absent / 'off') MUST be byte-equivalent
 * to the pre-R43 behavior — pinned below.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import { ruleOnlyVerdict } from '../assessor-passthrough.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';

/** A full six-block cognitive JSON answer with handle_independently. */
const HANDLE_INDEPENDENTLY_JSON = JSON.stringify({
  situation: { type: 'anomaly', severity: 3, affectedZones: ['region-1'], rootCauseHypothesis: 'temperature breach', confidence: 0.8 },
  goals: [{ goal: 'restore temperature', priority: 2 }],
  actionPlan: { primary: { action: 'handle_independently', reasoning: 'Direct actuator coverage and all required capabilities — rule 4.' } },
  explanation: { summary: 'All EVENT_NEEDS met with COVERAGE=DIRECT — independent handling.', factors: [{ name: 'coverage_direct', weight: 0.9 }] },
  collaboration: { needed: false, reasoning: 'no partner needed' },
  uncertainty: { overall: 0.2, dataQuality: 0.9 },
});

describe('ACNecessityAssessor - precheck Type-A pass-through (R43-B/lever-b)', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  /** Type-A cluster: event in region-1 with a DECLARED requirement the agent fully covers. */
  const createTypeACluster = (): SpatialClusterSummary => ({
    clusterId: 'cluster-a',
    region: { id: 'region-1', center: { x: 50, y: 50 }, radius: 10, type: 'zone' },
    timeWindow: '2026-08-29T10:00:00Z - 2026-08-29T10:05:00Z',
    significance: 'medium',
    summary: 'Temperature breach detected in region-1',
    findings: [{
      eventType: 'temperature.breach',
      count: 1,
      trend: 'increasing',
      anomaly: true,
      details: { severity: 'high', requiredCapabilities: ['temperature-control'] },
    }],
    recommendation: 'immediate_action',
  });

  /** Type-A agent: direct actuator coverage of region-1 + all declared capabilities. */
  const createTypeAAgent = (overrides?: Partial<AgentContext>): AgentContext => ({
    agentId: 'agent-hvac',
    agentName: 'HVACAgent',
    capabilities: ['temperature-control', 'monitoring'],
    availableResources: [
      { deviceId: 'device-1', type: 'thermostat', capabilities: ['temperature-control'] },
    ],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['region-1'],
    ...overrides,
  });

  it('default (no policy): Type-A short-circuits deterministically — zero LLM calls', async () => {
    const result = await assessor.assess(createTypeACluster(), createTypeAAgent());
    expect(result.decision).toBe('handle_independently');
    expect(result.decisionSource).toBe('precheck');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.independent');
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(0);
  });

  it("mode 'off' explicit: byte-equivalent to the default (same source, code, zero LLM calls)", async () => {
    const agent = createTypeAAgent({ precheckPassThrough: { mode: 'off' } });
    const result = await assessor.assess(createTypeACluster(), agent);
    expect(result.decisionSource).toBe('precheck');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.independent');
    expect(result.decision).toBe('handle_independently');
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(0);
  });

  it("mode 'all': the Type-A event runs the LLM lane (decisionSource='llm', passthrough marker)", async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(HANDLE_INDEPENDENTLY_JSON);
    const agent = createTypeAAgent({ precheckPassThrough: { mode: 'all' } });
    const result = await assessor.assess(createTypeACluster(), agent);
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(1);
    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('handle_independently');
    // R43-B observability marker (counts real GT-A×LLM records at export time).
    expect(result.llmAssessment.reasoningCode).toBe('llm.precheck_passthrough');
    expect(result.llmAssessment.reasoningParams).toEqual({ mode: 'all' });
    // The six-block cognitive decision rides the assessment (structured export input).
    expect(result.cognitiveDecision?.actionPlan.primary.action).toBe('handle_independently');
  });

  it("mode 'sample': passes only when the draw is under the rate (deterministic sampler seam)", async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(HANDLE_INDEPENDENTLY_JSON);
    const draws: number[] = [];
    const recordingSampler = () => {
      const d = draws.shift() ?? 0.99;
      return d;
    };

    // draw 0.1 < 0.3 (default rate) → LLM lane
    let a = new ACNecessityAssessor({}, mockLLMClient);
    a.setPrecheckPassThroughSampler(recordingSampler);
    draws.push(0.1);
    let result = await a.assess(createTypeACluster(), createTypeAAgent({ precheckPassThrough: { mode: 'sample' } }));
    expect(result.decisionSource).toBe('llm');
    expect(result.llmAssessment.reasoningCode).toBe('llm.precheck_passthrough');
    expect(result.llmAssessment.reasoningParams).toEqual({ mode: 'sample' });

    // draw 0.5 >= 0.3 → deterministic Type-A short-circuit
    a = new ACNecessityAssessor({}, mockLLMClient);
    a.setPrecheckPassThroughSampler(recordingSampler);
    draws.push(0.5);
    result = await a.assess(createTypeACluster(), createTypeAAgent({ precheckPassThrough: { mode: 'sample' } }));
    expect(result.decisionSource).toBe('precheck');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.independent');
  });

  it("mode 'sample' with explicit rate 1.0: always passes (clamp ceiling)", async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(HANDLE_INDEPENDENTLY_JSON);
    const a = new ACNecessityAssessor({}, mockLLMClient);
    a.setPrecheckPassThroughSampler(() => 0.999);
    const result = await a.assess(
      createTypeACluster(),
      createTypeAAgent({ precheckPassThrough: { mode: 'sample', rate: 1 } }),
    );
    expect(result.decisionSource).toBe('llm');
    expect(result.llmAssessment.reasoningCode).toBe('llm.precheck_passthrough');
  });

  it('guard: rule-only agents never pass through (no LLM configured)', async () => {
    const agent = createTypeAAgent({
      ruleOnlyMode: true,
      precheckPassThrough: { mode: 'all' },
    });
    const result = await assessor.assess(createTypeACluster(), agent);
    // rule-only Type-A: preCheck verdict, source 'rule' (existing behavior).
    expect(result.decisionSource).toBe('rule');
    expect(result.decision).toBe('handle_independently');
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(0);
  });

  it('guard: pass-through never fires for non-Type-A precheck verdicts (Type-E delegate stays precheck)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(HANDLE_INDEPENDENTLY_JSON);
    // Type-E agent: capabilities cover the declared needs but NO actuator
    // coverage of the event zone → precheck.no_coverage_delegate.
    const typeEAgent = createTypeAAgent({
      actuatorZoneIds: ['region-other'],
      precheckPassThrough: { mode: 'all' },
    });
    const result = await assessor.assess(createTypeACluster(), typeEAgent);
    expect(result.decisionSource).toBe('precheck');
    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.no_coverage_delegate');
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(0);
  });

  it('R2-UX-11: no-requirements Type-A flags the i18n context slot instead of empty parens', async () => {
    const noRequirementsCluster = (): SpatialClusterSummary => ({
      ...createTypeACluster(),
      findings: [{
        eventType: 'info.broadcast',
        count: 1,
        trend: 'stable',
        anomaly: false,
        details: { severity: 'low', requiredCapabilities: [] },
      }],
    });
    const result = await assessor.assess(noRequirementsCluster(), createTypeAAgent());
    expect(result.decision).toBe('handle_independently');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.independent');
    // context:'none' lets the client pick the `_none` template (「（）」bug);
    // `required` stays the raw join (empty) for legacy clients.
    expect(result.llmAssessment.reasoningParams).toMatchObject({
      zone: 'region-1',
      required: '',
      context: 'none',
    });
  });

  it('R2-UX-11: a declared-requirements Type-A keeps the base template (no context slot)', async () => {
    const result = await assessor.assess(createTypeACluster(), createTypeAAgent());
    expect(result.llmAssessment.reasoningParams).toEqual({
      zone: 'region-1',
      required: 'temperature-control',
    });
  });

  it('R2-UX-11: ruleOnlyVerdict flags the context slot only on empty requirements', () => {
    const empty = ruleOnlyVerdict(
      { findings: [{ details: { requiredCapabilities: [] } }] },
      ['temperature-control'],
    );
    expect(empty.decision).toBe('handle_independently');
    expect(empty.reasoningCode).toBe('rule.independent');
    expect(empty.reasoningParams).toEqual({ required: '', missing: '', context: 'none' });

    const declared = ruleOnlyVerdict(
      { findings: [{ details: { requiredCapabilities: ['temperature-control'] } }] },
      ['temperature-control'],
    );
    expect(declared.reasoningCode).toBe('rule.independent');
    expect(declared.reasoningParams).toEqual({
      required: 'temperature-control',
      missing: '',
    });
  });
});
