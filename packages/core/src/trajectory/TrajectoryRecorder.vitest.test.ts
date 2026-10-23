/**
 * @vitest-environment node
 *
 * TrajectoryRecorder unit tests (T-014 regression): the `correct` verdict
 * must be meaningful — true when the decision matches ground truth, false
 * when it contradicts it, and null (unscored) when the run had no ground
 * truth at all. Deterministic decisions (precheck/rule) must not consume
 * LLM calls from the join pool, so their model attribution stays truthful.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrajectoryRecorder, type TrajectoryLLMCall } from './index.js';
import type { ACNecessityAssessment } from '../decision/ACNecessityAssessor.js';
import { parseCognitiveDecision } from '../decision/cognitive-decision.js';
import type { SystemEvent } from '../events/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeRecorder(): TrajectoryRecorder {
  const dir = mkdtempSync(join(tmpdir(), 'trajectory-recorder-test-'));
  tempDirs.push(dir);
  return new TrajectoryRecorder({
    outputDir: dir,
    condition: 'test',
    scenario: 'unit',
    iteration: 0,
    model: 'test-model',
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeAssessment(
  decision: ACNecessityAssessment['decision'],
  decisionSource: ACNecessityAssessment['decisionSource'],
): ACNecessityAssessment {
  return {
    clusterSummary: {} as ACNecessityAssessment['clusterSummary'],
    agentContext: {
      agentId: 'agent-1',
      agentName: 'Agent One',
      capabilities: ['temperature-control'],
    } as ACNecessityAssessment['agentContext'],
    llmAssessment: {
      needsCollaboration: false,
      reasoning: 'unit test',
      urgency: 'medium',
      suggestedPartnerTypes: [],
      requiredCapabilities: [],
      confidence: 1,
      estimatedDuration: 0,
      potentialRisks: [],
    },
    decision,
    decisionSource,
    timestamp: new Date(),
  };
}

function makeEvent(eventId: string): SystemEvent {
  return {
    id: `evt-${eventId}`,
    type: 'ENVIRONMENT_PARAM_CHANGED' as SystemEvent['type'],
    source: 'test',
    timestamp: new Date(),
    payload: { eventId, zoneId: 'zone-a' },
    metadata: { eventId },
  } as SystemEvent;
}

function readRecords(recorder: TrajectoryRecorder): Array<Record<string, any>> {
  // Living-worlds P2: the recorder appends to the ACTIVE segment and no
  // longer creates an empty file eagerly — "no records yet" is a missing
  // file, not an empty one.
  let raw: string;
  try {
    raw = readFileSync(recorder.filePath, 'utf-8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

const llmCall = (model: string, eventId: string, agentId = 'agent-1'): TrajectoryLLMCall => ({
  userPrompt: `AGENT: Agent One | event ${eventId}`,
  response: '{"decision":"collaborate"}',
  durationMs: 5,
  model,
  success: true,
  context: { eventId, agentId },
});

// ---------------------------------------------------------------------------
// Correctness verdict
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder correctness verdict (T-014)', () => {
  it('scores correct:true when the decision matches the ground truth', () => {
    const recorder = makeRecorder();
    recorder.recordAssessment('agent-1', makeAssessment('initiate_ac', 'llm'), makeEvent('evt-1'));
    recorder.recordOutcome({
      eventId: 'evt-1',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'B' },
    });

    const [record] = readRecords(recorder);
    expect(record.correct).toBe(true);
  });

  it('scores correct:false when the decision contradicts the ground truth', () => {
    const recorder = makeRecorder();
    recorder.recordAssessment('agent-1', makeAssessment('defer', 'llm'), makeEvent('evt-1'));
    recorder.recordOutcome({
      eventId: 'evt-1',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'B' },
    });

    const [record] = readRecords(recorder);
    expect(record.correct).toBe(false);
  });

  it('marks decisions without ground truth unscored (null), not false', () => {
    const recorder = makeRecorder();
    recorder.recordAssessment('agent-1', makeAssessment('handle_independently', 'rule'), makeEvent('evt-1'));
    recorder.recordOutcome({
      eventId: 'evt-1',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'unknown', interactionType: 'unknown' },
    });

    const [record] = readRecords(recorder);
    // Unscored is an explicit null verdict — never a false "wrong" answer.
    expect(record.correct).toBeNull();
  });

  it('marks collaboration-response records unscored (null)', () => {
    const recorder = makeRecorder();
    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'agent-2',
      decision: 'accept',
      decisionSource: 'llm',
    });

    const [record] = readRecords(recorder);
    expect(record.kind).toBe('collaboration-response');
    expect(record.correct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-202 — honest handshake records (responder context)
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder collaboration-response context (T-202)', () => {
  it('persists the enriched responder context when supplied', () => {
    const recorder = makeRecorder();
    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'facility-agent',
      decision: 'accept',
      decisionSource: 'llm',
      context: {
        providerAgentId: 'facility-agent',
        capabilities: ['facility-management', 'cooling', 'heating'],
        partnerServices: [
          { serviceName: 'Office B HVAC Unit Service', capabilities: ['cooling'], providerAgentId: 'sec-agent' },
        ],
      },
    });

    const [record] = readRecords(recorder);
    expect(record.kind).toBe('collaboration-response');
    expect(record.context.capabilities).toEqual(['facility-management', 'cooling', 'heating']);
    expect(record.context.partnerServicesTotal).toBe(1);
    expect(record.context.partnerServices[0].serviceName).toBe('Office B HVAC Unit Service');
  });

  it('recordHandshakeToTrajectory threads the answer event responderContext into the record', async () => {
    const { recordHandshakeToTrajectory } = await import('../runtime/shaping/collaboration.js');
    const recorder = makeRecorder();
    const accepts: unknown[] = [];
    const recorderLike = {
      recordCollaborationResponse(input: unknown) {
        accepts.push(input);
        return recorder.recordCollaborationResponse(input as Parameters<TrajectoryRecorder['recordCollaborationResponse']>[0]);
      },
    };

    const event = {
      id: 'evt-9',
      type: 'COLLABORATION_MESSAGE',
      source: 'facility-agent',
      timestamp: new Date(),
      payload: {
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'facility-agent',
        collaborationId: 'ac-9',
        reason: 'my HVAC can cool the zone',
        evaluationSource: 'llm',
        responderContext: {
          providerAgentId: 'facility-agent',
          capabilities: ['cooling', 'heating'],
          devices: [{ id: 'hvac-1', name: 'Office A HVAC Unit', capabilities: ['cooling'] }],
        },
      },
      metadata: {},
    } as unknown as SystemEvent;

    recordHandshakeToTrajectory(recorderLike, event, 'evt-9');

    expect(accepts).toHaveLength(1);
    const input = accepts[0] as { context?: { devices?: unknown; providerAgentId?: unknown } };
    // T-054: the shaping seam THREADS devices + providerAgentId (pre-fix it
    // parsed only capabilities/providerAgentId and dropped devices).
    expect(input.context?.providerAgentId).toBe('facility-agent');
    expect(input.context?.devices).toEqual([
      { id: 'hvac-1', name: 'Office A HVAC Unit', capabilities: ['cooling'] },
    ]);
    const [record] = readRecords(recorder);
    expect(record.context.capabilities).toEqual(['cooling', 'heating']);
    expect(record.context.partnerServicesTotal).toBe(0);
    // T-054: the record carries the honest surface — devices + provider.
    expect(record.context.providerAgentId).toBe('facility-agent');
    expect(record.context.devices).toEqual([
      { id: 'hvac-1', name: 'Office A HVAC Unit', capabilities: ['cooling'] },
    ]);
  });

  it('T-054: device zoneIds ride along and malformed device lists are omitted honestly', async () => {
    const { recordHandshakeToTrajectory } = await import('../runtime/shaping/collaboration.js');
    const recorder = makeRecorder();
    const base = {
      id: 'evt-11',
      type: 'COLLABORATION_MESSAGE',
      source: 'agent-z',
      timestamp: new Date(),
      metadata: {},
    };
    const accept = (responderContext: unknown) => ({
      ...base,
      payload: {
        type: 'join-response', acDecision: 'accept', agentId: 'agent-z',
        collaborationId: 'ac-11', responderContext,
      },
    } as unknown as SystemEvent);

    recordHandshakeToTrajectory(
      { recordCollaborationResponse: i => recorder.recordCollaborationResponse(i as Parameters<TrajectoryRecorder['recordCollaborationResponse']>[0]) },
      accept({ providerAgentId: 'agent-z', devices: [{ id: 'd1', name: 'Meter', capabilities: ['energy-monitoring'], zoneId: 'zone-a' }] }),
      undefined,
    );
    recordHandshakeToTrajectory(
      { recordCollaborationResponse: i => recorder.recordCollaborationResponse(i as Parameters<TrajectoryRecorder['recordCollaborationResponse']>[0]) },
      accept({ providerAgentId: 'agent-z', devices: [{ id: 'd2', name: 'Broken', capabilities: 'not-an-array' }] }),
      undefined,
    );

    const [zoned, malformed] = readRecords(recorder);
    expect(zoned.context.devices).toEqual([
      { id: 'd1', name: 'Meter', capabilities: ['energy-monitoring'], zoneId: 'zone-a' },
    ]);
    // Malformed list → devices omitted (undefined), not a garbage record.
    expect(malformed.context.devices).toBeUndefined();
  });

  it('T-054: write-time caps bound devices (20) and partnerServices (50); totals stay honest', () => {
    const recorder = makeRecorder();
    recorder.recordCollaborationResponse({
      collaborationId: 'ac-12',
      agentId: 'agent-b',
      decision: 'accept',
      decisionSource: 'rule',
      context: {
        devices: Array.from({ length: 25 }, (_, i) => ({
          id: `dev-${i}`, name: `Device ${i}`, capabilities: ['turn-on'],
        })),
        partnerServices: Array.from({ length: 60 }, (_, i) => ({
          serviceName: `svc-${i}`, capabilities: ['cooling'], providerAgentId: 'p1',
        })),
      },
    });
    const [record] = readRecords(recorder);
    expect(record.context.devices).toHaveLength(20);
    expect(record.context.partnerServices).toHaveLength(50);
    expect(record.context.partnerServicesTotal).toBe(60);
  });

  it('keeps empty context only when genuinely unknown (no responderContext on the event)', async () => {
    const { recordHandshakeToTrajectory } = await import('../runtime/shaping/collaboration.js');
    const recorder = makeRecorder();
    const event = {
      id: 'evt-10',
      type: 'COLLABORATION_MESSAGE',
      source: 'agent-x',
      timestamp: new Date(),
      payload: { type: 'reject', acDecision: 'reject', agentId: 'agent-x', collaborationId: 'ac-10' },
      metadata: {},
    } as unknown as SystemEvent;

    recordHandshakeToTrajectory(
      { recordCollaborationResponse: i => recorder.recordCollaborationResponse(i as Parameters<TrajectoryRecorder['recordCollaborationResponse']>[0]) },
      event,
      undefined,
    );

    const [record] = readRecords(recorder);
    expect(record.context.capabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LLM-call attribution
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder LLM-call attribution (T-014)', () => {
  it('attributes an llm decision to the model of its matched call', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(llmCall('qwen3-vl:8b', 'evt-1'));
    recorder.recordAssessment('agent-1', makeAssessment('initiate_ac', 'llm'), makeEvent('evt-1'));
    recorder.recordOutcome({
      eventId: 'evt-1',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'B' },
    });

    const [record] = readRecords(recorder);
    expect(record.decisionSource).toBe('llm');
    expect(record.model).toBe('qwen3-vl:8b');
    expect(record.prompt.userPrompt).toContain('AGENT: Agent One');
  });

  it('does not let precheck/rule decisions consume LLM calls (model stays omitted)', () => {
    const recorder = makeRecorder();
    // A call exists for the same event — a rule-only agent in a mixed
    // runtime must not nearest-match it and misattribute its model.
    recorder.recordLLMCall(llmCall('big-model', 'evt-1'));
    recorder.recordAssessment('agent-1', makeAssessment('handle_independently', 'precheck'), makeEvent('evt-1'));
    recorder.recordOutcome({
      eventId: 'evt-1',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'handle_independently', interactionType: 'A' },
    });
    recorder.recordAssessment('agent-1', makeAssessment('defer', 'rule'), makeEvent('evt-2'));
    recorder.recordOutcome({
      eventId: 'evt-2',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'defer', interactionType: 'D' },
    });

    const [precheck, rule] = readRecords(recorder);
    expect(precheck.decisionSource).toBe('precheck');
    expect(precheck.model).toBeUndefined();
    expect(precheck.prompt).toBeUndefined();
    expect(rule.decisionSource).toBe('rule');
    expect(rule.model).toBeUndefined();
    expect(rule.prompt).toBeUndefined();
  });

  it('T-024-part3: rides the parse-quality marker (decisionSubSource) beside the decision', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(llmCall('big-model', 'evt-1'));
    const assessment = makeAssessment('initiate_ac', 'llm');
    assessment.llmAssessment = {
      ...assessment.llmAssessment,
      decisionSubSource: 'llm-fsm', // prose scanner recovered this answer
    };
    recorder.recordAssessment('agent-1', assessment, makeEvent('evt-1'));
    recorder.recordOutcome({
      eventId: 'evt-1',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'B' },
    });

    const [record] = readRecords(recorder);
    expect(record.decisionSource).toBe('llm');
    expect(record.decisionSubSource).toBe('llm-fsm');

    // Non-LLM records never carry the marker (no big-model parse happened).
    recorder.recordAssessment('agent-1', makeAssessment('defer', 'rule'), makeEvent('evt-2'));
    recorder.recordOutcome({
      eventId: 'evt-2',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'defer', interactionType: 'D' },
    });
    const [, ruleRecord] = readRecords(recorder);
    expect(ruleRecord.decisionSubSource).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Collaboration-response LLM-call attribution (R81-D2 / R44-F4)
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder collaboration-response LLM attribution (R81-D2)', () => {
  /** The responder's evaluation call (CollaborationProposalHandler prompt). */
  const evaluationCall = (model: string, durationMs: number): TrajectoryLLMCall => ({
    userPrompt: 'COLLABORATION PROPOSAL EVALUATION\n\nYOUR PROFILE:\n- Agent: Agent Two',
    response: '{"recommendedDecision":"accept"}',
    durationMs,
    model,
    success: true,
    context: {},
  });

  it('an llm-sourced answer claims its evaluation call — model + durationMs ride the record', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(evaluationCall('ac-decision-v5', 1234));

    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'agent-2',
      decision: 'accept',
      decisionSource: 'llm',
      eventId: 'evt-heat-1',
    });

    const [record] = readRecords(recorder);
    expect(record.kind).toBe('collaboration-response');
    expect(record.decisionSource).toBe('llm');
    expect(record.model).toBe('ac-decision-v5');
    expect(record.durationMs).toBe(1234);
  });

  it('rule/fallback/timeout answers never consume an evaluation call', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(evaluationCall('ac-decision-v5', 1234));

    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'agent-2',
      decision: 'accept',
      decisionSource: 'fallback',
      eventId: 'evt-heat-1',
    });

    const [record] = readRecords(recorder);
    expect(record.decisionSource).toBe('fallback');
    expect(record.model).toBeUndefined();
    expect(record.durationMs).toBeUndefined();

    // The unconsumed call is still matchable by the NEXT llm-sourced answer
    // (fallback did not steal it).
    recorder.recordCollaborationResponse({
      collaborationId: 'ac-2',
      agentId: 'agent-2',
      decision: 'reject',
      decisionSource: 'llm',
      eventId: 'evt-heat-2',
    });
    const [, second] = readRecords(recorder);
    expect(second.model).toBe('ac-decision-v5');
    expect(second.durationMs).toBe(1234);
  });

  it('an evaluation call is consumed once — a second answer does not re-attribute it', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(evaluationCall('ac-decision-v5', 100));

    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'agent-2',
      decision: 'accept',
      decisionSource: 'llm',
      eventId: 'evt-1',
    });
    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'agent-3',
      decision: 'accept',
      decisionSource: 'llm',
      eventId: 'evt-1',
    });

    const [first, second] = readRecords(recorder);
    expect(first.durationMs).toBe(100);
    expect(second.durationMs).toBeUndefined();
    expect(second.model).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failed-call flush (T-105)
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder failed-call flush (T-105)', () => {
  it('writes a failed LLM call through immediately with the error message', () => {
    const recorder = makeRecorder();

    recorder.recordLLMCall({
      userPrompt: 'AGENT: Agent One | assess cluster',
      response: '',
      durationMs: 12,
      model: 'test-model',
      success: false,
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:11434',
      context: { eventId: 'evt-9', agentId: 'agent-1' },
    });

    // No assessment/outcome will ever claim this call — the record must be
    // on disk NOW, not held in the pool.
    expect(recorder.size).toBe(1);
    const [record] = readRecords(recorder);
    expect(record.kind).toBe('llm-failure');
    expect(record.decision).toBe('error');
    expect(record.errorMessage).toBe('connect ECONNREFUSED 127.0.0.1:11434');
    expect(record.eventId).toBe('evt-9');
    expect(record.agentId).toBe('agent-1');
    expect(record.correct).toBeNull();
  });

  it('still pools successful calls for assessment matching (happy path unchanged)', () => {
    const recorder = makeRecorder();

    recorder.recordLLMCall(llmCall('test-model', 'evt-1'));

    expect(recorder.size).toBe(0); // pooled, not yet written
    expect(readRecords(recorder)).toHaveLength(0);
  });
});

