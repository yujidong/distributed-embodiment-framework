/**
 * @vitest-environment node
 *
 * R45-P1 (F4): decisionRole 'coordinator' — a dispatcher (municipal /
 * regional center) is never Type-A short-circuited into
 * 'handle_independently' by precheck, even when it holds actuators in the
 * event zone and covers every declared capability. Its bound devices are
 * REPRESENTATIVE reach, not an execution mandate; the LLM lane must decide
 * so cross-zone dispatch ("市级点将") stays possible
 * (docs/devloop-r45-realistic-report.md §2.4 finding 1).
 *
 * Executors (role absent) keep the deterministic Type-A short-circuit.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';

/** A six-block cognitive JSON answer that dispatches (initiate_ac). */
const COLLABORATE_JSON = JSON.stringify({
  situation: { type: 'emergency', severity: 4, affectedZones: ['nan-substation'], rootCauseHypothesis: 'load gap after transfer', confidence: 0.85 },
  goals: [{ goal: 'cover the Nanshan load gap', priority: 4 }],
  actionPlan: {
    primary: {
      action: 'initiate_ac',
      reasoning: 'I dispatch — mobilize the adjacent corridor (Bao\'an) generators.',
      collaboration: { partnerCapabilities: ['power-monitoring', 'load-management'] },
    },
  },
  explanation: { summary: 'Coordinator role: cross-zone dispatch.', factors: [{ name: 'safety', weight: 0.9 }] },
  collaboration: { needed: true, partnerType: 'substation-keeper', reasoning: 'cross-zone support' },
  uncertainty: { overall: 0.2, dataQuality: 0.9 },
});

describe('ACNecessityAssessor - decisionRole coordinator (R45-P1)', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  /**
   * The nan-load-gap shape: event in nan-substation; the agent (city-energy)
   * holds the nan-substation generator (actuator coverage) and covers every
   * declared capability — classic Type-A for an EXECUTOR.
   */
  const createCluster = (): SpatialClusterSummary => ({
    clusterId: 'cluster-nan-load-gap',
    region: { id: 'nan-substation', center: { x: 50, y: 50 }, radius: 10, type: 'zone' },
    timeWindow: '2026-08-29T10:00:00Z - 2026-08-29T10:05:00Z',
    significance: 'high',
    summary: 'Nanshan 35% load gap after transfer — backup generator support needed',
    findings: [{
      eventType: 'load.gap',
      count: 1,
      trend: 'increasing',
      anomaly: true,
      details: { severity: 'high', requiredCapabilities: ['power-monitoring', 'load-management'] },
    }],
    recommendation: 'immediate_action',
  });

  const createAgent = (overrides?: Partial<AgentContext>): AgentContext => ({
    agentId: 'city-energy',
    agentName: '市电网调度中心',
    capabilities: ['power-monitoring', 'energy-monitoring', 'turn-on', 'turn-off', 'load-management'],
    availableResources: [
      { deviceId: 'nan-substation-g1', type: 'generator', capabilities: ['turn-on'] },
    ],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['bao-substation', 'nan-substation'],
    ...overrides,
  });

  it('executor (role absent): Type-A still short-circuits deterministically — zero LLM calls', async () => {
    const result = await assessor.assess(createCluster(), createAgent());
    expect(result.decision).toBe('handle_independently');
    expect(result.decisionSource).toBe('precheck');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.independent');
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(0);
  });

  it("coordinator: the SAME Type-A event is NOT short-circuited — the LLM lane decides", async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(COLLABORATE_JSON);
    const result = await assessor.assess(
      createCluster(),
      createAgent({ decisionRole: 'coordinator' }),
    );
    // The LLM was consulted — 市级点将 stays possible.
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(1);
    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.reasoningCode).not.toBe('precheck.independent');
  });

  it("coordinator + LLM says handle_independently: the answer is the model's (LLM lane, no precheck stamp)", async () => {
    const HANDLE_JSON = JSON.stringify({
      situation: { type: 'anomaly', severity: 3, affectedZones: ['nan-substation'], rootCauseHypothesis: 'load gap', confidence: 0.8 },
      goals: [{ goal: 'cover the gap', priority: 3 }],
      actionPlan: { primary: { action: 'handle_independently', reasoning: 'Representative device suffices here.' } },
      explanation: { summary: 'Local handling is enough.', factors: [{ name: 'cost', weight: 0.4 }] },
      collaboration: { needed: false, reasoning: 'no partner needed' },
      uncertainty: { overall: 0.2, dataQuality: 0.9 },
    });
    (mockLLMClient.quickChat as Mock).mockResolvedValue(HANDLE_JSON);
    const result = await assessor.assess(
      createCluster(),
      createAgent({ decisionRole: 'coordinator' }),
    );
    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('handle_independently');
  });

  it('coordinator does NOT touch the no-coverage paths (Type-E delegate and the praised defer stay precheck)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(COLLABORATE_JSON);
    // Event OUTSIDE the coordinator's actuator reach, capabilities complete
    // → Type E initiate_ac (precheck) — unchanged by the role.
    const outside = await assessor.assess(
      createCluster(),
      createAgent({ decisionRole: 'coordinator', actuatorZoneIds: ['sz-city-command'] }),
    );
    expect(outside.decisionSource).toBe('precheck');
    expect(outside.decision).toBe('initiate_ac');
    expect(outside.llmAssessment.reasoningCode).toBe('precheck.no_coverage_delegate');
    expect((mockLLMClient.quickChat as Mock).mock.calls).toHaveLength(0);
  });

  it('the coordinator role rides the LLM prompt (ROLE: COORDINATOR)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(COLLABORATE_JSON);
    await assessor.assess(createCluster(), createAgent({ decisionRole: 'coordinator' }));
    const prompt = String((mockLLMClient.quickChat as Mock).mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('ROLE: COORDINATOR');
    // Executors must NOT see the line (byte-stability for the legacy shape).
    await assessor.assess(createCluster(), createAgent());
    const executorPrompt = String((mockLLMClient.quickChat as Mock).mock.calls[1]?.[0] ?? '');
    expect(executorPrompt).not.toContain('ROLE: COORDINATOR');
  });
});
