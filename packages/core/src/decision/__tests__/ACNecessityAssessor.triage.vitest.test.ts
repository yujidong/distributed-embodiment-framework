/**
 * Integration tests for small-model triage in ACNecessityAssessor (P4-2).
 *
 * No LLM backend: both the big-model client and the triage client are scripted
 * fakes implementing the LLMClient surface the assessor uses
 * (quickChat; the triage fake also carries emitLog/getModel).
 *
 * Covers the deliverable's integration checks:
 * - shadow mode records agreement but NEVER changes the decision
 * - enforce mode skips the big-model call on a trusted 'independent'
 * - enforce mode always falls through on 'collaborate'
 * - trustIndependent: false disables the enforce short-circuit
 * - triage failure falls through to the big model
 * - metrics math (agreement rate, saved %, latency averages)
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { ACNecessityAssessor, type TriageConfig } from '../ACNecessityAssessor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';

// ---------------------------------------------------------------------------
// Scripted fakes
// ---------------------------------------------------------------------------

function makeBigClient(decision: 'collaborate' | 'independent') {
  return {
    quickChat: vi.fn(async () => ({
      content: JSON.stringify({ decision, reasoning: `big says ${decision}` }),
      model: 'big-14b',
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    })),
  } as unknown as LLMClient;
}

function makeTriageClient(impl: () => Promise<unknown>) {
  return {
    quickChat: vi.fn(impl),
    emitLog: vi.fn(),
    getModel: () => 'ac-decision-15b-v2',
  } as unknown as LLMClient & { emitLog: Mock };
}

function triageSays(decision: 'collaborate' | 'independent') {
  return makeTriageClient(async () => ({
    content: JSON.stringify({ decision, reasoning: `triage says ${decision}` }),
    model: 'ac-decision-15b-v2',
  }));
}

// ---------------------------------------------------------------------------
// Fixtures: force the needs_llm path (direct zone coverage + capability gap)
// ---------------------------------------------------------------------------

function clusterForLLM(): SpatialClusterSummary {
  return {
    clusterId: 'cluster-1',
    region: { id: 'region-1', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
    timeWindow: '2024-03-15T10:00:00Z - 2024-03-15T10:05:00Z',
    significance: 'medium',
    summary: 'Generic event requiring LLM evaluation',
    findings: [
      {
        eventType: 'temperature.breach',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { requiredCapabilities: ['cooling'], severity: 'high' },
      },
    ],
    recommendation: 'evaluate_with_llm',
  } as unknown as SpatialClusterSummary;
}

function agentCtx(): AgentContext {
  return {
    agentId: 'agent-1',
    agentName: 'TempAgent',
    capabilities: ['monitoring'], // lacks 'cooling' → Type A preCheck does not fire
    availableResources: [],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['region-1'], // direct coverage → not Type D/E, not sensor-only
  } as AgentContext;
}

function makeAssessor(
  bigClient: LLMClient,
  triage?: TriageConfig,
): ACNecessityAssessor {
  return new ACNecessityAssessor(
    {
      confidenceThreshold: 0.5,
      useStructuredOutput: true,
      ...(triage ? { triage } : {}),
    },
    bigClient,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ACNecessityAssessor — triage (P4-2)', () => {
  it('disabled by default: no triage call, decisionSource llm, no metrics', async () => {
    const big = makeBigClient('collaborate');
    const assessor = makeAssessor(big);

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect(result.decisionSource).toBe('llm');
    expect((big.quickChat as Mock).mock.calls.length).toBe(1);
    expect(assessor.getTriageMetrics()).toBeUndefined();
  });

  it('shadow: records disagreement but keeps the big-model decision', async () => {
    const big = makeBigClient('collaborate');
    const triage = triageSays('independent');
    const assessor = makeAssessor(big, { enabled: true, client: triage, mode: 'shadow' });

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    // Behavior unchanged: big model decided
    expect(result.decision).toBe('initiate_ac');
    expect(result.decisionSource).toBe('llm');
    expect((big.quickChat as Mock).mock.calls.length).toBe(1);
    expect((triage.quickChat as Mock).mock.calls.length).toBe(1);

    const m = assessor.getTriageMetrics()!;
    expect(m.triageCalls).toBe(1);
    expect(m.disagreements).toBe(1);
    expect(m.agreements).toBe(0);
    expect(m.agreementRate).toBe(0);
    expect(m.bigModelCalls).toBe(1);
    expect(m.bigModelCallsSaved).toBe(0);

    // Triage outcome logged additively via the triage client's emitLog
    expect(triage.emitLog).toHaveBeenCalledTimes(1);
    const entry = triage.emitLog.mock.calls[0][0] as any;
    expect(entry.context.triage).toEqual({
      decision: 'independent',
      agreed: false,
      latencyMs: expect.any(Number),
    });
    expect(entry.context.interactionType).toBe('ac_decision_triage');
    expect(entry.model).toBe('ac-decision-15b-v2');
  });

  it('shadow: agreement is recorded when decisions match', async () => {
    const big = makeBigClient('collaborate');
    const assessor = makeAssessor(big, { enabled: true, client: triageSays('collaborate'), mode: 'shadow' });

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect(result.decision).toBe('initiate_ac');
    const m = assessor.getTriageMetrics()!;
    expect(m.agreements).toBe(1);
    expect(m.agreementRate).toBe(1);
  });

  it('enforce: trusted triage independent skips the big-model call', async () => {
    const big = makeBigClient('collaborate'); // would disagree — must NOT be consulted
    const triage = triageSays('independent');
    const assessor = makeAssessor(big, { enabled: true, client: triage, mode: 'enforce' });

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect((big.quickChat as Mock).mock.calls.length).toBe(0);
    expect(result.decisionSource).toBe('triage');
    // T-203: agent lacks 'cooling' → the binary independent answer cannot
    // express "not my responsibility", so a capability mismatch resolves to
    // 'defer' (needs review) — NEVER 'ignore' (ignore stays reserved for the
    // deterministic Type D precheck).
    expect(result.decision).toBe('defer');
    expect(result.llmAssessment.reasoning).toContain('[triage]');

    const m = assessor.getTriageMetrics()!;
    expect(m.bigModelCalls).toBe(0);
    expect(m.bigModelCallsSaved).toBe(1);
    expect(m.bigModelCallSaveRate).toBe(1);
    expect(m.agreementRate).toBeNull(); // big model never asked → no comparison

    const entry = triage.emitLog.mock.calls[0][0] as any;
    expect(entry.context.triage.decision).toBe('independent');
    expect(entry.context.triage.agreed).toBeUndefined();
  });

  it('enforce: triage collaborate ALWAYS falls through to the big model', async () => {
    const big = makeBigClient('collaborate');
    const assessor = makeAssessor(big, { enabled: true, client: triageSays('collaborate'), mode: 'enforce' });

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect((big.quickChat as Mock).mock.calls.length).toBe(1);
    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('initiate_ac');
    expect(assessor.getTriageMetrics()!.bigModelCallsSaved).toBe(0);
  });

  it('enforce + trustIndependent:false never skips the big model', async () => {
    const big = makeBigClient('collaborate');
    const assessor = makeAssessor(big, {
      enabled: true,
      client: triageSays('independent'),
      mode: 'enforce',
      trustIndependent: false,
    });

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect((big.quickChat as Mock).mock.calls.length).toBe(1);
    expect(result.decisionSource).toBe('llm');
    expect(result.decision).toBe('initiate_ac');
    expect(assessor.getTriageMetrics()!.bigModelCallsSaved).toBe(0);
  });

  it('triage failure falls through to the big model and counts an error', async () => {
    const big = makeBigClient('collaborate');
    const failingTriage = makeTriageClient(async () => { throw new Error('triage down'); });
    const assessor = makeAssessor(big, { enabled: true, client: failingTriage, mode: 'enforce' });

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect((big.quickChat as Mock).mock.calls.length).toBe(1);
    expect(result.decisionSource).toBe('llm');
    const m = assessor.getTriageMetrics()!;
    expect(m.triageErrors).toBe(1);
    expect(m.triageCalls).toBe(0);
  });

  it('metrics math: agreement rate, save rate, latency averages over mixed outcomes', async () => {
    const big = makeBigClient('collaborate');
    // Sequence: disagree (independent vs collaborate), agree, enforce-skip
    const triageClient = makeTriageClient(async () => ({
      content: JSON.stringify({ decision: 'independent', reasoning: 't' }),
      model: 'm',
    }));
    const assessor = makeAssessor(big, { enabled: true, client: triageClient, mode: 'shadow' });

    await assessor.assess(clusterForLLM(), agentCtx()); // disagree

    (triageClient.quickChat as Mock).mockImplementation(async () => ({
      content: JSON.stringify({ decision: 'collaborate', reasoning: 't' }),
      model: 'm',
    }));
    await assessor.assess(clusterForLLM(), agentCtx()); // agree

    let m = assessor.getTriageMetrics()!;
    expect(m.agreementRate).toBe(0.5);
    expect(m.bigModelCalls).toBe(2);
    expect(m.avgTriageLatencyMs).not.toBeNull();
    expect(m.avgBigModelLatencyMs).not.toBeNull();
    expect(m.latencyDeltaMs).toBe(m.avgBigModelLatencyMs! - m.avgTriageLatencyMs!);

    // Now flip to enforce with a fresh assessor: one skip + one fall-through
    const big2 = makeBigClient('collaborate');
    const triage2 = triageSays('independent');
    const assessor2 = makeAssessor(big2, { enabled: true, client: triage2, mode: 'enforce' });
    await assessor2.assess(clusterForLLM(), agentCtx()); // skip
    (triage2.quickChat as Mock).mockImplementation(async () => ({
      content: JSON.stringify({ decision: 'collaborate', reasoning: 't' }),
      model: 'm',
    }));
    await assessor2.assess(clusterForLLM(), agentCtx()); // fall through

    m = assessor2.getTriageMetrics()!;
    expect(m.bigModelCallsSaved).toBe(1);
    expect(m.bigModelCalls).toBe(1);
    expect(m.bigModelCallSaveRate).toBe(0.5);
  });

  it('manager-level getter: DualTriggerACManager.getStats().triage', async () => {
    // Verified indirectly: the assessor's metrics object is what the manager
    // re-exports — assert the shape the manager snapshot aggregation needs.
    const big = makeBigClient('independent');
    const assessor = makeAssessor(big, { enabled: true, client: triageSays('independent'), mode: 'shadow' });
    await assessor.assess(clusterForLLM(), agentCtx());

    const m = assessor.getTriageMetrics()!;
    for (const key of [
      'triageCalls', 'triageErrors', 'agreements', 'disagreements', 'agreementRate',
      'bigModelCalls', 'bigModelCallsSaved', 'bigModelCallSaveRate',
      'avgTriageLatencyMs', 'avgBigModelLatencyMs', 'latencyDeltaMs',
    ]) {
      expect(m).toHaveProperty(key);
    }
  });
});