describe('TrajectoryRecorder stored-text cap (T-106)', () => {
  it('caps an oversized rawResponse at write time with an explicit marker', () => {
    const recorder = makeRecorder();
    const huge = 'x'.repeat(1024 * 1024); // 1MB backend answer
    recorder.recordLLMCall({ ...llmCall('test-model', 'evt-big'), response: huge });
    recorder.recordAssessment('agent-1', makeAssessment('initiate_ac', 'llm'), makeEvent('evt-big'));
    recorder.recordOutcome({
      eventId: 'evt-big',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'B' },
    });

    const [record] = readRecords(recorder);
    expect(record.rawResponse.length).toBeLessThanOrEqual(16 * 1024 + 100);
    expect(record.rawResponse).toMatch(/\[truncated \d+ of 1048576 chars\]$/);
  });

  it('stores a short rawResponse byte-identical (no marker)', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall({ ...llmCall('test-model', 'evt-small'), response: 'short answer' });
    recorder.recordAssessment('agent-1', makeAssessment('initiate_ac', 'llm'), makeEvent('evt-small'));
    recorder.recordOutcome({
      eventId: 'evt-small',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'B' },
    });

    const [record] = readRecords(recorder);
    expect(record.rawResponse).toBe('short answer');
  });
});

// ---------------------------------------------------------------------------
// Phase 1 (cognitive architecture §14.1) — the full CognitiveDecision rides
// the trajectory JSONL (training-data upgrade from binary labels).
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder cognitive decision capture (Phase 1)', () => {
  const cognitiveAnswer = JSON.stringify({
    situation: { type: 'anomaly', severity: 3, affectedZones: ['zone-a'], rootCauseHypothesis: 'heat load', confidence: 0.8 },
    goals: [{ goal: 'maintain_comfort', priority: 1, deadline: 'sim+600s' }],
    actionPlan: { primary: {
      action: 'handle_independently',
      reasoning: 'own devices cover it',
      deviceActions: [{ deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } }],
    } },
    explanation: {
      summary: 'Own HVAC covers the zone.',
      factors: [{ name: 'comfort', weight: 0.8 }],
      tradeoffs: 'acting now over waiting',
      alternativesConsidered: ['defer'],
    },
    collaboration: { needed: false },
    uncertainty: { overall: 0.2, dataQuality: 0.9, riskFactors: ['sensor_calibration'] },
  });

  it('writes the full CognitiveDecision onto the assessment record', () => {
    const recorder = makeRecorder();
    const assessment = makeAssessment('handle_independently', 'llm');
    assessment.cognitiveDecision = parseCognitiveDecision(cognitiveAnswer)!;
    recorder.recordAssessment('agent-1', assessment, makeEvent('evt-cog'));
    recorder.recordOutcome({
      eventId: 'evt-cog',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'handle_independently', interactionType: 'A' },
    });

    const [record] = readRecords(recorder);
    expect(record.cognitiveDecision).toBeDefined();
    expect(record.cognitiveDecision.situation).toEqual({
      type: 'anomaly', severity: 3, affectedZones: ['zone-a'],
      rootCauseHypothesis: 'heat load', confidence: 0.8,
    });
    expect(record.cognitiveDecision.goals).toEqual([
      { goal: 'maintain_comfort', priority: 1, deadline: 'sim+600s' },
    ]);
    expect(record.cognitiveDecision.actionPlan.primary.deviceActions).toEqual([
      { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } },
    ]);
    expect(record.cognitiveDecision.explanation.factors).toEqual([{ name: 'comfort', weight: 0.8 }]);
    expect(record.cognitiveDecision.uncertainty.riskFactors).toEqual(['sensor_calibration']);
    // The legacy fields remain (derived view) — label joins keep working.
    expect(record.decision).toBe('handle_independently');
    expect(record.reasoning).toBe('unit test');
  });

  it('records WITHOUT cognitiveDecision stay byte-compatible (legacy/binary answers)', () => {
    const recorder = makeRecorder();
    recorder.recordAssessment('agent-1', makeAssessment('initiate_ac', 'llm'), makeEvent('evt-legacy'));
    recorder.recordOutcome({
      eventId: 'evt-legacy',
      agentId: 'agent-1',
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'B' },
    });

    const [record] = readRecords(recorder);
    expect(record.cognitiveDecision).toBeUndefined();
    expect(record.decision).toBe('initiate_ac');
  });
});

