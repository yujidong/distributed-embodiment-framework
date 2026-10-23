/**
 * @vitest-environment node
 *
 * Initiator-side deterministic requiredCapabilities request face (P5
 * metering bridge; 8087 实测: 跨构建 16 起成功 AC 握手只落 1 份 ephemeral
 * 合约 — capability-less / no-match requests are honestly skipped by the
 * ac-agreement-bridge's selectMeteredService).
 *
 * The model decides WHETHER to collaborate; the deterministic layer
 * guarantees WHAT is requested. Precedence on LLM-lane initiate_ac:
 *
 * 1. The model's own collaboration.partnerCapabilities when it named them
 *    (lowercased) — an explicit answer always wins.
 * 2. Otherwise the event's DETERMINISTIC gap needs (computeGapNeeds —
 *    declared ∪ inferred minus own capability coverage, the same
 *    computation partner-summaries' selectRelevant/rankPartners uses). This
 *    REPLACES the raw keyword-inferred table: self-covered needs are not
 *    something to ask a partner for, and the table's generic caps
 *    (monitoring / device-control / emergency-response) match no offer
 *    surface at the bridge.
 * 3. An EMPTY gap (full own coverage, model still insists on AC) stays
 *    empty — there is no honest meter target, so the bridge's skip stands.
 *
 * Non-initiate decisions keep the parse-time face (untouched).
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';

/** 'odd-event' matches no keyword in the inference table → inferred = declared. */
function cluster(overrides: Partial<SpatialClusterSummary> = {}): SpatialClusterSummary {
  return {
    clusterId: 'cluster-1',
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
    ...overrides,
  };
}

/** Direct zone coverage but a declared capability gap → the LLM lane runs. */
function agentCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    agentId: 'agent-1',
    agentName: 'AgentOne',
    capabilities: ['monitoring'],
    availableResources: [],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['region-1'],
    ...overrides,
  };
}

/** Cognitive six-block initiate_ac answer; collaboration block optional. */
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

describe('ACNecessityAssessor — initiator-side requiredCapabilities request face', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  it('cognitive initiate_ac WITHOUT a collaboration block → deterministic gap needs (self-coverage stripped)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveInitiateAC());
    // declared ['cooling', 'ventilation']; the agent self-covers 'cooling'.
    // The raw inferred table would request BOTH — the gap face asks only
    // for what is actually missing.
    const declared = cluster({
      findings: [{
        eventType: 'odd-event',
        count: 1,
        trend: 'stable',
        anomaly: false,
        details: { requiredCapabilities: ['cooling', 'ventilation'] },
      }],
    });

    const result = await assessor.assess(declared, agentCtx({ capabilities: ['cooling'] }));

    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.requiredCapabilities).toEqual(['ventilation']);
  });

  it('legacy binary JSON collaborate answer (no model face exists) → same deterministic gap needs', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      JSON.stringify({ decision: 'collaborate', reasoning: 'need a partner' }),
    );
    const declared = cluster({
      findings: [{
        eventType: 'odd-event',
        count: 1,
        trend: 'stable',
        anomaly: false,
        details: { requiredCapabilities: ['cooling', 'ventilation'] },
      }],
    });

    const result = await assessor.assess(declared, agentCtx({ capabilities: ['cooling'] }));

    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.requiredCapabilities).toEqual(['ventilation']);
  });

  it('gap needs = declared ∪ inferred MINUS own coverage (inferred-only event, partial own coverage)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveInitiateAC());
    // No declared face; a humidity anomaly infers
    // ['dehumidifier-control', 'humidity-control']. The agent self-covers
    // 'humidity-control' (no synonym/substring relation to the dehumidifier
    // cap — pinned against capabilityMatches regressions).
    const inferredOnly = cluster({
      findings: [{
        eventType: 'humidity-spike',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { parameter: 'humidity', newValue: 88 },
      }],
    });

    const result = await assessor.assess(inferredOnly, agentCtx({ capabilities: ['humidity-control'] }));

    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.requiredCapabilities).toEqual(['dehumidifier-control']);
  });

  it('the model\'s explicit partnerCapabilities WIN (lowercased) — no deterministic override', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveInitiateAC(['Ventilation']));

    const result = await assessor.assess(cluster(), agentCtx());

    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.requiredCapabilities).toEqual(['ventilation']);
  });

  it('an explicit EMPTY partnerCapabilities array counts as omitted → deterministic gap needs', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveInitiateAC([]));

    const result = await assessor.assess(cluster(), agentCtx());

    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.requiredCapabilities).toEqual(['cooling']);
  });

  it('empty gap (full own coverage, model still insists on AC) → stays empty; the bridge skip stands', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveInitiateAC());
    // The agent covers the declared 'cooling'; the coordinator role keeps
    // the Type-A short-circuit off so the LLM lane actually runs.
    const result = await assessor.assess(
      cluster(),
      agentCtx({ capabilities: ['cooling', 'monitoring'], decisionRole: 'coordinator' }),
    );

    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.requiredCapabilities).toEqual([]);
  });

  it('non-initiate decisions keep the parse-time face (no gap-face rewrite)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
      situation: { type: 'anomaly', severity: 2, confidence: 0.8 },
      actionPlan: { primary: { action: 'handle_independently', reasoning: 'covered' } },
      uncertainty: { overall: 0.2 },
    }));

    // Coordinator role keeps the LLM lane on (full own coverage would else
    // Type-A short-circuit before the LLM — that deterministic path is not
    // what this suite pins).
    const result = await assessor.assess(
      cluster(),
      agentCtx({ capabilities: ['cooling', 'monitoring'], decisionRole: 'coordinator' }),
    );

    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('handle_independently');
    // Parse-time face (model gave none → inferred table, which carries the
    // declared 'cooling') — the deterministic gap rewrite is initiate_ac-only.
    expect(result.llmAssessment.requiredCapabilities).toEqual(['cooling']);
  });
});

