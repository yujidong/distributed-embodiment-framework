/**
 * @vitest-environment node
 *
 * T-022 (DevLoop R17, R10 ED-F01): bounded degradation policy for LLM-backed
 * AC necessity decisions.
 *
 * Dead-backend pattern (fake-LLM dead-port): the mock client rejects with
 * the ECONNREFUSED signature the real provider produces. The policy:
 *   1. bounded retry for TRANSIENT errors only (permanent = no retry);
 *   2. honest degradation — the decision IS recorded (decisionSource
 *      'rule-llm-down', provider error in the reasoning, deterministic
 *      capability-rule verdict) — never the pre-T-022 silent drop where a
 *      dead backend left every LLM-needing event with NO decision record.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import type { AgentContext } from '../ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';

/** The dead-port error the providers actually surface (R10 ED-F01). */
const deadPortError = () =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });

/** Cluster + context forcing preCheck to fall through to the LLM path. */
const llmBoundSummary = {
  clusterId: 'cluster-t022',
  region: { id: 'region-t022', center: { x: 10, y: 10 }, radius: 15, type: 'zone' },
  timeWindow: new Date().toISOString(),
  significance: 'medium',
  summary: 'Cluster needing LLM evaluation',
  findings: [{
    eventType: 'device.anomaly',
    count: 1,
    trend: 'rising',
    anomaly: true,
    details: { requiredCapabilities: ['plumbing-repair'] },
  }],
  recommendation: 'evaluate_with_llm',
} as unknown as SpatialClusterSummary;

const llmBoundContext = {
  agentId: 'agent-t022',
  agentName: 'T022Agent',
  capabilities: ['temperature-control'], // gap vs plumbing-repair → rule says defer
  availableResources: [],
  currentWorkload: 'idle',
  recentCollaborations: [],
  currentCollaborations: 0,
  actuatorZoneIds: ['region-t022'],
} as unknown as AgentContext;

const CANNED_LLM_ANSWER = JSON.stringify({
  needsCollaboration: false,
  reasoning: 'healthy backend',
  urgency: 'low',
  suggestedPartnerTypes: [],
  requiredCapabilities: [],
  confidence: 0.9,
  estimatedDuration: 1000,
  potentialRisks: [],
});

function deadBackendClient(): { client: LLMClient; quickChat: Mock } {
  const quickChat = vi.fn().mockRejectedValue(deadPortError());
  return { client: { quickChat } as unknown as LLMClient, quickChat };
}

describe('ACNecessityAssessor bounded degradation (T-022)', () => {
  it('default policy: transient failure → ONE retry → honest rule fallback, never a throw', async () => {
    const { client, quickChat } = deadBackendClient();
    const assessor = new ACNecessityAssessor(
      { llmRetryBackoffMs: 5 }, // default policy: rule-fallback; default retries: 1
      client,
    );

    const assessment = await assessor.assess(llmBoundSummary, llmBoundContext);

    // Bounded retry: initial attempt + 1 retry, no more.
    expect(quickChat).toHaveBeenCalledTimes(2);
    // The decision is RECORDED with the degradation named.
    expect(assessment.decision).toBe('defer'); // capability gap → deterministic rule
    expect(assessment.decisionSource).toBe('rule-llm-down');
    expect(assessment.llmAssessment.reasoning).toMatch(/ECONNREFUSED .*127\.0\.0\.1:1/);
    expect(assessment.llmAssessment.reasoning).toMatch(/2 attempt\(s\)/);
    // R15-D3 structured twin for downstream localization.
    expect(assessment.llmAssessment.reasoningCode).toBe('rule.llm_down');
    // T-105 observability still counts the failure.
    expect(assessor.getStats().llmErrors).toBe(1);
  });

  it('a recovered retry decides via the LLM (no failure recorded)', async () => {
    const quickChat = vi.fn()
      .mockRejectedValueOnce(deadPortError())
      .mockResolvedValue(CANNED_LLM_ANSWER);
    const assessor = new ACNecessityAssessor(
      { llmRetryBackoffMs: 5 },
      { quickChat } as unknown as LLMClient,
    );

    const assessment = await assessor.assess(llmBoundSummary, llmBoundContext);
    expect(quickChat).toHaveBeenCalledTimes(2);
    expect(assessment.decisionSource).toBe('llm');
    expect(assessor.getStats().llmErrors).toBe(0);
  });

  it('permanent errors (401) are NOT retried but still degrade honestly', async () => {
    const quickChat = vi.fn().mockRejectedValue(
      new Error('API request failed: 401 Unauthorized'),
    );
    const assessor = new ACNecessityAssessor(
      { llmRetryBackoffMs: 5 },
      { quickChat } as unknown as LLMClient,
    );

    const assessment = await assessor.assess(llmBoundSummary, llmBoundContext);
    expect(quickChat).toHaveBeenCalledTimes(1);
    expect(assessment.decisionSource).toBe('rule-llm-down');
    expect(assessment.llmAssessment.reasoning).toMatch(/401 Unauthorized/);
    expect(assessor.getStats().llmErrors).toBe(1);
  });

  it("retries: 0 disables the retry loop (single attempt)", async () => {
    const { client, quickChat } = deadBackendClient();
    const assessor = new ACNecessityAssessor(
      { maxRetries: 0, llmRetryBackoffMs: 5 },
      client,
    );

    const assessment = await assessor.assess(llmBoundSummary, llmBoundContext);
    expect(quickChat).toHaveBeenCalledTimes(1);
    expect(assessment.decisionSource).toBe('rule-llm-down');
    expect(assessment.llmAssessment.reasoning).toMatch(/1 attempt\(s\)/);
  });

  it("policy 'drop' restores the pre-T-022 re-throw (evaluation control arm)", async () => {
    const { client, quickChat } = deadBackendClient();
    const assessor = new ACNecessityAssessor(
      { llmFailurePolicy: 'drop', maxRetries: 0 },
      client,
    );

    await expect(assessor.assess(llmBoundSummary, llmBoundContext))
      .rejects.toThrow(/LLM assessment failed for cluster cluster-t022: connect ECONNREFUSED/);
    expect(assessor.getStats().llmErrors).toBe(1);
  });

  it('the degraded record is API-shaped: risk note + structured twin + capability gap named', async () => {
    const { client } = deadBackendClient();
    const assessor = new ACNecessityAssessor({ llmRetryBackoffMs: 5 }, client);

    const assessment = await assessor.assess(llmBoundSummary, llmBoundContext);
    expect(assessment.llmAssessment.potentialRisks).toEqual([
      'decision made without LLM evaluation — provider was down',
    ]);
    expect(assessment.llmAssessment.requiredCapabilities).toContain('plumbing-repair');
    // The capability inference derives a broader class set than the finding's
    // explicit requirement — the GAP is named, exact membership is the rule's.
    expect(assessment.llmAssessment.reasoningParams).toMatchObject({ attempts: 2 });
    expect(String(assessment.llmAssessment.reasoningParams?.missing)).toContain('plumbing-repair');
  });
});