// ---------------------------------------------------------------------------
// P5 — handshake records carry the real initiator + service-origin face
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder P5 handshake context (initiator + service origin)', () => {
  it('records the REAL initiator beside the answering provider (R44-extreme-F3 self-reference regression)', () => {
    const recorder = makeRecorder();
    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'responder-agent',
      decision: 'accept',
      decisionSource: 'rule',
      context: {
        providerAgentId: 'responder-agent',
        initiatorAgentId: 'initiator-agent',
      },
    });

    const [record] = readRecords(recorder);
    expect(record.context.providerAgentId).toBe('responder-agent');
    // Pre-P5 the record was self-only (agentId = providerAgentId = responder)
    // and the (initiator, responder) edge deduped to zero.
    expect(record.context.initiatorAgentId).toBe('initiator-agent');
    expect(record.context.initiatorAgentId).not.toBe(record.context.providerAgentId);
  });

  it('omits initiatorAgentId/requestedCapabilities when the answer did not carry them', () => {
    const recorder = makeRecorder();
    recorder.recordCollaborationResponse({
      collaborationId: 'ac-2',
      agentId: 'responder-agent',
      decision: 'reject',
      decisionSource: 'fallback',
      context: { providerAgentId: 'responder-agent' },
    });

    const [record] = readRecords(recorder);
    expect(record.context.initiatorAgentId).toBeUndefined();
    expect(record.context.requestedCapabilities).toBeUndefined();
  });

  it('persists requestedCapabilities + myServices origin for the service-origin funnel', () => {
    const recorder = makeRecorder();
    recorder.recordCollaborationResponse({
      collaborationId: 'ac-3',
      agentId: 'steward-a',
      decision: 'accept',
      decisionSource: 'llm',
      context: {
        initiatorAgentId: 'consumer-b',
        requestedCapabilities: ['valve-control'],
        myServices: [
          { name: '区域排涝调度', semanticType: 'drainage-control', origin: 'aggregate' },
          { name: '排涝智能阀 1: open', semanticType: 'open', visibility: 'public', origin: 'derived' },
        ],
      },
    });

    const [record] = readRecords(recorder);
    expect(record.context.requestedCapabilities).toEqual(['valve-control']);
    expect(record.context.myServices).toEqual([
      { name: '区域排涝调度', semanticType: 'drainage-control', origin: 'aggregate' },
      { name: '排涝智能阀 1: open', semanticType: 'open', visibility: 'public', origin: 'derived' },
    ]);
  });

  it('shaping threads responderContext.initiatorAgentId + proposal capabilities + myServices origin', async () => {
    const { recordHandshakeToTrajectory } = await import('../runtime/shaping/collaboration.js');
    const recorder = makeRecorder();
    const event = {
      id: 'evt-p5',
      type: 'COLLABORATION_MESSAGE',
      source: 'steward-a',
      timestamp: new Date(),
      metadata: {},
      payload: {
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'steward-a',
        collaborationId: 'ac-p5',
        proposal: { capabilities: ['valve-control', 'water-level-monitoring'] },
        responderContext: {
          providerAgentId: 'steward-a',
          initiatorAgentId: 'consumer-b',
          myServices: [
            { name: '区域排涝调度', semanticType: 'drainage-control', origin: 'aggregate' },
            { name: 'broken-entry' },
          ],
        },
      },
    } as unknown as SystemEvent;

    recordHandshakeToTrajectory(
      { recordCollaborationResponse: i => recorder.recordCollaborationResponse(i as Parameters<TrajectoryRecorder['recordCollaborationResponse']>[0]) },
      event,
      undefined,
    );

    const [record] = readRecords(recorder);
    expect(record.context.initiatorAgentId).toBe('consumer-b');
    expect(record.context.providerAgentId).toBe('steward-a');
    expect(record.context.requestedCapabilities).toEqual(['valve-control', 'water-level-monitoring']);
    // A malformed myServices entry drops the whole list honestly (existing
    // parse contract), never a garbage record.
    expect(record.context.myServices).toBeUndefined();

    const clean = {
      ...event,
      payload: {
        ...(event.payload as Record<string, unknown>),
        collaborationId: 'ac-p5b',
        responderContext: {
          providerAgentId: 'steward-a',
          initiatorAgentId: 'consumer-b',
          myServices: [{ name: '区域排涝调度', semanticType: 'drainage-control', origin: 'aggregate' }],
        },
      },
    } as unknown as SystemEvent;
    recordHandshakeToTrajectory(
      { recordCollaborationResponse: i => recorder.recordCollaborationResponse(i as Parameters<TrajectoryRecorder['recordCollaborationResponse']>[0]) },
      clean,
      undefined,
    );
    const [, cleanRecord] = readRecords(recorder);
    expect(cleanRecord.context.myServices).toEqual([
      { name: '区域排涝调度', semanticType: 'drainage-control', origin: 'aggregate' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// R81-D2 完成：responder 评估道 prompt/rawResponse 落盘（训练数据缺口修复）
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder collaboration-response prompt capture (R81-D2 完成)', () => {
  const evaluationCall = (model: string): TrajectoryLLMCall => ({
    systemPrompt: 'You evaluate collaboration proposals.',
    userPrompt: 'COLLABORATION PROPOSAL EVALUATION\n\nYOUR PROFILE:\n- Agent: Agent Two',
    response: '{"recommendedDecision":"accept","reasoning":"fits"}',
    durationMs: 42,
    model,
    success: true,
    context: { agentId: 'agent-2' },
  });

  it('llm-sourced answer record carries prompt + rawResponse（与决策道同构）', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(evaluationCall('ac-decision-v5'));

    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'agent-2',
      decision: 'accept',
      decisionSource: 'llm',
      eventId: 'evt-heat-1',
    });

    const [record] = readRecords(recorder);
    expect(record.kind).toBe('collaboration-response');
    expect(record.prompt?.userPrompt).toContain('COLLABORATION PROPOSAL EVALUATION');
    expect(record.prompt?.systemPrompt).toBe('You evaluate collaboration proposals.');
    expect(record.rawResponse).toBe('{"recommendedDecision":"accept","reasoning":"fits"}');
    // 原 R81-D2 的 model/时延归因不破。
    expect(record.model).toBe('ac-decision-v5');
    expect(record.durationMs).toBe(42);
  });

  it('fallback answer keeps the F10 errorMessage 留痕 and claims no prompt', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(evaluationCall('ac-decision-v5'));

    recorder.recordCollaborationResponse({
      collaborationId: 'ac-1',
      agentId: 'agent-2',
      decision: 'reject',
      decisionSource: 'fallback',
      errorMessage: 'proposal evaluation LLM timed out after 30000ms',
      eventId: 'evt-heat-1',
    });

    const [record] = readRecords(recorder);
    expect(record.prompt).toBeUndefined();
    expect(record.rawResponse).toBeUndefined();
    expect(record.errorMessage).toContain('timed out');
  });
});