/**
 * Precheck lane alignment: the deterministic initiate_ac verdicts
 * (precheck.sensor_notify / precheck.no_coverage_delegate) carry the SAME
 * gap-needs request face the LLM lane computes (initiatorRequestFace —
 * declared ∪ inferred minus own coverage), not the raw keyword-inferred
 * table. Self-covered needs are not something to ask a partner for.
 */
describe('ACNecessityAssessor — precheck lane requiredCapabilities request face', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  it('sensor_notify: self-covered declared needs are stripped; only the real gap is requested', async () => {
    // Sensor-only agent (no actuator zones) with domain relevance (≥2 of the
    // declared caps) → deterministic precheck.sensor_notify initiate_ac.
    const event = cluster({
      findings: [{
        eventType: 'odd-event',
        count: 1,
        trend: 'stable',
        anomaly: false,
        details: { requiredCapabilities: ['cooling', 'ventilation', 'air-purification'] },
      }],
    });

    const result = await assessor.assess(
      event,
      agentCtx({ actuatorZoneIds: [], capabilities: ['cooling', 'ventilation'] }),
    );

    expect(result.decisionSource).toBe('precheck');
    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.sensor_notify');
    // The raw inferred table would request all three — the gap face asks
    // only for what is actually missing.
    expect(result.llmAssessment.requiredCapabilities).toEqual(['air-purification']);
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(0);
  });

  it('precheck lane === LLM lane for the same event and same own capabilities', async () => {
    const event = cluster({
      findings: [{
        eventType: 'odd-event',
        count: 1,
        trend: 'stable',
        anomaly: false,
        details: { requiredCapabilities: ['cooling', 'ventilation', 'air-purification'] },
      }],
    });
    const ownCapabilities = ['cooling', 'ventilation'];

    // Precheck lane: sensor-only agent → deterministic initiate_ac.
    const precheck = await assessor.assess(
      event,
      agentCtx({ actuatorZoneIds: [], capabilities: ownCapabilities }),
    );
    expect(precheck.decisionSource).toBe('precheck');

    // LLM lane: direct zone coverage + a capability gap → the LLM decides;
    // the model omits partnerCapabilities → deterministic gap-fill.
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveInitiateAC());
    const llm = await assessor.assess(
      event,
      agentCtx({ capabilities: ownCapabilities }),
    );
    expect(llm.decisionSource).toBe('llm');
    expect(llm.decision).toBe('initiate_ac');

    expect(precheck.llmAssessment.requiredCapabilities)
      .toEqual(llm.llmAssessment.requiredCapabilities);
  });

  it('Type-E delegate with full own coverage → empty face; the bridge skip stands', async () => {
    // Actuator agent WITHOUT coverage of the event zone and NO capability
    // gap → precheck.no_coverage_delegate initiate_ac.
    const result = await assessor.assess(
      cluster(),
      agentCtx({ actuatorZoneIds: ['region-other'], capabilities: ['cooling', 'monitoring'] }),
    );

    expect(result.decisionSource).toBe('precheck');
    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.no_coverage_delegate');
    // Old behavior requested the raw inferred table (['cooling']) — a
    // self-covered need. The gap face is honestly empty.
    expect(result.llmAssessment.requiredCapabilities).toEqual([]);
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(0);
  });
});