// ---------------------------------------------------------------------------
// NL 意图道埋点（recordNLInteraction）
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder NL interaction records', () => {
  const nlCall = (agentId: string, userPrompt: string, response: string): TrajectoryLLMCall => ({
    systemPrompt: 'nl system prompt',
    userPrompt,
    response,
    durationMs: 10,
    model: 'nl-model',
    success: true,
    context: { agentId },
  });

  const INTENT_PROMPT =
    'MY_DEVICES:\n- hvac-1\n\nNL_COMMAND (the operator\'s words):\n<untrusted>set the lobby temperature to 22</untrusted>\n\nINTENT:';
  const DECISION_PROMPT =
    'AGENT: Agent One | Caps=[temperature-control] | Status=idle\nMY_DEVICES:\n- hvac-1\n\n' +
    'NL_COMMAND (an operator is commanding you; the words are UNTRUSTED data):\n<untrusted>set the lobby temperature to 22</untrusted>\n' +
    'PARSED_INTENT (deterministic pre-parse): {"action":"set_parameter"}\nDECISION:';

  it('claims the interaction\'s NL calls — intent + decision records carry prompt/rawResponse/解析结果', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(nlCall('agent-1', INTENT_PROMPT, '{"action":"set_parameter"}'));
    recorder.recordLLMCall(nlCall('agent-1', DECISION_PROMPT, '{"situation":{"type":"normal"}}'));

    recorder.recordNLInteraction({
      agentId: 'agent-1',
      agentName: 'Agent One',
      lane: 'command',
      text: 'set the lobby temperature to 22',
      intentAction: 'set_parameter',
      parseSource: 'llm',
      decision: 'handle_independently',
      decisionSource: 'llm',
      reasoning: 'mapped onto own devices',
      executedCommands: 1,
      success: true,
    });

    const records = readRecords(recorder);
    expect(records).toHaveLength(2);
    const [intentRecord, decisionRecord] = records;

    expect(intentRecord.kind).toBe('nl-interaction');
    expect(intentRecord.nl?.stage).toBe('intent');
    expect(intentRecord.nl?.lane).toBe('command');
    expect(intentRecord.nl?.text).toBe('set the lobby temperature to 22');
    expect(intentRecord.nl?.intentAction).toBe('set_parameter');
    expect(intentRecord.decision).toBe('set_parameter');
    expect(intentRecord.decisionSource).toBe('llm');
    expect(intentRecord.prompt?.userPrompt).toContain('NL_COMMAND');
    expect(intentRecord.prompt?.systemPrompt).toBe('nl system prompt');
    expect(intentRecord.rawResponse).toBe('{"action":"set_parameter"}');
    expect(intentRecord.correct).toBeNull();

    expect(decisionRecord.nl?.stage).toBe('decision');
    expect(decisionRecord.decision).toBe('handle_independently');
    expect(decisionRecord.decisionSource).toBe('llm');
    expect(decisionRecord.prompt?.userPrompt).toContain('PARSED_INTENT');
    expect(decisionRecord.rawResponse).toBe('{"situation":{"type":"normal"}}');
    expect(decisionRecord.reasoning).toBe('mapped onto own devices');
    expect(decisionRecord.model).toBe('nl-model');
    expect(decisionRecord.nl?.executedCommands).toBe(1);
    expect(decisionRecord.nl?.success).toBe(true);
  });

  it('R6-C-F04: a rules-llm-down intent with a claimed (transport-successful) call is tagged errorMessage', () => {
    const recorder = makeRecorder();
    // The intent call SUCCEEDED at transport but its answer was unusable —
    // the write-through llm-failure ledger never sees this degradation.
    recorder.recordLLMCall(nlCall('agent-1', INTENT_PROMPT, 'sorry, I cannot help with that'));

    recorder.recordNLInteraction({
      agentId: 'agent-1',
      lane: 'command',
      text: 'set the lobby temperature to 22',
      intentAction: 'unknown',
      parseSource: 'rules-llm-down',
      decision: 'handle_independently',
      decisionSource: 'rules',
    });

    const [record] = readRecords(recorder);
    expect(record.nl?.stage).toBe('intent');
    expect(record.nl?.parseSource).toBe('rules-llm-down');
    expect(record.decisionSource).toBe('rules-llm-down');
    expect(record.errorMessage).toContain('rules-llm-down');
  });

  it('R6-C-F04: a call-FAILED rules-llm-down interaction stays untagged (the llm-failure ledger already counts it)', () => {
    const recorder = makeRecorder();
    // Transport failure: written through as llm-failure, never pooled — the
    // interaction then claims nothing and lands as one stage-rules record.
    recorder.recordLLMCall({
      systemPrompt: 'nl system prompt',
      userPrompt: INTENT_PROMPT,
      response: '',
      durationMs: 5,
      success: false,
      errorMessage: 'connection refused',
      context: { agentId: 'agent-1' },
    });

    recorder.recordNLInteraction({
      agentId: 'agent-1',
      lane: 'command',
      text: 'set the lobby temperature to 22',
      intentAction: 'unknown',
      parseSource: 'rules-llm-down',
      decision: 'handle_independently',
      decisionSource: 'rules',
    });

    const records = readRecords(recorder);
    expect(records).toHaveLength(2);
    expect(records[0].kind).toBe('llm-failure');
    const nlRecord = records[1];
    expect(nlRecord.nl?.stage).toBe('rules');
    expect(nlRecord.errorMessage).toBeUndefined(); // no double count
  });

  it('rule-only interaction writes one prompt-less stage rules record', () => {
    const recorder = makeRecorder();

    recorder.recordNLInteraction({
      agentId: 'agent-1',
      lane: 'command',
      text: 'fire in the lobby!',
      intentAction: 'emergency',
      parseSource: 'rules',
      decision: 'escalate',
      decisionSource: 'emergency',
    });

    const [record] = readRecords(recorder);
    expect(record.kind).toBe('nl-interaction');
    expect(record.nl?.stage).toBe('rules');
    expect(record.prompt).toBeUndefined();
    expect(record.rawResponse).toBeUndefined();
    expect(record.decision).toBe('escalate');
    expect(record.decisionSource).toBe('emergency');
    expect(record.correct).toBeNull();
  });

  it('never claims another agent\'s NL call or a non-NL call of the same agent', () => {
    const recorder = makeRecorder();
    recorder.recordLLMCall(nlCall('agent-2', INTENT_PROMPT, '{}'));
    recorder.recordLLMCall(nlCall('agent-1', 'AGENT: Agent One | assess cluster', '{}'));

    recorder.recordNLInteraction({
      agentId: 'agent-1',
      lane: 'ask',
      text: 'what is the temperature?',
      intentAction: 'get_status',
      parseSource: 'rules',
      decision: 'get_status',
      decisionSource: 'rules',
    });

    const [record] = readRecords(recorder);
    // 没有可认领的调用（agent-2 的 NL 调用、agent-1 的非 NL 调用都不算）——
    // 退化为一条 stage rules 记录。
    expect(record.nl?.stage).toBe('rules');
    expect(record.prompt).toBeUndefined();
  });
});

// ============================================================================
// R6-E-F10 — device-execution receipts: one record per command carrying the
// execution half of decision → execution → world-feedback.
// ============================================================================

describe('R6-E-F10 — recordDeviceExecution', () => {
  it('writes a device-execution record with the full receipt shape', () => {
    const recorder = makeRecorder();
    recorder.recordDeviceExecution({
      agentId: 'agent-1',
      eventId: 'evt-42',
      deviceId: 'hvac-b',
      deviceName: 'HVAC B',
      command: 'set-temperature',
      params: { target: 22 },
      success: true,
      result: { targetTemperature: 22 },
      executionTime: 3,
      actor: 'engine:agent:agent-1',
    });
    const records = readRecords(recorder);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.kind).toBe('device-execution');
    expect(r.agentId).toBe('agent-1');
    expect(r.eventId).toBe('evt-42');
    expect(r.decision).toBe('executed');
    expect(r.correct).toBeNull();
    expect(r.groundTruth).toEqual({ correctDecision: 'unknown', interactionType: 'unknown' });
    expect(r.deviceExecution).toEqual({
      deviceId: 'hvac-b',
      deviceName: 'HVAC B',
      command: 'set-temperature',
      params: JSON.stringify({ target: 22 }),
      success: true,
      result: JSON.stringify({ targetTemperature: 22 }),
      executionTime: 3,
      actor: 'engine:agent:agent-1',
    });
  });

  it('a failed command records success:false + error, decision "failed"', () => {
    const recorder = makeRecorder();
    recorder.recordDeviceExecution({
      agentId: 'agent-1',
      deviceId: 'hvac-b',
      command: 'set-temperature',
      success: false,
      error: 'Command execution timed out after 5000ms',
      executionTime: 5000,
    });
    const [r] = readRecords(recorder);
    expect(r.kind).toBe('device-execution');
    expect(r.decision).toBe('failed');
    expect(r.eventId).toBe('unattributed'); // no inflight event — honest marker
    expect(r.deviceExecution.success).toBe(false);
    expect(r.deviceExecution.error).toContain('timed out');
    expect(r.deviceExecution.result).toBeUndefined();
  });

  it('oversized params/result are truncated at write time (T-106 discipline)', () => {
    const recorder = makeRecorder();
    recorder.recordDeviceExecution({
      agentId: 'agent-1',
      deviceId: 'hvac-b',
      command: 'set-temperature',
      params: { blob: 'x'.repeat(20000) },
      success: true,
      result: { blob: 'y'.repeat(20000) },
    });
    const [r] = readRecords(recorder);
    expect(r.deviceExecution.params.length).toBeLessThan(5000);
    expect(r.deviceExecution.params).toContain('[truncated');
    expect(r.deviceExecution.result.length).toBeLessThan(5000);
    expect(r.deviceExecution.result).toContain('[truncated');
  });
});
